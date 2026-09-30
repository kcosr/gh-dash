// The list, detail and stats queries as plain functions: no Hono context, and failures as HttpError. The routes
// (api/routes/lists.ts, stats.ts) parse the request and call these; a later MCP transport calls them with a tool's
// arguments. Input is the validated shape of api/scope.ts's schemas (parseWith(schema, plain object) makes one).

import type { z } from 'zod';
import type {
  ActivityEvent,
  ActivityResponse,
  BranchesResponse,
  Commit,
  Issue,
  ListFormat,
  ListResponse,
  PrListResponse,
  PullRequestDetail,
  Release,
  Star,
  StatsResponse,
} from '../../shared/api';
import {
  activityQuerySchema,
  branchQuerySchema,
  decodeCursor,
  encodeCursor,
  issueQuerySchema,
  listQuerySchema,
  parseTypes,
  prQuerySchema,
  scopeFor,
  scopeSchema,
  splitList,
  statsQuerySchema,
} from '../api/scope';
import type { Config } from '../config';
import { listBranches } from '../db/branches';
import type { Db } from '../db/db';
import { loadQueryCtx, type QueryCtx, type Scope } from '../db/filters';
import { getPrDetail, listActivity, listCommits, listIssues, listPrs, listReleases, listStars, type Page } from '../db/lists';
import { computeStats } from '../db/stats';
import { activityCsv, commitsCsv, issuesCsv, prsCsv, releasesCsv, starsCsv } from '../format/csv';
import { eventsMarkdown, type KindOf, type MdContext, prsMarkdown } from '../format/markdown';
import { HttpError } from '../lib/errors';

export interface QueryDeps {
  db: Db;
  config: Pick<Config, 'defaultTz' | 'myEmails'>;
}

export type ScopeParams = z.infer<typeof scopeSchema>;
type PageParams = { limit?: number; cursor?: string; format?: ListFormat };

/**
 * What a list answers: the JSON page, or (`format` md / csv) the whole selection rendered as text. A transport picks
 * the content type from `format`.
 */
export type ListReply<T> = { format: 'json'; body: T } | { format: 'md' | 'csv'; text: string };

/**
 * A request's scope and the per-request facts "me" and the default selection need. 400 for a bad range or timezone, and
 * for a `source` host that isn't a source of this database (`scopeFor`: a typo shouldn't read as "nothing here").
 */
export function scopedQuery(db: Db, config: QueryDeps['config'], query: ScopeParams, now = Date.now()): { scope: Scope; ctx: QueryCtx } {
  const scope = scopeFor(db, query, config.defaultTz, now);
  return { scope, ctx: loadQueryCtx(db, config.myEmails) };
}

/** A PR number from a path parameter; 400 unless it is a positive integer. */
export function parsePrNumber(value: string | number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Invalid PR number');
  return number;
}

export function page(q: PageParams, keyLength: number): NonNullable<Page> {
  return { limit: q.limit ?? 200, after: decodeCursor(q.cursor, keyLength) };
}

/** Each repo's code host (by repo key), for the exports' words (`#`/`!`, PRs/MRs). Unknown keys read as GitHub. */
export function repoKinds(db: Db): KindOf {
  const kinds = new Map(
    db.all<{ key: string; kind: string }>('SELECT r.key, s.kind FROM repos r JOIN sources s ON s.id = r.source_id').map((r) => [r.key, r.kind]),
  );
  return (repo) => (kinds.get(repo) === 'gitlab' ? 'gitlab' : 'github');
}

const mdCtx = (scope: Scope, kindOf: KindOf): MdContext => ({ tz: scope.tz, now: Date.now(), from: scope.from, to: scope.to, kindOf });

// Entities as feed events, so every list's Markdown shares the day-grouped event format.
const commitEvent = (commit: Commit): ActivityEvent => ({ type: 'commit', at: commit.committedAt, repo: commit.repo, actor: commit.author, commit });
const issueEvent = (issue: Issue): ActivityEvent =>
  issue.state === 'closed'
    ? { type: 'issue', kind: 'closed', at: issue.closedAt ?? issue.updatedAt, repo: issue.repo, actor: issue.closedBy ?? issue.author, issue }
    : { type: 'issue', kind: 'opened', at: issue.createdAt, repo: issue.repo, actor: issue.author, issue };
const releaseEvent = (release: Release): ActivityEvent => ({ type: 'release', at: release.publishedAt, repo: release.repo, actor: release.author, release });
const starEvent = (s: Star): ActivityEvent => ({ type: 'star', at: s.starredAt, repo: s.repo, actor: s.user });

const json = <T>(body: T): ListReply<T> => ({ format: 'json', body });
const markdown = (text: string): ListReply<never> => ({ format: 'md', text });
const csv = (text: string): ListReply<never> => ({ format: 'csv', text });
const wantsText = (q: PageParams) => q.format === 'md' || q.format === 'csv';

