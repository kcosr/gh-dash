import type { PrState, ThreadKindFilter, ThreadListItem, ThreadSort, ThreadStatus, ThreadStatusFilter } from '../../shared/api';
import { PROVIDERS } from '../../shared/provider';
import { hydrate, SELF_PRINCIPAL_ID, type ThreadRow } from './comments';
import type { Db } from './db';
import { addRepoScope, likeContains, type QueryCtx, type Scope, Where } from './filters';
import type { CursorKey, Page } from './lists';
import { repoKeySql } from './repo-key';

export interface ThreadFilter {
  status: ThreadStatusFilter;
  kind: ThreadKindFilter;
  sort: ThreadSort;
  /** Who opened the thread (its first comment's author): the dashboard's user, any agent, or one principal by id. */
  author?: 'self' | 'agents' | number;
  /** Open threads whose last comment isn't this principal's (someone is waiting on them): GET /threads's waiting=you is the dashboard's user. */
  waitingOn?: number;
  /** One PR's threads, or one commit's (a full oid or a prefix of one), in the scope's repos (MCP's list_threads). */
  target?: { pr: number } | { commit: string };
  /** Threads on this file, or on files under this directory. */
  path?: string;
  /** Threads with activity (updatedAt) at or after this ISO time. */
  since?: string;
}

export interface ThreadListResult {
  items: ThreadListItem[];
  /** [updated_at, id] of the page's last thread. */
  nextCursor: CursorKey | null;
  /** Threads matching every filter. */
  total: number;
  /** Threads per status matching every filter but `status`. */
  counts: Record<ThreadStatus, number>;
}

interface ThreadListRow extends ThreadRow {
  target_title: string | null;
  /** The synced PR's or commit's own url; null when not synced, or synced without one (GitLab's webUrl can be null). */
  target_url: string | null;
  pr_state: PrState | null;
  pr_head_oid: string | null;
  repo_url: string;
  source_kind: string;
}

// What the filters and counts need: threads in their live repos.
const THREADS = 'comment_threads t JOIN repos r ON r.id = t.repo_id';
// What a listed thread is on. Threads are keyed by repo and PR number or commit oid, so they still list when the sync
// hasn't (or no longer has) the PR or commit; both joins hit a unique key, so a thread is one row.
const THREADS_WITH_TARGETS =
  `${THREADS} JOIN sources s ON s.id = r.source_id LEFT JOIN pull_requests p ON p.repo_id = t.repo_id AND p.number = t.pr_number ` +
  'LEFT JOIN commits c ON c.repo_id = t.repo_id AND t.pr_number IS NULL AND c.oid = t.commit_oid';
/**
 * A commit the sync doesn't hold (default branches only) may be one of a synced PR's: its headline is then the newest
 * such PR's (highest number; the same commit reads the same in each). A PR thread never takes a commit's headline.
 * `alias`: a row with a thread's repo_id, pr_number and commit_oid (a thread, or a comment event).
 */
export const prCommitHeadlineSql = (alias: string) =>
  `(SELECT pc.headline FROM pr_commits pc JOIN pull_requests q ON q.id = pc.pr_id
     WHERE ${alias}.pr_number IS NULL AND q.repo_id = ${alias}.repo_id AND pc.oid = ${alias}.commit_oid ORDER BY q.number DESC LIMIT 1)`;
const SELECT =
  `t.*, ${repoKeySql('r')} AS repo, r.url AS repo_url, s.kind AS source_kind, ` +
  `COALESCE(p.title, c.headline, ${prCommitHeadlineSql('t')}) AS target_title, COALESCE(NULLIF(p.url, ''), NULLIF(c.url, '')) AS target_url, ` +
  'p.state AS pr_state, p.head_oid AS pr_head_oid';

// The author of a thread's first comment (the thread's) and of its last one.
const OPENER = '(SELECT m.author_id FROM comments m WHERE m.thread_id = t.id ORDER BY m.id LIMIT 1)';
const LAST_AUTHOR = '(SELECT m.author_id FROM comments m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1)';

