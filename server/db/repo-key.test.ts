import { describe, expect, it } from 'vitest';
import { resolveRepoKey } from '../../shared/repos';
import { addManualRepo, GITHUB, seedDb } from '../test/seed';
import type { Db } from './db';
import { addRepoScope, loadQueryCtx, type Scope, Where } from './filters';
import { getPrDetail, listPrs } from './lists';
import type { RepoRecord } from './records';
import { REPO_IDS_FOR_KEYS, repoKey, repoKeySql, resolveRepo, resolveRepoIds, resolveRepoOn } from './repo-key';
import { createSet, getRepo, listRepos, listSets, setRepoPrefs, updateSet } from './repos';
import { ensureSource, sourceByHost, type SourceRef } from './sources';
import { markReposRemoved, upsertOwned } from './write';

const idOf = (db: Db, key: string) => db.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', [key])!.id;

/** A GitLab project as the GitLab source reports it (path = full path). */
function project(path: string, over: Partial<RepoRecord> = {}): RepoRecord {
  const i = path.lastIndexOf('/');
  return {
    nodeId: `gid://gitlab/Project/${path}`, name: path.slice(i + 1), nameWithOwner: path, owner: path.slice(0, i), description: null,
    url: `https://gitlab.example.com/${path}`, visibility: 'private', isArchived: false, isFork: false, languageName: null, languageColor: null,
    topics: [], defaultBranch: 'main', stars: 0, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-20T00:00:00Z', ...over,
  };
}

/**
 * seedDb (owned alice/app, secret, old, fork, hidden) with `old` and `hidden` marked removed, plus repos added by hand:
 * bob/app (a namesake of the owned app), carol/tool (alone under its name), grp/sub/proj (a nested path) and a
 * removed one, dave/gone. On a GitLab source, gitlab.example.com: the viewer's own alice/app (the same path as the
 * GitHub repo) and alice/notes (a short name no GitHub repo has), and platform/team/svc added by hand (nested).
 */
