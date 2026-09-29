// Bundles tools/gitlab-smoke.ts into one self-contained ESM file (default dist/gitlab-smoke.mjs) that runs with plain
// `node` on Node >= 22: everything but Node built-ins is bundled.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(process.argv[2] ?? join(root, 'dist/gitlab-smoke.mjs'));
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() ? '+dirty' : '';

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'tools/gitlab-smoke.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'warning',
  legalComments: 'none',
  define: { SMOKE_BUILD: JSON.stringify(sha + dirty) },
  banner: { js: '#!/usr/bin/env node' },
});
console.log(`build: ${outfile} (${sha}${dirty})`);
