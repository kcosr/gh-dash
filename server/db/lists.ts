import type {
  ActivityEvent,
  CommentActivity,
  CommentEventKind,
  CommentFilter,
  Commit,
  EventType,
  Facets,
  Issue,
  IssueState,
  PrincipalKind,
  PrStateFilter,
  PullRequest,
  PullRequestDetail,
  Release,
  Star,
} from '../../shared/api';
import { localDateSql, offsetSegments } from '../lib/time';
import { prViewSql, SELF_PRINCIPAL_ID } from './comments';
import type { Db, Param } from './db';
import {
  addLike,
  addRange,
  addRepoScope,
  addText,
  addWho,
  type FtsTable,
  isMeFn,
  type QueryCtx,
  type Scope,
  Where,
} from './filters';
import { repoKeySql, resolveRepo } from './repo-key';
import { prCommitHeadlineSql } from './thread-list';
import {
  type CommitRow,
  type IssueRow,
  type PrCommitRow,
  type PrRow,
  type ReleaseRow,
  type StarRow,
  toCommit,
  toIssue,
  toPr,
  toPrDetail,
  toRelease,
  toStar,
} from './rows';

/** Sort key of a row: [timestamp, ...tie-breakers]; the API encodes it as the opaque cursor. */
export type CursorKey = (string | number)[];

/** null = every matching row (used by format=md/csv). */
export type Page = { limit: number; after: CursorKey | null } | null;

export interface ListResult<T> {
  items: T[];
  nextCursor: CursorKey | null;
  total: number;
}

interface PagedSpec<R> {
  /** FROM clause (with joins). */
  from: string;
  /** Parameters bound inside `from` (e.g. a subquery). */
  fromParams?: Param[];
  select: string;
  where: Where;
  /** Sorted DESC. */
  at: string;
  /** Tie-breakers, sorted ASC. */
  keys: string[];
  cursorOf: (row: R) => CursorKey;
}

/** `knownTotal`: skip the count query when the caller already has the total. */
function runPaged<R>(db: Db, spec: PagedSpec<R>, page: Page, knownTotal?: number): { rows: R[]; next: CursorKey | null; total: number } {
  const whereSql = spec.where.toSql();
  const baseParams = [...(spec.fromParams ?? []), ...spec.where.params];
  const total = knownTotal ?? db.get<{ n: number }>(`SELECT count(*) AS n FROM ${spec.from} WHERE ${whereSql}`, baseParams)!.n;
  const order = `ORDER BY ${spec.at} DESC, ${spec.keys.map((k) => `${k} ASC`).join(', ')}`;
  if (!page) {
    const rows = db.all<R>(`SELECT ${spec.select} FROM ${spec.from} WHERE ${whereSql} ${order}`, baseParams);
    return { rows, next: null, total };
  }
  const params: Param[] = [...baseParams];
  let keyset = '';
  if (page.after) {
    const [at, ...rest] = page.after;
    keyset = ` AND (${spec.at} < ? OR (${spec.at} = ? AND (${spec.keys.join(', ')}) > (${spec.keys.map(() => '?').join(', ')})))`;
    params.push(at!, at!, ...rest);
  }
  params.push(page.limit + 1);
  const rows = db.all<R>(`SELECT ${spec.select} FROM ${spec.from} WHERE ${whereSql}${keyset} ${order} LIMIT ?`, params);
  const hasMore = rows.length > page.limit;
  if (hasMore) rows.length = page.limit;
  return { rows, next: hasMore ? spec.cursorOf(rows[rows.length - 1]!) : null, total };
}

function facetByRepo(db: Db, from: string, where: Where): Record<string, number> {
  const rows = db.all<{ repo: string; n: number }>(
    `SELECT ${repoKeySql('r')} AS repo, count(*) AS n FROM ${from} WHERE ${where.toSql()} GROUP BY ${repoKeySql('r')}`,
    where.params,
  );
  return Object.fromEntries(rows.map((r) => [r.repo, r.n]));
}

const idList = (ids: number[]) => JSON.stringify(ids);

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface PrFilter {
  state: PrStateFilter;
  labels: string[] | null;
  /** Only PRs with local comment threads (any, or unresolved ones). */
  comments?: CommentFilter;
}

