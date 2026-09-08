import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJsonSha256,
  isRedistributableLicense,
  normalizedLicenseUrl,
  parseCliArguments,
  plainText,
  readJson,
  sha256,
  sourceExtension,
  writeJson,
} from './library-image-common.mjs';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_QUERY_API = 'https://query.wikidata.org/sparql';
const GBIF_SPECIES_API = 'https://api.gbif.org/v1/species';
const GBIF_OCCURRENCE_API = 'https://api.gbif.org/v1/occurrence';
const INATURALIST_API = 'https://api.inaturalist.org/v1';
const USER_AGENT =
  'AussiePlantPacksResearch/1.0 (https://github.com/Studio-Tansy/aussie-plant-packs)';
const WIKIDATA_BATCH_SIZE = 80;
const COMMONS_BATCH_SIZE = 40;
const CATEGORY_QUERY_CONCURRENCY = 6;
const DOWNLOAD_CONCURRENCY = 4;
const RETRY_ATTEMPTS = 8;
const API_DELAY_MS = 150;
const DOWNLOAD_DELAY_MS = 100;
const SUPPORTED_SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UNDESIRABLE_IMAGE_WORDS =
  /\b(map|range|distribution|herbarium|specimen|diagram|icon|logo|stamp|coin|flag|symbol|unknown|unidentified|perhaps|possibly|probably|disease|rot|rust|mildew|virus|bacterial|fungal|drought)\b/i;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const packDirectory = join(repositoryDirectory, 'library-images');
const cacheDirectory = join(packDirectory, 'cache');
const apiCacheDirectory = join(cacheDirectory, 'api');
const downloadCacheDirectory = join(cacheDirectory, 'downloads');
const sourceDirectory = join(packDirectory, 'source');
const catalogPath = join(packDirectory, 'catalog.json');
const pilotPath = join(packDirectory, 'sources.json');
const taxonNameOverridesPath = join(packDirectory, 'taxon-name-overrides.json');
const researchPath = join(packDirectory, 'research-manifest.json');
const options = parseCliArguments(process.argv.slice(2));
const refresh = options.has('refresh');
const skipDownloads = options.has('skip-downloads');
const researchDate =
  typeof options.get('research-date') === 'string'
    ? options.get('research-date')
    : new Date().toISOString().slice(0, 10);

mkdirSync(apiCacheDirectory, { recursive: true });
mkdirSync(downloadCacheDirectory, { recursive: true });
mkdirSync(sourceDirectory, { recursive: true });

const catalog = readJson(catalogPath);
const pilot = readJson(pilotPath);
const taxonNameOverrides = readJson(taxonNameOverridesPath);
const previousResearch = existsSync(researchPath) ? readJson(researchPath) : null;
const previousById = new Map(
  previousResearch?.records?.map((record) => [record.speciesId, record]) ?? [],
);
const pilotById = new Map(pilot.images.map((image) => [image.speciesId, image]));

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function cachePath(namespace, request) {
  return join(apiCacheDirectory, `${namespace}-${sha256(Buffer.from(request))}.json`);
}

async function fetchWithRetry(url, init, description) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(60_000),
        headers: {
          'User-Agent': USER_AGENT,
          ...(init?.headers ?? {}),
        },
      });
      if (response.ok) return response;
      const body = await response.text();
      lastError = new Error(
        `${description} returned ${response.status}: ${body.slice(0, 300)}`,
      );
      if (response.status < 500 && response.status !== 429) break;
      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000 * attempt);
        continue;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError ?? new Error(`${description} failed.`);
}

async function cachedJson(namespace, request, fetcher) {
  const path = cachePath(namespace, request);
  if (!refresh && existsSync(path)) return readJson(path);
  const value = await fetcher();
  writeJson(path, value);
  await sleep(API_DELAY_MS);
  return value;
}

function sparqlString(value) {
  return JSON.stringify(value);
}

async function queryWikidata(names) {
  const results = new Map();
  for (let offset = 0; offset < names.length; offset += WIKIDATA_BATCH_SIZE) {
    const batch = names.slice(offset, offset + WIKIDATA_BATCH_SIZE);
    const query = `SELECT ?taxon ?taxonName ?image WHERE {
  VALUES ?taxonName { ${batch.map(sparqlString).join(' ')} }
  ?taxon wdt:P225 ?taxonName.
  OPTIONAL { ?taxon wdt:P18 ?image. }
}`;
    const data = await cachedJson('wikidata', query, async () => {
      const url = new URL(WIKIDATA_QUERY_API);
      url.searchParams.set('query', query);
      url.searchParams.set('format', 'json');
      const response = await fetchWithRetry(
        url,
        { headers: { Accept: 'application/sparql-results+json' } },
        'Wikidata query',
      );
      return response.json();
    });

    for (const binding of data.results?.bindings ?? []) {
      const name = binding.taxonName?.value;
      const entity = binding.taxon?.value;
      if (typeof name !== 'string' || typeof entity !== 'string') continue;
      const current = results.get(name) ?? { entities: new Set(), images: new Set() };
      current.entities.add(entity);
      if (typeof binding.image?.value === 'string') {
        current.images.add(binding.image.value);
      }
      results.set(name, current);
    }
    process.stderr.write(
      `\rWikidata exact-name research: ${Math.min(offset + WIKIDATA_BATCH_SIZE, names.length)}/${names.length}`,
    );
  }
  process.stderr.write('\n');
  return results;
}

async function queryTaxonOnlyWikidata(names) {
  const results = new Map();
  for (let offset = 0; offset < names.length; offset += WIKIDATA_BATCH_SIZE) {
    const batch = names.slice(offset, offset + WIKIDATA_BATCH_SIZE);
    const query = `SELECT ?taxon ?taxonName ?image WHERE {
  VALUES ?taxonName { ${batch.map(sparqlString).join(' ')} }
  ?taxon wdt:P225 ?taxonName;
    wdt:P31 wd:Q16521.
  OPTIONAL { ?taxon wdt:P18 ?image. }
}`;
    const data = await cachedJson('wikidata-taxa', query, async () => {
      const url = new URL(WIKIDATA_QUERY_API);
      url.searchParams.set('query', query);
      url.searchParams.set('format', 'json');
      const response = await fetchWithRetry(
        url,
        { headers: { Accept: 'application/sparql-results+json' } },
        'Wikidata taxon query',
      );
      return response.json();
    });

    for (const binding of data.results?.bindings ?? []) {
      const name = binding.taxonName?.value;
      const entity = binding.taxon?.value;
      if (typeof name !== 'string' || typeof entity !== 'string') continue;
      const current = results.get(name) ?? { entities: new Set(), images: new Set() };
      current.entities.add(entity);
      if (typeof binding.image?.value === 'string') {
        current.images.add(binding.image.value);
      }
      results.set(name, current);
    }
    process.stderr.write(
      `\rWikidata resolved-taxon research: ${Math.min(offset + WIKIDATA_BATCH_SIZE, names.length)}/${names.length}`,
    );
  }
  if (names.length > 0) process.stderr.write('\n');
  return results;
}

