import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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
  OUTPUT_DIMENSIONS,
  OUTPUT_QUALITIES,
  TARGET_PACK_IMAGE_BYTES,
  assertNoExif,
  jpegDimensions,
  parseCliArguments,
  readJson,
  sha256,
  writeJson,
} from './library-image-common.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const packDirectory = join(repositoryDirectory, 'library-images');
const sourceDirectory = join(packDirectory, 'source');
const buildDirectory = join(packDirectory, 'build');
const normalizedDirectory = join(buildDirectory, 'normalized');
const stagingDirectory = join(buildDirectory, 'packs');
const outputDirectory = join(packDirectory, 'packs');
const pilotArchivePath = join(packDirectory, 'library-images.zip');
const research = readJson(join(packDirectory, 'research-manifest.json'));
const pilot = readJson(join(packDirectory, 'sources.json'));
const options = parseCliArguments(process.argv.slice(2));
const selectedPack = options.get('pack');

if (selectedPack !== undefined && typeof selectedPack !== 'string') {
  throw new Error('--pack requires a pack ID.');
}

mkdirSync(sourceDirectory, { recursive: true });
mkdirSync(normalizedDirectory, { recursive: true });
rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });
mkdirSync(outputDirectory, { recursive: true });

function downloadSource(record, sourcePath) {
  execFileSync(
    'curl',
    [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--silent',
      '--show-error',
      '--user-agent',
      'AussiePlantPacksBuilder/1.0 (https://github.com/Studio-Tansy/aussie-plant-packs)',
      record.sourceDownloadUrl,
      '--output',
      sourcePath,
    ],
    { stdio: 'inherit' },
  );
}

function verifiedSourcePath(record) {
  if (!/^[a-f0-9]{64}$/.test(record.sourceSha256)) {
    throw new Error(`${record.speciesId} has no valid source SHA-256.`);
  }
  const sourcePath = join(sourceDirectory, record.sourceFilename);
  if (!existsSync(sourcePath)) downloadSource(record, sourcePath);
  let source = readFileSync(sourcePath);
  if (sha256(source) !== record.sourceSha256) {
    rmSync(sourcePath, { force: true });
    downloadSource(record, sourcePath);
    source = readFileSync(sourcePath);
  }
  if (sha256(source) !== record.sourceSha256) {
    throw new Error(
      `${record.speciesId} no longer matches its reviewed source SHA-256; review its attribution before rebuilding.`,
    );
  }
  return sourcePath;
}

function validateOutput(path, speciesId) {
  const output = readFileSync(path);
  const { width, height } = jpegDimensions(output);
  assertNoExif(output);
  const byteSize = output.byteLength;
  if (byteSize > MAX_IMAGE_BYTES) {
    throw new Error(`${speciesId}.jpg exceeds the ${MAX_IMAGE_BYTES}-byte image limit.`);
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`${speciesId}.jpg exceeds the ${MAX_IMAGE_DIMENSION}px dimension limit.`);
  }
  return { width, height, byteSize };
}

function normalizeImage(record) {
  const sourcePath = verifiedSourcePath(record);
  const outputPath = join(normalizedDirectory, record.filename);
  const pinPath = `${outputPath}.source-sha256`;
  if (
    existsSync(outputPath) &&
    existsSync(pinPath) &&
    readFileSync(pinPath, 'utf8').trim() === record.sourceSha256
  ) {
    return {
      outputPath,
      ...validateOutput(outputPath, record.speciesId),
    };
  }

  rmSync(outputPath, { force: true });
  for (const dimension of OUTPUT_DIMENSIONS) {
    for (const quality of OUTPUT_QUALITIES) {
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-loglevel',
          'error',
          '-i',
          sourcePath,
          '-map_metadata',
          '-1',
          '-vf',
          `scale=${dimension}:${dimension}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          '-frames:v',
          '1',
          '-q:v',
          String(quality),
          outputPath,
        ],
        { stdio: 'inherit' },
      );
      try {
        const dimensions = validateOutput(outputPath, record.speciesId);
        writeFileSync(pinPath, `${record.sourceSha256}\n`);
        return { outputPath, ...dimensions };
      } catch (error) {
        if (!String(error.message).includes('exceeds')) throw error;
      }
    }
  }
  throw new Error(`${record.speciesId} could not be normalized below the image limits.`);
}

function manifestEntry(record, output) {
  return {
    speciesId: record.speciesId,
    filename: record.filename,
    contentType: 'image/jpeg',
    width: output.width,
    height: output.height,
    byteSize: output.byteSize,
    attribution: record.attribution,
  };
}

function chunkRecords(records) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const record of records) {
    if (
      current.length > 0 &&
      (current.length >= MAX_PACK_IMAGES ||
        currentBytes + record.output.byteSize > TARGET_PACK_IMAGE_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += record.output.byteSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildArchive(packId, packVersion, records, archivePath, category, chunk) {
  const stageDirectory = join(stagingDirectory, packId);
  const imageDirectory = join(stageDirectory, 'images');
  const metadataDirectory = join(stageDirectory, '_meta');
  rmSync(stageDirectory, { recursive: true, force: true });
  mkdirSync(imageDirectory, { recursive: true });
  mkdirSync(metadataDirectory, { recursive: true });

  const images = records.map(({ record, output }) => {
    copyFileSync(output.outputPath, join(imageDirectory, record.filename));
    return manifestEntry(record, output);
  });
  const manifest = {
    manifestVersion: 1,
    packId,
    packVersion,
    images,
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBuffer.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`${packId} manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  }
  writeFileSync(join(metadataDirectory, 'library-image-manifest.json'), manifestBuffer);

  rmSync(archivePath, { force: true });
  execFileSync('zip', ['-q', '-r', archivePath, '_meta', 'images'], {
    cwd: stageDirectory,
    stdio: 'inherit',
  });
  const archive = readFileSync(archivePath);
  const archiveBytes = archive.byteLength;
  const imageBytes = images.reduce((total, image) => total + image.byteSize, 0);
  const expandedBytes = imageBytes + manifestBuffer.byteLength;
  if (archiveBytes > MAX_PACK_BYTES) {
    throw new Error(`${packId} compressed archive exceeds ${MAX_PACK_BYTES} bytes.`);
  }
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error(`${packId} expanded content exceeds ${MAX_EXPANDED_BYTES} bytes.`);
  }
  if (images.length + 2 > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`${packId} exceeds ${MAX_ARCHIVE_ENTRIES} archive entries.`);
  }

  return {
    packId,
    packVersion,
    category,
    chunk,
    archiveFilename:
      archivePath === pilotArchivePath ? 'library-images.zip' : `packs/${packId}.zip`,
    archiveBytes,
    archiveSha256: sha256(archive),
    expandedBytes,
    imageBytes,
    manifestBytes: manifestBuffer.byteLength,
    imageCount: images.length,
  };
}

