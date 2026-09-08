import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_IMAGE_DIMENSION = 2048;
export const MAX_PACK_BYTES = 24 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_EXPANDED_BYTES = MAX_PACK_BYTES + MAX_MANIFEST_BYTES;
export const MAX_PACK_IMAGES = 1000;
export const MAX_ARCHIVE_ENTRIES = MAX_PACK_IMAGES + 16;
export const TARGET_PACK_IMAGE_BYTES = 20 * 1024 * 1024;
export const OUTPUT_DIMENSIONS = [1600, 1400, 1200, 1000, 800];
export const OUTPUT_QUALITIES = [4, 6, 8, 10];
export const CATALOG_CATEGORIES = [
  'flower',
  'fruit',
  'herb',
  'indoor',
  'native',
  'ornamental',
  'succulent',
  'uncategorized-edible',
  'vegetable',
];

const HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"'],
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJsonSha256(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

export function plainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
      if (entity.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return HTML_ENTITIES.get(entity.toLowerCase()) ?? `&${entity};`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isRedistributableLicense(license, licenseUrl) {
  if (!isHttpsUrl(licenseUrl)) return false;
  const url = new URL(licenseUrl);
  if (
    !['creativecommons.org', 'www.creativecommons.org'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  const expectedPath = canonicalLicensePath(license);
  if (!expectedPath) return false;
  const pathname = url.pathname.toLocaleLowerCase('en');
  if (pathname === expectedPath || pathname === expectedPath.slice(0, -1)) {
    return true;
  }
  if (!pathname.startsWith(expectedPath)) return false;
  return /^(?:deed\.[a-z]{2}(?:[-_][a-z]{2})?|legalcode)\/?$/.test(
    pathname.slice(expectedPath.length),
  );
}

function canonicalLicensePath(license) {
  if (typeof license !== 'string') return '';
  const normalized = license.trim();
  if (/^Public domain$/i.test(normalized)) {
    return '/publicdomain/mark/1.0/';
  }
  if (/^CC0(?:\s+1\.0)?$/i.test(normalized)) {
    return '/publicdomain/zero/1.0/';
  }
  const match =
    /^CC BY(-SA)?\s+(1\.0|2\.0|2\.1|2\.5|3\.0|4\.0)(?:\s+([A-Z]{2}))?$/i.exec(
      normalized,
    );
  if (match) {
    const jurisdiction = match[3]
      ? `${match[3].toLocaleLowerCase('en')}/`
      : '';
    return `/licenses/by${match[1] ? '-sa' : ''}/${match[2]}/${jurisdiction}`;
  }
  return '';
}

export function normalizedLicenseUrl(license, suppliedUrl) {
  const path = canonicalLicensePath(license);
  if (!path) return '';
  if (suppliedUrl !== undefined) {
    try {
      const url = new URL(suppliedUrl);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (!isRedistributableLicense(license, url.toString())) return '';
    } catch {
      return '';
    }
  }
  return `https://creativecommons.org${path}`;
}

export function sourceExtension(contentType) {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported source content type: ${contentType}`);
  }
}

export function jpegDimensions(buffer) {
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

export function assertNoExif(buffer) {
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

export function parseCliArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options.set(key, true);
    } else {
      options.set(key, next);
      index += 1;
    }
  }
  return options;
}
