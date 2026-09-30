import { type Context, Hono } from 'hono';
import type { AppDeps } from '../app';
import { parseWith } from '../http';
import { activityQuerySchema, branchQuerySchema, issueQuerySchema, listQuerySchema, prQuerySchema } from '../scope';
import {
  prDetail,
  queryActivity,
  queryBranches,
  queryCommits,
  queryIssues,
  queryPrs,
  queryReleases,
  queryStars,
  type ListReply,
} from '../../services/lists';

/** Sends a list service's answer: the JSON page, or the text export with its content type. */
function reply<T>(c: Context, out: ListReply<T>) {
  if (out.format === 'json') return c.json(out.body);
  return c.body(out.text, 200, { 'Content-Type': out.format === 'md' ? 'text/markdown; charset=utf-8' : 'text/csv; charset=utf-8' });
}

// Thin adapters: parse the query, call the service (services/lists.ts), send the answer.
export function listRoutes({ db, config }: AppDeps): Hono {
  const r = new Hono();
  const deps = { db, config };

  r.get('/prs', (c) => reply(c, queryPrs(deps, parseWith(prQuerySchema, c.req.query()))));

  r.get('/prs/:repo/:number', (c) => c.json(prDetail(deps, c.req.param('repo'), c.req.param('number'))));

  // The branches the sync holds that have no PR yet, across repos: no code host request, so no noCrossSiteReads. One
  // repo's branches, with or without a PR, are /branches/:repo (routes/diffs.ts): a segment longer, no clash.
  r.get('/branches', (c) => c.json(queryBranches(deps, parseWith(branchQuerySchema, c.req.query()))));

  r.get('/activity', (c) => reply(c, queryActivity(deps, parseWith(activityQuerySchema, c.req.query()))));

  r.get('/commits', (c) => reply(c, queryCommits(deps, parseWith(listQuerySchema, c.req.query()))));

  r.get('/issues', (c) => reply(c, queryIssues(deps, parseWith(issueQuerySchema, c.req.query()))));

  r.get('/releases', (c) => reply(c, queryReleases(deps, parseWith(listQuerySchema, c.req.query()))));

  r.get('/stars', (c) => reply(c, queryStars(deps, parseWith(listQuerySchema, c.req.query()))));

  return r;
}
