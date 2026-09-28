// Bundles the Node side after `vite build` has produced dist/web:
//   dist/server/index.mjs    headless server (npm start)
//   dist/server/desktop.mjs  the desktop app's server child (utilityProcess)
//   dist/electron/main.mjs   Electron main process
//   dist/electron/preload.cjs
// Everything except Node built-ins and `electron` is bundled, so the packaged app ships no node_modules.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (path) => join(root, path);

const desktopEntry = at('server/desktop.ts');
if (!existsSync(desktopEntry)) {
  console.error(`build: ${relative(root, desktopEntry)} is missing; it is the desktop app's server entry (see shared/desktop.ts).`);
  process.exit(1);
}
if (!existsSync(at('dist/web/index.html'))) {
  console.error('build: dist/web/index.html is missing; run `vite build` first (npm run build does both).');
  process.exit(1);
}

rmSync(at('dist/server'), { recursive: true, force: true });
rmSync(at('dist/electron'), { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  logLevel: 'warning',
  legalComments: 'none',
  // Readable stack traces in bug reports matter more than a few hundred kB.
  minify: false,
};

await Promise.all([
  build({
    ...common,
    entryPoints: { index: at('server/index.ts'), desktop: desktopEntry },
    outdir: at('dist/server'),
    platform: 'node',
    target: 'node22.13',
    format: 'esm',
    // Code splitting keeps index.ts's dynamic import('./main') lazy, so its warning filter is installed before
    // node:sqlite loads (a single-file bundle would hoist that import). The two entries share their chunks.
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
  }),
  build({
    ...common,
    entryPoints: [at('electron/main.ts')],
    outfile: at('dist/electron/main.mjs'),
    platform: 'node',
    target: 'node22.13',
    format: 'esm',
    external: ['electron'],
  }),
  // Sandboxed preload: CommonJS, and nothing but `electron` may be required at run time.
  build({
    ...common,
    entryPoints: [at('electron/preload.ts')],
    outfile: at('dist/electron/preload.cjs'),
    platform: 'browser',
    target: 'chrome140',
    format: 'cjs',
    external: ['electron'],
  }),
]);

// Window icon for Linux (the packaged .desktop entry has its own); macOS and Windows use the bundle's icon.
mkdirSync(at('dist/electron'), { recursive: true });
copyFileSync(at('build/icons/512x512.png'), at('dist/electron/icon.png'));

console.log('build: dist/server/{index,desktop}.mjs, dist/electron/{main.mjs,preload.cjs}');
