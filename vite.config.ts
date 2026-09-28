import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnvironment } from './server/config.ts';

// @pierre/diffs and its Shiki highlighter (the diffs group below).
const DIFFS = /node_modules[\\/](@pierre|shiki|@shikijs|oniguruma-to-es|oniguruma-parser|regex|regex-recursion|regex-utilities|diff|lru_map|hast-util-to-html|html-void-elements|stringify-entities|character-entities-html4|character-entities-legacy|zwitch)[\\/]/;
// Loaded on demand, one chunk each: Shiki's grammars and themes (fetched per language in view),
// Pierre's own themes and Shiki's WASM engine (neither used here).
const LAZY_DATA = /node_modules[\\/](@shikijs[\\/](langs|themes)|@pierre[\\/]theme|shiki[\\/]dist[\\/](langs|themes|wasm)|@shikijs[\\/]engine-oniguruma[\\/]dist[\\/]wasm)/;
// Shiki's grammars, named "lang-<language>" (one chunk each, or shared by the grammars embedding it).
const GRAMMAR = /node_modules[\\/](@shikijs[\\/]langs|shiki[\\/]dist[\\/]langs)[\\/]/;

export default defineConfig(({ command }) => {
  // Production builds do not need deployment config or credentials.
  const env = command === 'serve' ? loadEnvironment() : process.env;
  return {
    root: 'web',
    plugins: [react()],
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      // Lazy and long-cached: the diffs chunk (~630 kB, 175 kB gzipped) and Shiki's biggest grammars
      // (cpp, emacs-lisp: ~790 kB), fetched only when a diff shows such a file. Don't warn about them.
      chunkSizeWarningLimit: 800,
      rolldownOptions: {
        output: {
          // Otherwise Shiki's Markdown grammar would be a second "markdown-*.js" beside the markdown stack.
          chunkFileNames: (chunk) => `assets/${chunk.moduleIds.length && chunk.moduleIds.every((id) => GRAMMAR.test(id)) ? 'lang-' : ''}[name]-[hash].js`,
          // Views are split with React.lazy (web/src/App.tsx). On top of that, keep third-party code
          // in its own long-cached chunks: the React/router/query runtime (needed at startup), the diff
          // renderer (web/src/diff, loaded when a diff first opens) and the markdown stack (only
          // reachable from the lazily loaded MarkdownRenderer).
          codeSplitting: {
            groups: [
              { name: 'vendor', test: /node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack)[\\/]/, priority: 4 },
              // What both lazy stacks use (the hast utilities: property-information, ccount, ...), so
              // opening a diff doesn't fetch the markdown stack, nor a PR description the diff renderer.
              { name: 'shared', test: (id) => /node_modules[\\/]/.test(id) && !/@fontsource|\.css$/.test(id) && !LAZY_DATA.test(id), minShareCount: 2, priority: 3 },
              // Groups take their dependencies along: outranking the markdown group keeps a Pierre
              // dependency missing from DIFFS with Pierre.
              { name: 'diffs', test: (id) => DIFFS.test(id) && !LAZY_DATA.test(id), priority: 2 },
              // Everything else from node_modules is the markdown stack (fonts are CSS, left to Vite).
              { name: 'markdown', test: (id) => /node_modules[\\/]/.test(id) && !/@fontsource|\.css$/.test(id) && !DIFFS.test(id) && !LAZY_DATA.test(id), priority: 1 },
            ],
          },
        },
      },
    },
    // Module workers, so the diff highlighter's worker keeps Shiki's WASM engine (unused: Pierre runs
    // the JavaScript regex engine) as a separate never-loaded chunk instead of inlining it.
    worker: { format: 'es' as const },
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: { '/api': `http://127.0.0.1:${env.PORT ?? 4780}` },
    },
  };
});