function commonsFileTitleFromUrl(imageUrl) {
  const url = new URL(imageUrl);
  const marker = '/wiki/Special:FilePath/';
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Unsupported Wikidata image URL: ${imageUrl}`);
  }
  return `File:${decodeURIComponent(url.pathname.slice(markerIndex + marker.length))}`;
}

function canonicalTitle(title) {
  return title.replace(/_/g, ' ').toLocaleLowerCase('en');
}

function cleanSourceUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  return url.toString();
}

function candidateFromPage(page) {
  const info = page?.imageinfo?.[0];
  if (!info || !SUPPORTED_SOURCE_TYPES.has(info.mime)) return null;
  const metadata = info.extmetadata ?? {};
  const creator = plainText(metadata.Artist?.value || metadata.Credit?.value);
  const license = plainText(metadata.LicenseShortName?.value);
  const licenseUrl = normalizedLicenseUrl(license, metadata.LicenseUrl?.value);
  if (
    creator.length === 0 ||
    creator.length > 200 ||
    !isRedistributableLicense(license, licenseUrl)
  ) {
    return null;
  }
  const sourceDownloadUrl = cleanSourceUrl(info.thumburl || info.url);
  const sourcePageUrl = cleanSourceUrl(info.descriptionurl);
  if (!sourceDownloadUrl.startsWith('https://') || !sourcePageUrl.startsWith('https://')) {
    return null;
  }
  return {
    commonsTitle: page.title,
    contentType: info.mime,
    sourceDownloadUrl,
    originalDownloadUrl: cleanSourceUrl(info.url),
    sourcePageUrl,
    sourceWidth: info.width,
    sourceHeight: info.height,
    creator,
    license,
    licenseUrl,
    description: plainText(metadata.ImageDescription?.value),
    categories: plainText(metadata.Categories?.value),
  };
}

function candidateScore(candidate, scientificName) {
  const normalizedName = scientificName.toLocaleLowerCase('en');
  const haystack = `${candidate.commonsTitle} ${candidate.description}`.toLocaleLowerCase('en');
  let score = Math.min(candidate.sourceWidth * candidate.sourceHeight, 20_000_000) / 1_000_000;
  if (candidate.exactTaxonEvidenceFields?.includes('filename')) score += 500;
  if (candidate.exactTaxonEvidenceFields?.includes('description')) score += 250;
  if (candidate.exactTaxonEvidenceFields?.includes('categories')) score += 100;
  if (haystack.includes(normalizedName)) score += 200;
  if (canonicalTitle(candidate.commonsTitle).includes(normalizedName)) score += 100;
  if (UNDESIRABLE_IMAGE_WORDS.test(candidate.commonsTitle)) score -= 1000;
  return score;
}

function selectCandidate(candidates, scientificName) {
  return candidates
    .filter(
      (candidate) =>
        candidate && !UNDESIRABLE_IMAGE_WORDS.test(candidate.commonsTitle),
    )
    .sort((left, right) => {
      const scoreDifference =
        candidateScore(right, scientificName) - candidateScore(left, scientificName);
      return scoreDifference || left.commonsTitle.localeCompare(right.commonsTitle);
    })[0] ?? null;
}

function normalizeTaxonText(value) {
  return value
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[×✕]/g, ' x ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en');
}

function normalizeTaxonIdentity(value) {
  return normalizeTaxonText(value)
    .replace(/\b(?:var|subsp|ssp|f)\.?\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAmbiguousCatalogTaxonName(scientificName) {
  const normalized = normalizeTaxonText(scientificName);
  return (
    normalized.startsWith('various ') ||
    /\b(?:sp\.?|spp\.?|hybrids?|group)\b/.test(normalized)
  );
}

function hasNonTaxonomicQualifier(scientificName) {
  return /\((?!syn\.)[^)]+\)/i.test(scientificName);
}

function exactTaxonEvidenceFields(candidate, scientificName) {
  const needle = normalizeTaxonText(scientificName);
  if (needle.length === 0) return [];
  return [
    ['filename', candidate.commonsTitle.replace(/^File:/i, '')],
    ['description', candidate.description],
    ['categories', candidate.categories],
  ]
    .filter(([, value]) => normalizeTaxonText(value).includes(needle))
    .map(([field]) => field);
}

function catalogNameCandidates(scientificName) {
  const candidates = [
    {
      name: scientificName,
      relationship: 'catalog-scientific-name',
    },
  ];
  const synonymMatch = /^(.+?)\s*\(syn\.\s*(.+?)\)\s*$/i.exec(scientificName);
  if (synonymMatch) {
    candidates.splice(
      0,
      candidates.length,
      {
        name: synonymMatch[1].trim(),
        relationship: 'catalog-primary-name',
      },
      {
        name: synonymMatch[2].trim(),
        relationship: 'catalog-declared-synonym',
      },
    );
  }
  const expanded = [];
  for (const candidate of candidates) {
    expanded.push(candidate);
    if (/\s[x×]\s/i.test(candidate.name)) {
      expanded.push({
        name: candidate.name.replace(/\s[x×]\s/gi, ' × '),
        relationship: `${candidate.relationship}-hybrid-sign-variant`,
      });
      expanded.push({
        name: candidate.name.replace(/\s[x×]\s/gi, ' x '),
        relationship: `${candidate.relationship}-hybrid-letter-variant`,
      });
    }
  }
  const seen = new Set();
  return expanded.filter((candidate) => {
    const key = candidate.name
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('en');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEligibleForObservationResearch(scientificName) {
  return (
    !isAmbiguousCatalogTaxonName(scientificName) &&
    !hasNonTaxonomicQualifier(scientificName) &&
    !/[‘’'"]/.test(scientificName) &&
    !/\b(?:group|hybrids?|various)\b/i.test(scientificName)
  );
}

async function queryCommonsFiles(titles) {
  const uniqueTitles = [...new Set(titles)].sort();
  const results = new Map();
  for (let offset = 0; offset < uniqueTitles.length; offset += COMMONS_BATCH_SIZE) {
    const batch = uniqueTitles.slice(offset, offset + COMMONS_BATCH_SIZE);
    const body = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      redirects: '1',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|sha1|extmetadata',
      iiurlwidth: '1024',
      titles: batch.join('|'),
    });
    const request = body.toString();
    const data = await cachedJson('commons-files', request, async () => {
      const response = await fetchWithRetry(
        COMMONS_API,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        },
        'Commons file metadata query',
      );
      return response.json();
    });
    for (const page of data.query?.pages ?? []) {
      const candidate = candidateFromPage(page);
      if (candidate) results.set(canonicalTitle(page.title), candidate);
    }
    for (const redirect of data.query?.redirects ?? []) {
      const target = results.get(canonicalTitle(redirect.to));
      if (target) results.set(canonicalTitle(redirect.from), target);
    }
    process.stderr.write(
      `\rCommons P18 metadata: ${Math.min(offset + COMMONS_BATCH_SIZE, uniqueTitles.length)}/${uniqueTitles.length}`,
    );
  }
  process.stderr.write('\n');
  return results;
}

async function queryCommonsCategory(scientificName) {
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    generator: 'categorymembers',
    gcmtitle: `Category:${scientificName}`,
    gcmtype: 'file',
    gcmlimit: '20',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|sha1|extmetadata',
    iiurlwidth: '1024',
  });
  const request = body.toString();
  const data = await cachedJson('commons-category', request, async () => {
    const response = await fetchWithRetry(
      COMMONS_API,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      `Commons category query for ${scientificName}`,
    );
    return response.json();
  });
  const candidates = (data.query?.pages ?? []).map(candidateFromPage).filter(Boolean);
  const redirect = (data.query?.redirects ?? []).find(
    (entry) => canonicalTitle(entry.from) === canonicalTitle(`Category:${scientificName}`),
  );
  return {
    candidate: selectCandidate(candidates, scientificName),
    redirectTarget:
      typeof redirect?.to === 'string' ? redirect.to.replace(/^Category:/, '') : null,
  };
}

async function queryCommonsSearch(scientificName) {
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: scientificName,
    gsrlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|sha1|extmetadata',
    iiurlwidth: '1024',
  });
  const request = body.toString();
  const data = await cachedJson('commons-search', request, async () => {
    const response = await fetchWithRetry(
      COMMONS_API,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      `Commons exact metadata search for ${scientificName}`,
    );
    return response.json();
  });
  const candidates = (data.query?.pages ?? [])
    .map(candidateFromPage)
    .filter((candidate) => candidate !== null)
    .map((candidate) => ({
      ...candidate,
      exactTaxonEvidenceFields: exactTaxonEvidenceFields(candidate, scientificName),
    }))
    .filter((candidate) => candidate.exactTaxonEvidenceFields.length > 0);
  return selectCandidate(candidates, scientificName);
}

function cultivarNameParts(scientificName) {
  const firstQuote = scientificName.search(/[‘']/);
  const lastStraightQuote = scientificName.lastIndexOf("'");
  const lastCurlyQuote = scientificName.lastIndexOf('’');
  const lastQuote = Math.max(lastStraightQuote, lastCurlyQuote);
  if (firstQuote < 1 || lastQuote <= firstQuote) return null;
  const botanicalName = scientificName.slice(0, firstQuote).trim();
  const cultivarName = scientificName.slice(firstQuote + 1, lastQuote).trim();
  const genus = botanicalName.replace(/^[×x]\s*/, '').split(/\s+/)[0];
  const botanicalTokens = normalizeTaxonText(botanicalName)
    .match(/[a-z0-9]+/g)
    ?.filter(
      (token) =>
        token.length > 1 && !['subsp', 'ssp', 'var', 'forma'].includes(token),
    );
  const cultivarTokens = normalizeTaxonText(cultivarName)
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length > 1);
  if (!genus || !botanicalTokens?.length || !cultivarTokens?.length) return null;
  return {
    botanicalName,
    botanicalTokens,
    cultivarName,
    cultivarTokens,
    genus,
  };
}

async function queryCommonsCultivarSearch(scientificName) {
  const parts = cultivarNameParts(scientificName);
  if (!parts) return null;
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${parts.genus} ${parts.cultivarTokens.join(' ')}`,
    gsrlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|sha1|extmetadata',
    iiurlwidth: '1024',
  });
  const request = body.toString();
  const data = await cachedJson('commons-cultivar-search', request, async () => {
    const response = await fetchWithRetry(
      COMMONS_API,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      `Commons exact cultivar search for ${scientificName}`,
    );
    return response.json();
  });
  const genus = normalizeTaxonText(parts.genus);
  const candidates = (data.query?.pages ?? [])
    .map(candidateFromPage)
    .filter((candidate) => candidate !== null)
    .map((candidate) => {
      const filename = normalizeTaxonText(
        candidate.commonsTitle.replace(/^File:/i, ''),
      );
      const tokens = filename.match(/[a-z0-9]+/g) ?? [];
      const evidenceFields =
        tokens.includes(genus) &&
        parts.botanicalTokens.every((token) => tokens.includes(token)) &&
        parts.cultivarTokens.every((token) => tokens.includes(token))
          ? ['filename']
          : [];
      return { ...candidate, exactTaxonEvidenceFields: evidenceFields };
    })
    .filter((candidate) => candidate.exactTaxonEvidenceFields.length > 0);
  return selectCandidate(candidates, scientificName);
}

function taxonFilenameTokens(scientificName) {
  if (/\b(?:sp|spp)\.?\b/i.test(scientificName)) return [];
  return (
    normalizeTaxonText(scientificName)
      .match(/[a-z0-9]+/g)
      ?.filter(
        (token) =>
          token.length > 1 &&
          !['sp', 'spp', 'syn', 'subsp', 'ssp', 'var', 'forma', 'group'].includes(
            token,
          ),
      ) ?? []
  );
}

async function queryCommonsFilenameTokenSearch(scientificName) {
  const requiredTokens = taxonFilenameTokens(scientificName);
  if (requiredTokens.length < 2 || isAmbiguousCatalogTaxonName(scientificName)) {
    return null;
  }
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: requiredTokens.join(' '),
    gsrlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|sha1|extmetadata',
    iiurlwidth: '1024',
  });
  const request = body.toString();
  const data = await cachedJson('commons-filename-token-search', request, async () => {
    const response = await fetchWithRetry(
      COMMONS_API,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      `Commons tokenized filename search for ${scientificName}`,
    );
    return response.json();
  });
  const candidates = (data.query?.pages ?? [])
    .map(candidateFromPage)
    .filter((candidate) => candidate !== null)
    .map((candidate) => {
      const filenameTokens =
        normalizeTaxonText(candidate.commonsTitle.replace(/^File:/i, '')).match(
          /[a-z0-9]+/g,
        )?.filter(
          (token) =>
            !['subsp', 'ssp', 'var', 'forma', 'fma', 'v'].includes(token),
        ) ?? [];
      const hasRequiredSequence = filenameTokens.some((_, start) =>
        requiredTokens.every(
          (token, offset) => filenameTokens[start + offset] === token,
        ),
      );
      return {
        ...candidate,
        exactTaxonEvidenceFields:
          hasRequiredSequence && !filenameTokens.includes('syn')
            ? ['filename']
            : [],
      };
    })
    .filter((candidate) => candidate.exactTaxonEvidenceFields.length > 0);
  return selectCandidate(candidates, scientificName);
}

