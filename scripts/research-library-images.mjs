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
const USER_AGENT =
  'AussiePlantPacksResearch/1.0 (https://github.com/Studio-Tansy/aussie-plant-packs)';
const WIKIDATA_BATCH_SIZE = 80;
const COMMONS_BATCH_SIZE = 40;
const CATEGORY_QUERY_CONCURRENCY = 3;
const DOWNLOAD_CONCURRENCY = 3;
const RETRY_ATTEMPTS = 5;
const API_DELAY_MS = 150;
const DOWNLOAD_DELAY_MS = 100;
const SUPPORTED_SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UNDESIRABLE_IMAGE_WORDS =
  /\b(map|range|distribution|herbarium|specimen|drawing|illustration|diagram|icon|logo|stamp|coin|flag|symbol|plate)\b/i;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const packDirectory = join(repositoryDirectory, 'library-images');
const cacheDirectory = join(packDirectory, 'cache');
const apiCacheDirectory = join(cacheDirectory, 'api');
const downloadCacheDirectory = join(cacheDirectory, 'downloads');
const sourceDirectory = join(packDirectory, 'source');
const catalogPath = join(packDirectory, 'catalog.json');
const pilotPath = join(packDirectory, 'sources.json');
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
  if (haystack.includes(normalizedName)) score += 200;
  if (canonicalTitle(candidate.commonsTitle).includes(normalizedName)) score += 100;
  if (UNDESIRABLE_IMAGE_WORDS.test(candidate.commonsTitle)) score -= 1000;
  return score;
}

function selectCandidate(candidates, scientificName) {
  return candidates
    .filter(Boolean)
    .sort((left, right) => {
      const scoreDifference =
        candidateScore(right, scientificName) - candidateScore(left, scientificName);
      return scoreDifference || left.commonsTitle.localeCompare(right.commonsTitle);
    })[0] ?? null;
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
      iiurlwidth: '1600',
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
    iiurlwidth: '1600',
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
    commonsTitle: candidate.commonsTitle,
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

const records = catalog.species.map((species) => {
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
  researchVersion: 1,
  researchDate,
  packVersion: researchDate,
  catalogSha256: catalog.catalogSha256,
  catalogSpeciesCount: catalog.speciesCount,
  methodology: {
    primary:
      'Exact catalog scientificName to Wikidata taxon name (P225), then a Commons P18 image.',
    fallback:
      'A compatible direct file in an exact Commons scientific-name category; category redirects require exact Wikidata confirmation or human review.',
    automatedReviewBoundary:
      'Common-name-only results, ambiguous Wikidata entities, and unconfirmed category redirects are never released automatically.',
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
