import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../shared/api';
import { ymdToDayNum, zonedMidnight } from '../lib/time';
import { commitRecord, GITLAB_HOST, prRecord, repoRecord, seedDb, seedGitLab, setViewer } from '../test/seed';
import type { Db } from './db';
import { isMeFn, loadQueryCtx, meSql, type Scope } from './filters';
import { getPrDetail, listActivity, listCommits, listIssues, listPrs, listReleases } from './lists';
import type { ActorRecord } from './records';
import { patchSettings } from './settings';
import { ensureSource, getSource } from './sources';
import { computeStats } from './stats';
import { upsertCommit, upsertOwned, upsertPr } from './write';

// "Me" is per source: each source has its own account, so the same login can be two different people. The seed's GitHub
// viewer is alice; seedGitLab adds gitlab.example.com claimed by bob (with the address bob@corp.example), where an
// "alice" and GitHub's own "bob" are somebody else. settings.myEmails (alice@work.example) counts on every source.

const KEY = `${GITLAB_HOST}/platform/app`;
const BOB_GITLAB = { login: 'bob', name: 'Bob B', avatarUrl: 'https://avatars.example/bob-gl' };

const by = (login: string | null, email: string | null = null, name = login ?? 'Nobody'): ActorRecord => ({ login, name, email, avatarUrl: null });

/** Both sources, plus GitHub commits that only make sense next to the GitLab ones. */
function world(): { db: Db; app: number; gitlab: number } {
  const db = seedDb();
  const { repoId: gitlab } = seedGitLab(db);
  const app = db.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', ['alice/app'])!.id;
  // bob's GitLab address on a GitHub commit is nobody's in particular there.
  upsertCommit(db, app, commitRecord('h1', '2026-09-23T08:00:00Z', by(null, 'bob@corp.example', 'Bob (laptop)'), null, 'Laptop tweak'));
  // Another carol on GitHub; the same address on both sources is one person.
  upsertCommit(db, app, commitRecord('h2', '2026-09-23T09:00:00Z', by('carol'), null, 'Carol on GitHub'));
  upsertCommit(db, app, commitRecord('h3', '2026-09-23T11:00:00Z', by(null, 'dan@x.example', 'Dan'), null, 'Dan on GitHub'));
  upsertCommit(db, gitlab, commitRecord('gl5', '2026-09-23T12:00:00Z', by(null, 'dan@x.example', 'Dan'), null, 'Dan on GitLab'));
  return { db, app, gitlab };
}

const scope = (over: Partial<Scope> = {}): Scope => ({
  repos: null,
  visibility: 'all',
  ownership: 'all',
  who: 'everyone',
  from: Date.parse('2026-09-01T00:00:00Z'),
  to: Date.parse('2026-09-28T00:00:00Z'),
  tz: 'UTC',
  q: null,
  ...over,
});
/** Local days `from`..`to` inclusive, in UTC. */
const days = (from: string, to: string, over: Partial<Scope> = {}): Scope =>
  scope({ from: zonedMidnight('UTC', ymdToDayNum(from)!), to: zonedMidnight('UTC', ymdToDayNum(to)! + 1), ...over });
const STATS = days('2026-09-20', '2026-09-26');
const all = { state: 'all', labels: null } as const;