async function queryCommonsDeepCategory(scientificName) {
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `deepcategory:"${scientificName}"`,
    gsrlimit: '50',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|sha1|extmetadata',
    iiurlwidth: '1024',
  });
  const request = body.toString();
  const data = await cachedJson('commons-deep-category', request, async () => {
    const response = await fetchWithRetry(
      COMMONS_API,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      `Commons recursive category search for ${scientificName}`,
    );
    return response.json();
  });
  const candidates = (data.query?.pages ?? [])
    .map(candidateFromPage)
    .filter((candidate) => candidate !== null);
  return selectCandidate(candidates, scientificName);
}

function gbifSpeciesUrl(key) {
  return `https://www.gbif.org/species/${key}`;
}

async function queryGbifSpecies(key) {
  const request = String(key);
  return cachedJson('gbif-species', request, async () => {
    const response = await fetchWithRetry(
      `${GBIF_SPECIES_API}/${key}`,
      { headers: { Accept: 'application/json' } },
      `GBIF species ${key}`,
    );
    return response.json();
  });
}

async function queryGbifSynonyms(key) {
  const url = new URL(`${GBIF_SPECIES_API}/${key}/synonyms`);
  url.searchParams.set('limit', '1000');
  const request = url.toString();
  const data = await cachedJson('gbif-synonyms', request, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json' } },
      `GBIF synonyms for accepted usage ${key}`,
    );
    return response.json();
  });
  return (data.results ?? [])
    .filter(
      (entry) =>
        entry.taxonomicStatus === 'SYNONYM' &&
        entry.nameType === 'SCIENTIFIC' &&
        Number.isInteger(entry.key) &&
        Number.isInteger(entry.acceptedKey) &&
        entry.acceptedKey === key &&
        typeof entry.canonicalName === 'string' &&
        entry.canonicalName.trim().length > 0,
    )
    .map((entry) => ({
      authority: 'GBIF Backbone Taxonomy',
      synonymUsageKey: entry.key,
      synonymUsageUrl: gbifSpeciesUrl(entry.key),
      synonymScientificName: entry.scientificName,
      synonymCanonicalName: entry.canonicalName,
      acceptedUsageKey: entry.acceptedKey,
      acceptedUsageUrl: gbifSpeciesUrl(entry.acceptedKey),
    }))
    .sort(
      (left, right) =>
        left.synonymCanonicalName.localeCompare(right.synonymCanonicalName) ||
        left.synonymUsageKey - right.synonymUsageKey,
    );
}

function isFormalTaxonName(name) {
  return (
    /^[×x]?[A-Z][a-z-]+(?:\s+(?:(?:var|subsp|ssp|f)\.?\s+)?[a-z][a-z-]+){1,3}$/.test(
      name,
    ) &&
    !/\b(?:sp|spp|hybrid|hybrida|hybridum|hybridus)\b/i.test(name)
  );
}

async function queryGbifExactNameSearch(name) {
  if (!isFormalTaxonName(name)) return null;
  const url = new URL(`${GBIF_SPECIES_API}/search`);
  url.searchParams.set('q', name);
  url.searchParams.set('limit', '100');
  const request = url.searchParams.toString();
  const data = await cachedJson('gbif-search', request, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json' } },
      `GBIF exact species search for ${name}`,
    );
    return response.json();
  });
  const exact = (data.results ?? []).filter(
    (entry) =>
      entry.kingdom === 'Plantae' &&
      ['ACCEPTED', 'SYNONYM'].includes(entry.taxonomicStatus) &&
      Number.isInteger(entry.key) &&
      typeof entry.canonicalName === 'string' &&
      normalizeTaxonIdentity(entry.canonicalName) === normalizeTaxonIdentity(name),
  );
  const acceptedKeys = [
    ...new Set(
      exact
        .map((entry) =>
          entry.taxonomicStatus === 'SYNONYM' ? entry.acceptedKey : entry.key,
        )
        .filter(Number.isInteger),
    ),
  ];
  if (acceptedKeys.length !== 1) return null;
  const selected =
    exact.find(
      (entry) =>
        (entry.taxonomicStatus === 'SYNONYM' ? entry.acceptedKey : entry.key) ===
        acceptedKeys[0],
    ) ?? null;
  if (!selected) return null;
  const accepted = await queryGbifSpecies(acceptedKeys[0]);
  if (
    typeof accepted.canonicalName !== 'string' ||
    typeof accepted.scientificName !== 'string'
  ) {
    return null;
  }
  return {
    authority: 'GBIF Backbone Taxonomy',
    queryName: name,
    matchType: 'EXACT_SEARCH',
    confidence: 100,
    status: selected.taxonomicStatus,
    usageKey: selected.key,
    usageUrl: gbifSpeciesUrl(selected.key),
    matchedScientificName: selected.scientificName,
    matchedCanonicalName: selected.canonicalName,
    acceptedUsageKey: acceptedKeys[0],
    acceptedUsageUrl: gbifSpeciesUrl(acceptedKeys[0]),
    acceptedScientificName: accepted.scientificName,
    acceptedCanonicalName: accepted.canonicalName,
    acceptedRank: accepted.rank,
  };
}

async function queryGbifName(name) {
  const url = new URL(`${GBIF_SPECIES_API}/match`);
  url.searchParams.set('name', name);
  url.searchParams.set('strict', 'true');
  url.searchParams.set('verbose', 'true');
  const request = url.searchParams.toString();
  const match = await cachedJson('gbif-match', request, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json' } },
      `GBIF name match for ${name}`,
    );
    return response.json();
  });
  if (
    match.matchType !== 'EXACT' ||
    !Number.isInteger(match.confidence) ||
    match.confidence < 95 ||
    !['ACCEPTED', 'SYNONYM'].includes(match.status) ||
    !Number.isInteger(match.usageKey)
  ) {
    return queryGbifExactNameSearch(name);
  }
  if (
    typeof match.canonicalName !== 'string' ||
    normalizeTaxonIdentity(name) !== normalizeTaxonIdentity(match.canonicalName)
  ) {
    return queryGbifExactNameSearch(name);
  }
  const acceptedUsageKey =
    match.status === 'SYNONYM' && Number.isInteger(match.acceptedUsageKey)
      ? match.acceptedUsageKey
      : match.usageKey;
  const accepted = await queryGbifSpecies(acceptedUsageKey);
  if (
    typeof accepted.canonicalName !== 'string' ||
    typeof accepted.scientificName !== 'string'
  ) {
    return queryGbifExactNameSearch(name);
  }
  return {
    authority: 'GBIF Backbone Taxonomy',
    queryName: name,
    matchType: match.matchType,
    confidence: match.confidence,
    status: match.status,
    usageKey: match.usageKey,
    usageUrl: gbifSpeciesUrl(match.usageKey),
    matchedScientificName: match.scientificName,
    matchedCanonicalName: match.canonicalName,
    acceptedUsageKey,
    acceptedUsageUrl: gbifSpeciesUrl(acceptedUsageKey),
    acceptedScientificName: accepted.scientificName,
    acceptedCanonicalName: accepted.canonicalName,
    acceptedRank: accepted.rank,
  };
}

function gbifMediaLicense(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en');
  if (
    normalized.includes('creativecommons.org/publicdomain/zero/1.0') ||
    /\bcc0(?:\s+1\.0)?\b/i.test(value)
  ) {
    return {
      license: 'CC0 1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    };
  }
  if (
    normalized.includes('creativecommons.org/publicdomain/mark/1.0') ||
    normalized.includes('works-public-domain') ||
    normalized === 'public domain'
  ) {
    return {
      license: 'Public domain',
      licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    };
  }
  const match = /creativecommons\.org\/licenses\/(by(?:-sa)?)\/(1\.0|2\.0|2\.1|2\.5|3\.0|4\.0)/i.exec(
    value,
  );
  if (!match) return null;
  const licenseName = match[1].toLocaleLowerCase('en') === 'by-sa' ? 'CC BY-SA' : 'CC BY';
  return {
    license: `${licenseName} ${match[2]}`,
    licenseUrl: `https://creativecommons.org/licenses/${match[1].toLocaleLowerCase('en')}/${match[2]}/`,
  };
}

function gbifMediaContentType(media) {
  const format = media.format?.toLocaleLowerCase('en');
  if (SUPPORTED_SOURCE_TYPES.has(format)) return format;
  const pathname = new URL(media.identifier).pathname.toLocaleLowerCase('en');
  if (/\.(?:jpe?g)$/.test(pathname)) return 'image/jpeg';
  if (/\.png$/.test(pathname)) return 'image/png';
  if (/\.webp$/.test(pathname)) return 'image/webp';
  return null;
}

function gbifMediaCreator(media, occurrence) {
  return (
    plainText(media.creator) ||
    plainText(media.rightsHolder) ||
    plainText(occurrence.recordedBy) ||
    plainText(occurrence.rightsHolder)
  );
}

function gbifOccurrenceMatchesTaxon(occurrence, resolution) {
  if (resolution.acceptedRank === 'SPECIES') {
    return occurrence.speciesKey === resolution.acceptedUsageKey;
  }
  return (
    occurrence.taxonKey === resolution.acceptedUsageKey ||
    occurrence.acceptedTaxonKey === resolution.acceptedUsageKey
  );
}

function gbifBasisScore(value) {
  switch (value) {
    case 'HUMAN_OBSERVATION':
      return 3;
    case 'LIVING_SPECIMEN':
      return 2;
    case 'PRESERVED_SPECIMEN':
      return 1;
    default:
      return 0;
  }
}

async function queryGbifOccurrenceImage(resolution) {
  const url = new URL(`${GBIF_OCCURRENCE_API}/search`);
  url.searchParams.set('taxon_key', String(resolution.acceptedUsageKey));
  url.searchParams.set('media_type', 'StillImage');
  url.searchParams.set('limit', '100');
  const request = url.searchParams.toString();
  const data = await cachedJson('gbif-occurrence-media', request, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json' } },
      `GBIF occurrence media for ${resolution.acceptedCanonicalName}`,
    );
    return response.json();
  });
  const candidates = [];
  for (const occurrence of data.results ?? []) {
    if (
      !Number.isInteger(occurrence.key) ||
      !gbifOccurrenceMatchesTaxon(occurrence, resolution)
    ) {
      continue;
    }
    for (const media of occurrence.media ?? []) {
      if (
        media.type !== 'StillImage' ||
        typeof media.identifier !== 'string' ||
        !media.identifier.startsWith('https://') ||
        ['api.idigbio.org', 'api.jacq.org'].includes(
          new URL(media.identifier).hostname,
        )
      ) {
        continue;
      }
      const license = gbifMediaLicense(media.license ?? occurrence.license);
      const creator = gbifMediaCreator(media, occurrence);
      const contentType = gbifMediaContentType(media);
      if (
        !license ||
        !contentType ||
        creator.length === 0 ||
        creator.length > 200
      ) {
        continue;
      }
      candidates.push({
        sourceProvider: `${plainText(media.publisher) || plainText(occurrence.datasetName) || 'Occurrence publisher'} via GBIF`,
        sourceTitle: `GBIF occurrence ${occurrence.key}`,
        contentType,
        sourceDownloadUrl: media.identifier,
        originalDownloadUrl: media.identifier,
        sourcePageUrl: `https://www.gbif.org/occurrence/${occurrence.key}`,
        creator,
        license: license.license,
        licenseUrl: license.licenseUrl,
        gbifOccurrenceEvidence: {
          occurrenceKey: occurrence.key,
          occurrenceUrl: `https://www.gbif.org/occurrence/${occurrence.key}`,
          mediaReferenceUrl:
            typeof media.references === 'string' &&
            media.references.startsWith('https://')
              ? media.references
              : null,
          datasetTitle: plainText(occurrence.datasetName),
          datasetKey: occurrence.datasetKey,
          basisOfRecord: occurrence.basisOfRecord,
          taxonKey: occurrence.taxonKey,
          acceptedTaxonKey: occurrence.acceptedTaxonKey,
          speciesKey: occurrence.speciesKey,
          mediaLicenseEvidence: media.license ?? occurrence.license,
        },
      });
    }
  }
  return (
    candidates.sort((left, right) => {
      const basisDifference =
        gbifBasisScore(right.gbifOccurrenceEvidence.basisOfRecord) -
        gbifBasisScore(left.gbifOccurrenceEvidence.basisOfRecord);
      return (
        basisDifference ||
        left.sourceDownloadUrl.localeCompare(right.sourceDownloadUrl)
      );
    })[0] ?? null
  );
}

