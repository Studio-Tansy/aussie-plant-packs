import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_ARCHIVE_ENTRIES,
  MAX_EXPANDED_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_MANIFEST_BYTES,
  MAX_PACK_BYTES,
  MAX_PACK_IMAGES,
  canonicalJsonSha256,
  isHttpsUrl,
  isRedistributableLicense,
  jpegDimensions,
  parseCliArguments,
  readJson,
  sha256,
} from './library-image-common.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const packDirectory = join(repositoryDirectory, 'library-images');
const catalog = readJson(join(packDirectory, 'catalog.json'));
const research = readJson(join(packDirectory, 'research-manifest.json'));
const pilot = readJson(join(packDirectory, 'sources.json'));
const taxonNameOverrides = readJson(
  join(packDirectory, 'taxon-name-overrides.json'),
);
const researchSha256 = canonicalJsonSha256(research);
const researchById = new Map(
  research.records.map((record) => [record.speciesId, record]),
);
const options = parseCliArguments(process.argv.slice(2));
const researchOnly = options.has('research-only');
const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function validateResearch() {
  assert(catalog.catalogVersion === 1, 'catalogVersion must be 1.');
  assert(catalog.speciesCount === catalog.species.length, 'Catalog count does not match species.');
  assert(
    catalog.catalogSha256 === canonicalJsonSha256(catalog.species),
    'Catalog SHA-256 does not match its species snapshot.',
  );
  assert(research.researchVersion === 2, 'researchVersion must be 2.');
  assert(
    research.catalogSha256 === catalog.catalogSha256,
    'Research manifest targets a different catalog SHA-256.',
  );
  assert(
    research.catalogSpeciesCount === catalog.speciesCount,
    'Research catalog count does not match the catalog.',
  );
  assert(
    research.records.length === catalog.species.length,
    'Research record count does not match the catalog.',
  );

  const catalogById = new Map(catalog.species.map((species) => [species.id, species]));
  assert(taxonNameOverrides.version === 1, 'Taxon-name override version must be 1.');
  const overridesById = new Map();
  for (const override of taxonNameOverrides.overrides ?? []) {
    const label = `taxon-name override ${override.speciesId}`;
    assert(!overridesById.has(override.speciesId), `${label} is duplicated.`);
    overridesById.set(override.speciesId, override);
    assert(
      catalogById.get(override.speciesId)?.scientificName ===
        override.catalogScientificName,
      `${label} does not match the canonical catalog.`,
    );
    assert(
      Number.isInteger(override.usageKey) &&
        Number.isInteger(override.acceptedUsageKey) &&
        isHttpsUrl(override.usageUrl) &&
        isHttpsUrl(override.acceptedUsageUrl),
      `${label} has invalid authority evidence.`,
    );
    assert(
      typeof override.rationale === 'string' && override.rationale.length > 0,
      `${label} has no review rationale.`,
    );
  }
  const seenIds = new Set();
  for (const record of research.records) {
    const label = `research record ${record.speciesId}`;
    assert(!seenIds.has(record.speciesId), `${label} is duplicated.`);
    seenIds.add(record.speciesId);
    const species = catalogById.get(record.speciesId);
    assert(Boolean(species), `${label} is not in the canonical catalog.`);
    if (species) {
      assert(record.category === species.category, `${label} category does not match.`);
      assert(record.commonName === species.commonName, `${label} commonName does not match.`);
      assert(
        record.scientificName === species.scientificName,
        `${label} scientificName does not match.`,
      );
    }
    assert(
      ['matched', 'review-needed', 'unresolved'].includes(record.status),
      `${label} has an invalid status.`,
    );
    if (record.status !== 'matched') {
      assert(
        typeof record.reason === 'string' && record.reason.length > 0,
        `${label} must explain why it is not matched.`,
      );
      continue;
    }
    assert(
      ['human-reviewed', 'automated-exact'].includes(record.reviewLevel),
      `${label} has an invalid reviewLevel.`,
    );
    assert(
      typeof record.matchRationale === 'string' && record.matchRationale.length > 0,
      `${label} has no matching rationale.`,
    );
    assert(
      record.filename === `${record.speciesId}.jpg`,
      `${label} filename is not the stable canonical species ID.`,
    );
    assert(/^[a-f0-9]{64}$/.test(record.sourceSha256), `${label} has no source SHA-256.`);
    assert(isHttpsUrl(record.sourceDownloadUrl), `${label} has an invalid source download URL.`);
    assert(isHttpsUrl(record.sourcePageUrl), `${label} has an invalid source page URL.`);
    assert(
      record.attribution?.sourceUrl === record.sourcePageUrl,
      `${label} attribution source does not match its source page.`,
    );
    assert(
      typeof record.attribution?.creator === 'string' &&
        record.attribution.creator.length > 0 &&
        record.attribution.creator.length <= 200,
      `${label} creator is invalid.`,
    );
    assert(
      isRedistributableLicense(
        record.attribution?.license,
        record.attribution?.licenseUrl,
      ),
      `${label} licence is not in the approved redistribution allowlist.`,
    );
    if (record.taxonResolution !== undefined) {
      assert(
        record.taxonResolution.authority === 'GBIF Backbone Taxonomy',
        `${label} has an unsupported taxon-resolution authority.`,
      );
      assert(
        ['EXACT', 'EXACT_SEARCH'].includes(record.taxonResolution.matchType) &&
          Number.isInteger(record.taxonResolution.confidence) &&
          record.taxonResolution.confidence >= 95,
        `${label} taxon resolution is not an exact high-confidence match.`,
      );
      assert(
        isHttpsUrl(record.taxonResolution.usageUrl) &&
          isHttpsUrl(record.taxonResolution.acceptedUsageUrl),
        `${label} taxon-resolution evidence URLs are invalid.`,
      );
    }
    if (record.gbifOccurrenceEvidence !== undefined) {
      assert(
        record.matchMethod === 'gbif-exact-taxon-licensed-occurrence-media',
        `${label} has GBIF occurrence evidence for an unsupported match method.`,
      );
      assert(
        Number.isInteger(record.gbifOccurrenceEvidence.occurrenceKey) &&
          isHttpsUrl(record.gbifOccurrenceEvidence.occurrenceUrl),
        `${label} GBIF occurrence evidence is invalid.`,
      );
      assert(
        ['HUMAN_OBSERVATION', 'LIVING_SPECIMEN', 'PRESERVED_SPECIMEN'].includes(
          record.gbifOccurrenceEvidence.basisOfRecord,
        ),
        `${label} GBIF occurrence basis is unsupported.`,
      );
      assert(
        [
          record.gbifOccurrenceEvidence.taxonKey,
          record.gbifOccurrenceEvidence.acceptedTaxonKey,
          record.gbifOccurrenceEvidence.speciesKey,
        ].includes(record.taxonResolution?.acceptedUsageKey),
        `${label} GBIF occurrence taxon does not match its accepted resolution.`,
      );
      assert(
        typeof record.gbifOccurrenceEvidence.mediaLicenseEvidence === 'string' &&
          record.gbifOccurrenceEvidence.mediaLicenseEvidence.length > 0,
        `${label} GBIF occurrence licence evidence is missing.`,
      );
    }
    if (record.gbifSynonymEvidence !== undefined) {
      assert(
        record.gbifSynonymEvidence.authority === 'GBIF Backbone Taxonomy' &&
          Number.isInteger(record.gbifSynonymEvidence.synonymUsageKey) &&
          Number.isInteger(record.gbifSynonymEvidence.acceptedUsageKey),
        `${label} GBIF synonym evidence is invalid.`,
      );
      assert(
        record.gbifSynonymEvidence.acceptedUsageKey ===
          record.taxonResolution?.acceptedUsageKey,
        `${label} GBIF synonym does not resolve to its accepted taxon.`,
      );
      assert(
        isHttpsUrl(record.gbifSynonymEvidence.synonymUsageUrl) &&
          isHttpsUrl(record.gbifSynonymEvidence.acceptedUsageUrl),
        `${label} GBIF synonym evidence URLs are invalid.`,
      );
      assert(
        typeof record.gbifSynonymEvidence.synonymCanonicalName === 'string' &&
          record.gbifSynonymEvidence.synonymCanonicalName.length > 0,
        `${label} GBIF synonym name is missing.`,
      );
    }
    if (record.taxonNameOverride !== undefined) {
      assert(
        record.reviewLevel === 'human-reviewed' &&
          record.matchMethod === 'reviewed-taxon-name-override',
        `${label} taxon-name override was not marked human-reviewed.`,
      );
      assert(
        JSON.stringify(record.taxonNameOverride) ===
          JSON.stringify(overridesById.get(record.speciesId)),
        `${label} taxon-name override does not match the reviewed manifest.`,
      );
    }
  }
  for (const species of catalog.species) {
    assert(seenIds.has(species.id), `Canonical species ${species.id} has no research record.`);
  }

  for (const image of pilot.images) {
    const record = researchById.get(image.speciesId);
    assert(record?.status === 'matched', `Pilot species ${image.speciesId} is not matched.`);
    assert(
      record?.sourceDownloadUrl === image.sourceDownloadUrl,
      `Pilot species ${image.speciesId} source URL changed.`,
    );
    assert(
      record?.sourceSha256 === image.sourceSha256,
      `Pilot species ${image.speciesId} source SHA-256 changed.`,
    );
    assert(
      JSON.stringify(record?.attribution) === JSON.stringify(image.attribution),
      `Pilot species ${image.speciesId} attribution changed.`,
    );
  }
}