export function queryPrs({ db, config }: QueryDeps, q: z.infer<typeof prQuerySchema>): ListReply<PrListResponse> {
  const { scope, ctx } = scopedQuery(db, config, q);
  const filter = { state: q.state ?? 'all', labels: splitList(q.labels), comments: q.comments };
  if (wantsText(q)) {
    const { items } = listPrs(db, ctx, scope, filter, null);
    return q.format === 'md'
      ? markdown(prsMarkdown(items, { state: filter.state, who: scope.who, group: q.group ?? 'week' }, mdCtx(scope, repoKinds(db))))
      : csv(prsCsv(items));
  }
  const res = listPrs(db, ctx, scope, filter, page(q, 3));
  return json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
}

/** Branches with no PR yet, from the sync (no code host request): JSON only, as branchQuerySchema allows. */
export function queryBranches({ db, config }: QueryDeps, q: z.infer<typeof branchQuerySchema>): BranchesResponse {
  const { scope, ctx } = scopedQuery(db, config, q);
  const res = listBranches(db, ctx, scope, page(q, 3));
  return { ...res, nextCursor: encodeCursor(res.nextCursor) };
}

/** One pull request (or merge request) with its commits and linked issues; `repo` is a key; 400 / 404. */
export function prDetail({ db, config }: QueryDeps, repo: string, number: string | number): PullRequestDetail {
  const n = parsePrNumber(number);
  const pr = getPrDetail(db, loadQueryCtx(db, config.myEmails), repo, n);
  if (!pr) throw new HttpError(404, 'Pull request not found');
  return pr;
}

export function queryActivity({ db, config }: QueryDeps, q: z.infer<typeof activityQuerySchema>): ListReply<ActivityResponse> {
  const { scope, ctx } = scopedQuery(db, config, q);
  const types = parseTypes(q.types);
  if (wantsText(q)) {
    const { items } = listActivity(db, ctx, scope, types, null);
    const kindOf = repoKinds(db);
    return q.format === 'md' ? markdown(eventsMarkdown('Activity', items, mdCtx(scope, kindOf))) : csv(activityCsv(items, kindOf));
  }
  const res = listActivity(db, ctx, scope, types, page(q, 2));
  return json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
}

export function queryCommits({ db, config }: QueryDeps, q: z.infer<typeof listQuerySchema>): ListReply<ListResponse<Commit>> {
  const { scope, ctx } = scopedQuery(db, config, q);
  if (wantsText(q)) {
    const { items } = listCommits(db, ctx, scope, null);
    return q.format === 'md' ? markdown(eventsMarkdown('Commits', items.map(commitEvent), mdCtx(scope, repoKinds(db)))) : csv(commitsCsv(items));
  }
  const res = listCommits(db, ctx, scope, page(q, 3));
  return json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
}

export function queryIssues({ db, config }: QueryDeps, q: z.infer<typeof issueQuerySchema>): ListReply<ListResponse<Issue>> {
  const { scope, ctx } = scopedQuery(db, config, q);
  const state = q.state ?? 'all';
  if (wantsText(q)) {
    const { items } = listIssues(db, ctx, scope, state, null);
    return q.format === 'md' ? markdown(eventsMarkdown('Issues', items.map(issueEvent), mdCtx(scope, repoKinds(db)))) : csv(issuesCsv(items));
  }
  const res = listIssues(db, ctx, scope, state, page(q, 3));
  return json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
}

export function queryReleases({ db, config }: QueryDeps, q: z.infer<typeof listQuerySchema>): ListReply<ListResponse<Release>> {
  const { scope, ctx } = scopedQuery(db, config, q);
  if (wantsText(q)) {
    const { items } = listReleases(db, ctx, scope, null);
    return q.format === 'md' ? markdown(eventsMarkdown('Releases', items.map(releaseEvent), mdCtx(scope, repoKinds(db)))) : csv(releasesCsv(items));
  }
  const res = listReleases(db, ctx, scope, page(q, 3));
  return json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
}

export function queryStars({ db, config }: QueryDeps, q: z.infer<typeof listQuerySchema>): ListReply<ListResponse<Star>> {
  const { scope, ctx } = scopedQuery(db, config, q);
  if (wantsText(q)) {
    const { items } = listStars(db, ctx, scope, null);
    return q.format === 'md' ? markdown(eventsMarkdown('Stars', items.map(starEvent), mdCtx(scope, repoKinds(db)))) : csv(starsCsv(items));
  }
  const res = listStars(db, ctx, scope, page(q, 3));
  return json({ ...res, nextCursor: encodeCursor(res.nextCursor) });
}

export function queryStats({ db, config }: QueryDeps, q: z.infer<typeof statsQuerySchema>): StatsResponse {
  const { scope, ctx } = scopedQuery(db, config, q);
  return computeStats(db, ctx, scope, q.bucket);
}