export const PR_FROM = 'pull_requests p JOIN repos r ON r.id = p.repo_id';
// A PR's threads as its view shows them (db/comments.ts): its own, keyed by repo and number (not p.id) so they match
// the PR's current row, and its branch group. Counted per row of a page only; filtering by them goes the other way.
const PR_THREADS = `FROM comment_threads t WHERE (${prViewSql('t', 'p')})`;
export const PR_SELECT =
  `p.*, ${repoKeySql('r')} AS repo, r.source_id AS source_id, ` +
  `(SELECT count(*) ${PR_THREADS}) AS threads, (SELECT count(*) ${PR_THREADS} AND t.status = 'open') AS unresolved_threads`;
/**
 * The ids of the PRs whose view shows a thread (an open one, for `unresolved`), found from the threads: they are few
 * beside the PRs a filter looks through, and each finds its PRs by index (its own by number, its group's by head
 * branch). Run once per query.
 */
const prsWithThreads = (f: CommentFilter) =>
  `SELECT tp.id FROM comment_threads t JOIN pull_requests tp ON ${prViewSql('t', 'tp')}${f === 'unresolved' ? " WHERE t.status = 'open'" : ''}`;

// Commit threads are keyed by repo and oid, with no PR number or branch: a PR's or a branch's threads made on a commit
// are not the commit's.
const COMMIT_THREADS = 'FROM comment_threads t WHERE t.repo_id = c.repo_id AND t.pr_number IS NULL AND t.branch IS NULL AND t.commit_oid = c.oid';
export const COMMIT_SELECT =
  `c.*, ${repoKeySql('r')} AS repo, r.source_id AS source_id, ` +
  `(SELECT count(*) ${COMMIT_THREADS}) AS threads, (SELECT count(*) ${COMMIT_THREADS} AND t.status = 'open') AS unresolved_threads`;

function prWhere(ctx: QueryCtx, scope: Scope, f: PrFilter, ignoreRepos: boolean): Where {
  const w = new Where();
  addRepoScope(w, scope, ctx, ignoreRepos);
  if (f.state !== 'all') w.add('p.state = ?', f.state);
  if (f.labels?.length) {
    w.add(
      `EXISTS (SELECT 1 FROM json_each(p.labels) l WHERE lower(json_extract(l.value, '$.name')) IN (SELECT value FROM json_each(?)))`,
      JSON.stringify(f.labels.map((l) => l.toLowerCase())),
    );
  }
  if (f.comments) w.add(`p.id IN (${prsWithThreads(f.comments)})`);
  addRange(w, 'p.activity_at', scope);
  addWho(w, scope.who, ctx, 'p.author_login');
  addText(w, scope.q, 'pull_requests', 'p', ['p.title', 'p.body']);
  return w;
}

export function listPrs(
  db: Db,
  ctx: QueryCtx,
  scope: Scope,
  f: PrFilter,
  page: Page,
): ListResult<PullRequest> & { facets: Facets } {
  const isMe = isMeFn(ctx);
  const { rows, next, total } = runPaged<PrRow>(db, {
    from: PR_FROM,
    select: PR_SELECT,
    where: prWhere(ctx, scope, f, false),
    at: 'p.activity_at',
    keys: [repoKeySql('r'), 'p.number'],
    cursorOf: (r) => [r.activity_at, r.repo, r.number],
  }, page);
  return {
    items: rows.map((r) => toPr(r, isMe)),
    nextCursor: next,
    total,
    facets: { byRepo: facetByRepo(db, PR_FROM, prWhere(ctx, scope, f, true)) },
  };
}

export function getPrDetail(db: Db, ctx: QueryCtx, repo: string, number: number): PullRequestDetail | null {
  const ref = resolveRepo(db, repo);
  if (!ref) return null;
  const row = db.get<PrRow>(`SELECT ${PR_SELECT} FROM ${PR_FROM} WHERE p.repo_id = ? AND p.number = ?`, [ref.id, number]);
  if (!row) return null;
  const commits = db.all<PrCommitRow>('SELECT * FROM pr_commits WHERE pr_id = ? ORDER BY position', [row.id]);
  return toPrDetail(row, commits, isMeFn(ctx));
}

// ---------------------------------------------------------------------------
// Commits, issues, releases, stars
// ---------------------------------------------------------------------------

