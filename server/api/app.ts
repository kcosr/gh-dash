import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config';
import type { Db } from '../db/db';
import type { DiffService } from '../diff/service';
import type { SyncManager } from '../sync/manager';
import { installAuth, sameOriginWrites } from './auth';
import { docsPage } from './docs';
import { HttpError } from './http';
import { openApiDocument } from './openapi';
import { diffRoutes } from './routes/diffs';
import { listRoutes } from './routes/lists';
import { repoRoutes } from './routes/repos';
import { statsRoutes } from './routes/stats';
import { systemRoutes } from './routes/system';
import { installStatic } from './static';

export interface AppDeps {
  db: Db;
  config: Config;
  sync: SyncManager;
  diffs: DiffService;
  /**
   * How requests reach this app instance. `tcp` (default): a network listener, guarded by the Host allowlist and
   * the optional password/API key. `desktop`: the desktop app's local socket; every request must carry
   * DESKTOP_SECRET_HEADER with this secret, and password/API-key auth doesn't apply (there is one local user).
   */
  transport?: AppTransport;
}

export type AppTransport = { kind: 'tcp' } | { kind: 'desktop'; secret: string };

/** Public origin of the request, honouring a reverse proxy's forwarded headers. */
function origin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  return `${proto}://${host}`;
}

export function createApp(deps: AppDeps): Hono {
  const { config } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details }, err.status);
    }
    console.error(`[http] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Every body we accept (settings, sets, views, sync, login) is tiny; don't buffer arbitrary uploads.
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large (max 1 MB)' }, 413) }));
  app.use('*', sameOriginWrites);
  installAuth(app, deps.db, config);

  app.get('/api/health', (c) => c.json({ ok: true, version: config.version }));
  app.route('/api/v1', systemRoutes(deps));
  app.route('/api/v1', repoRoutes(deps));
  app.route('/api/v1', listRoutes(deps));
  app.route('/api/v1', statsRoutes(deps));
  app.route('/api/v1', diffRoutes(deps));
  app.get('/api/v1/openapi.json', (c) => c.json(openApiDocument(config.version)));
  app.get('/api/docs', (c) =>
    c.html(
      docsPage(
        origin(c),
        config.apiKey ? "This server requires an API key: add <code>-H 'Authorization: Bearer &lt;key&gt;'</code> to the examples." : null,
      ),
    ),
  );
  app.all('/api/*', (c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));

  installStatic(app, config.webDir);
  return app;
}
