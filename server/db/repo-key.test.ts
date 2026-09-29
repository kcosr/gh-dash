import { describe, expect, it } from 'vitest';
import { seedDb } from '../test/seed';
import type { Db } from './db';
import { addRepoScope, loadQueryCtx, type Scope, Where } from './filters';
import { getPrDetail, listPrs } from './lists';
import { REPO_IDS_FOR_KEYS, repoKey, repoKeySql, resolveRepo, resolveRepoIds } from './repo-key';
import { createSet, getRepo, listRepos, listSets, setRepoPrefs, updateSet } from './repos';
import { markReposRemoved, upsertRepo } from './write';

const idOf = (db: Db, name: string) => db.get<{ id: number }>('SELECT id FROM repos WHERE name = ?', [name])!.id;

/** seedDb, with `old` and `hidden` marked removed (the sync does this to repos that disappear). */
function withRemoved(): Db {
  const db = seedDb();
  const keep = db.all<{ node_id: string }>(`SELECT node_id FROM repos WHERE name NOT IN ('old', 'hidden')`).map((r) => r.node_id);
  expect(markReposRemoved(db, keep, '2026-09-28T00:00:00Z')).toBe(2);
  return db;
}

describe('repoKeySql / repoKey', () => {
  it('name the short name for now', () => {
    expect(repoKeySql('r')).toBe('r.name');
    expect(repoKeySql('repos')).toBe('repos.name');
    expect(repoKey({ name: 'app', name_with_owner: 'alice/app' })).toBe('app');
  });

  it('agree with each other on a row', () => {
    const db = seedDb();
    const row = db.get<{ name: string; name_with_owner: string; key: string }>(`SELECT r.*, ${repoKeySql('r')} AS key FROM repos r WHERE r.name = 'app'`)!;
    expect(repoKey(row)).toBe(row.key);
  });
});

describe('resolveRepo', () => {
  it('finds a live repo by exact short name', () => {
    const db = seedDb();
    expect(resolveRepo(db, 'app')).toEqual({ id: idOf(db, 'app'), key: 'app', owner: 'alice', name: 'app', nodeId: 'R_app', trackedBy: 'owned' });
    expect(resolveRepo(db, 'secret')).toMatchObject({ id: idOf(db, 'secret'), key: 'secret' });
  });

  it('returns null for an unknown key', () => {
    const db = seedDb();
    expect(resolveRepo(db, 'nope')).toBeNull();
    expect(resolveRepo(db, '')).toBeNull();
  });

  it('returns null for a removed repo', () => {
    const db = withRemoved();
    expect(resolveRepo(db, 'old')).toBeNull();
    expect(resolveRepo(db, 'hidden')).toBeNull();
    expect(resolveRepo(db, 'app')).not.toBeNull();
  });

  it('is case-sensitive, and takes no owner prefix (yet)', () => {
    const db = seedDb();
    expect(resolveRepo(db, 'App')).toBeNull();
    expect(resolveRepo(db, 'APP')).toBeNull();
    expect(resolveRepo(db, 'alice/app')).toBeNull();
  });
});

describe('resolveRepoIds', () => {
  it('maps each resolvable input to its id, in input order', () => {
    const db = seedDb();
    const ids = resolveRepoIds(db, ['secret', 'app', 'fork']);
    expect([...ids]).toEqual([['secret', idOf(db, 'secret')], ['app', idOf(db, 'app')], ['fork', idOf(db, 'fork')]]);
  });

  it('leaves out unknown, removed and differently cased inputs', () => {
    const db = withRemoved();
    const ids = resolveRepoIds(db, ['nope', 'app', 'old', 'SECRET', 'hidden', 'secret']);
    expect([...ids]).toEqual([['app', idOf(db, 'app')], ['secret', idOf(db, 'secret')]]);
  });

  it('lists a repeated input once, at its first position', () => {
    const db = seedDb();
    expect([...resolveRepoIds(db, ['secret', 'app', 'secret']).keys()]).toEqual(['secret', 'app']);
  });

  it('is empty for no input', () => {
    expect(resolveRepoIds(seedDb(), []).size).toBe(0);
  });
});

