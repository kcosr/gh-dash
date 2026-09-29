import { type Context, Hono } from 'hono';
import type { ActivityEvent, Commit, Issue, Release, Star } from '../../../shared/api';
import type { Scope } from '../../db/filters';
import { loadQueryCtx } from '../../db/filters';
import {
  getPrDetail,
  listActivity,
  listCommits,
  listIssues,
  listPrs,
  listReleases,
  listStars,
  type Page,
} from '../../db/lists';
import { activityCsv, commitsCsv, issuesCsv, prsCsv, releasesCsv, starsCsv } from '../../format/csv';
import { eventsMarkdown, type MdContext, prsMarkdown } from '../../format/markdown';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';
import {
  activityQuerySchema,
  decodeCursor,
  encodeCursor,
  issueQuerySchema,
  listQuerySchema,
  pageSchema,
  parseScope,
  parseTypes,
  prQuerySchema,
  splitList,
} from '../scope';
import type { z } from 'zod';

type PageQuery = z.infer<typeof pageSchema>;

const markdown = (c: Context, text: string) => c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
const csv = (c: Context, text: string) => c.body(text, 200, { 'Content-Type': 'text/csv; charset=utf-8' });

function page(q: PageQuery, keyLength: number): Page {
  return { limit: q.limit ?? 200, after: decodeCursor(q.cursor, keyLength) };
}

const mdCtx = (scope: Scope): MdContext => ({ tz: scope.tz, now: Date.now(), from: scope.from, to: scope.to });

// Entities as feed events, so every list's Markdown shares the day-grouped event format.
const commitEvent = (commit: Commit): ActivityEvent => ({ type: 'commit', at: commit.committedAt, repo: commit.repo, actor: commit.author, commit });
const issueEvent = (issue: Issue): ActivityEvent =>
  issue.state === 'closed'
    ? { type: 'issue', kind: 'closed', at: issue.closedAt ?? issue.updatedAt, repo: issue.repo, actor: issue.closedBy ?? issue.author, issue }
    : { type: 'issue', kind: 'opened', at: issue.createdAt, repo: issue.repo, actor: issue.author, issue };
const releaseEvent = (release: Release): ActivityEvent => ({ type: 'release', at: release.publishedAt, repo: release.repo, actor: release.author, release });
const starEvent = (s: Star): ActivityEvent => ({ type: 'star', at: s.starredAt, repo: s.repo, actor: s.user });

export function listRoutes({ db, config }: AppDeps): Hono {
  const r = new Hono();

  r.get('/prs', (c) => {
    const q = parseWith(prQuerySchema, c.req.query());
    const scope = parseScope(q, config.defaultTz);
    const ctx = loadQueryCtx(db, config.myEmails);
    const filter = { state: q.state ?? 'all', labels: splitList(q.labels), comments: q.comments };
    if (q.format === 'md' || q.format === 'csv') {
      const { items } = listPrs(db, ctx, scope, filter, null);
      return q.format === 'md'
        ? markdown(c, prsMarkdown(items, { state: filter.state, who: scope.who, group: q.group ?? 'week' }, mdCtx(scope)))
        : csv(c, prsCsv(items));
    }
    const res = listPrs(db, ctx, scope, filter, page(q, 3));
    return c.json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
  });

  r.get('/prs/:repo/:number', (c) => {
    const number = Number(c.req.param('number'));
    if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Invalid PR number');
    const pr = getPrDetail(db, loadQueryCtx(db, config.myEmails), c.req.param('repo'), number);
    if (!pr) throw new HttpError(404, 'Pull request not found');
    return c.json(pr);
  });

  r.get('/activity', (c) => {
    const q = parseWith(activityQuerySchema, c.req.query());
    const scope = parseScope(q, config.defaultTz);
    const types = parseTypes(q.types);
    const ctx = loadQueryCtx(db, config.myEmails);
    if (q.format === 'md' || q.format === 'csv') {
      const { items } = listActivity(db, ctx, scope, types, null);
      return q.format === 'md' ? markdown(c, eventsMarkdown('Activity', items, mdCtx(scope))) : csv(c, activityCsv(items));
    }
    const res = listActivity(db, ctx, scope, types, page(q, 2));
    return c.json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
  });

  r.get('/commits', (c) => {
    const q = parseWith(listQuerySchema, c.req.query());
    const scope = parseScope(q, config.defaultTz);
    const ctx = loadQueryCtx(db, config.myEmails);
    if (q.format === 'md' || q.format === 'csv') {
      const { items } = listCommits(db, ctx, scope, null);
      return q.format === 'md' ? markdown(c, eventsMarkdown('Commits', items.map(commitEvent), mdCtx(scope))) : csv(c, commitsCsv(items));
    }
    const res = listCommits(db, ctx, scope, page(q, 3));
    return c.json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
  });

  r.get('/issues', (c) => {
    const q = parseWith(issueQuerySchema, c.req.query());
    const scope = parseScope(q, config.defaultTz);
    const ctx = loadQueryCtx(db, config.myEmails);
    const state = q.state ?? 'all';
    if (q.format === 'md' || q.format === 'csv') {
      const { items } = listIssues(db, ctx, scope, state, null);
      return q.format === 'md' ? markdown(c, eventsMarkdown('Issues', items.map(issueEvent), mdCtx(scope))) : csv(c, issuesCsv(items));
    }
    const res = listIssues(db, ctx, scope, state, page(q, 3));
    return c.json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
  });

  r.get('/releases', (c) => {
    const q = parseWith(listQuerySchema, c.req.query());
    const scope = parseScope(q, config.defaultTz);
    const ctx = loadQueryCtx(db, config.myEmails);
    if (q.format === 'md' || q.format === 'csv') {
      const { items } = listReleases(db, ctx, scope, null);
      return q.format === 'md'
        ? markdown(c, eventsMarkdown('Releases', items.map(releaseEvent), mdCtx(scope)))
        : csv(c, releasesCsv(items));
    }
    const res = listReleases(db, ctx, scope, page(q, 3));
    return c.json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
  });

  r.get('/stars', (c) => {
    const q = parseWith(listQuerySchema, c.req.query());
    const scope = parseScope(q, config.defaultTz);
    const ctx = loadQueryCtx(db, config.myEmails);
    if (q.format === 'md' || q.format === 'csv') {
      const { items } = listStars(db, ctx, scope, null);
      return q.format === 'md' ? markdown(c, eventsMarkdown('Stars', items.map(starEvent), mdCtx(scope))) : csv(c, starsCsv(items));
    }
    const res = listStars(db, ctx, scope, page(q, 3));
    return c.json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
  });

  return r;
}
