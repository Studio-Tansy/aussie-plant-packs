import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_CATEGORIES,
  canonicalJsonSha256,
  parseCliArguments,
  writeJson,
} from './library-image-common.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const options = parseCliArguments(process.argv.slice(2));
const suppliedRoot = options.get('catalog-root') ?? process.env.GARDEN_TRACKER_LIBRARY_ROOT;

if (typeof suppliedRoot !== 'string') {
  throw new Error(
    'Pass --catalog-root /path/to/garden-tracker/src/assets/library or set GARDEN_TRACKER_LIBRARY_ROOT.',
  );
}

const catalogRoot = resolve(suppliedRoot);
if (!existsSync(catalogRoot) || !statSync(catalogRoot).isDirectory()) {
  throw new Error(`Catalog root does not exist: ${catalogRoot}`);
}

const species = [];
const seenIds = new Set();
for (const category of CATALOG_CATEGORIES) {
  const categoryDirectory = join(catalogRoot, category);
  if (!existsSync(categoryDirectory) || !statSync(categoryDirectory).isDirectory()) {
    throw new Error(`Missing canonical category directory: ${categoryDirectory}`);
  }

  const filenames = readdirSync(categoryDirectory)
    .filter((filename) => filename.endsWith('.json'))
    .sort();
  for (const filename of filenames) {
    const sourcePath = join(categoryDirectory, filename);
    const record = JSON.parse(readFileSync(sourcePath, 'utf8'));
    if (
      typeof record.id !== 'string' ||
      typeof record.commonName !== 'string' ||
      typeof record.scientificName !== 'string'
    ) {
      throw new Error(`${sourcePath} is missing id, commonName, or scientificName.`);
    }
    if (seenIds.has(record.id)) {
      throw new Error(`Duplicate canonical species ID: ${record.id}`);
    }
    seenIds.add(record.id);
    species.push({
      id: record.id,
      category,
      commonName: record.commonName,
      scientificName: record.scientificName,
      alsoKnownAs: Array.isArray(record.alsoKnownAs) ? record.alsoKnownAs : [],
      sourcePath: relative(catalogRoot, sourcePath).split('\\').join('/'),
      ...(record.category === category ? {} : { declaredCategory: record.category }),
    });
  }
}

const catalog = {
  catalogVersion: 1,
  sourceRoot: 'src/assets/library',
  speciesCount: species.length,
  catalogSha256: canonicalJsonSha256(species),
  species,
};
const outputPath = join(repositoryDirectory, 'library-images', 'catalog.json');
writeJson(outputPath, catalog);
console.log(
  `Exported ${catalog.speciesCount} canonical species to ${outputPath} (${catalog.catalogSha256}).`,
);
