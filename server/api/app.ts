import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CommentBus } from '../comments/bus';
import type { Config } from '../config';
import { agentSourceIds, builtInAgent, principalForToken } from '../db/agents';
import type { Db } from '../db/db';
import type { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { createMcpCore } from '../mcp';
import { Tracking } from '../sync/tracking';
import { SourceRegistry } from '../sources/registry';
import type { SyncManager } from '../sync/manager';
import type { TokenProvider } from '../token';
import { desktopOnly, hostAllowlist, installAuth, sameOriginWrites } from './auth';
import { docsPage } from './docs';
import { HttpError, origin } from './http';
import { openApiDocument } from './openapi';
import { accountRoutes } from './routes/account';
import { agentRoutes } from './routes/agents';
import { commentRoutes } from './routes/comments';
import { diffRoutes } from './routes/diffs';
import { instanceRoutes } from './routes/instance';
import { listRoutes } from './routes/lists';
import { installMcp, refuseMcp } from './routes/mcp';
import { repoRoutes } from './routes/repos';
import { sourceRoutes } from './routes/sources';
import { statsRoutes } from './routes/stats';
import { streamRoutes } from './routes/stream';
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
  /** Desktop transport: the Local API's URL while its TCP listener serves the REST API, else null (GET /instance apiUrl). */
  localApiUrl?: () => string | null;
  /** Desktop transport: the Local API's MCP URL while it serves MCP, else null (GET /instance mcpUrl). */
  localMcpUrl?: () => string | null;
  /** Adding repositories (lookups and candidates on any source); by default over `tokens`, `sources` and `sync`. */
  tracking?: Tracking;
  /**
   * What happens to comments and agents, as it happens (GET /stream, MCP): one per server, shared by its listeners'
   * apps (startServer passes it). By default a bus of this app's own.
   */
  bus?: CommentBus;
}

export type AppTransport = { kind: 'tcp' } | { kind: 'desktop'; secret: string };

export function createApp(input: AppDeps): Hono {
  const deps: AppDeps = {
    ...input,
    tracking: input.tracking ?? new Tracking({ db: input.db, tokens: input.tokens, sources: input.sources, sync: input.sync, tz: input.config.defaultTz }),
    bus: input.bus ?? new CommentBus(),
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
  // Every body we accept (settings, sets, views, sync, login, comments) is small; don't buffer arbitrary uploads.
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large (max 1 MB)' }, 413) }));
  // Inert on the desktop socket (app:// fetches send no Origin), kept there as defence in depth.
  app.use('*', sameOriginWrites);
  // What the TCP listener serves: all of it on a headless server; the desktop app's Local API has a switch for the REST
  // API and one for MCP. /api/health always. The desktop socket serves the REST API to the app's windows, never MCP.
  const tcp = transport.kind === 'tcp';
  const rest = !tcp || config.restApi;
  // The desktop app has one local user: the secret is its authentication.
  if (tcp && rest) installAuth(app, deps.db, config);

  // Agents: its own auth (an agent token, or none as the built-in agent where allowed), exempt from installAuth's.
  if (tcp && config.mcp) {
    installMcp(app, {
      core: createMcpCore({ ...deps, bus: deps.bus! }),
      principalFor: (token) => principalForToken(deps.db, token),
      withoutToken: config.mcpRequireTokens ? undefined : () => builtInAgent(deps.db),
      sourcesFor: (principal) => agentSourceIds(deps.db, principal.id),
    });
  } else {
    refuseMcp(app, tcp ? 'MCP is off on this port; turn on "MCP for agents" in gh-dash Settings → Instance' : undefined);
  }

  app.get('/api/health', (c) => c.json({ ok: true, version: config.version }));
  if (!rest) {
    // Nothing else: no API, docs, web app or sign-in on this port.
    app.all('*', (c) => c.json({ error: 'The REST API is off on this port; turn it on in gh-dash Settings → Instance (Local API)' }, 404));
    return app;
  }
  app.route('/api/v1', systemRoutes(deps));
  app.route('/api/v1', repoRoutes(deps));
  app.route('/api/v1', listRoutes(deps));
  app.route('/api/v1', statsRoutes(deps));
  app.route('/api/v1', diffRoutes(deps));
  app.route('/api/v1', commentRoutes(deps));
  app.route('/api/v1', agentRoutes(deps));
  app.route('/api/v1', streamRoutes(deps));
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
