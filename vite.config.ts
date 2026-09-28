import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnvironment } from './server/config.ts';

export default defineConfig(({ command }) => {
  // Production builds do not need deployment config or credentials.
  const env = command === 'serve' ? loadEnvironment() : process.env;
  return {
    root: 'web',
    plugins: [react()],
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          // Views are split with React.lazy (web/src/App.tsx). On top of that, keep third-party code
          // in its own long-cached chunks: the React/router/query runtime (needed at startup) and the
          // markdown stack (only reachable from the lazily loaded MarkdownRenderer).
          codeSplitting: {
            groups: [
              { name: 'vendor', test: /node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack)[\\/]/, priority: 2 },
              // Everything else from node_modules is the markdown stack (fonts are CSS, left to Vite).
              { name: 'markdown', test: (id) => /node_modules[\\/]/.test(id) && !/@fontsource|\.css$/.test(id), priority: 1 },
            ],
          },
        },
      },
    },
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: { '/api': `http://127.0.0.1:${env.PORT ?? 4780}` },
    },
  };
});