export function listCommits(db: Db, ctx: QueryCtx, scope: Scope, page: Page): ListResult<Commit> {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  addRange(w, 'c.committed_at', scope);
  addWho(w, scope.who, ctx, 'c.author_login', 'c.author_email');
  addText(w, scope.q, 'commits', 'c', ['c.headline', 'c.body']);
  const isMe = isMeFn(ctx);
  const { rows, next, total } = runPaged<CommitRow>(db, {
    from: 'commits c JOIN repos r ON r.id = c.repo_id',
    select: COMMIT_SELECT,
    where: w,
    at: 'c.committed_at',
    keys: [repoKeySql('r'), 'c.oid'],
    cursorOf: (r) => [r.committed_at, r.repo, r.oid],
  }, page);
  return { items: rows.map((r) => toCommit(r, isMe)), nextCursor: next, total };
}

export function listIssues(db: Db, ctx: QueryCtx, scope: Scope, state: IssueState | 'all', page: Page): ListResult<Issue> {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  if (state !== 'all') w.add('i.state = ?', state);
  addRange(w, 'i.activity_at', scope);
  addWho(w, scope.who, ctx, 'i.author_login');
  addText(w, scope.q, 'issues', 'i', ['i.title', 'i.body']);
  const isMe = isMeFn(ctx);
  const { rows, next, total } = runPaged<IssueRow>(db, {
    from: 'issues i JOIN repos r ON r.id = i.repo_id',
    select: `i.*, ${repoKeySql('r')} AS repo, r.source_id AS source_id`,
    where: w,
    at: 'i.activity_at',
    keys: [repoKeySql('r'), 'i.number'],
    cursorOf: (r) => [r.activity_at, r.repo, r.number],
  }, page);
  return { items: rows.map((r) => toIssue(r, isMe)), nextCursor: next, total };
}

export function listReleases(db: Db, ctx: QueryCtx, scope: Scope, page: Page): ListResult<Release> {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  addRange(w, 'rel.published_at', scope);
  addWho(w, scope.who, ctx, 'rel.author_login');
  addText(w, scope.q, 'releases', 'rel', ['rel.tag', 'rel.name', 'rel.body']);
  const isMe = isMeFn(ctx);
  const { rows, next, total } = runPaged<ReleaseRow>(db, {
    from: 'releases rel JOIN repos r ON r.id = rel.repo_id',
    select: `rel.*, ${repoKeySql('r')} AS repo, r.source_id AS source_id`,
    where: w,
    at: 'rel.published_at',
    keys: [repoKeySql('r'), 'rel.tag'],
    cursorOf: (r) => [r.published_at, r.repo, r.tag],
  }, page);
  return { items: rows.map((r) => toRelease(r, isMe)), nextCursor: next, total };
}

export function listStars(db: Db, ctx: QueryCtx, scope: Scope, page: Page): ListResult<Star> {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  addRange(w, 's.starred_at', scope);
  // Like the star event source: stargazers of repos you own only.
  w.add(`r.tracked_by = 'owned'`);
  // Stars are always by others; stars carry no text for `q`.
  if (scope.who === 'me' || scope.q) w.add('0');
  const { rows, next, total } = runPaged<StarRow>(db, {
    from: 'stars s JOIN repos r ON r.id = s.repo_id',
    select: `s.*, ${repoKeySql('r')} AS repo`,
    where: w,
    at: 's.starred_at',
    keys: [repoKeySql('r'), 's.login'],
    cursorOf: (r) => [r.starred_at, r.repo, r.login],
  }, page);
  return { items: rows.map(toStar), nextCursor: next, total };
}

// ---------------------------------------------------------------------------
// Activity: a UNION of event sources, one per (type, kind)
// ---------------------------------------------------------------------------

export interface EventSource {
  type: EventType;
  kind: 'opened' | 'merged' | 'closed' | null;
  /** The kind from a column instead (comment events: CommentEventKind). */
  kindCol?: string;
  /** Short unique code, prefix of the event key used for stable ordering. */
  code: string;
  table: string;
  alias: string;
  at: string;
  /** `at` has milliseconds (gh-dash's own timestamps), so the range compares with bounds that have them too. */
  atMs?: boolean;
  extra?: string;
  /**
   * The who filter: actor columns, compared with each source's account (see meSql); or `self`, a predicate for "the
   * dashboard's user" (comment events: the principal); null = never "me" (stars).
   */
  who: { login: string; email?: string } | { self: string } | null;
  /** Words for `q`: the FTS table and the LIKE fallback's columns; no table = LIKE only. null = no text to match. */
  text: { table: FtsTable | null; like: string[] } | null;
}

