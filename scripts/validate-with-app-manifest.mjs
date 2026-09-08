import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliArguments, readJson } from './library-image-common.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, '..');
const options = parseCliArguments(process.argv.slice(2));
const suppliedRoot = options.get('app-root');
if (typeof suppliedRoot !== 'string') {
  throw new Error('Pass --app-root /path/to/garden-tracker.');
}

const appRoot = resolve(suppliedRoot);
const typescriptPath = join(appRoot, 'node_modules', 'typescript');
if (!existsSync(typescriptPath)) {
  throw new Error(`TypeScript is not installed under ${appRoot}; run the app's normal install first.`);
}
const requireFromApp = createRequire(join(appRoot, 'package.json'));
const typescript = requireFromApp('typescript');
const loadedModules = new Map();

function loadTypeScriptModule(path) {
  if (loadedModules.has(path)) return loadedModules.get(path);
  const source = readFileSync(path, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === '@/types/library-image-pack.types') {
      return loadTypeScriptModule(
        join(appRoot, 'src', 'types', 'library-image-pack.types.ts'),
      );
    }
    return requireFromApp(specifier);
  };
  const execute = new Function('require', 'module', 'exports', output);
  execute(localRequire, module, module.exports);
  loadedModules.set(path, module.exports);
  return module.exports;
}

const validatorModule = loadTypeScriptModule(
  join(appRoot, 'src', 'services', 'library-image-pack-manifest.service.ts'),
);
const validateLibraryImagePackManifest =
  validatorModule.validateLibraryImagePackManifest;
if (typeof validateLibraryImagePackManifest !== 'function') {
  throw new Error('Could not load the app manifest validator.');
}

const packDirectory = join(repositoryDirectory, 'library-images');
const index = readJson(join(packDirectory, 'packs', 'index.json'));
for (const pack of index.packs) {
  const archivePath = join(packDirectory, pack.archiveFilename);
  const manifest = JSON.parse(
    execFileSync(
      'unzip',
      ['-p', archivePath, '_meta/library-image-manifest.json'],
      { encoding: 'utf8' },
    ),
  );
  const result = validateLibraryImagePackManifest(manifest, pack.packId);
  if (!result.isValid) {
    throw new Error(`${pack.packId} failed the app validator:\n${result.errors.join('\n')}`);
  }
}

console.log(`The app's real manifest validator accepted ${index.packs.length} packs.`);