describe('REPO_IDS_FOR_KEYS', () => {
  const inputs: string[][] = [
    [],
    ['app'],
    ['secret', 'app'],
    ['app', 'nope', 'fork'],
    ['App', 'SECRET'],
    ['old', 'hidden'],
    ['old', 'app', 'hidden', 'nope'],
    ['app', 'app'],
  ];

  // The form the code used before the helpers, minus the removed_at test that a caller's own `r.removed_at IS NULL` supplied.
  const before = (db: Db, keys: string[]) =>
    db
      .all<{ id: number }>(`SELECT r.id FROM repos r WHERE r.removed_at IS NULL AND r.name IN (SELECT value FROM json_each(?)) ORDER BY r.id`, [JSON.stringify(keys)])
      .map((r) => r.id);
  const after = (db: Db, keys: string[]) =>
    db
      .all<{ id: number }>(`SELECT r.id FROM repos r WHERE r.removed_at IS NULL AND r.id IN ${REPO_IDS_FOR_KEYS} ORDER BY r.id`, [JSON.stringify(keys)])
      .map((r) => r.id);

  it('is one parenthesised subquery with a single parameter', () => {
    expect(REPO_IDS_FOR_KEYS.startsWith('(SELECT')).toBe(true);
    expect(REPO_IDS_FOR_KEYS.endsWith(')')).toBe(true);
    expect(REPO_IDS_FOR_KEYS.match(/\?/g)).toHaveLength(1);
  });

  it('selects the same repos as the name list it replaced', () => {
    for (const db of [seedDb(), withRemoved()]) {
      for (const keys of inputs) expect(after(db, keys), JSON.stringify(keys)).toEqual(before(db, keys));
    }
  });

  it('selects live repos only, and only exact names', () => {
    const db = withRemoved();
    expect(after(db, ['app', 'secret'])).toEqual([idOf(db, 'app'), idOf(db, 'secret')]);
    expect(after(db, ['old', 'hidden', 'App', 'nope'])).toEqual([]);
  });

  it('is what resolveRepoIds resolves', () => {
    const db = withRemoved();
    for (const keys of inputs) expect(after(db, keys), JSON.stringify(keys)).toEqual([...resolveRepoIds(db, keys).values()].sort((a, b) => a - b));
  });

  it('drives the repo scope of a list', () => {
    const scope = (repos: string[] | null): Scope => ({
      repos, visibility: 'all', who: 'everyone', from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-10-01T00:00:00Z'), tz: 'UTC', q: null,
    });
    const db = withRemoved();
    const ctx = loadQueryCtx(db);
    const ids = (repos: string[]) => listPrs(db, ctx, scope(repos), { state: 'all', labels: null }, null).items.map((p) => p.id);
    expect(ids(['app', 'secret'])).toEqual(['secret#1', 'app#3', 'app#2', 'app#1']);
    // Removed repos stay out of a scope that names them; unknown names match nothing.
    expect(ids(['old', 'hidden', 'nope'])).toEqual([]);
    expect(ids(['old', 'app'])).toEqual(['app#3', 'app#2', 'app#1']);

    const w = new Where();
    addRepoScope(w, scope(['app']), ctx);
    expect(w.parts).toContain(`r.id IN ${REPO_IDS_FOR_KEYS}`);
    expect(w.params).toContain('["app"]');
  });
});