export const EVENT_SOURCES: EventSource[] = [
  {
    type: 'commit', kind: null, code: 'c', table: 'commits', alias: 'c', at: 'c.committed_at', extra: 'c.pr_number IS NULL',
    who: { login: 'c.author_login', email: 'c.author_email' }, text: { table: 'commits', like: ['c.headline', 'c.body'] },
  },
  {
    type: 'pr', kind: 'opened', code: 'po', table: 'pull_requests', alias: 'p', at: 'p.created_at',
    who: { login: 'p.author_login' }, text: { table: 'pull_requests', like: ['p.title', 'p.body'] },
  },
  {
    type: 'pr', kind: 'merged', code: 'pm', table: 'pull_requests', alias: 'p', at: 'p.merged_at', extra: `p.state = 'merged'`,
    who: { login: 'p.author_login' }, text: { table: 'pull_requests', like: ['p.title', 'p.body'] },
  },
  {
    type: 'pr', kind: 'closed', code: 'pc', table: 'pull_requests', alias: 'p', at: 'p.closed_at', extra: `p.state = 'closed'`,
    who: { login: 'p.author_login' }, text: { table: 'pull_requests', like: ['p.title', 'p.body'] },
  },
  {
    type: 'issue', kind: 'opened', code: 'io', table: 'issues', alias: 'i', at: 'i.created_at',
    who: { login: 'i.author_login' }, text: { table: 'issues', like: ['i.title', 'i.body'] },
  },
  {
    type: 'issue', kind: 'closed', code: 'ic', table: 'issues', alias: 'i', at: 'i.closed_at', extra: `i.state = 'closed'`,
    who: { login: 'coalesce(i.closed_by_login, i.author_login)' }, text: { table: 'issues', like: ['i.title', 'i.body'] },
  },
  {
    type: 'release', kind: null, code: 'r', table: 'releases', alias: 'rel', at: 'rel.published_at',
    who: { login: 'rel.author_login' }, text: { table: 'releases', like: ['rel.tag', 'rel.name', 'rel.body'] },
  },
  // Stargazers are only synced for repos the viewer owns; this keeps any left from before a repo was transferred away
  // out of activity and stats.
  { type: 'star', kind: null, code: 's', table: 'stars', alias: 's', at: 's.starred_at', extra: `r.tracked_by = 'owned'`, who: null, text: null },
  // The comment event log: "me" is the dashboard's user, everyone else an agent. `q` matches the excerpt or the file.
  {
    type: 'comment', kind: null, kindCol: 'ce.kind', code: 'm', table: 'comment_events', alias: 'ce', at: 'ce.at', atMs: true,
    who: { self: `ce.actor_id = ${SELF_PRINCIPAL_ID}` }, text: { table: null, like: ['ce.excerpt', 'ce.path'] },
  },
];

interface EventRow {
  at: string;
  type: EventType;
  kind: 'opened' | 'merged' | 'closed' | CommentEventKind | null;
  eid: number;
  repo: string;
  ek: string;
}

/** Scope + range + who + text filters for one event source (the source's table is joined to repos as `r`). */
export function sourceWhere(src: EventSource, ctx: QueryCtx, scope: Scope, ignoreRepos = false): Where {
  const w = new Where();
  addRepoScope(w, scope, ctx, ignoreRepos);
  if (src.extra) w.add(src.extra);
  addRange(w, src.at, scope, src.atMs);
  if (!src.who) {
    if (scope.who === 'me') w.add('0');
  } else if ('self' in src.who) {
    if (scope.who !== 'everyone') w.add(scope.who === 'me' ? src.who.self : `NOT (${src.who.self})`);
  } else {
    addWho(w, scope.who, ctx, src.who.login, src.who.email);
  }
  if (!src.text) {
    if (scope.q) w.add('0');
  } else if (src.text.table) {
    addText(w, scope.q, src.text.table, src.alias, src.text.like);
  } else {
    addLike(w, scope.q, src.text.like);
  }
  return w;
}

