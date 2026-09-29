import { Hono } from 'hono';
import type { InstanceInfo } from '../../../shared/api';
import type { AppDeps } from '../app';
import { origin } from '../http';

/** How this server is running: version, where the API can be reached, and the effective instance settings. */
export function instanceRoutes({ config, transport, localApiUrl }: AppDeps): Hono {
  const r = new Hono();

  r.get('/instance', (c) => {
    const s = config.sources;
    const info: InstanceInfo = {
      version: config.version,
      desktop: config.desktop,
      // Over the network, the address this request came in on; the desktop app's socket isn't reachable by other
      // clients, so there it's the Local API's address, if that is on.
      apiUrl: (transport?.kind ?? 'tcp') === 'tcp' ? origin(c) : (localApiUrl?.() ?? null),
      auth: { password: !!config.password, apiKey: !!config.apiKey },
      configPath: config.configPath,
      settings: {
        host: { value: config.host, source: s.host },
        port: { value: config.port, source: s.port },
        dbPath: { value: config.dbPath, source: s.db },
        cacheDbPath: { value: config.cacheDbPath, source: s.cacheDb },
        sync: { value: config.syncEnabled, source: s.sync },
        allowedHosts: { value: config.allowedHosts, source: s.allowedHosts },
        tokenFile: { value: config.tokenFile, source: s.tokenFile },
        defaultTz: { value: config.defaultTz, source: s.timezone },
        glabPath: { value: config.glabPath, source: s.glabPath },
        // Read on each request: the desktop app's reload-sources replaces config.sourceConfigs.
        sources: config.sourceConfigs.map((c) => ({ host: c.host, from: c.from })),
      },
    };
    return c.json(info);
  });

  return r;
}