/** The scope (as /prs applies it) and the filters; `status` 'all' leaves the status out (for `counts`). */
function threadWhere(ctx: QueryCtx, scope: Scope, f: ThreadFilter, status: ThreadStatusFilter): Where {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  if (status !== 'all') w.add('t.status = ?', status);
  if (f.kind !== 'all') w.add(f.kind === 'pr' ? 't.pr_number IS NOT NULL' : 't.pr_number IS NULL');
  if (f.author === 'self') w.add(`${OPENER} = ?`, SELF_PRINCIPAL_ID);
  else if (f.author === 'agents') w.add(`${OPENER} IN (SELECT id FROM principals WHERE kind = 'agent')`);
  else if (f.author !== undefined) w.add(`${OPENER} = ?`, f.author);
  if (f.waitingOn !== undefined) w.add(`t.status = 'open' AND ${LAST_AUTHOR} <> ?`, f.waitingOn);
  if (f.target && 'pr' in f.target) w.add('t.pr_number = ?', f.target.pr);
  // Oids are stored lower-case: [prefix, prefix + 'g') is every oid that starts with it.
  else if (f.target) w.add('t.pr_number IS NULL AND t.commit_oid >= ? AND t.commit_oid < ?', f.target.commit, `${f.target.commit}g`);
  if (f.path !== undefined) {
    // Under a directory: from "dir/" up to "dir0" ('0' follows '/'), comparing bytes as the paths are case-sensitive.
    const dir = f.path.replace(/\/+$/, '');
    w.add('t.path = ? OR (t.path >= ? AND t.path < ?)', f.path, `${dir}/`, `${dir}0`);
  }
  if (f.since !== undefined) w.add('t.updated_at >= ?', f.since);
  if (scope.q) {
    // Any comment's words, or the file. LIKE (no FTS table): case-insensitive for ASCII only, as SQLite's is.
    const like = likeContains(scope.q);
    w.add(`t.path LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM comments m WHERE m.thread_id = t.id AND m.body LIKE ? ESCAPE '\\')`, like, like);
  }
  return w;
}

/** Where the PR or commit is on its code host, built from the repo's url when the sync has no row (with its url) for it. */
function unsyncedUrl(row: ThreadListRow): string {
  const link = PROVIDERS[row.source_kind === 'gitlab' ? 'gitlab' : 'github'].link;
  const repoUrl = row.repo_url.replace(/\/+$/, '');
  return row.pr_number === null ? link.commit(repoUrl, row.commit_oid) : link.pr(repoUrl, row.pr_number);
}

/**
 * Every thread in scope, across PRs and commits, by last activity: `recent` newest first, `oldest` the reverse, ties by
 * thread id in the same direction, so each order is the exact reverse of the other. `page.after` is the previous page's
 * `nextCursor`; null pages = every matching thread. `scope.who` and the date range don't apply: a thread stays open
 * however old it is.
 */
export function listThreadItems(db: Db, ctx: QueryCtx, scope: Scope, f: ThreadFilter, page: Page): ThreadListResult {
  const base = threadWhere(ctx, scope, f, 'all');
  const counts: Record<ThreadStatus, number> = { open: 0, resolved: 0 };
  for (const row of db.all<{ status: ThreadStatus; n: number }>(
    `SELECT t.status AS status, count(*) AS n FROM ${THREADS} WHERE ${base.toSql()} GROUP BY t.status`,
    base.params,
  )) {
    counts[row.status] = row.n;
  }
  const total = f.status === 'all' ? counts.open + counts.resolved : counts[f.status];

  const w = threadWhere(ctx, scope, f, f.status);
  const dir = f.sort === 'recent' ? 'DESC' : 'ASC';
  const params = [...w.params];
  let keyset = '';
  if (page?.after) {
    keyset = ` AND (t.updated_at, t.id) ${f.sort === 'recent' ? '<' : '>'} (?, ?)`;
    params.push(page.after[0]!, page.after[1]!);
  }
  if (page) params.push(page.limit + 1);
  const rows = db.all<ThreadListRow>(
    `SELECT ${SELECT} FROM ${THREADS_WITH_TARGETS} WHERE ${w.toSql()}${keyset} ORDER BY t.updated_at ${dir}, t.id ${dir}${page ? ' LIMIT ?' : ''}`,
    params,
  );
  const hasMore = !!page && rows.length > page.limit;
  if (hasMore) rows.length = page.limit;
  const last = rows[rows.length - 1];

  const threads = hydrate(db, rows);
  const items = threads.map((t, i): ThreadListItem => {
    const row = rows[i]!;
    return {
      ...t,
      targetTitle: row.target_title,
      prState: row.pr_state,
      targetUrl: row.target_url ?? unsyncedUrl(row),
      earlierPush: row.pr_number !== null && row.pr_head_oid !== null && row.pr_head_oid !== row.commit_oid,
    };
  });
  return { items, nextCursor: hasMore ? [last!.updated_at, last!.id] : null, total, counts };
}
