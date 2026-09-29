import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config';
import type { Db } from '../db/db';
import type { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { Tracking } from '../sync/tracking';
import { SourceRegistry } from '../sources/registry';
import type { SyncManager } from '../sync/manager';
import type { TokenProvider } from '../token';
import { desktopOnly, hostAllowlist, installAuth, sameOriginWrites } from './auth';
import { docsPage } from './docs';
import { HttpError, origin } from './http';
import { openApiDocument } from './openapi';
import { accountRoutes } from './routes/account';
import { diffRoutes } from './routes/diffs';
import { instanceRoutes } from './routes/instance';
import { listRoutes } from './routes/lists';
import { repoRoutes } from './routes/repos';
import { sourceRoutes } from './routes/sources';
import { statsRoutes } from './routes/stats';
import { systemRoutes } from './routes/system';
import { installStatic } from './static';

export interface AppDeps {
  db: Db;
  config: Config;
  sync: SyncManager;
  diffs: DiffService;
  /** The GitHub token, shared with sync and diffs: account routes, and the reason in "no token" errors. */
  tokens: TokenProvider;
  /**
   * Every source's runtime (github.com's tokens are `tokens.credentials`). startServer always passes it; without it
   * (tests that don't need it) github.com is the only source the tracking API and /sources know.
   */
  sources?: SourceRegistry;
  /**
   * How requests reach this app instance. `tcp` (default): a network listener, guarded by the Host allowlist and
   * the optional password/API key. `desktop`: the desktop app's local socket; every request must carry
   * DESKTOP_SECRET_HEADER with this secret, and password/API-key auth doesn't apply (there is one local user).
   */
  transport?: AppTransport;
  /** Desktop transport: the Local API's URL while its TCP listener runs, else null (GET /instance apiUrl). */
  localApiUrl?: () => string | null;
  /** Adding repositories (lookups and candidates on any source); by default over `tokens`, `sources` and `sync`. */
  tracking?: Tracking;
}

export type AppTransport = { kind: 'tcp' } | { kind: 'desktop'; secret: string };

export function createApp(input: AppDeps): Hono {
  const deps: AppDeps = {
    ...input,
    tracking: input.tracking ?? new Tracking({ db: input.db, tokens: input.tokens, sources: input.sources, sync: input.sync, tz: input.config.defaultTz }),
  };
  const { config } = deps;
  // The sources API needs a registry; without one (tests) github.com is the only source it knows.
  const sources =
    input.sources ??
    new SourceRegistry({ db: input.db, env: {}, github: { tokens: input.tokens.credentials, diffs: new GitHubDiffSources({ tokens: input.tokens }) }, log: () => {} });
  const transport: AppTransport = deps.transport ?? { kind: 'tcp' };
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details }, err.status);
    }
    console.error(`[http] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Before anything else, /api/health included: who may talk to this instance at all.
  app.use('*', transport.kind === 'desktop' ? desktopOnly(transport.secret) : hostAllowlist(config.allowedHosts));
  // Every body we accept (settings, sets, views, sync, login) is tiny; don't buffer arbitrary uploads.
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large (max 1 MB)' }, 413) }));
  // Inert on the desktop socket (app:// fetches send no Origin), kept there as defence in depth.
  app.use('*', sameOriginWrites);
  // The desktop app has one local user: the secret is its authentication.
  if (transport.kind === 'tcp') installAuth(app, deps.db, config);

  app.get('/api/health', (c) => c.json({ ok: true, version: config.version }));
  app.route('/api/v1', systemRoutes(deps));
  app.route('/api/v1', repoRoutes(deps));
  app.route('/api/v1', listRoutes(deps));
  app.route('/api/v1', statsRoutes(deps));
  app.route('/api/v1', diffRoutes(deps));
  app.route('/api/v1', accountRoutes(deps));
  app.route('/api/v1', sourceRoutes({ ...deps, sources }));
  app.route('/api/v1', instanceRoutes(deps));
  app.get('/api/v1/openapi.json', (c) => c.json(openApiDocument(config.version)));
  app.get('/api/docs', (c) =>
    c.html(
      docsPage(
        origin(c),
        transport.kind === 'tcp' && config.apiKey ? "This server requires an API key: add <code>-H 'Authorization: Bearer &lt;key&gt;'</code> to the examples." : null,
      ),
    ),
  );
  app.all('/api/*', (c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));

  installStatic(app, config.webDir);
  return app;
}
