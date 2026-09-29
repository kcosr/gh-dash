import { Hono } from 'hono';
import type { SourceRegistry } from '../../sources/registry';
import { checkSource, deleteSource, getSourceView, listSourceViews } from '../../services/sources';
import type { AppDeps } from '../app';

/**
 * The sources this database tracks repositories on. Nothing here adds a source or writes a credential: those come from
 * config.json / the environment (headless) or the desktop app, never over HTTP (design §1.6).
 */
export function sourceRoutes({ db, sync, diffs, sources }: AppDeps & { sources: SourceRegistry }): Hono {
  const r = new Hono();
  const deps = { db, sources, sync, diffs };

  // Never calls a provider (like /account): a new token is validated in the background when it turns up.
  r.get('/sources', async (c) => c.json({ items: await listSourceViews(deps) }));

  r.get('/sources/:source', async (c) => c.json(await getSourceView(deps, c.req.param('source'))));

  // "Retry": resolve the source's token again and validate it now (github.com: 1 GraphQL point; GitLab: 2 requests).
  r.post('/sources/:source/check', async (c) => c.json(await checkSource(deps, c.req.param('source'))));

  r.delete('/sources/:source', (c) => {
    deleteSource(deps, c.req.param('source'));
    return c.body(null, 204);
  });

  return r;
}