describe('the query context', () => {
  it('holds the account of each source that has one, lower-cased, and its own addresses', () => {
    const { db } = world();
    ensureSource(db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    const ctx = loadQueryCtx(db, ['ME@Home.example']);
    // gitlab2 has no account yet: it has no entry.
    expect(ctx.viewers).toEqual(new Map([[1, 'alice'], [2, 'bob']]));
    // The addresses that count on every source; a source's own are kept apart.
    expect(ctx.myEmails).toEqual(['alice@work.example', 'me@home.example']);
    expect(ctx.viewerEmails).toEqual(new Map([[2, ['bob@corp.example']]]));
    expect(ctx).not.toHaveProperty('viewer');
  });

  it('has no accounts before the first sync', () => {
    const db = seedDb();
    setViewer(db, null);
    expect(loadQueryCtx(db).viewers.size).toBe(0);
  });
});

describe('isMe', () => {
  const { db } = world();
  const isMe = isMeFn(loadQueryCtx(db));

  it('matches the login of the row’s own source only', () => {
    expect(isMe('alice', null, 1)).toBe(true);
    expect(isMe('ALICE', null, 1)).toBe(true);
    expect(isMe('bob', null, 2)).toBe(true);
    // The same login is somebody else on the other source.
    expect(isMe('alice', null, 2)).toBe(false);
    expect(isMe('bob', null, 1)).toBe(false);
    expect(isMe('bob', null, 99)).toBe(false);
    expect(isMe(null, null, 1)).toBe(false);
  });

  it('counts a source’s own addresses on that source only, and myEmails on every one', () => {
    expect(isMe(null, 'bob@corp.example', 2)).toBe(true);
    expect(isMe(null, 'BOB@Corp.example', 2)).toBe(true);
    expect(isMe(null, 'bob@corp.example', 1)).toBe(false);
    expect(isMe(null, 'alice@work.example', 1)).toBe(true);
    expect(isMe(null, 'alice@work.example', 2)).toBe(true);
    expect(isMe(null, 'carol@corp.example', 2)).toBe(false);
  });
});

describe('meSql', () => {
  it('is 0 when nothing can be me', () => {
    const db = seedDb();
    setViewer(db, null);
    patchSettings(db, { myEmails: [] });
    expect(meSql(loadQueryCtx(db), 'c.author_login', 'c.author_email')).toEqual({ sql: '0', params: [] });
  });
});

describe('lists across sources', () => {
  const { db } = world();
  const ctx = loadQueryCtx(db);
  const prs = (over: Partial<Scope> = {}) => listPrs(db, ctx, scope(over), all, null).items;
  const ids = (items: { id: string }[]) => items.map((i) => i.id);
  const partition = <T>(everyone: T[], me: T[], others: T[]) => {
    expect([...me, ...others].sort()).toEqual([...everyone].sort());
  };

  it('pull requests: the same login is a different person on each source', () => {
    // GitHub: alice is me, bob is not. GitLab: bob is me, alice is not.
    expect(ids(prs({ who: 'me' }))).toEqual(['alice/secret#1', `${KEY}#1`, 'alice/app#1']);
    expect(ids(prs({ who: 'others' }))).toEqual([`${KEY}#3`, 'alice/app#3', `${KEY}#2`, 'alice/app#2']);
    partition(ids(prs()), ids(prs({ who: 'me' })), ids(prs({ who: 'others' })));
    const byId = new Map(prs().map((p) => [p.id, p.author]));
    expect(byId.get(`${KEY}#1`)).toMatchObject({ login: 'bob', isMe: true });
    expect(byId.get('alice/app#2')).toMatchObject({ login: 'bob', isMe: false });
    expect(byId.get(`${KEY}#2`)).toMatchObject({ login: 'alice', isMe: false });
    expect(byId.get('alice/app#1')).toMatchObject({ login: 'alice', isMe: true });
  });

  it('scopes to one source’s repos and facets follow who', () => {
    expect(ids(prs({ repos: [KEY], who: 'me' }))).toEqual([`${KEY}#1`]);
    expect(ids(prs({ repos: [KEY], who: 'others' }))).toEqual([`${KEY}#3`, `${KEY}#2`]);
    expect(ids(prs({ repos: ['app'], who: 'me' }))).toEqual(['alice/app#1']);
    // The facets ignore the repo selection (so archived and hidden repos show), but not who.
    expect(listPrs(db, ctx, scope({ repos: ['app'], who: 'me' }), all, null).facets.byRepo).toEqual({
      'alice/app': 1, 'alice/secret': 1, 'alice/old': 1, 'alice/hidden': 1, [KEY]: 1,
    });
    expect(listPrs(db, ctx, scope({ who: 'others' }), all, null).facets.byRepo).toEqual({ 'alice/app': 2, [KEY]: 2, 'alice/fork': 1 });
  });

  it('commits: the viewer’s addresses match their own source’s repos, myEmails match everywhere', () => {
    const headlines = (who: Scope['who']) =>
      listCommits(db, ctx, scope({ who }), null).items.map((c) => c.headline).sort();
    expect(headlines('me')).toEqual(['Bootstrap service', 'Commit c4', 'Merge pull request #1', 'Tune pipeline', 'Tweak config']);
    expect(headlines('others')).toEqual([
      'Bump deps', 'Carol on GitHub', 'Dan on GitHub', 'Dan on GitLab', 'Laptop tweak', 'Refactor parser module', 'Rotate keys',
    ]);
    partition(headlines('everyone'), headlines('me'), headlines('others'));
    const byHeadline = new Map(listCommits(db, ctx, scope(), null).items.map((c) => [c.headline, c.author]));
    // bob@corp.example: bob's on GitLab, nobody's on GitHub.
    expect(byHeadline.get('Bootstrap service')).toMatchObject({ login: null, isMe: true });
    expect(byHeadline.get('Laptop tweak')).toMatchObject({ login: null, isMe: false });
    // alice@work.example (settings.myEmails): mine on both.
    expect(byHeadline.get('Tweak config')?.isMe).toBe(true);
    expect(byHeadline.get('Tune pipeline')?.isMe).toBe(true);
    // Logins: alice on GitLab and bob on GitHub are others.
    expect(byHeadline.get('Rotate keys')).toMatchObject({ login: 'alice', isMe: false });
    expect(byHeadline.get('Refactor parser module')).toMatchObject({ login: 'bob', isMe: false });
  });

  it('GH_DASH_MY_EMAILS counts on every source', () => {
    const c = loadQueryCtx(db, ['dan@x.example']);
    const dan = listCommits(db, c, scope({ who: 'me' }), null).items.map((x) => x.headline).filter((h) => h.startsWith('Dan'));
    expect(dan.sort()).toEqual(['Dan on GitHub', 'Dan on GitLab']);
  });

  it('issues and releases', () => {
    const issues = (who: Scope['who']) => listIssues(db, ctx, scope({ who }), 'all', null).items.map((i) => i.id);
    // GitHub: #10 is bob's, #11 alice's. GitLab: #1 is bob's, #2 alice's (closed by bob, which is dated by the close).
    expect(issues('me')).toEqual(['alice/app#11', `${KEY}#1`]);
    expect(issues('others')).toEqual([`${KEY}#2`, 'alice/app#10']);
    const closed = listIssues(db, ctx, scope(), 'closed', null).items;
    expect(closed.map((i) => [i.id, i.author.isMe, i.closedBy?.isMe])).toEqual([
      [`${KEY}#2`, false, true],
      ['alice/app#10', false, true],
    ]);
    const releases = (who: Scope['who']) => listReleases(db, ctx, scope({ who }), null).items.map((r) => r.id);
    expect(releases('me')).toEqual([`${KEY}@v2.0.0`, 'alice/app@v1.0.0']);
    expect(releases('others')).toEqual([]);
    expect(listReleases(db, ctx, scope(), null).items.map((r) => [r.id, r.author?.isMe])).toEqual([[`${KEY}@v2.0.0`, true], ['alice/app@v1.0.0', true]]);
  });

  it('pull request details judge their commits by the PR’s source', () => {
    const d = seedDb();
    seedGitLab(d);
    const app = d.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', ['alice/app'])!.id;
    upsertPr(d, app, prRecord(9, {
      state: 'open', createdAt: '2026-09-25T00:00:00Z', author: by('carol'),
      commits: [
        { oid: 'q1', headline: 'from the work laptop', committedAt: '2026-09-25T00:00:00Z', url: 'u', author: by(null, 'bob@corp.example') },
        { oid: 'q2', headline: 'by alice', committedAt: '2026-09-25T01:00:00Z', url: 'u', author: by('alice') },
      ],
    }));
    const c = loadQueryCtx(d);
    const flags = (repo: string, n: number) => getPrDetail(d, c, repo, n)!.commits.map((x) => [x.headline, x.author.isMe]);
    expect(flags('alice/app', 9)).toEqual([['from the work laptop', false], ['by alice', true]]);
    expect(flags(KEY, 1)).toEqual([['parser', true], ['review fixes', false]]);
    expect(getPrDetail(d, c, KEY, 1)!.author.isMe).toBe(true);
  });

  it('activity: who=me and who=others split events by their own source’s account', () => {
    const label = (e: ActivityEvent): string => {
      switch (e.type) {
        case 'commit': return `commit ${e.repo} ${e.commit.headline}`;
        case 'pr': return `pr:${e.kind} ${e.pr.id}`;
        case 'issue': return `issue:${e.kind} ${e.issue.id}`;
        case 'release': return `release ${e.release.id}`;
        case 'star': return `star ${e.repo}`;
        case 'comment': return `comment:${e.kind} ${e.repo}`;
      }
    };
    const range = days('2026-09-20', '2026-09-27');
    const events = (who: Scope['who']) => listActivity(db, ctx, { ...range, who }, null, null);
    const me = events('me');
    expect(me.items.every((e) => e.actor?.isMe)).toBe(true);
    expect(me.items.map(label).sort()).toEqual([
      'commit alice/app Tweak config',
      `commit ${KEY} Bootstrap service`,
      `commit ${KEY} Tune pipeline`,
      'issue:closed alice/app#10',
      `issue:closed ${KEY}#2`,
      'issue:opened alice/app#11',
      `issue:opened ${KEY}#1`,
      'pr:merged alice/app#1',
      'pr:merged alice/secret#1',
      `pr:merged ${KEY}#1`,
      'pr:opened alice/app#1',
      'pr:opened alice/secret#1',
      `pr:opened ${KEY}#1`,
      'release alice/app@v1.0.0',
      `release ${KEY}@v2.0.0`,
    ].sort());
    expect(me.total).toBe(15);
    expect(me.facets.byRepo).toEqual({ 'alice/app': 6, 'alice/secret': 2, [KEY]: 7 });
    const others = events('others');
    expect(others.items.some((e) => e.actor?.isMe)).toBe(false);
    expect(others.items.map(label)).toEqual(expect.arrayContaining([
      `pr:opened ${KEY}#2`, `pr:merged ${KEY}#3`, `commit ${KEY} Rotate keys`, 'pr:closed alice/app#3', 'commit alice/app Laptop tweak',
    ]));
    partition(events('everyone').items.map(label), me.items.map(label), others.items.map(label));
    expect(events('everyone').total).toBe(me.total + others.total);
  });

  it('a source that has no account yet has no "me" but for the shared addresses; its rows are all "others"', () => {
    const d = seedDb();
    seedGitLab(d);
    setViewer(d, null, 2);
    const c = loadQueryCtx(d);
    expect(ids(listPrs(d, c, scope({ who: 'me' }), all, null).items)).toEqual(['alice/secret#1', 'alice/app#1']);
    // Not dropped by a NULL: bob's and alice's MRs are others until bob's account is known.
    expect(ids(listPrs(d, c, scope({ who: 'others' }), all, null).items)).toEqual([`${KEY}#3`, 'alice/app#3', `${KEY}#2`, 'alice/app#2', `${KEY}#1`]);
    // gl1 was bob's address and is no longer mine; gl2 is alice@work.example, which is.
    const commits = listCommits(d, c, scope({ who: 'me' }), null).items.map((x) => x.headline).sort();
    expect(commits).toEqual(['Commit c4', 'Merge pull request #1', 'Tune pipeline', 'Tweak config']);
    expect(getSource(d, 2)!.viewer).toBeNull();
  });
});

describe('stats across sources', () => {
  const { db } = world();
  const ctx = loadQueryCtx(db);
  const total = (s: ReturnType<typeof computeStats>, key: 'commitsMine' | 'prsMergedMine' | 'commits' | 'prsMerged') =>
    s.series.reduce((a, b) => a + b[key], 0);
  const rows = (s: ReturnType<typeof computeStats>) =>
    s.contributors.map((c) => [c.actor.login, c.actor.name, c.actor.isMe, c.commits, c.prsMerged, c.total] as const);

  it('flags my commits and merged PRs on every source', () => {
    const s = computeStats(db, ctx, STATS);
    expect(total(s, 'commits')).toBe(12);
    // GitHub c1, c2, c4; GitLab gl1 (bob@corp.example) and gl2 (alice@work.example).
    expect(total(s, 'commitsMine')).toBe(5);
    // GitHub alice/app#1 and alice/secret#1, and GitLab !1; not !3, by GitLab’s alice.
    expect(total(s, 'prsMerged')).toBe(4);
    expect(total(s, 'prsMergedMine')).toBe(3);
  });

  it('who=me and who=others partition the tiles', () => {
    const at = (who: Scope['who']) => computeStats(db, ctx, { ...STATS, who });
    expect([at('me'), at('others'), at('everyone')].map((s) => [s.tiles.commits.value, s.tiles.prsMerged.value])).toEqual([
      [5, 3],
      [7, 1],
      [12, 4],
    ]);
    expect(total(at('me'), 'commitsMine')).toBe(5);
    expect(total(at('others'), 'commitsMine')).toBe(0);
    expect(total(at('others'), 'prsMergedMine')).toBe(0);
    expect(at('me').byRepo.map((r) => [r.repo, r.commits, r.prsMerged])).toEqual([
      ['alice/app', 2, 1],
      [KEY, 2, 1],
      ['alice/secret', 1, 1],
    ]);
  });

  it('merges every "me" into one row shown as source 1’s viewer, and never merges two people who share a login', () => {
    const s = computeStats(db, ctx, STATS);
    expect(rows(s)[0]).toEqual(['Alice', 'Alice A', true, 5, 3, 8]);
    expect(s.contributors[0]!.actor.avatarUrl).toBe('https://avatars.example/alice');
    // GitLab’s alice (a commit and !3) is not GitHub’s; the two carols are two people; one address is one person.
    expect(rows(s).slice(1).map((r) => r.map(String).join('|')).sort()).toEqual([
      'alice|alice|false|1|1|2',
      'bob|Bob|false|1|0|1',
      'carol|carol|false|1|0|1',
      'carol|carol|false|1|0|1',
      'null|Bob (laptop)|false|1|0|1',
      'null|Dan|false|2|0|2',
    ].sort());
    expect(rows(computeStats(db, ctx, { ...STATS, who: 'me' }))).toEqual([['Alice', 'Alice A', true, 5, 3, 8]]);
    const others = computeStats(db, ctx, { ...STATS, who: 'others' });
    expect(others.contributors.some((c) => c.actor.isMe)).toBe(false);
    expect(others.contributors.reduce((a, c) => a + c.total, 0)).toBe(7 + 1);
  });

  it('shows the viewer of the source the "me" events are on', () => {
    // Only GitLab’s repo in scope: bob’s events are the viewer’s, and GitHub’s account isn't shown for them.
    const gl = computeStats(db, ctx, { ...STATS, repos: [KEY] });
    expect(gl.contributors[0]!.actor).toEqual({ ...BOB_GITLAB, isMe: true });
    expect(rows(gl)[0]).toEqual(['bob', 'Bob B', true, 2, 1, 3]);
    // Only GitHub's: as before.
    expect(computeStats(db, ctx, { ...STATS, repos: ['app'] }).contributors[0]!.actor).toMatchObject({ login: 'Alice', isMe: true });
  });

  it('shows the first source’s viewer that has an account when source 1 has none', () => {
    const d = world().db;
    setViewer(d, null, 1);
    const s = computeStats(d, loadQueryCtx(d), STATS);
    // GitHub’s events are now nobody’s but the addresses (c2 by alice@work.example, shared); GitLab’s are bob’s.
    expect(s.contributors.filter((c) => c.actor.isMe)).toEqual([
      { actor: { ...BOB_GITLAB, isMe: true }, commits: 3, prsMerged: 1, total: 4 },
    ]);
  });

  it('env addresses and second GitLab sources join in', () => {
    const d = world().db;
    const second = ensureSource(d, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    setViewer(d, { login: 'carol', emails: ['carol@corp.example'] }, second.id);
    const other = upsertOwned(d, { id: second.id, host: second.host }, {
      ...repoRecord('infra'), nodeId: 'gid://gitlab/Project/9', nameWithOwner: 'ops/infra', owner: 'ops', url: 'https://gitlab2.example.com/ops/infra',
    }, '2026-09-27T12:00:00Z');
    upsertCommit(d, other, commitRecord('z1', '2026-09-22T00:00:00Z', by(null, 'carol@corp.example'), null, 'Provision'));
    upsertCommit(d, other, commitRecord('z2', '2026-09-22T01:00:00Z', by('bob'), null, 'Bob on gitlab2'));
    const s = computeStats(d, loadQueryCtx(d), { ...STATS, who: 'me' });
    // carol@corp.example counts on gitlab2 only, where carol is the viewer; bob is not the viewer there.
    expect(s.tiles.commits.value).toBe(6);
    expect(s.byRepo.find((r) => r.repo === 'gitlab2.example.com/ops/infra')).toMatchObject({ commits: 1 });
  });
});