function fixture(): Db {
  const db = seedDb();
  const keep = db.all<{ node_id: string }>(`SELECT node_id FROM repos WHERE name NOT IN ('old', 'hidden')`).map((r) => r.node_id);
  expect(markReposRemoved(db, GITHUB, keep, '2026-09-28T00:00:00Z')).toBe(2);
  addManualRepo(db, 'bob/app');
  addManualRepo(db, 'carol/tool');
  addManualRepo(db, 'grp/sub/proj');
  db.run(`UPDATE repos SET removed_at = '2026-09-28T00:00:00Z' WHERE id = ?`, [addManualRepo(db, 'dave/gone')]);
  const gitlab = ensureSource(db, { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' });
  upsertOwned(db, gitlab, project('alice/app'), '2026-09-27T12:00:00Z');
  upsertOwned(db, gitlab, project('alice/notes'), '2026-09-27T12:00:00Z');
  addManualRepo(db, 'platform/team/svc', { source: gitlab, nodeId: 'gid://gitlab/Project/9' });
  return db;
}

/** Input → the key it resolves to (section 2.2 of the design), or null. */
const RESOLUTION: [input: string, key: string | null][] = [
  ['alice/app', 'alice/app'], // a key
  ['ALICE/App', 'alice/app'], // in any case
  ['app', 'alice/app'], // the short name of an owned repo
  ['APP', 'alice/app'],
  ['secret', 'alice/secret'],
  ['bob/app', 'bob/app'], // a repo added by hand, by key
  ['Bob/APP', 'bob/app'],
  ['carol/tool', 'carol/tool'],
  ['tool', null], // a bare name only a repo added by hand has: nothing
  ['grp/sub/proj', 'grp/sub/proj'], // nested
  ['GRP/Sub/Proj', 'grp/sub/proj'],
  ['proj', null],
  ['sub/proj', null], // a partial path is not a key
  ['old', null], // removed
  ['alice/old', null],
  ['hidden', null],
  ['dave/gone', null],
  ['gone', null],
  ['nope', null],
  ['alice/nope', null],
  ['', null],
  ['/', null],
  ['alice/', null],
  ['/app', null],
  ['app/', null],
  ['alice/app/', null],
  ['a%p', null], // no pattern matching
  ['_pp', null],
  ['alice/app,alice/secret', null],
  // Another source: keys carry its host.
  ['gitlab.example.com/alice/app', 'gitlab.example.com/alice/app'], // the GitLab namesake of alice/app
  ['GITLAB.EXAMPLE.COM/Alice/APP', 'gitlab.example.com/alice/app'], // hosts in any case too
  ['gitlab.example.com/platform/team/svc', 'gitlab.example.com/platform/team/svc'], // nested
  ['Gitlab.Example.Com/PLATFORM/Team/Svc', 'gitlab.example.com/platform/team/svc'],
  ['gitlab.example.com/alice/notes', 'gitlab.example.com/alice/notes'],
  ['notes', null], // the short name of an owned GitLab project: the alias is github.com's only
  ['svc', null],
  ['alice/notes', null], // the path without the host is not the key
  ['platform/team/svc', null],
  ['gitlab.example.com', null],
  ['gitlab.example.com/notes', null],
  ['gitlab.example.com/app', null],
];

describe('repoKeySql / repoKey', () => {
  it('name the key column', () => {
    expect(repoKeySql('r')).toBe('r.key');
    expect(repoKeySql('repos')).toBe('repos.key');
    expect(repoKey({ key: 'alice/app' })).toBe('alice/app');
  });

  it('agree with each other on a row', () => {
    const db = fixture();
    for (const name of ['app', 'svc']) {
      const row = db.get<{ key: string; k: string }>(`SELECT r.*, ${repoKeySql('r')} AS k FROM repos r WHERE r.name = ? ORDER BY r.id DESC`, [name])!;
      expect(repoKey(row)).toBe(row.k);
    }
  });
});

describe('resolution', () => {
  const idsFor = (db: Db, keys: string[]) =>
    db.all<{ id: number }>(`SELECT id FROM repos WHERE id IN ${REPO_IDS_FOR_KEYS} ORDER BY id`, [JSON.stringify(keys)]).map((r) => r.id);

  it.each(RESOLUTION)('%j -> %j', (input, key) => {
    const db = fixture();
    expect(resolveRepo(db, input)?.key ?? null).toBe(key);
    expect(idsFor(db, [input])).toEqual(key ? [idOf(db, key)] : []);
  });

  it('is the same rule on the server (SQL) and in shared/repos.ts (the web app)', () => {
    const db = fixture();
    const repos = listRepos(db, 'UTC');
    for (const [input, key] of RESOLUTION) {
      expect(resolveRepoKey(input, repos), input).toBe(key);
      expect(resolveRepo(db, input)?.key ?? null, input).toBe(resolveRepoKey(input, repos));
    }
  });

  it('returns the whole ref, with how the repo is tracked', () => {
    const db = fixture();
    expect(resolveRepo(db, 'app')).toEqual({
      id: idOf(db, 'alice/app'), sourceId: 1, key: 'alice/app', owner: 'alice', name: 'app', path: 'alice/app', nodeId: 'R_app', trackedBy: 'owned',
    });
    expect(resolveRepo(db, 'bob/app')).toEqual({
      id: idOf(db, 'bob/app'), sourceId: 1, key: 'bob/app', owner: 'bob', name: 'app', path: 'bob/app', nodeId: 'R_bob/app', trackedBy: 'manual',
    });
    expect(resolveRepo(db, 'grp/sub/proj')).toMatchObject({ owner: 'grp/sub', name: 'proj', path: 'grp/sub/proj' });
    // On another source the key carries the host; the path, the owner and the name don't.
    expect(resolveRepo(db, 'gitlab.example.com/platform/team/svc')).toEqual({
      id: idOf(db, 'gitlab.example.com/platform/team/svc'), sourceId: 2, key: 'gitlab.example.com/platform/team/svc', owner: 'platform/team',
      name: 'svc', path: 'platform/team/svc', nodeId: 'gid://gitlab/Project/9', trackedBy: 'manual',
    });
  });

  it('selects every repo named in a list, once', () => {
    const db = fixture();
    expect(idsFor(db, ['app', 'alice/app', 'bob/app', 'tool', 'carol/tool', 'old', 'nope'])).toEqual(
      [idOf(db, 'alice/app'), idOf(db, 'bob/app'), idOf(db, 'carol/tool')].sort((a, b) => a - b),
    );
    expect(idsFor(db, [])).toEqual([]);
  });

  it('selects repos of every source, a key of each of a namesake pair', () => {
    const db = fixture();
    expect(idsFor(db, ['app', 'gitlab.example.com/alice/app', 'notes'])).toEqual(
      [idOf(db, 'alice/app'), idOf(db, 'gitlab.example.com/alice/app')].sort((a, b) => a - b),
    );
  });

  it('looks keys up through the key index', () => {
    const db = fixture();
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT id FROM repos WHERE id IN ${REPO_IDS_FOR_KEYS}`, ['["alice/app"]']).map((r) => r.detail);
    expect(plan.join('\n')).toMatch(/repos_key/);
  });
});

describe('resolveRepoIds', () => {
  it('maps each resolvable input to its id, in input order', () => {
    const db = fixture();
    const ids = resolveRepoIds(db, ['secret', 'bob/app', 'nope', 'ALICE/APP', 'tool', 'app', 'fork', 'old']);
    expect([...ids]).toEqual([
      ['secret', idOf(db, 'alice/secret')], ['bob/app', idOf(db, 'bob/app')], ['ALICE/APP', idOf(db, 'alice/app')],
      ['app', idOf(db, 'alice/app')], ['fork', idOf(db, 'alice/fork')],
    ]);
  });

  it('lists a repeated input once, at its first position', () => {
    const db = seedDb();
    expect([...resolveRepoIds(db, ['secret', 'app', 'secret']).keys()]).toEqual(['secret', 'app']);
  });

  it('is empty for no input', () => {
    expect(resolveRepoIds(seedDb(), []).size).toBe(0);
  });
});

describe('resolveRepoOn', () => {
  it("resolves a key, or a path on the source given, and only that source's repos", () => {
    const db = fixture();
    const gitlab = sourceByHost(db, 'gitlab.example.com')!;
    const on = (input: string, src: SourceRef = gitlab) => resolveRepoOn(db, input, src)?.key ?? null;
    expect(on('alice/app')).toBe('gitlab.example.com/alice/app'); // a path there, though github.com has the same key
    expect(on('Platform/Team/SVC')).toBe('gitlab.example.com/platform/team/svc');
    expect(on('gitlab.example.com/platform/team/svc')).toBe('gitlab.example.com/platform/team/svc'); // its key
    expect(on('app')).toBeNull(); // the short-name alias is github.com's only
    expect(on('bob/app')).toBeNull(); // a github.com key
    expect(on('alice/app', GITHUB)).toBe('alice/app');
    expect(on('app', GITHUB)).toBe('alice/app');
    expect(on('platform/team/svc', GITHUB)).toBeNull();
    expect(on('gitlab.example.com/platform/team/svc', GITHUB)).toBeNull();
  });
});

describe('call sites', () => {
  const scope = (repos: string[] | null): Scope => ({
    repos, visibility: 'all', ownership: 'all', who: 'everyone', from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-10-01T00:00:00Z'), tz: 'UTC', q: null,
  });

  it('a list scope takes keys and aliases alike', () => {
    const db = fixture();
    const ctx = loadQueryCtx(db);
    const ids = (repos: string[]) => listPrs(db, ctx, scope(repos), { state: 'all', labels: null }, null).items.map((p) => p.id);
    expect(ids(['alice/app', 'alice/secret'])).toEqual(['alice/secret#1', 'alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(ids(['app', 'SECRET'])).toEqual(ids(['alice/app', 'alice/secret']));
    // Removed repos stay out of a scope that names them; unknown names match nothing.
    expect(ids(['old', 'alice/hidden', 'nope'])).toEqual([]);

    const w = new Where();
    addRepoScope(w, scope(['app']), ctx);
    expect(w.parts).toContain(`r.id IN ${REPO_IDS_FOR_KEYS}`);
    expect(w.params).toContain('["app"]');
  });

  it('getRepo / listRepos(onlyKey) find a live repo by key or alias', () => {
    const db = fixture();
    expect(getRepo(db, 'alice/app', 'UTC')?.key).toBe('alice/app');
    expect(getRepo(db, 'App', 'UTC')?.key).toBe('alice/app');
    expect(getRepo(db, 'bob/app', 'UTC')).toMatchObject({ key: 'bob/app', trackedBy: 'manual', addedAt: '2026-09-27T12:00:00Z', unavailable: null });
    expect(getRepo(db, 'tool', 'UTC')).toBeNull();
    expect(getRepo(db, 'old', 'UTC')).toBeNull();
    expect(listRepos(db, 'UTC', Date.now(), 'secret').map((r) => r.key)).toEqual(['alice/secret']);
    expect(listRepos(db, 'UTC').map((r) => r.key)).not.toContain('alice/old');
  });

  it('listRepos names every repo\'s source and provider', () => {
    const db = fixture();
    const byKey = new Map(listRepos(db, 'UTC').map((r) => [r.key, r]));
    expect(byKey.get('alice/app')).toMatchObject({ source: 'github.com', provider: 'github', nameWithOwner: 'alice/app' });
    expect(byKey.get('gitlab.example.com/alice/app')).toMatchObject({
      source: 'gitlab.example.com', provider: 'gitlab', name: 'app', owner: 'alice', nameWithOwner: 'alice/app', trackedBy: 'owned',
    });
    expect(getRepo(db, 'GitLab.example.com/platform/team/svc', 'UTC')).toMatchObject({ key: 'gitlab.example.com/platform/team/svc', owner: 'platform/team' });
  });

  it('listRepos orders by activity, then by key', () => {
    const db = seedDb();
    // Inserted in the opposite order to their keys, with the same (old) activity and nothing else.
    for (const key of ['zed/lib', 'amy/lib']) addManualRepo(db, key, { createdAt: '2019-01-01T00:00:00Z', pushedAt: '2020-01-01T00:00:00Z' });
    expect(listRepos(db, 'UTC', Date.parse('2026-09-27T12:00:00Z')).slice(-2).map((r) => r.key)).toEqual(['amy/lib', 'zed/lib']);
  });

  it('setRepoPrefs answers whether a live repo was found', () => {
    const db = fixture();
    expect(setRepoPrefs(db, 'app', { pinned: true })).toBe(true);
    expect(getRepo(db, 'alice/app', 'UTC')?.pinned).toBe(true);
    expect(setRepoPrefs(db, 'bob/app', { hidden: true })).toBe(true);
    expect(getRepo(db, 'bob/app', 'UTC')?.hidden).toBe(true);
    expect(getRepo(db, 'alice/app', 'UTC')?.hidden).toBe(false);
    // No preferences: only existence is reported.
    expect(setRepoPrefs(db, 'secret', {})).toBe(true);
    expect(setRepoPrefs(db, 'nope', {})).toBe(false);
    expect(setRepoPrefs(db, 'tool', { pinned: true })).toBe(false);
    // A removed repo keeps its preferences untouched.
    expect(setRepoPrefs(db, 'old', { pinned: true })).toBe(false);
    expect(db.get<{ pinned: number }>(`SELECT pinned FROM repos WHERE name = 'old'`)!.pinned).toBe(0);
  });

  it('sets store members by key, in order, and drop unknown, removed and repeated names', () => {
    const db = fixture();
    const set = createSet(db, 'mix', ['secret', 'nope', 'bob/app', 'old', 'secret', 'fork', 'ALICE/FORK', 'tool']);
    expect(set.repos).toEqual(['alice/secret', 'bob/app', 'alice/fork']);
    // Positions count every distinct input, so the gaps left by dropped names don't reorder the rest.
    expect(db.all<{ position: number }>('SELECT position FROM repo_set_members WHERE set_id = ? ORDER BY position', [set.id]).map((r) => r.position)).toEqual([0, 2, 4]);
    expect(updateSet(db, set.id, { repos: ['alice/fork', 'app'] })?.repos).toEqual(['alice/fork', 'alice/app']);
    expect(updateSet(db, set.id, { name: 'renamed' })).toMatchObject({ name: 'renamed', repos: ['alice/fork', 'alice/app'] });
    expect(createSet(db, 'empty', []).repos).toEqual([]);
    expect(listSets(db).map((x) => [x.name, x.repos])).toEqual([['empty', []], ['renamed', ['alice/fork', 'alice/app']]]);
  });

  it('listSets leaves out members that were removed since', () => {
    const db = seedDb();
    const set = createSet(db, 'all', ['app', 'old', 'secret']);
    expect(set.repos).toEqual(['alice/app', 'alice/old', 'alice/secret']);
    const keep = db.all<{ node_id: string }>(`SELECT node_id FROM repos WHERE name <> 'old'`).map((r) => r.node_id);
    markReposRemoved(db, GITHUB, keep, '2026-09-28T00:00:00Z');
    expect(listSets(db)).toEqual([{ id: set.id, name: 'all', repos: ['alice/app', 'alice/secret'] }]);
  });

  it('getPrDetail finds a PR of a live repo by key or alias, else null', () => {
    const db = fixture();
    const ctx = loadQueryCtx(db);
    expect(getPrDetail(db, ctx, 'alice/app', 1)).toMatchObject({ id: 'alice/app#1', repo: 'alice/app', number: 1 });
    expect(getPrDetail(db, ctx, 'App', 1)).toMatchObject({ id: 'alice/app#1' });
    expect(getPrDetail(db, ctx, 'secret', 1)).toMatchObject({ id: 'alice/secret#1' });
    expect(getPrDetail(db, ctx, 'alice/app', 999)).toBeNull();
    expect(getPrDetail(db, ctx, 'bob/app', 1)).toBeNull();
    expect(getPrDetail(db, ctx, 'nope', 1)).toBeNull();
    expect(getPrDetail(db, ctx, 'old', 1)).toBeNull();
  });

  it('a repo renamed on GitHub gets its new key; its old key stops resolving', () => {
    const db = seedDb();
    upsertOwned(db, GITHUB, {
      nodeId: 'R_app', name: 'app2', nameWithOwner: 'alice/app2', owner: 'alice', description: null, url: 'https://github.com/alice/app2',
      visibility: 'public', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
      stars: 0, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-25T00:00:00Z',
    }, '2026-09-28T00:00:00Z');
    expect(resolveRepo(db, 'alice/app')).toBeNull();
    expect(resolveRepo(db, 'app2')?.key).toBe('alice/app2');
  });
});