const matchedRecords = research.records
  .filter((record) => record.status === 'matched')
  .sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.speciesId.localeCompare(right.speciesId),
  );
const pilotIds = new Set(pilot.images.map((image) => image.speciesId));
const normalized = [];
for (let index = 0; index < matchedRecords.length; index += 1) {
  const record = matchedRecords[index];
  const output = normalizeImage(record);
  normalized.push({ record, output });
  process.stderr.write(`\rNormalized images: ${index + 1}/${matchedRecords.length}`);
}
if (matchedRecords.length > 0) process.stderr.write('\n');

const definitions = [];
const pilotRecords = normalized.filter(({ record }) => pilotIds.has(record.speciesId));
definitions.push({
  packId: pilot.packId,
  packVersion: pilot.packVersion,
  category: 'pilot',
  chunk: 1,
  records: pilotRecords,
  archivePath: pilotArchivePath,
});

const categories = [...new Set(
  normalized
    .filter(({ record }) => !pilotIds.has(record.speciesId))
    .map(({ record }) => record.category),
)].sort();
for (const category of categories) {
  const categoryRecords = normalized.filter(
    ({ record }) => record.category === category && !pilotIds.has(record.speciesId),
  );
  const chunks = chunkRecords(categoryRecords);
  chunks.forEach((records, index) => {
    const packId = `library-images-${category}-${String(index + 1).padStart(2, '0')}`;
    definitions.push({
      packId,
      packVersion: research.packVersion,
      category,
      chunk: index + 1,
      records,
      archivePath: join(outputDirectory, `${packId}.zip`),
    });
  });
}

const selectedDefinitions =
  typeof selectedPack === 'string'
    ? definitions.filter((definition) => definition.packId === selectedPack)
    : definitions;
if (selectedDefinitions.length === 0) {
  throw new Error(`No generated pack has ID "${selectedPack}".`);
}

const previousIndexPath = join(outputDirectory, 'index.json');
const previousIndex = existsSync(previousIndexPath) ? readJson(previousIndexPath) : null;
const builtById = new Map(previousIndex?.packs?.map((entry) => [entry.packId, entry]) ?? []);
for (const definition of selectedDefinitions) {
  const result = buildArchive(
    definition.packId,
    definition.packVersion,
    definition.records,
    definition.archivePath,
    definition.category,
    definition.chunk,
  );
  builtById.set(result.packId, result);
  console.log(
    `Built ${result.archiveFilename} (${result.archiveBytes} bytes; ${result.imageCount} images; ${result.imageBytes} image bytes).`,
  );
}

const expectedPackIds = new Set(definitions.map((definition) => definition.packId));
const packs = [...builtById.values()]
  .filter((entry) => expectedPackIds.has(entry.packId))
  .sort((left, right) => left.packId.localeCompare(right.packId));
const index = {
  indexVersion: 1,
  packVersion: research.packVersion,
  catalogSha256: research.catalogSha256,
  catalogSpeciesCount: research.catalogSpeciesCount,
  matchedSpeciesCount: matchedRecords.length,
  unresolvedSpeciesCount: research.records.filter((record) => record.status === 'unresolved')
    .length,
  reviewNeededSpeciesCount: research.records.filter(
    (record) => record.status === 'review-needed',
  ).length,
  packs,
};
writeJson(previousIndexPath, index);