function archivePath(entry) {
  return join(packDirectory, entry.archiveFilename);
}

function validateArchive(entry) {
  const path = archivePath(entry);
  assert(existsSync(path), `${entry.packId} archive is missing at ${entry.archiveFilename}.`);
  if (!existsSync(path)) return;
  const archive = readFileSync(path);
  assert(archive.byteLength <= MAX_PACK_BYTES, `${entry.packId} archive exceeds 24 MiB.`);
  assert(sha256(archive) === entry.archiveSha256, `${entry.packId} archive SHA-256 differs.`);
  assert(statSync(path).size === entry.archiveBytes, `${entry.packId} archive size differs.`);

  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  assert(
    entries.length <= MAX_ARCHIVE_ENTRIES,
    `${entry.packId} exceeds the archive-entry limit.`,
  );
  assert(entries.includes('_meta/library-image-manifest.json'), `${entry.packId} has no manifest.`);
  assert(
    entries.every(
      (name) =>
        name === '_meta/' ||
        name === 'images/' ||
        name === '_meta/library-image-manifest.json' ||
        /^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.jpg$/.test(name),
    ),
    `${entry.packId} contains an unsafe or unexpected path.`,
  );

  const manifestBytes = execFileSync(
    'unzip',
    ['-p', path, '_meta/library-image-manifest.json'],
    { encoding: null, maxBuffer: MAX_MANIFEST_BYTES + 1 },
  );
  assert(manifestBytes.byteLength <= MAX_MANIFEST_BYTES, `${entry.packId} manifest is too large.`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert(manifest.manifestVersion === 1, `${entry.packId} manifestVersion must be 1.`);
  assert(manifest.packId === entry.packId, `${entry.packId} manifest identity differs.`);
  assert(
    entry.catalogSha256 === research.catalogSha256,
    `${entry.packId} catalog identity differs.`,
  );
  assert(
    entry.researchSha256 === researchSha256,
    `${entry.packId} research identity differs.`,
  );
  assert(
    typeof manifest.packVersion === 'string' &&
      manifest.packVersion.length > 0 &&
      manifest.packVersion === entry.packVersion,
    `${entry.packId} packVersion is invalid or differs from the index.`,
  );
  assert(
    Array.isArray(manifest.images) &&
      manifest.images.length > 0 &&
      manifest.images.length <= MAX_PACK_IMAGES,
    `${entry.packId} image count is invalid.`,
  );
  const speciesIds = new Set();
  const filenames = new Set();
  let expandedBytes = manifestBytes.byteLength;
  for (const image of manifest.images ?? []) {
    const label = `${entry.packId}/${image.speciesId}`;
    assert(!speciesIds.has(image.speciesId), `${label} duplicates a species ID.`);
    assert(!filenames.has(image.filename), `${label} duplicates a filename.`);
    speciesIds.add(image.speciesId);
    filenames.add(image.filename);
    assert(image.filename === `${image.speciesId}.jpg`, `${label} filename is unstable.`);
    assert(image.contentType === 'image/jpeg', `${label} is not declared as JPEG.`);
    assert(
      Number.isInteger(image.byteSize) && image.byteSize > 0 && image.byteSize <= MAX_IMAGE_BYTES,
      `${label} byteSize is invalid.`,
    );
    assert(
      isRedistributableLicense(
        image.attribution?.license,
        image.attribution?.licenseUrl,
      ),
      `${label} licence is invalid.`,
    );
    assert(isHttpsUrl(image.attribution?.sourceUrl), `${label} source URL is invalid.`);
    const imageBytes = execFileSync('unzip', ['-p', path, `images/${image.filename}`], {
      encoding: null,
      maxBuffer: MAX_IMAGE_BYTES + 1,
    });
    const dimensions = jpegDimensions(imageBytes);
    assert(imageBytes.byteLength === image.byteSize, `${label} byteSize differs.`);
    assert(
      dimensions.width === image.width && dimensions.height === image.height,
      `${label} dimensions differ.`,
    );
    assert(
      dimensions.width <= MAX_IMAGE_DIMENSION && dimensions.height <= MAX_IMAGE_DIMENSION,
      `${label} exceeds the dimension limit.`,
    );
    expandedBytes += imageBytes.byteLength;
  }
  assert(expandedBytes <= MAX_EXPANDED_BYTES, `${entry.packId} expanded bytes exceed the limit.`);
  assert(entry.imageCount === manifest.images.length, `${entry.packId} index image count differs.`);
  assert(entry.expandedBytes === expandedBytes, `${entry.packId} index expanded bytes differ.`);
  assert(
    entry.sourceSetSha256 ===
      canonicalJsonSha256(
        manifest.images.map((image) => [
          image.speciesId,
          researchById.get(image.speciesId)?.sourceSha256,
        ]),
      ),
    `${entry.packId} source-pin set differs from current research.`,
  );
}

validateResearch();
if (!researchOnly) {
  const indexPath = join(packDirectory, 'packs', 'index.json');
  assert(existsSync(indexPath), 'Pack index is missing.');
  if (existsSync(indexPath)) {
    const index = readJson(indexPath);
    const matchedCount = research.records.filter((record) => record.status === 'matched').length;
    assert(index.catalogSha256 === research.catalogSha256, 'Pack index catalog differs.');
    assert(index.researchSha256 === researchSha256, 'Pack index research differs.');
    assert(index.matchedSpeciesCount === matchedCount, 'Pack index matched count differs.');
    const seenPackSpecies = new Set();
    for (const entry of index.packs ?? []) {
      validateArchive(entry);
      if (!existsSync(archivePath(entry))) continue;
      const manifest = JSON.parse(
        execFileSync(
          'unzip',
          ['-p', archivePath(entry), '_meta/library-image-manifest.json'],
          { encoding: 'utf8' },
        ),
      );
      for (const image of manifest.images) {
        assert(
          !seenPackSpecies.has(image.speciesId),
          `${image.speciesId} occurs in more than one pack.`,
        );
        seenPackSpecies.add(image.speciesId);
      }
    }
    assert(
      seenPackSpecies.size === matchedCount,
      `Packs contain ${seenPackSpecies.size} species, expected ${matchedCount}.`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  const counts = research.records.reduce((result, record) => {
    result[record.status] = (result[record.status] ?? 0) + 1;
    return result;
  }, {});
  console.log(`Validated library-image research and packs: ${JSON.stringify(counts)}.`);
}
