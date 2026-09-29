import { Hono } from 'hono';
import { z } from 'zod';
import { createSet, createView, deleteSet, deleteView, listSets, listViews, updateSet } from '../../db/repos';
import { patchRepo, queryRepos, repoDetail } from '../../services/repos';
import { removeTrackedRepo } from '../../sync/tracking';
import type { AppDeps } from '../app';
import { noCrossSiteReads } from '../auth';
import { HttpError, jsonBody, parseWith } from '../http';

const name = z.string().trim().min(1).max(100);
const repoList = z.array(z.string().trim().min(1)).max(1000);

const repoPatch = z.object({ pinned: z.boolean().optional(), hidden: z.boolean().optional() }).strict();
const repoQuery = z.object({
  repos: z.string().max(100_000).optional(),
  scope: z.enum(['all', 'default']).optional(),
  visibility: z.enum(['all', 'public', 'private', 'internal']).optional(),
  ownership: z.enum(['all', 'mine', 'others']).optional(),
  q: z.string().max(4000).optional(),
  sort: z.enum(['activity', 'stars', 'open', 'name']).optional(),
});
const setCreate = z.object({ name, repos: repoList }).strict();
/** A source, by its host (github.com, gitlab.example.com). */
const source = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'must be a host name like gitlab.example.com');
const lookupQuery = z.object({ repo: z.string().trim().min(1).max(500), source: source.optional() });
const candidatesQuery = z.object({ refresh: z.literal('1').optional(), source: source.optional() });
const addBody = z.object({ repo: z.string().trim().min(1).max(500), source: source.optional(), includeInDefault: z.boolean().optional() }).strict();
const removeQuery = z.object({ source: source.optional() });
const setPatch = z.object({ name: name.optional(), repos: repoList.optional() }).strict();
const viewCreate = z
  .object({
    name,
    path: z.string().trim().regex(/^\/[^?#]*$/, 'must be an app path like /prs'),
    query: z.string().trim().max(4000).transform((q) => q.replace(/^\?/, '')),
  })
  .strict();

function idParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

export function repoRoutes({ db, config, tracking, diffs }: AppDeps): Hono {
  const r = new Hono();
  if (!tracking) throw new Error('repoRoutes needs tracking');

  r.get('/repos', (c) => c.json({ items: queryRepos({ db, config }, parseWith(repoQuery, c.req.query())) }));

  r.get('/repos/:repo', (c) => c.json(repoDetail({ db, config }, c.req.param('repo'))));

  r.patch('/repos/:repo', async (c) => c.json(patchRepo({ db, config }, c.req.param('repo'), parseWith(repoPatch, await jsonBody(c)))));

  // Adding and removing repositories of other owners, on any source (`source`: its host; github.com by default). The
  // GETs spend the owner's quota on the code host: not for other sites.
  r.get('/repo-candidates', noCrossSiteReads, async (c) => {
    const q = parseWith(candidatesQuery, c.req.query());
    return c.json(await tracking.candidates({ refresh: !!q.refresh, source: q.source }));
  });

  r.get('/repo-lookup', noCrossSiteReads, async (c) => {
    const q = parseWith(lookupQuery, c.req.query());
    return c.json(await tracking.lookup(q.repo, q.source));
  });

  r.post('/repos', async (c) => {
    const body = parseWith(addBody, await jsonBody(c));
    return c.json(await tracking.add(body.repo, body.includeInDefault ?? true, body.source), 201);
  });

  // With `source`, the repo may also be named by its path there (group%2Fproject), and must be on that source. A
  // source that isn't configured on this server still has its repos removed: that needs no token.
  r.delete('/repos/:repo', (c) => {
    removeTrackedRepo({ db, diffs }, c.req.param('repo'), parseWith(removeQuery, c.req.query()).source);
    return c.body(null, 204);
  });

  r.get('/sets', (c) => c.json({ items: listSets(db) }));

  r.post('/sets', async (c) => {
    const body = parseWith(setCreate, await jsonBody(c));
    return c.json(createSet(db, body.name, body.repos));
  });

  r.patch('/sets/:id', async (c) => {
    const body = parseWith(setPatch, await jsonBody(c));
    const set = updateSet(db, idParam(c.req.param('id')), body);
    if (!set) throw new HttpError(404, 'Set not found');
    return c.json(set);
  });

  r.delete('/sets/:id', (c) => {
    if (!deleteSet(db, idParam(c.req.param('id')))) throw new HttpError(404, 'Set not found');
    return c.body(null, 204);
  });

  r.get('/views', (c) => c.json({ items: listViews(db) }));

  r.post('/views', async (c) => {
    const body = parseWith(viewCreate, await jsonBody(c));
    return c.json(createView(db, body));
  });

  r.delete('/views/:id', (c) => {
    if (!deleteView(db, idParam(c.req.param('id')))) throw new HttpError(404, 'View not found');
    return c.body(null, 204);
  });

  return r;
}
