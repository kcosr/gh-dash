import { Hono } from 'hono';
import { z } from 'zod';
import { selectRepos } from '../../../shared/repos';
import { resolveRepo } from '../../db/repo-key';
import { getSettings } from '../../db/settings';
import { createSet, createView, deleteSet, deleteView, getRepo, listRepos, listSets, listViews, removeRepo, setRepoPrefs, updateSet } from '../../db/repos';
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
const lookupQuery = z.object({ repo: z.string().trim().min(1).max(500) });
const candidatesQuery = z.object({ refresh: z.literal('1').optional() });
const addBody = z.object({ repo: z.string().trim().min(1).max(500), includeInDefault: z.boolean().optional() }).strict();
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

  r.get('/repos', (c) => {
    const query = parseWith(repoQuery, c.req.query());
    return c.json({ items: selectRepos(listRepos(db, config.defaultTz), query, getSettings(db).includeForks) });
  });

  r.get('/repos/:repo', (c) => {
    const repo = getRepo(db, c.req.param('repo'), config.defaultTz);
    if (!repo) throw new HttpError(404, 'Repository not found');
    return c.json(repo);
  });

  r.patch('/repos/:repo', async (c) => {
    const prefs = parseWith(repoPatch, await jsonBody(c));
    if (!setRepoPrefs(db, c.req.param('repo'), prefs)) throw new HttpError(404, 'Repository not found');
    return c.json(getRepo(db, c.req.param('repo'), config.defaultTz));
  });

  // Adding and removing repositories of other owners. The GETs spend the owner's GitHub quota: not for other sites.
  r.get('/repo-candidates', noCrossSiteReads, async (c) => {
    const { refresh } = parseWith(candidatesQuery, c.req.query());
    return c.json(await tracking.candidates(!!refresh));
  });

  r.get('/repo-lookup', noCrossSiteReads, async (c) => {
    const { repo } = parseWith(lookupQuery, c.req.query());
    return c.json(await tracking.lookup(repo));
  });

  r.post('/repos', async (c) => {
    const body = parseWith(addBody, await jsonBody(c));
    return c.json(await tracking.add(body.repo, body.includeInDefault ?? true), 201);
  });

  r.delete('/repos/:repo', (c) => {
    const ref = resolveRepo(db, c.req.param('repo'));
    if (!ref) throw new HttpError(404, 'Repository not found');
    if (ref.trackedBy === 'owned') {
      throw new HttpError(409, 'Repositories you own are tracked automatically; hide it instead.', { key: ref.key, trackedBy: 'owned' });
    }
    // TODO(diff-comments): once comments exist, the Remove confirmation shows how many of the user's comments go with
    // the repo (the user decided: show the count, then delete). Add Repo.commentCount; the cascade already deletes them.
    removeRepo(db, ref.id);
    diffs.evict();
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
