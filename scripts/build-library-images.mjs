import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_PACK_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_DIMENSION = 1600;

function jpegDimensions(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Generated image is not a JPEG.');
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      throw new Error('Generated JPEG has an invalid segment.');
    }

    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      };
    }

    offset += length;
  }

  throw new Error('Generated JPEG has no dimensions.');
}

function assertNoExif(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      throw new Error('Generated JPEG has an invalid segment.');
    }
    if (
      marker === 0xe1 &&
      buffer.subarray(offset + 2, offset + 8).toString('ascii') === 'Exif\0\0'
    ) {
      throw new Error('Generated JPEG still contains EXIF metadata.');
    }
    offset += length;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const packDirectory = join(repositoryDirectory, 'library-images');
const sourceDirectory = join(packDirectory, 'source');
const buildDirectory = join(packDirectory, 'build');
const imageDirectory = join(buildDirectory, 'images');
const metadataDirectory = join(buildDirectory, '_meta');
const archivePath = join(packDirectory, 'library-images.zip');
const source = JSON.parse(readFileSync(join(packDirectory, 'sources.json'), 'utf8'));

rmSync(buildDirectory, { recursive: true, force: true });
rmSync(archivePath, { force: true });
mkdirSync(sourceDirectory, { recursive: true });
mkdirSync(imageDirectory, { recursive: true });
mkdirSync(metadataDirectory, { recursive: true });

const manifestImages = source.images.map((image) => {
  const sourcePath = join(sourceDirectory, `${image.speciesId}-original.jpg`);
  const outputPath = join(imageDirectory, image.filename);

  execFileSync(
    'curl',
    [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--silent',
      '--show-error',
      image.sourceDownloadUrl,
      '--output',
      sourcePath,
    ],
    { stdio: 'inherit' },
  );
  const original = readFileSync(sourcePath);
  if (!/^[a-f0-9]{64}$/.test(image.sourceSha256)) {
    throw new Error(`${image.speciesId} has no valid source SHA-256.`);
  }
  if (sha256(original) !== image.sourceSha256) {
    throw new Error(
      `${image.speciesId} no longer matches its reviewed source SHA-256; review its attribution before rebuilding.`,
    );
  }
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
      `scale=${MAX_OUTPUT_DIMENSION}:${MAX_OUTPUT_DIMENSION}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      outputPath,
    ],
    { stdio: 'inherit' },
  );

  const output = readFileSync(outputPath);
  const { width, height } = jpegDimensions(output);
  assertNoExif(output);
  const byteSize = statSync(outputPath).size;
  if (byteSize > MAX_IMAGE_BYTES) {
    throw new Error(`${image.filename} exceeds the ${MAX_IMAGE_BYTES}-byte image limit.`);
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`${image.filename} exceeds the ${MAX_IMAGE_DIMENSION}px dimension limit.`);
  }

  return {
    speciesId: image.speciesId,
    filename: image.filename,
    contentType: 'image/jpeg',
    width,
    height,
    byteSize,
    attribution: image.attribution,
  };
});

const declaredImageBytes = manifestImages.reduce((total, image) => total + image.byteSize, 0);
if (declaredImageBytes > MAX_PACK_BYTES) {
  throw new Error(`Image payload exceeds the ${MAX_PACK_BYTES}-byte pack limit.`);
}

const manifest = {
  manifestVersion: source.manifestVersion,
  packId: source.packId,
  packVersion: source.packVersion,
  images: manifestImages,
};
writeFileSync(
  join(metadataDirectory, 'library-image-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
execFileSync('zip', ['-q', '-r', archivePath, '_meta', 'images'], {
  cwd: buildDirectory,
  stdio: 'inherit',
});

const archiveBytes = statSync(archivePath).size;
if (archiveBytes > MAX_PACK_BYTES) {
  throw new Error(`Compressed archive exceeds the ${MAX_PACK_BYTES}-byte pack limit.`);
}

console.log(
  `Built ${archivePath} (${archiveBytes} bytes; ${manifestImages.length} images; ${declaredImageBytes} image bytes).`,
);