function eventUnion(ctx: QueryCtx, scope: Scope, types: EventType[] | null, ignoreRepos: boolean): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  for (const src of EVENT_SOURCES) {
    if (types && !types.includes(src.type)) continue;
    const w = sourceWhere(src, ctx, scope, ignoreRepos);
    parts.push(
      `SELECT ${src.at} AS at, '${src.type}' AS type, ${src.kindCol ?? (src.kind ? `'${src.kind}'` : 'NULL')} AS kind, ${src.alias}.id AS eid, ` +
        `${repoKeySql('r')} AS repo, '${src.code}' || printf('%012d', ${src.alias}.id) AS ek ` +
        `FROM ${src.table} ${src.alias} JOIN repos r ON r.id = ${src.alias}.repo_id WHERE ${w.toSql()}`,
    );
    params.push(...w.params);
  }
  const empty = 'SELECT NULL AS at, NULL AS type, NULL AS kind, NULL AS eid, NULL AS repo, NULL AS ek WHERE 0';
  return { sql: parts.length ? parts.join(' UNION ALL ') : empty, params };
}

/**
 * Total and facets of the activity feed from a single pass: events of every type in every repo (visibility,
 * range, who and q still apply), counted per (type, repo, local day). byRepo then ignores the repo selection,
 * byType ignores `types`, and byDay / total apply both.
 */
function activityFacets(
  db: Db,
  ctx: QueryCtx,
  scope: Scope,
  types: EventType[] | null,
): { total: number; byRepo: Record<string, number>; byType: Partial<Record<EventType, number>>; byDay: Record<string, number> } {
  const union = eventUnion(ctx, scope, null, true);
  const day = localDateSql('at', offsetSegments(scope.tz, scope.from, scope.to));
  const groups = db.all<{ type: EventType; repo: string; day: string; n: number }>(
    `SELECT type, repo, ${day.sql} AS day, count(*) AS n FROM (${union.sql}) GROUP BY type, repo, day`,
    [...day.params, ...union.params],
  );
  const w = new Where();
  addRepoScope(w, scope, ctx);
  const selected = new Set(db.all<{ repo: string }>(`SELECT ${repoKeySql('r')} AS repo FROM repos r WHERE ${w.toSql()}`, w.params).map((r) => r.repo));

  let total = 0;
  const byRepo: Record<string, number> = {};
  const byType: Partial<Record<EventType, number>> = {};
  const byDay: Record<string, number> = {};
  for (const g of groups) {
    const typeOk = !types || types.includes(g.type);
    const repoOk = selected.has(g.repo);
    if (typeOk) byRepo[g.repo] = (byRepo[g.repo] ?? 0) + g.n;
    if (repoOk) byType[g.type] = (byType[g.type] ?? 0) + g.n;
    if (typeOk && repoOk) {
      byDay[g.day] = (byDay[g.day] ?? 0) + g.n;
      total += g.n;
    }
  }
  return { total, byRepo, byType, byDay };
}

export function listActivity(
  db: Db,
  ctx: QueryCtx,
  scope: Scope,
  types: EventType[] | null,
  page: Page,
): ListResult<ActivityEvent> & { facets: Facets } {
  const { total, ...facets } = activityFacets(db, ctx, scope, types);
  const union = eventUnion(ctx, scope, types, false);
  const { rows, next } = runPaged<EventRow>(db, {
    from: `(${union.sql}) AS r`,
    fromParams: union.params,
    select: 'r.*',
    where: new Where(),
    at: 'r.at',
    keys: ['r.ek'],
    cursorOf: (r) => [r.at, r.ek],
  }, page, total);

  return { items: hydrateEvents(db, ctx, rows), nextCursor: next, total, facets };
}

interface CommentEventRow {
  id: number;
  thread_id: number;
  comment_id: number | null;
  live: number;
  actor_id: number;
  actor_kind: PrincipalKind;
  actor_name: string;
  pr_number: number | null;
  branch: string | null;
  commit_oid: string;
  target_title: string | null;
  path: string | null;
  side: CommentActivity['side'];
  start_line: number | null;
  end_line: number | null;
  excerpt: string | null;
}

// What an event copied of its thread, plus what is known now: who the actor is, whether the thread is still there, and
// the title of what it is on (as GET /threads finds it, the pr_commits fallback included; a branch has none).
const COMMENT_EVENT_SELECT =
  'ce.*, (SELECT kind FROM principals WHERE id = ce.actor_id) AS actor_kind, (SELECT name FROM principals WHERE id = ce.actor_id) AS actor_name, ' +
  'EXISTS (SELECT 1 FROM comment_threads WHERE id = ce.thread_id) AS live, ' +
  'CASE WHEN ce.pr_number IS NOT NULL THEN (SELECT title FROM pull_requests WHERE repo_id = ce.repo_id AND number = ce.pr_number) ' +
  'WHEN ce.branch IS NOT NULL THEN NULL ' +
  `ELSE COALESCE((SELECT headline FROM commits WHERE repo_id = ce.repo_id AND oid = ce.commit_oid), ${prCommitHeadlineSql('ce')}) END AS target_title`;