function iNaturalistLicense(licenseCode) {
  switch (licenseCode?.toLocaleLowerCase('en')) {
    case 'cc0':
      return {
        license: 'CC0 1.0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      };
    case 'cc-by':
      return {
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      };
    case 'cc-by-sa':
      return {
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      };
    default:
      return null;
  }
}

async function queryINaturalistTaxon(name) {
  const url = new URL(`${INATURALIST_API}/taxa`);
  url.searchParams.set('q', name);
  url.searchParams.set('per_page', '20');
  const request = url.searchParams.toString();
  const data = await cachedJson('inaturalist-taxa', request, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json' } },
      `iNaturalist taxon search for ${name}`,
    );
    return response.json();
  });
  const exact = (data.results ?? []).filter(
    (taxon) =>
      taxon.is_active !== false &&
      Number.isInteger(taxon.id) &&
      typeof taxon.name === 'string' &&
      normalizeTaxonIdentity(taxon.name) === normalizeTaxonIdentity(name),
  );
  if (exact.length !== 1) return null;
  return {
    id: exact[0].id,
    name: exact[0].name,
    rank: exact[0].rank,
    taxonUrl: `https://www.inaturalist.org/taxa/${exact[0].id}`,
  };
}

function iNaturalistImageUrl(url, size) {
  return url.replace(/\/(?:square|small|medium|large|original)\.([a-z0-9]+)(?:\?.*)?$/i, `/${size}.$1`);
}

function iNaturalistCreator(photo, observation) {
  const attribution = plainText(photo.attribution);
  const fromAttribution = attribution
    .replace(/^\(c\)\s*/i, '')
    .replace(/,\s*some rights reserved.*$/i, '')
    .trim();
  return (
    fromAttribution ||
    plainText(observation.user?.name) ||
    plainText(observation.user?.login)
  );
}

async function queryINaturalistObservation(taxon) {
  const url = new URL(`${INATURALIST_API}/observations`);
  url.searchParams.set('taxon_id', String(taxon.id));
  url.searchParams.set('quality_grade', 'research');
  url.searchParams.set('photos', 'true');
  url.searchParams.set('photo_license', 'cc0,cc-by,cc-by-sa');
  url.searchParams.set('per_page', '20');
  url.searchParams.set('order_by', 'votes');
  url.searchParams.set('order', 'desc');
  const request = url.searchParams.toString();
  const data = await cachedJson('inaturalist-observations', request, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json' } },
      `iNaturalist observations for ${taxon.name}`,
    );
    return response.json();
  });
  for (const observation of data.results ?? []) {
    if (
      observation.quality_grade !== 'research' ||
      typeof observation.uri !== 'string' ||
      !observation.uri.startsWith('https://')
    ) {
      continue;
    }
    for (const photo of observation.photos ?? []) {
      const license = iNaturalistLicense(photo.license_code);
      const creator = iNaturalistCreator(photo, observation);
      if (
        !license ||
        creator.length === 0 ||
        creator.length > 200 ||
        typeof photo.url !== 'string'
      ) {
        continue;
      }
      const sourceDownloadUrl = iNaturalistImageUrl(photo.url, 'large');
      const originalDownloadUrl = iNaturalistImageUrl(photo.url, 'original');
      if (
        !sourceDownloadUrl.startsWith('https://') ||
        !originalDownloadUrl.startsWith('https://')
      ) {
        continue;
      }
      return {
        sourceProvider: 'iNaturalist',
        sourceTitle: `Research-grade observation ${observation.id}, photo ${photo.id}`,
        contentType: 'image/jpeg',
        sourceDownloadUrl,
        originalDownloadUrl,
        sourcePageUrl: observation.uri,
        sourceWidth: photo.original_dimensions?.width,
        sourceHeight: photo.original_dimensions?.height,
        creator,
        license: license.license,
        licenseUrl: license.licenseUrl,
        iNaturalistTaxonUrl: taxon.taxonUrl,
        iNaturalistObservationId: observation.id,
        iNaturalistPhotoId: photo.id,
      };
    }
  }
  return null;
}

function modifiedText(license) {
  const shareAlike = /^CC BY-SA/i.test(license)
    ? ` This adaptation is distributed under ${license}.`
    : '';
  return `Resized to fit the offline app pack and JPEG re-encoded; metadata removed.${shareAlike}`;
}

function matchedRecord(species, candidate, details) {
  return {
    speciesId: species.id,
    category: species.category,
    commonName: species.commonName,
    scientificName: species.scientificName,
    status: 'matched',
    reviewLevel: details.reviewLevel,
    matchMethod: details.matchMethod,
    matchRationale: details.matchRationale,
    ...(details.wikidataEntityUrl
      ? { wikidataEntityUrl: details.wikidataEntityUrl }
      : {}),
    ...(details.matchedTaxonName
      ? { matchedTaxonName: details.matchedTaxonName }
      : {}),
    ...(details.wikidataEntityUrls
      ? { wikidataEntityUrls: details.wikidataEntityUrls }
      : {}),
    ...(details.taxonResolution
      ? { taxonResolution: details.taxonResolution }
      : {}),
    ...(details.searchEvidence
      ? { searchEvidence: details.searchEvidence }
      : {}),
    ...(details.gbifSynonymEvidence
      ? { gbifSynonymEvidence: details.gbifSynonymEvidence }
      : {}),
    ...(details.taxonNameOverride
      ? { taxonNameOverride: details.taxonNameOverride }
      : {}),
    ...(candidate.gbifOccurrenceEvidence
      ? { gbifOccurrenceEvidence: candidate.gbifOccurrenceEvidence }
      : {}),
    sourceProvider: candidate.sourceProvider ?? 'Wikimedia Commons',
    sourceTitle: candidate.sourceTitle ?? candidate.commonsTitle,
    ...(candidate.commonsTitle ? { commonsTitle: candidate.commonsTitle } : {}),
    ...(candidate.iNaturalistTaxonUrl
      ? { iNaturalistTaxonUrl: candidate.iNaturalistTaxonUrl }
      : {}),
    ...(candidate.iNaturalistObservationId
      ? { iNaturalistObservationId: candidate.iNaturalistObservationId }
      : {}),
    ...(candidate.iNaturalistPhotoId
      ? { iNaturalistPhotoId: candidate.iNaturalistPhotoId }
      : {}),
    filename: `${species.id}.jpg`,
    sourceFilename: `${species.id}-original.${sourceExtension(candidate.contentType)}`,
    sourceContentType: candidate.contentType,
    sourceDownloadUrl: candidate.sourceDownloadUrl,
    originalDownloadUrl: candidate.originalDownloadUrl,
    sourcePageUrl: candidate.sourcePageUrl,
    sourceSha256: '',
    attribution: {
      creator: candidate.creator,
      license: candidate.license,
      licenseUrl: candidate.licenseUrl,
      sourceUrl: candidate.sourcePageUrl,
      modified: modifiedText(candidate.license),
    },
  };
}

function pilotRecord(species, image) {
  return {
    speciesId: species.id,
    category: species.category,
    commonName: species.commonName,
    scientificName: species.scientificName,
    status: 'matched',
    reviewLevel: 'human-reviewed',
    matchMethod: 'manual-reviewed-pilot',
    matchRationale:
      'Preserved from the published five-image pilot after manual botanical and licence review.',
    commonsTitle: decodeURIComponent(
      new URL(image.attribution.sourceUrl).pathname.split('/').at(-1),
    ).replace(/_/g, ' '),
    filename: image.filename,
    sourceFilename: `${species.id}-original.jpg`,
    sourceContentType: 'image/jpeg',
    sourceDownloadUrl: image.sourceDownloadUrl,
    originalDownloadUrl: image.sourceDownloadUrl,
    sourcePageUrl: image.attribution.sourceUrl,
    sourceSha256: image.sourceSha256,
    attribution: image.attribution,
  };
}

function reviewRecord(species, reason, extra = {}) {
  return {
    speciesId: species.id,
    category: species.category,
    commonName: species.commonName,
    scientificName: species.scientificName,
    status: 'review-needed',
    reason,
    researchUrl: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(
      species.scientificName,
    )}&title=Special:MediaSearch&type=image`,
    ...extra,
  };
}

function unresolvedRecord(species, reason) {
  return {
    speciesId: species.id,
    category: species.category,
    commonName: species.commonName,
    scientificName: species.scientificName,
    status: 'unresolved',
    reason,
    researchUrl: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(
      species.scientificName,
    )}&title=Special:MediaSearch&type=image`,
  };
}

