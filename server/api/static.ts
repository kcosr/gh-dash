import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono, MiddlewareHandler } from 'hono';

const NOT_BUILT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>gh-dash</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1f2328}code{background:#eff1f3;padding:2px 5px;border-radius:4px}</style>
</head><body><h1>gh-dash</h1><p>The web app hasn't been built yet. Run <code>npm run build</code> and reload,
or use <code>npm run dev</code> for development.</p><p>The API is available: <a href="/api/docs">/api/docs</a>.</p></body></html>`;

/** Serves dist/web with an index.html fallback for client-side routes; checked per request so a later build is picked up. */
export function installStatic(app: Hono, webDir: string): void {
  const indexPath = join(webDir, 'index.html');
  // Created on first use: serveStatic warns at construction time when the directory doesn't exist yet.
  let files: MiddlewareHandler | null = null;

  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/') || !existsSync(indexPath)) return next();
    files ??= serveStatic({
      root: webDir,
      onFound: (path, ctx) => {
        ctx.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    return files(c, next);
  });

  app.get('*', (c) => {
    if (!existsSync(indexPath)) return c.html(NOT_BUILT);
    // Missing build assets and top-level files (favicon, robots.txt) are 404s. Any other path is a client-side
    // route, dots included: /repos/user.github.io.
    if (/^\/(assets\/|[^/]+\.[a-z0-9]+$)/i.test(c.req.path)) return c.text('Not found', 404);
    c.header('Cache-Control', 'no-cache');
    return c.html(readFileSync(indexPath, 'utf8'));
  });
}