/** What an event's thread is on, derived as a thread's kind is (db/comments.ts hydrate). */
function eventTarget(r: CommentEventRow): CommentActivity['target'] {
  if (r.pr_number !== null) return { kind: 'pr', number: r.pr_number, title: r.target_title };
  if (r.branch !== null) return { kind: 'branch', branch: r.branch, title: null };
  return { kind: 'commit', oid: r.commit_oid, title: r.target_title };
}

const toCommentActivity = (r: CommentEventRow): CommentActivity => ({
  eventId: r.id,
  threadId: r.thread_id,
  commentId: r.comment_id,
  live: !!r.live,
  by: { id: r.actor_id, kind: r.actor_kind, name: r.actor_name },
  target: eventTarget(r),
  commitOid: r.commit_oid,
  path: r.path,
  side: r.side,
  startLine: r.start_line,
  endLine: r.end_line,
  excerpt: r.excerpt,
});

function hydrateEvents(db: Db, ctx: QueryCtx, rows: EventRow[]): ActivityEvent[] {
  const isMe = isMeFn(ctx);
  const ids = (type: EventType) => idList([...new Set(rows.filter((r) => r.type === type).map((r) => r.eid))]);
  // `select` defaults to the entity and its repo; PRs and commits add their local comment counts (only the page's rows).
  const load = <R extends { id: number }, T>(type: EventType, table: string, alias: string, map: (row: R) => T, select = `${alias}.*, ${repoKeySql('r')} AS repo, r.source_id AS source_id`) => {
    const out = new Map<number, T>();
    if (!rows.some((r) => r.type === type)) return out;
    const sql = `SELECT ${select} FROM ${table} ${alias} JOIN repos r ON r.id = ${alias}.repo_id WHERE ${alias}.id IN (SELECT value FROM json_each(?))`;
    for (const row of db.all<R>(sql, [ids(type)])) out.set(row.id, map(row));
    return out;
  };
  const commits = load<CommitRow, Commit>('commit', 'commits', 'c', (r) => toCommit(r, isMe), COMMIT_SELECT);
  const prs = load<PrRow, PullRequest>('pr', 'pull_requests', 'p', (r) => toPr(r, isMe), PR_SELECT);
  const issues = load<IssueRow, Issue>('issue', 'issues', 'i', (r) => toIssue(r, isMe));
  const releases = load<ReleaseRow, Release>('release', 'releases', 'rel', (r) => toRelease(r, isMe));
  const stars = load<StarRow, Star>('star', 'stars', 's', toStar);
  const comments = load<CommentEventRow, CommentActivity>('comment', 'comment_events', 'ce', toCommentActivity, COMMENT_EVENT_SELECT);

  return rows.map((e): ActivityEvent => {
    const base = { at: e.at, repo: e.repo };
    switch (e.type) {
      case 'commit': {
        const commit = commits.get(e.eid)!;
        return { type: 'commit', ...base, actor: commit.author, commit };
      }
      case 'pr': {
        const pr = prs.get(e.eid)!;
        return { type: 'pr', kind: e.kind as 'opened' | 'merged' | 'closed', ...base, actor: pr.author, pr };
      }
      case 'issue': {
        const issue = issues.get(e.eid)!;
        const actor = e.kind === 'closed' ? (issue.closedBy ?? issue.author) : issue.author;
        return { type: 'issue', kind: e.kind as 'opened' | 'closed', ...base, actor, issue };
      }
      case 'release': {
        const release = releases.get(e.eid)!;
        return { type: 'release', ...base, actor: release.author, release };
      }
      case 'star':
        return { type: 'star', ...base, actor: stars.get(e.eid)!.user };
      case 'comment': {
        const comment = comments.get(e.eid)!;
        // A principal, not an account: no login or avatar.
        const actor = { login: null, name: comment.by.name, avatarUrl: null, isMe: comment.by.kind === 'self' };
        return { type: 'comment', kind: e.kind as CommentEventKind, ...base, actor, comment };
      }
    }
  });
}