async function downloadBytes(url) {
  const response = await fetchWithRetry(url, {}, `Source download ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function pinSelectedSources(records) {
  const matched = records.filter(
    (record) => record.status === 'matched' && record.sourceSha256.length === 0,
  );
  const byUrl = new Map();
  for (const record of matched) {
    const entries = byUrl.get(record.sourceDownloadUrl) ?? [];
    entries.push(record);
    byUrl.set(record.sourceDownloadUrl, entries);
  }
  const jobs = [...byUrl.entries()];
  let completed = 0;
  let nextJob = 0;

  async function worker() {
    while (nextJob < jobs.length) {
      const jobIndex = nextJob;
      nextJob += 1;
      const [url, urlRecords] = jobs[jobIndex];
      const extension = sourceExtension(urlRecords[0].sourceContentType);
      const downloadPath = join(downloadCacheDirectory, `${sha256(Buffer.from(url))}.${extension}`);
      let bytes;
      if (existsSync(downloadPath) && !refresh) {
        bytes = readFileSync(downloadPath);
      } else {
        bytes = await downloadBytes(url);
        writeFileSync(downloadPath, bytes);
        await sleep(DOWNLOAD_DELAY_MS);
      }
      const sourceSha256 = sha256(bytes);
      for (const record of urlRecords) {
        record.sourceSha256 = sourceSha256;
        copyFileSync(downloadPath, join(sourceDirectory, record.sourceFilename));
      }
      completed += 1;
      process.stderr.write(`\rPinned source downloads: ${completed}/${jobs.length}`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, () => worker()),
  );
  if (jobs.length > 0) process.stderr.write('\n');
}

async function queryConcurrently(items, concurrency, description, query) {
  const results = new Map();
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      results.set(item, await query(item));
      completed += 1;
      process.stderr.write(`\r${description}: ${completed}/${items.length}`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  if (items.length > 0) process.stderr.write('\n');
  return results;
}

const uniqueScientificNames = [
  ...new Set(
    catalog.species
      .filter((species) => !pilotById.has(species.id))
      .map((species) => species.scientificName),
  ),
].sort();
const wikidata = await queryWikidata(uniqueScientificNames);
const p18Titles = [];
for (const result of wikidata.values()) {
  for (const imageUrl of result.images) {
    p18Titles.push(commonsFileTitleFromUrl(imageUrl));
  }
}
const commonsFiles = await queryCommonsFiles(p18Titles);
const exactSelections = new Map();

for (const scientificName of uniqueScientificNames) {
  const result = wikidata.get(scientificName);
  if (!result || result.entities.size !== 1 || result.images.size === 0) continue;
  const candidates = [...result.images]
    .map((url) => commonsFiles.get(canonicalTitle(commonsFileTitleFromUrl(url))))
    .filter(Boolean);
  const candidate = selectCandidate(candidates, scientificName);
  if (candidate) {
    exactSelections.set(scientificName, {
      candidate,
      wikidataEntityUrl: [...result.entities][0].replace('http://', 'https://'),
    });
  }
}

const fallbackNames = uniqueScientificNames.filter(
  (scientificName) => !exactSelections.has(scientificName),
);
const categorySelections = new Map();
let nextCategory = 0;
let completedCategories = 0;
async function categoryWorker() {
  while (nextCategory < fallbackNames.length) {
    const index = nextCategory;
    nextCategory += 1;
    const scientificName = fallbackNames[index];
    categorySelections.set(scientificName, await queryCommonsCategory(scientificName));
    completedCategories += 1;
    process.stderr.write(
      `\rCommons exact-category research: ${completedCategories}/${fallbackNames.length}`,
    );
  }
}
await Promise.all(
  Array.from(
    { length: Math.min(CATEGORY_QUERY_CONCURRENCY, fallbackNames.length) },
    () => categoryWorker(),
  ),
);
if (fallbackNames.length > 0) process.stderr.write('\n');

let records = catalog.species.map((species) => {
  const pilotImage = pilotById.get(species.id);
  if (pilotImage) return pilotRecord(species, pilotImage);

  const wikidataResult = wikidata.get(species.scientificName);
  if (wikidataResult?.entities.size > 1) {
    return reviewRecord(
      species,
      'Multiple Wikidata taxon entities use this exact scientific name; botanical identity must be reviewed before selecting an image.',
      {
        candidateWikidataEntityUrls: [...wikidataResult.entities]
          .sort()
          .map((url) => url.replace('http://', 'https://')),
      },
    );
  }

  const exactSelection = exactSelections.get(species.scientificName);
  if (exactSelection) {
    return matchedRecord(species, exactSelection.candidate, {
      reviewLevel: 'automated-exact',
      matchMethod: 'wikidata-exact-taxon-p18',
      matchRationale:
        'The catalog scientificName exactly matches Wikidata taxon name P225; the selected Commons file is a P18 image on that taxon entity.',
      wikidataEntityUrl: exactSelection.wikidataEntityUrl,
    });
  }

  const categorySelection = categorySelections.get(species.scientificName);
  if (categorySelection?.candidate && !categorySelection.redirectTarget) {
    return matchedRecord(species, categorySelection.candidate, {
      reviewLevel: 'automated-exact',
      matchMethod: 'commons-exact-scientific-name-category',
      matchRationale:
        'The selected compatible file is directly classified in the Wikimedia Commons category whose title exactly matches the catalog scientificName.',
      ...(wikidataResult?.entities.size === 1
        ? {
            wikidataEntityUrl: [...wikidataResult.entities][0].replace(
              'http://',
              'https://',
            ),
          }
        : {}),
    });
  }

  if (
    categorySelection?.candidate &&
    categorySelection.redirectTarget &&
    wikidataResult?.entities.size === 1
  ) {
    return matchedRecord(species, categorySelection.candidate, {
      reviewLevel: 'automated-exact',
      matchMethod: 'wikidata-exact-taxon-commons-category-alias',
      matchRationale: `The catalog scientificName exactly matches Wikidata P225. Commons redirects that exact taxon category to "${categorySelection.redirectTarget}", documenting the accepted-name/alias path used for the selected file.`,
      wikidataEntityUrl: [...wikidataResult.entities][0].replace('http://', 'https://'),
      matchedTaxonName: categorySelection.redirectTarget,
    });
  }

  if (categorySelection?.candidate && categorySelection.redirectTarget) {
    return reviewRecord(
      species,
      `Commons redirects the catalog scientific name to "${categorySelection.redirectTarget}", but no unique exact Wikidata P225 taxon confirms that alias. Human botanical review is required.`,
      {
        candidateSourcePageUrl: categorySelection.candidate.sourcePageUrl,
        matchedTaxonName: categorySelection.redirectTarget,
      },
    );
  }

  if (wikidataResult?.entities.size === 1) {
    return unresolvedRecord(
      species,
      'An exact Wikidata taxon exists, but it has no compatible P18 image and its exact Commons category yielded no compatible direct file.',
    );
  }

  return unresolvedRecord(
    species,
    'No unique exact Wikidata P225 taxon image or compatible direct file in an exact Commons scientific-name category was found.',
  );
});

const firstPassById = new Map(records.map((record) => [record.speciesId, record]));
const pendingSpecies = catalog.species.filter(
  (species) => firstPassById.get(species.id)?.status !== 'matched',
);
const pendingNameCandidates = new Map(
  pendingSpecies.map((species) => [
    species.id,
    catalogNameCandidates(species.scientificName),
  ]),
);
const pendingNames = [
  ...new Set(
    [...pendingNameCandidates.values()]
      .flat()
      .map((candidate) => candidate.name),
  ),
].sort();
const gbifMatches = await queryConcurrently(
  pendingNames,
  6,
  'GBIF exact-name research',
  queryGbifName,
);
const commonsSearch = await queryConcurrently(
  pendingNames,
  6,
  'Commons exact metadata research',
  queryCommonsSearch,
);

const resolutionBySpecies = new Map();
for (const species of pendingSpecies) {
  const candidates = pendingNameCandidates.get(species.id) ?? [];
  const resolutions = candidates
    .map((candidate) => ({
      candidate,
      resolution: gbifMatches.get(candidate.name),
    }))
    .filter((entry) => entry.resolution !== null && entry.resolution !== undefined);
  if (resolutions.length > 0) resolutionBySpecies.set(species.id, resolutions);
}

const resolvedTaxonNames = [
  ...new Set(
    [...resolutionBySpecies.values()]
      .flatMap((entries) =>
        entries.flatMap(({ resolution }) => [
          resolution.acceptedCanonicalName,
          resolution.matchedCanonicalName,
        ]),
      )
      .filter((name) => typeof name === 'string' && name.length > 0),
  ),
].sort();
const resolvedWikidata = await queryTaxonOnlyWikidata(resolvedTaxonNames);
const resolvedP18Titles = [];
for (const result of resolvedWikidata.values()) {
  for (const imageUrl of result.images) {
    resolvedP18Titles.push(commonsFileTitleFromUrl(imageUrl));
  }
}
const resolvedCommonsFiles = await queryCommonsFiles(resolvedP18Titles);
const resolvedCategories = await queryConcurrently(
  resolvedTaxonNames,
  CATEGORY_QUERY_CONCURRENCY,
  'Commons resolved-name category research',
  queryCommonsCategory,
);
const resolvedSearch = await queryConcurrently(
  resolvedTaxonNames,
  6,
  'Commons resolved-name metadata research',
  queryCommonsSearch,
);
function confirmedDeclaredSynonym(speciesId, candidate, resolution) {
  if (candidate.relationship !== 'catalog-declared-synonym') return true;
  const resolutions = resolutionBySpecies.get(speciesId) ?? [];
  const primary = resolutions.find(
    (entry) => entry.candidate.relationship === 'catalog-primary-name',
  )?.resolution;
  return (
    primary !== undefined &&
    primary.acceptedUsageKey === resolution.acceptedUsageKey
  );
}

function exactSearchExpansion(species) {
  if (isAmbiguousCatalogTaxonName(species.scientificName)) return null;
  const candidates = pendingNameCandidates.get(species.id) ?? [];
  for (const candidate of candidates) {
    const image = commonsSearch.get(candidate.name);
    if (!image) continue;
    const resolution = gbifMatches.get(candidate.name);
    if (
      candidate.relationship === 'catalog-declared-synonym' &&
      (!resolution || !confirmedDeclaredSynonym(species.id, candidate, resolution))
    ) {
      continue;
    }
    if (
      !image.exactTaxonEvidenceFields.includes('filename') &&
      !resolution &&
      !(
        /[‘’'][^‘’']+[‘’']/.test(candidate.name) &&
        image.exactTaxonEvidenceFields.includes('description')
      )
    ) {
      continue;
    }
    const synonymRationale =
      candidate.relationship === 'catalog-declared-synonym'
        ? ` GBIF confirms that this catalog-declared synonym resolves to accepted taxon "${resolution.acceptedCanonicalName}".`
        : '';
    return matchedRecord(species, image, {
      reviewLevel: 'automated-exact',
      matchMethod: 'commons-exact-scientific-name-metadata',
      matchRationale: `The selected compatible Commons file metadata contains the exact catalog taxon name "${candidate.name}".${synonymRationale}`,
      matchedTaxonName: candidate.name,
      ...(resolution ? { taxonResolution: resolution } : {}),
      searchEvidence: {
        relationship: candidate.relationship,
        matchedName: candidate.name,
        evidenceFields: image.exactTaxonEvidenceFields,
      },
    });
  }
  return null;
}

function gbifExpansion(species) {
  if (
    isAmbiguousCatalogTaxonName(species.scientificName) ||
    hasNonTaxonomicQualifier(species.scientificName)
  ) {
    return null;
  }
  const resolutions = resolutionBySpecies.get(species.id) ?? [];
  for (const { candidate, resolution } of resolutions) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    const resolvedNames = [
      resolution.acceptedCanonicalName,
      resolution.matchedCanonicalName,
    ].filter(
      (name, index, values) =>
        typeof name === 'string' &&
        name.length > 0 &&
        values.indexOf(name) === index,
    );
    for (const resolvedName of resolvedNames) {
      const wikidataResult = resolvedWikidata.get(resolvedName);
      if (wikidataResult?.images.size > 0) {
        const candidates = [...wikidataResult.images]
          .map((url) =>
            resolvedCommonsFiles.get(
              canonicalTitle(commonsFileTitleFromUrl(url)),
            ),
          )
          .filter(Boolean);
        const image = selectCandidate(candidates, resolvedName);
        if (image) {
          return matchedRecord(species, image, {
            reviewLevel: 'automated-exact',
            matchMethod: 'gbif-resolved-wikidata-taxon-p18',
            matchRationale: `GBIF resolves catalog name "${candidate.name}" by exact match to accepted taxon "${resolution.acceptedCanonicalName}". The selected Commons file is a P18 image on a Wikidata taxon whose P225 name exactly matches "${resolvedName}".`,
            matchedTaxonName: resolvedName,
            wikidataEntityUrls: [...wikidataResult.entities]
              .sort()
              .map((url) => url.replace('http://', 'https://')),
            taxonResolution: resolution,
          });
        }
      }

      const category = resolvedCategories.get(resolvedName);
      if (category?.candidate) {
        return matchedRecord(species, category.candidate, {
          reviewLevel: 'automated-exact',
          matchMethod: 'gbif-resolved-commons-taxon-category',
          matchRationale: `GBIF resolves catalog name "${candidate.name}" by exact match to accepted taxon "${resolution.acceptedCanonicalName}". The selected compatible file is directly classified under the Commons taxon category for "${resolvedName}"${category.redirectTarget ? `, redirected to "${category.redirectTarget}"` : ''}.`,
          matchedTaxonName: category.redirectTarget ?? resolvedName,
          taxonResolution: resolution,
        });
      }

      const image = resolvedSearch.get(resolvedName);
      if (image) {
        return matchedRecord(species, image, {
          reviewLevel: 'automated-exact',
          matchMethod: 'gbif-resolved-commons-exact-metadata',
          matchRationale: `GBIF resolves catalog name "${candidate.name}" by exact match to accepted taxon "${resolution.acceptedCanonicalName}". The selected compatible Commons file metadata contains the exact resolved taxon name "${resolvedName}".`,
          matchedTaxonName: resolvedName,
          taxonResolution: resolution,
          searchEvidence: {
            relationship: 'gbif-resolved-name',
            matchedName: resolvedName,
            evidenceFields: image.exactTaxonEvidenceFields,
          },
        });
      }
    }

  }
  return null;
}

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = catalog.species.find((entry) => entry.id === record.speciesId);
  if (!species) return record;
  const expanded = exactSearchExpansion(species) ?? gbifExpansion(species);
  if (expanded) return expanded;
  const resolutions = resolutionBySpecies.get(species.id);
  return resolutions?.length
    ? {
        ...record,
        taxonResolutionCandidates: resolutions.map(
          ({ candidate, resolution }) => ({
            relationship: candidate.relationship,
            ...resolution,
          }),
        ),
      }
    : record;
});

const acceptedResolutions = new Map();
for (const species of pendingSpecies) {
  const record = records.find((entry) => entry.speciesId === species.id);
  if (record?.status === 'matched') continue;
  for (const { candidate, resolution } of resolutionBySpecies.get(species.id) ?? []) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    acceptedResolutions.set(resolution.acceptedUsageKey, resolution);
  }
}
const gbifSynonymLists = await queryConcurrently(
  [...acceptedResolutions.keys()].sort((left, right) => left - right),
  6,
  'GBIF accepted-synonym research',
  queryGbifSynonyms,
);
const gbifSynonymsBySpecies = new Map();
for (const species of pendingSpecies) {
  const record = records.find((entry) => entry.speciesId === species.id);
  if (record?.status === 'matched') continue;
  const synonyms = [];
  for (const { candidate, resolution } of resolutionBySpecies.get(species.id) ?? []) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    for (const synonym of gbifSynonymLists.get(resolution.acceptedUsageKey) ?? []) {
      synonyms.push({
        synonym,
        catalogCandidate: candidate,
        taxonResolution: resolution,
      });
    }
  }
  const seen = new Set();
  gbifSynonymsBySpecies.set(
    species.id,
    synonyms.filter(({ synonym }) => {
      const key = normalizeTaxonIdentity(synonym.synonymCanonicalName);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
const gbifSynonymNames = [
  ...new Set(
    [...gbifSynonymsBySpecies.values()]
      .flat()
      .map(({ synonym }) => synonym.synonymCanonicalName),
  ),
].sort();
const gbifSynonymWikidata = await queryTaxonOnlyWikidata(gbifSynonymNames);
const gbifSynonymP18Titles = [];
for (const result of gbifSynonymWikidata.values()) {
  for (const imageUrl of result.images) {
    gbifSynonymP18Titles.push(commonsFileTitleFromUrl(imageUrl));
  }
}
const gbifSynonymCommonsFiles = await queryCommonsFiles(gbifSynonymP18Titles);
const gbifSynonymCategories = await queryConcurrently(
  gbifSynonymNames,
  CATEGORY_QUERY_CONCURRENCY,
  'Commons GBIF-synonym category research',
  queryCommonsCategory,
);
const gbifSynonymSearch = await queryConcurrently(
  gbifSynonymNames,
  6,
  'Commons GBIF-synonym metadata research',
  queryCommonsSearch,
);

function gbifSynonymExpansion(species) {
  for (const {
    synonym,
    catalogCandidate,
    taxonResolution,
  } of gbifSynonymsBySpecies.get(species.id) ?? []) {
    const synonymName = synonym.synonymCanonicalName;
    const wikidataResult = gbifSynonymWikidata.get(synonymName);
    if (wikidataResult?.images.size > 0) {
      const candidates = [...wikidataResult.images]
        .map((url) =>
          gbifSynonymCommonsFiles.get(
            canonicalTitle(commonsFileTitleFromUrl(url)),
          ),
        )
        .filter(Boolean);
      const image = selectCandidate(candidates, synonymName);
      if (image) {
        return matchedRecord(species, image, {
          reviewLevel: 'automated-exact',
          matchMethod: 'gbif-synonym-wikidata-taxon-p18',
          matchRationale: `GBIF records "${synonymName}" as a scientific synonym of accepted taxon "${taxonResolution.acceptedCanonicalName}", which exactly resolves the catalog name "${catalogCandidate.name}". The selected Commons file is a P18 image on a Wikidata taxon whose P225 name exactly matches that synonym.`,
          matchedTaxonName: synonymName,
          wikidataEntityUrls: [...wikidataResult.entities]
            .sort()
            .map((url) => url.replace('http://', 'https://')),
          taxonResolution,
          gbifSynonymEvidence: synonym,
        });
      }
    }

    const category = gbifSynonymCategories.get(synonymName);
    if (
      category?.candidate &&
      (!category.redirectTarget ||
        [
          synonymName,
          taxonResolution.acceptedCanonicalName,
          taxonResolution.matchedCanonicalName,
        ].some(
          (name) =>
            normalizeTaxonIdentity(name) ===
            normalizeTaxonIdentity(category.redirectTarget),
        ))
    ) {
      return matchedRecord(species, category.candidate, {
        reviewLevel: 'automated-exact',
        matchMethod: 'gbif-synonym-commons-taxon-category',
        matchRationale: `GBIF records "${synonymName}" as a scientific synonym of accepted taxon "${taxonResolution.acceptedCanonicalName}", which exactly resolves the catalog name "${catalogCandidate.name}". The selected compatible file is directly classified under the Commons taxon category for that synonym.`,
        matchedTaxonName: category.redirectTarget ?? synonymName,
        taxonResolution,
        gbifSynonymEvidence: synonym,
      });
    }

    const image = gbifSynonymSearch.get(synonymName);
    if (image) {
      return matchedRecord(species, image, {
        reviewLevel: 'automated-exact',
        matchMethod: 'gbif-synonym-commons-exact-metadata',
        matchRationale: `GBIF records "${synonymName}" as a scientific synonym of accepted taxon "${taxonResolution.acceptedCanonicalName}", which exactly resolves the catalog name "${catalogCandidate.name}". The selected compatible Commons file metadata contains that exact synonym.`,
        matchedTaxonName: synonymName,
        taxonResolution,
        gbifSynonymEvidence: synonym,
        searchEvidence: {
          relationship: 'gbif-synonym',
          matchedName: synonymName,
          evidenceFields: image.exactTaxonEvidenceFields,
        },
      });
    }
  }
  return null;
}

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = pendingSpecies.find((entry) => entry.id === record.speciesId);
  return species ? gbifSynonymExpansion(species) ?? record : record;
});

const pendingCultivarNames = [
  ...new Set(
    pendingSpecies
      .filter((species) => {
        const record = records.find((entry) => entry.speciesId === species.id);
        return record?.status !== 'matched' && cultivarNameParts(species.scientificName);
      })
      .map((species) => species.scientificName),
  ),
].sort();
const commonsCultivarImages = await queryConcurrently(
  pendingCultivarNames,
  6,
  'Commons exact-cultivar research',
  queryCommonsCultivarSearch,
);

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = pendingSpecies.find((entry) => entry.id === record.speciesId);
  if (!species) return record;
  const parts = cultivarNameParts(species.scientificName);
  const image = commonsCultivarImages.get(species.scientificName);
  if (!parts || !image) return record;
  return matchedRecord(species, image, {
    reviewLevel: 'automated-exact',
    matchMethod: 'commons-exact-cultivar-metadata',
    matchRationale: `The selected compatible Commons filename contains every substantive token of botanical name "${parts.botanicalName}" and exact cultivar epithet "${parts.cultivarName}". Apostrophe and possessive punctuation differences are normalized, but no botanical or cultivar words are substituted.`,
    matchedTaxonName: species.scientificName,
    searchEvidence: {
      relationship: 'catalog-cultivar-name',
      matchedName: parts.cultivarName,
      evidenceFields: image.exactTaxonEvidenceFields,
    },
  });
});

const tokenSearchNamesBySpecies = new Map();
for (const species of pendingSpecies) {
  const record = records.find((entry) => entry.speciesId === species.id);
  if (record?.status === 'matched') continue;
  tokenSearchNamesBySpecies.set(
    species.id,
    (pendingNameCandidates.get(species.id) ?? []).filter(
      (candidate) =>
        taxonFilenameTokens(candidate.name).length >= 2 &&
        !isAmbiguousCatalogTaxonName(candidate.name) &&
        !/[‘’'"]/.test(candidate.name),
    ),
  );
}
const tokenSearchNames = [
  ...new Set(
    [...tokenSearchNamesBySpecies.values()]
      .flat()
      .map((candidate) => candidate.name),
  ),
].sort();
const commonsFilenameTokenImages = await queryConcurrently(
  tokenSearchNames,
  6,
  'Commons tokenized-filename research',
  queryCommonsFilenameTokenSearch,
);

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = pendingSpecies.find((entry) => entry.id === record.speciesId);
  if (!species) return record;
  for (const candidate of tokenSearchNamesBySpecies.get(species.id) ?? []) {
    const image = commonsFilenameTokenImages.get(candidate.name);
    if (!image) continue;
    const resolution = gbifMatches.get(candidate.name);
    if (
      candidate.relationship === 'catalog-declared-synonym' &&
      (!resolution || !confirmedDeclaredSynonym(species.id, candidate, resolution))
    ) {
      continue;
    }
    return matchedRecord(species, image, {
      reviewLevel: 'automated-exact',
      matchMethod: 'commons-tokenized-exact-scientific-name-filename',
      matchRationale: `The selected compatible Commons filename contains every substantive token of catalog scientific name "${candidate.name}"; punctuation, rank markers, and token order are ignored, but no taxon-name words are substituted.`,
      matchedTaxonName: candidate.name,
      ...(resolution ? { taxonResolution: resolution } : {}),
      searchEvidence: {
        relationship: candidate.relationship,
        matchedName: candidate.name,
        evidenceFields: ['filename'],
      },
    });
  }
  return record;
});

const catalogById = new Map(catalog.species.map((species) => [species.id, species]));
const activeTaxonNameOverrides = taxonNameOverrides.overrides.filter((override) => {
  const species = catalogById.get(override.speciesId);
  if (!species || species.scientificName !== override.catalogScientificName) {
    throw new Error(
      `Taxon-name override ${override.speciesId} does not match the canonical catalog.`,
    );
  }
  return (
    records.find((record) => record.speciesId === override.speciesId)?.status !==
    'matched'
  );
});
const overrideNames = [
  ...new Set(activeTaxonNameOverrides.map((override) => override.researchName)),
].sort();
const overrideWikidata = await queryTaxonOnlyWikidata(overrideNames);
const overrideP18Titles = [];
for (const result of overrideWikidata.values()) {
  for (const imageUrl of result.images) {
    overrideP18Titles.push(commonsFileTitleFromUrl(imageUrl));
  }
}
const overrideCommonsFiles = await queryCommonsFiles(overrideP18Titles);
const overrideCategories = await queryConcurrently(
  overrideNames,
  CATEGORY_QUERY_CONCURRENCY,
  'Commons reviewed-name category research',
  queryCommonsCategory,
);
const overrideSearch = await queryConcurrently(
  overrideNames,
  6,
  'Commons reviewed-name metadata research',
  queryCommonsSearch,
);
const overrideFilenameSearch = await queryConcurrently(
  overrideNames,
  6,
  'Commons reviewed-name filename research',
  queryCommonsFilenameTokenSearch,
);

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const override = activeTaxonNameOverrides.find(
    (entry) => entry.speciesId === record.speciesId,
  );
  const species = catalogById.get(record.speciesId);
  if (!override || !species) return record;
  let image = null;
  const wikidataResult = overrideWikidata.get(override.researchName);
  if (wikidataResult?.images.size > 0) {
    image = selectCandidate(
      [...wikidataResult.images]
        .map((url) =>
          overrideCommonsFiles.get(canonicalTitle(commonsFileTitleFromUrl(url))),
        )
        .filter(Boolean),
      override.researchName,
    );
  }
  if (!image) {
    const category = overrideCategories.get(override.researchName);
    if (
      category?.candidate &&
      (!category.redirectTarget ||
        normalizeTaxonIdentity(category.redirectTarget) ===
          normalizeTaxonIdentity(override.acceptedName))
    ) {
      image = category.candidate;
    }
  }
  image ??= overrideSearch.get(override.researchName);
  image ??= overrideFilenameSearch.get(override.researchName);
  if (!image) {
    return {
      ...record,
      taxonNameOverrideCandidate: override,
    };
  }
  return matchedRecord(species, image, {
    reviewLevel: 'human-reviewed',
    matchMethod: 'reviewed-taxon-name-override',
    matchRationale: `${override.rationale} The selected compatible Commons source identifies "${override.researchName}" exactly.`,
    matchedTaxonName: override.researchName,
    taxonNameOverride: override,
  });
});

const deepCategoryNamesBySpecies = new Map();
for (const species of pendingSpecies) {
  const record = records.find((entry) => entry.speciesId === species.id);
  if (record?.status === 'matched' || isAmbiguousCatalogTaxonName(species.scientificName)) {
    continue;
  }
  const names = [];
  for (const candidate of pendingNameCandidates.get(species.id) ?? []) {
    const wikidataResult = wikidata.get(candidate.name);
    const resolution = gbifMatches.get(candidate.name);
    const category = categorySelections.get(candidate.name);
    if (
      (!category?.redirectTarget &&
        (wikidataResult?.entities.size === 1 ||
          (resolution &&
            confirmedDeclaredSynonym(species.id, candidate, resolution))))
    ) {
      names.push({
        name: candidate.name,
        relationship: candidate.relationship,
        wikidataResult,
        taxonResolution: resolution ?? null,
      });
    }
  }
  for (const { candidate, resolution } of resolutionBySpecies.get(species.id) ?? []) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    const category = resolvedCategories.get(resolution.acceptedCanonicalName);
    if (category?.redirectTarget) continue;
    names.push({
      name: resolution.acceptedCanonicalName,
      relationship: 'gbif-accepted-name',
      wikidataResult: resolvedWikidata.get(resolution.acceptedCanonicalName),
      taxonResolution: resolution,
    });
  }
  const seen = new Set();
  deepCategoryNamesBySpecies.set(
    species.id,
    names.filter((entry) => {
      const key = normalizeTaxonIdentity(entry.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
const deepCategoryNames = [
  ...new Set(
    [...deepCategoryNamesBySpecies.values()]
      .flat()
      .map((entry) => entry.name),
  ),
].sort();
const deepCategoryImages = await queryConcurrently(
  deepCategoryNames,
  5,
  'Commons recursive taxon-category research',
  queryCommonsDeepCategory,
);

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = pendingSpecies.find((entry) => entry.id === record.speciesId);
  if (!species) return record;
  for (const name of deepCategoryNamesBySpecies.get(species.id) ?? []) {
    const image = deepCategoryImages.get(name.name);
    if (!image) continue;
    const wikidataEntityUrls = name.wikidataResult
      ? [...name.wikidataResult.entities]
          .sort()
          .map((url) => url.replace('http://', 'https://'))
      : undefined;
    return matchedRecord(species, image, {
      reviewLevel: 'automated-exact',
      matchMethod: name.taxonResolution
        ? 'gbif-resolved-commons-deep-taxon-category'
        : 'wikidata-exact-taxon-commons-deep-category',
      matchRationale: name.taxonResolution
        ? `GBIF resolves the catalog scientific name by exact match to accepted taxon "${name.name}". The selected compatible Commons file is classified within the recursive taxon category for that exact resolved name.`
        : `The catalog scientific name has one exact Wikidata taxon entity, and the selected compatible Commons file is classified within the recursive Commons taxon category for exact name "${name.name}".`,
      matchedTaxonName: name.name,
      ...(wikidataEntityUrls?.length
        ? { wikidataEntityUrls }
        : {}),
      ...(name.taxonResolution
        ? { taxonResolution: name.taxonResolution }
        : {}),
    });
  }
  return record;
});

const stillPendingSpecies = catalog.species.filter(
  (species) =>
    records.find((record) => record.speciesId === species.id)?.status !== 'matched' &&
    isEligibleForObservationResearch(species.scientificName),
);
const observationNamesBySpecies = new Map();
for (const species of stillPendingSpecies) {
  const names = [];
  for (const candidate of pendingNameCandidates.get(species.id) ?? []) {
    if (
      !candidate.relationship.includes('hybrid-sign-variant') &&
      !candidate.relationship.includes('hybrid-letter-variant')
    ) {
      names.push({
        name: candidate.name,
        relationship: candidate.relationship,
        taxonResolution: gbifMatches.get(candidate.name) ?? null,
      });
    }
  }
  for (const { candidate, resolution } of resolutionBySpecies.get(species.id) ?? []) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    names.push({
      name: resolution.acceptedCanonicalName,
      relationship: 'gbif-accepted-name',
      taxonResolution: resolution,
    });
  }
  for (const { synonym, taxonResolution } of gbifSynonymsBySpecies.get(
    species.id,
  ) ?? []) {
    names.push({
      name: synonym.synonymCanonicalName,
      relationship: 'gbif-synonym',
      taxonResolution,
      gbifSynonymEvidence: synonym,
    });
  }
  const seen = new Set();
  observationNamesBySpecies.set(
    species.id,
    names.filter((entry) => {
      const key = normalizeTaxonIdentity(entry.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
const observationNames = [
  ...new Set(
    [...observationNamesBySpecies.values()]
      .flat()
      .map((entry) => entry.name),
  ),
].sort();
const iNaturalistTaxa = await queryConcurrently(
  observationNames,
  6,
  'iNaturalist exact-taxon research',
  queryINaturalistTaxon,
);
const uniqueINaturalistTaxa = [
  ...new Map(
    [...iNaturalistTaxa.values()]
      .filter((taxon) => taxon !== null)
      .map((taxon) => [taxon.id, taxon]),
  ).values(),
];
const iNaturalistObservations = await queryConcurrently(
  uniqueINaturalistTaxa,
  4,
  'iNaturalist licensed observation research',
  async (taxon) => queryINaturalistObservation(taxon),
);

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = stillPendingSpecies.find((entry) => entry.id === record.speciesId);
  if (!species) return record;
  for (const name of observationNamesBySpecies.get(species.id) ?? []) {
    const taxon = iNaturalistTaxa.get(name.name);
    if (!taxon) continue;
    const image = iNaturalistObservations.get(taxon);
    if (!image) continue;
    return matchedRecord(species, image, {
      reviewLevel: 'automated-exact',
      matchMethod: 'inaturalist-exact-research-grade-observation',
      matchRationale:
        name.relationship === 'gbif-accepted-name'
          ? `GBIF resolves the catalog scientific name by exact match to accepted taxon "${name.name}". iNaturalist has one active taxon with that exact name; the selected compatible-licence photo belongs to a research-grade observation of that taxon.`
          : name.relationship === 'gbif-synonym'
            ? `GBIF records "${name.name}" as a scientific synonym of the exact accepted catalog taxon. iNaturalist has one active taxon with that exact synonym; the selected compatible-licence photo belongs to a research-grade observation of that taxon.`
          : `iNaturalist has one active taxon whose name exactly matches catalog taxon name "${name.name}". The selected compatible-licence photo belongs to a research-grade observation of that taxon.`,
      matchedTaxonName: name.name,
      ...(name.taxonResolution
        ? { taxonResolution: name.taxonResolution }
        : {}),
      ...(name.gbifSynonymEvidence
        ? { gbifSynonymEvidence: name.gbifSynonymEvidence }
        : {}),
    });
  }
  return record;
});

const gbifOccurrenceResolutions = new Map();
for (const species of pendingSpecies) {
  const record = records.find((entry) => entry.speciesId === species.id);
  if (record?.status === 'matched') continue;
  for (const { candidate, resolution } of resolutionBySpecies.get(species.id) ?? []) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    gbifOccurrenceResolutions.set(resolution.acceptedUsageKey, resolution);
  }
}
const gbifOccurrenceImages = await queryConcurrently(
  [...gbifOccurrenceResolutions.keys()].sort((left, right) => left - right),
  4,
  'GBIF licensed occurrence-media research',
  async (acceptedUsageKey) =>
    queryGbifOccurrenceImage(gbifOccurrenceResolutions.get(acceptedUsageKey)),
);

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const species = pendingSpecies.find((entry) => entry.id === record.speciesId);
  if (!species) return record;
  for (const { candidate, resolution } of resolutionBySpecies.get(species.id) ?? []) {
    if (!confirmedDeclaredSynonym(species.id, candidate, resolution)) continue;
    const image = gbifOccurrenceImages.get(resolution.acceptedUsageKey);
    if (!image) continue;
    const context =
      image.gbifOccurrenceEvidence.basisOfRecord === 'HUMAN_OBSERVATION'
        ? 'a field observation'
        : image.gbifOccurrenceEvidence.basisOfRecord === 'LIVING_SPECIMEN'
          ? 'a living collection specimen'
          : 'a preserved herbarium specimen';
    return matchedRecord(species, image, {
      reviewLevel: 'automated-exact',
      matchMethod: 'gbif-exact-taxon-licensed-occurrence-media',
      matchRationale: `GBIF resolves catalog name "${candidate.name}" by exact match to accepted taxon "${resolution.acceptedCanonicalName}". The selected compatible-licence image documents ${context} assigned to that exact accepted taxon in a GBIF occurrence record.`,
      matchedTaxonName: resolution.acceptedCanonicalName,
      taxonResolution: resolution,
    });
  }
  return record;
});

records = records.map((record) => {
  if (record.status === 'matched') return record;
  const strategies = [
    'exact Wikidata P225/P18',
    'direct and recursive Wikimedia Commons taxon categories',
    'exact and tokenized Commons metadata/filename search',
    'GBIF exact-name and accepted-synonym resolution',
    'licensed iNaturalist research-grade observations',
    'licensed GBIF occurrence media',
  ];
  if (record.taxonNameOverrideCandidate) {
    return {
      ...record,
      status: 'unresolved',
      reason: `A human-reviewed taxon-name correction to "${record.taxonNameOverrideCandidate.researchName}" is documented, but no exact compatible-licence image was found through the researched sources.`,
      researchStrategies: strategies,
    };
  }
  if (isAmbiguousCatalogTaxonName(record.scientificName)) {
    return {
      ...record,
      status: 'unresolved',
      reason:
        'The catalog scientificName describes a broad genus, hybrid collection, or horticultural group rather than one exact taxon. A representative species or cultivar cannot be substituted automatically.',
      researchStrategies: strategies,
    };
  }
  if (
    cultivarNameParts(record.scientificName) ||
    /^[×x]?[A-Z][a-z-]+\s+[A-Z]/.test(record.scientificName)
  ) {
    return {
      ...record,
      status: 'unresolved',
      reason:
        'No compatible-licence source was found whose filename or authoritative taxon metadata identifies this exact cultivar, grex, or horticultural hybrid. Species-level substitutes were rejected.',
      researchStrategies: strategies,
    };
  }
  if (record.taxonResolutionCandidates?.length) {
    return {
      ...record,
      status: 'unresolved',
      reason:
        'The catalog name has an exact accepted GBIF taxon resolution, but no exact compatible-licence image was found in Wikimedia Commons, licensed iNaturalist research-grade observations, or licensed GBIF occurrence media.',
      researchStrategies: strategies,
    };
  }
  return {
    ...record,
    status: record.status === 'review-needed' ? 'review-needed' : 'unresolved',
    reason:
      record.status === 'review-needed'
        ? record.reason
        : 'No unambiguous compatible-licence image and no authoritative exact taxon or synonym resolution were found. Fuzzy, common-name-only, and visually similar candidates were rejected.',
    researchStrategies: strategies,
  };
});

if (!skipDownloads) {
  await pinSelectedSources(records);
} else {
  for (const record of records) {
    if (record.status !== 'matched' || record.sourceSha256.length > 0) continue;
    const previous = previousById.get(record.speciesId);
    if (
      previous?.status === 'matched' &&
      previous.sourceDownloadUrl === record.sourceDownloadUrl &&
      /^[a-f0-9]{64}$/.test(previous.sourceSha256)
    ) {
      record.sourceSha256 = previous.sourceSha256;
    }
  }
}

const manifest = {
  researchVersion: 2,
  researchDate,
  packVersion: researchDate,
  catalogSha256: catalog.catalogSha256,
  catalogSpeciesCount: catalog.speciesCount,
  methodology: {
    primary:
      'Exact catalog scientificName to Wikidata taxon name (P225), then a Commons P18 image.',
    fallback:
      'A compatible direct file in an exact Commons scientific-name category; category redirects require exact Wikidata confirmation or human review.',
    expandedResearch:
      'Pending records are searched by exact scientific-name metadata. GBIF Backbone Taxonomy exact matches may resolve catalog names or declared synonyms to accepted names, which are then required to match Wikidata P225, a Commons taxon category, or exact Commons file metadata.',
    additionalSources:
      'Remaining exact GBIF taxon matches may use compatible-licence GBIF occurrence media, preferring human observations over living or preserved specimens and retaining occurrence, dataset, taxon, and media-licence evidence.',
    nameNormalization:
      'GBIF-listed scientific synonyms, punctuation-insensitive exact filenames, and a small committed set of human-reviewed orthographic/nomenclatural corrections may be used only with explicit evidence. Exact cultivar matching requires every botanical and cultivar-name token in the Commons filename.',
    automatedReviewBoundary:
      'Common-name-only results, fuzzy taxon matches, unconfirmed synonyms, and ambiguous substitutions are never released automatically.',
    acceptedLicenses: ['Public domain', 'CC0', 'CC BY', 'CC BY-SA'],
  },
  records,
};

if (!skipDownloads) {
  const unpinned = records.filter(
    (record) =>
      record.status === 'matched' && !/^[a-f0-9]{64}$/.test(record.sourceSha256),
  );
  if (unpinned.length > 0) {
    throw new Error(`${unpinned.length} matched records have no pinned source SHA-256.`);
  }
}

writeJson(researchPath, manifest);
const counts = records.reduce((result, record) => {
  result[record.status] = (result[record.status] ?? 0) + 1;
  return result;
}, {});
console.log(
  `Wrote ${researchPath}: ${JSON.stringify(counts)}; catalog ${canonicalJsonSha256(
    catalog.species,
  )}.`,
);
