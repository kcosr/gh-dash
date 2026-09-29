import type { Repo, RepoSet, SavedView } from '../../shared/api';
import { type RepoResolver, rewriteRepoParams, rewriteRepoPath } from '../../shared/query';
import { bucketIndex, DAY_MS, isoSec, localDayNum, makeBuckets, weekdayMon0, zonedMidnight } from '../lib/time';
import type { Db } from './db';
import { repoKey, repoKeySql, resolveRepo, resolveRepoIds } from './repo-key';

interface RepoRow {
  id: number;
  name: string;
  name_with_owner: string;
  owner: string;
  description: string | null;
  url: string;
  visibility: Repo['visibility'];
  is_archived: number;
  is_fork: number;
  language_name: string | null;
  language_color: string | null;
  topics: string;
  default_branch: string | null;
  stars: number;
  forks: number;
  open_prs: number;
  open_issues: number;
  created_at: string;
  pushed_at: string | null;
  pinned: number;
  hidden: number;
  tracked_by: string;
  added_at: string | null;
  unavailable_at: string | null;
  unavailable_reason: string | null;
  synced_at: string | null;
  last_activity_at: string | null;
}

// Stars are deliberately not activity: a star on an old repo must not bump it in the sidebar.
const REPO_SELECT = `
  SELECT r.*, ss.synced_at,
    max(
      ifnull(r.pushed_at, ''),
      ifnull((SELECT max(updated_at) FROM pull_requests WHERE repo_id = r.id), ''),
      ifnull((SELECT max(updated_at) FROM issues WHERE repo_id = r.id), ''),
      ifnull((SELECT max(published_at) FROM releases WHERE repo_id = r.id), '')
    ) AS last_activity_at
  FROM repos r LEFT JOIN sync_state ss ON ss.repo_id = r.id
  WHERE r.removed_at IS NULL`;

const WEEKS = 12;

function countBy(db: Db, sql: string, params: (string | number)[]): Map<number, number> {
  return new Map(db.all<{ repo_id: number; n: number }>(sql, params).map((r) => [r.repo_id, r.n]));
}

/** Repos with their stats; 30-day windows end at `now`, weekly buckets are Mon-start weeks in `tz`. */
export function listRepos(db: Db, tz: string, now = Date.now(), onlyKey?: string): Repo[] {
  const ref = onlyKey ? resolveRepo(db, onlyKey) : null;
  const rows = !onlyKey
    ? db.all<RepoRow>(`${REPO_SELECT} ORDER BY last_activity_at DESC, ${repoKeySql('r')}`)
    : ref
      ? db.all<RepoRow>(`${REPO_SELECT} AND r.id = ?`, [ref.id])
      : [];
  if (rows.length === 0) return [];

  const since30 = isoSec(now - 30 * DAY_MS);
  const merged = countBy(db, 'SELECT repo_id, count(*) AS n FROM pull_requests WHERE merged_at >= ? GROUP BY repo_id', [since30]);
  const commits = countBy(db, 'SELECT repo_id, count(*) AS n FROM commits WHERE committed_at >= ? GROUP BY repo_id', [since30]);
  const stars = countBy(db, 'SELECT repo_id, count(*) AS n FROM stars WHERE starred_at >= ? GROUP BY repo_id', [since30]);

  const today = localDayNum(tz, now);
  const firstWeek = today - weekdayMon0(today) - (WEEKS - 1) * 7;
  const weeks = makeBuckets(tz, zonedMidnight(tz, firstWeek), now + 1, 'week');
  const weekly = new Map<number, number[]>();
  for (const c of db.all<{ repo_id: number; committed_at: string }>('SELECT repo_id, committed_at FROM commits WHERE committed_at >= ?', [
    isoSec(weeks.starts[0]!),
  ])) {
    const i = bucketIndex(weeks, Date.parse(c.committed_at));
    if (i < 0) continue;
    let arr = weekly.get(c.repo_id);
    if (!arr) weekly.set(c.repo_id, (arr = new Array<number>(weeks.starts.length).fill(0)));
    arr[i]!++;
  }

  const setIds = new Map<number, number[]>();
  for (const m of db.all<{ repo_id: number; set_id: number }>('SELECT repo_id, set_id FROM repo_set_members ORDER BY set_id')) {
    const list = setIds.get(m.repo_id) ?? [];
    list.push(m.set_id);
    setIds.set(m.repo_id, list);
  }

  return rows.map((r) => ({
    key: repoKey(r),
    name: r.name,
    nameWithOwner: r.name_with_owner,
    owner: r.owner,
    description: r.description,
    url: r.url,
    visibility: r.visibility,
    isArchived: !!r.is_archived,
    isFork: !!r.is_fork,
    language: r.language_name ? { name: r.language_name, color: r.language_color } : null,
    topics: JSON.parse(r.topics) as string[],
    defaultBranch: r.default_branch,
    stars: r.stars,
    forks: r.forks,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    lastActivityAt: r.last_activity_at || null,
    pinned: !!r.pinned,
    hidden: !!r.hidden,
    setIds: setIds.get(r.id) ?? [],
    stats: {
      openPrs: r.open_prs,
      openIssues: r.open_issues,
      mergedPrs30d: merged.get(r.id) ?? 0,
      commits30d: commits.get(r.id) ?? 0,
      newStars30d: stars.get(r.id) ?? 0,
      weeklyCommits: (weekly.get(r.id) ?? new Array<number>(weeks.starts.length).fill(0)).slice(-WEEKS),
    },
    syncedAt: r.synced_at,
    trackedBy: r.tracked_by === 'manual' ? ('manual' as const) : ('owned' as const),
    addedAt: r.added_at,
    unavailable: r.unavailable_at ? { since: r.unavailable_at, reason: r.unavailable_reason ?? '' } : null,
  }));
}