describe('call sites', () => {
  it('getRepo / listRepos(onlyKey) match a live key exactly', () => {
    const db = withRemoved();
    expect(getRepo(db, 'app', 'UTC')?.name).toBe('app');
    expect(getRepo(db, 'App', 'UTC')).toBeNull();
    expect(getRepo(db, 'old', 'UTC')).toBeNull();
    expect(getRepo(db, 'nope', 'UTC')).toBeNull();
    expect(listRepos(db, 'UTC', Date.now(), 'secret').map((r) => r.name)).toEqual(['secret']);
    expect(listRepos(db, 'UTC').map((r) => r.name)).not.toContain('old');
  });

  it('listRepos orders by activity, then by key', () => {
    const db = seedDb();
    // Inserted in the opposite order to their keys, with the same (old) activity and nothing else.
    for (const name of ['zeta', 'alpha']) {
      upsertRepo(db, {
        nodeId: `R_${name}`, name, nameWithOwner: `alice/${name}`, owner: 'alice', description: null, url: `https://github.com/alice/${name}`,
        visibility: 'public', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
        stars: 0, forks: 0, createdAt: '2019-01-01T00:00:00Z', pushedAt: '2020-01-01T00:00:00Z',
      }, '2026-09-27T00:00:00Z');
    }
    expect(listRepos(db, 'UTC', Date.parse('2026-09-27T12:00:00Z')).slice(-2).map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });

  it('setRepoPrefs answers whether a live repo was found', () => {
    const db = withRemoved();
    expect(setRepoPrefs(db, 'app', { pinned: true })).toBe(true);
    expect(getRepo(db, 'app', 'UTC')?.pinned).toBe(true);
    expect(setRepoPrefs(db, 'app', { pinned: false, hidden: true })).toBe(true);
    expect(getRepo(db, 'app', 'UTC')).toMatchObject({ pinned: false, hidden: true });
    // No preferences: only existence is reported.
    expect(setRepoPrefs(db, 'secret', {})).toBe(true);
    expect(setRepoPrefs(db, 'nope', {})).toBe(false);
    expect(setRepoPrefs(db, 'old', {})).toBe(false);
    expect(setRepoPrefs(db, 'nope', { pinned: true })).toBe(false);
    expect(setRepoPrefs(db, 'App', { pinned: true })).toBe(false);
    // A removed repo keeps its preferences untouched.
    expect(setRepoPrefs(db, 'old', { pinned: true })).toBe(false);
    expect(db.get<{ pinned: number }>(`SELECT pinned FROM repos WHERE name = 'old'`)!.pinned).toBe(0);
  });

  it('sets keep member order and drop unknown, removed and repeated names', () => {
    const db = withRemoved();
    const set = createSet(db, 'mix', ['secret', 'nope', 'app', 'old', 'secret', 'fork']);
    expect(set.repos).toEqual(['secret', 'app', 'fork']);
    // Positions count every distinct input, so the gaps left by dropped names don't reorder the rest.
    expect(db.all<{ position: number }>('SELECT position FROM repo_set_members WHERE set_id = ? ORDER BY position', [set.id]).map((r) => r.position)).toEqual([0, 2, 4]);
    expect(updateSet(db, set.id, { repos: ['fork', 'app'] })?.repos).toEqual(['fork', 'app']);
    expect(updateSet(db, set.id, { name: 'renamed' })).toMatchObject({ name: 'renamed', repos: ['fork', 'app'] });
    expect(createSet(db, 'empty', []).repos).toEqual([]);
    expect(listSets(db).map((x) => [x.name, x.repos])).toEqual([['empty', []], ['renamed', ['fork', 'app']]]);
  });

  it('listSets leaves out members that were removed since', () => {
    const db = seedDb();
    const set = createSet(db, 'all', ['app', 'old', 'secret']);
    expect(set.repos).toEqual(['app', 'old', 'secret']);
    const keep = db.all<{ node_id: string }>(`SELECT node_id FROM repos WHERE name <> 'old'`).map((r) => r.node_id);
    markReposRemoved(db, keep, '2026-09-28T00:00:00Z');
    expect(listSets(db)).toEqual([{ id: set.id, name: 'all', repos: ['app', 'secret'] }]);
  });

  it('getPrDetail finds a PR of a live repo by exact key, else null', () => {
    const db = withRemoved();
    const ctx = loadQueryCtx(db);
    expect(getPrDetail(db, ctx, 'app', 1)).toMatchObject({ id: 'app#1', repo: 'app', number: 1 });
    expect(getPrDetail(db, ctx, 'secret', 1)).toMatchObject({ id: 'secret#1' });
    expect(getPrDetail(db, ctx, 'app', 999)).toBeNull();
    expect(getPrDetail(db, ctx, 'nope', 1)).toBeNull();
    expect(getPrDetail(db, ctx, 'App', 1)).toBeNull();
    expect(getPrDetail(db, ctx, 'old', 1)).toBeNull();
  });
});