export function getRepo(db: Db, key: string, tz: string): Repo | null {
  return listRepos(db, tz, Date.now(), key)[0] ?? null;
}

export function setRepoPrefs(db: Db, key: string, prefs: { pinned?: boolean; hidden?: boolean }): boolean {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (prefs.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(Number(prefs.pinned));
  }
  if (prefs.hidden !== undefined) {
    sets.push('hidden = ?');
    params.push(Number(prefs.hidden));
  }
  const ref = resolveRepo(db, key);
  if (!ref) return false;
  if (sets.length === 0) return true;
  return db.run(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`, [...params, ref.id]).changes > 0;
}

// ---------------------------------------------------------------------------
// Repo sets
// ---------------------------------------------------------------------------

export function listSets(db: Db): RepoSet[] {
  const sets = db.all<{ id: number; name: string }>('SELECT id, name FROM repo_sets ORDER BY name COLLATE NOCASE, id');
  const members = db.all<{ set_id: number; repo: string }>(
    `SELECT m.set_id, ${repoKeySql('r')} AS repo FROM repo_set_members m JOIN repos r ON r.id = m.repo_id
     WHERE r.removed_at IS NULL ORDER BY m.set_id, m.position`,
  );
  return sets.map((s) => ({ id: s.id, name: s.name, repos: members.filter((m) => m.set_id === s.id).map((m) => m.repo) }));
}

function getSet(db: Db, id: number): RepoSet | null {
  return listSets(db).find((s) => s.id === id) ?? null;
}

function replaceMembers(db: Db, setId: number, repos: string[]): void {
  db.run('DELETE FROM repo_set_members WHERE set_id = ?', [setId]);
  const ids = resolveRepoIds(db, repos);
  // Several inputs can name one repo (a key and an alias): the first one places it.
  const added = new Set<number>();
  [...new Set(repos)].forEach((key, position) => {
    const repoId = ids.get(key);
    if (repoId === undefined || added.has(repoId)) return;
    added.add(repoId);
    db.run('INSERT INTO repo_set_members (set_id, repo_id, position) VALUES (?, ?, ?)', [setId, repoId, position]);
  });
}

export function createSet(db: Db, name: string, repos: string[]): RepoSet {
  const id = db.tx(() => {
    const setId = db.run('INSERT INTO repo_sets (name, created_at) VALUES (?, ?)', [name, new Date().toISOString()]).lastInsertRowid;
    replaceMembers(db, setId, repos);
    return setId;
  });
  return getSet(db, id)!;
}

export function updateSet(db: Db, id: number, patch: { name?: string; repos?: string[] }): RepoSet | null {
  const found = db.tx(() => {
    if (!db.get('SELECT 1 FROM repo_sets WHERE id = ?', [id])) return false;
    if (patch.name !== undefined) db.run('UPDATE repo_sets SET name = ? WHERE id = ?', [patch.name, id]);
    if (patch.repos !== undefined) replaceMembers(db, id, patch.repos);
    return true;
  });
  return found ? getSet(db, id) : null;
}

export function deleteSet(db: Db, id: number): boolean {
  return db.run('DELETE FROM repo_sets WHERE id = ?', [id]).changes > 0;
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export function listViews(db: Db): SavedView[] {
  return db.all<SavedView>('SELECT id, name, path, query FROM saved_views ORDER BY name COLLATE NOCASE, id');
}

/** Stores a view with its repo references (`repos`, `pr`, `diff`, a `/repos/...` path) canonicalized to keys. */
export function createView(db: Db, v: Omit<SavedView, 'id'>): SavedView {
  const resolve: RepoResolver = (input) => resolveRepo(db, input)?.key ?? null;
  const view = { name: v.name, path: rewriteRepoPath(v.path, resolve), query: rewriteRepoParams(v.query, resolve) };
  const id = db.run('INSERT INTO saved_views (name, path, query, created_at) VALUES (?, ?, ?, ?)', [
    view.name,
    view.path,
    view.query,
    new Date().toISOString(),
  ]).lastInsertRowid;
  return { id, ...view };
}

export function deleteView(db: Db, id: number): boolean {
  return db.run('DELETE FROM saved_views WHERE id = ?', [id]).changes > 0;
}
