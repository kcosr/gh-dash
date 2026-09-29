import { describe, expect, it } from 'vitest';
import { addManualRepo, GITHUB, seedDb } from '../test/seed';
import { listRepos } from './repos';
import { upsertOwned, upsertStar } from './write';

describe('listRepos lastActivityAt', () => {
  it('is the latest push / PR / issue / release activity; stars do not count', () => {
    const db = seedDb();
    // An inactive repository: last pushed in January, starred in September.
    const dusty = upsertOwned(db, GITHUB, {
      nodeId: 'R_dusty', name: 'dusty', nameWithOwner: 'alice/dusty', owner: 'alice', description: null, url: 'https://github.com/alice/dusty',
      visibility: 'public', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
      stars: 1, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-01-29T01:03:25Z',
    }, '2026-09-27T00:00:00Z');
    upsertStar(db, dusty, { login: 'zed', name: null, avatarUrl: null, starredAt: '2026-09-24T22:11:34Z' });

    const repos = listRepos(db, 'UTC', Date.parse('2026-09-27T12:00:00Z'));
    const byName = new Map(repos.map((r) => [r.name, r]));
    expect(byName.get('dusty')!.lastActivityAt).toBe('2026-01-29T01:03:25Z');
    // app: pushed 09-25, issue #11 opened 09-26, erin's star on 09-27 is ignored.
    expect(byName.get('app')!.lastActivityAt).toBe('2026-09-26T00:00:00Z');
    // The list is ordered by it, so the starred-but-idle repo sorts last.
    expect(repos.at(-1)!.name).toBe('dusty');
    expect(byName.get('dusty')!.stats.newStars30d).toBe(1);
  });
});

describe('listRepos identity', () => {
  it('gives every repo its key (what the API and URLs call it) and how it is tracked', () => {
    const db = seedDb();
    addManualRepo(db, 'bob/app', { addedAt: '2026-09-28T00:00:00Z' });
    const unavailable = addManualRepo(db, 'carol/tool');
    db.run(`UPDATE repos SET unavailable_at = '2026-09-29T00:00:00Z', unavailable_reason = 'Not found' WHERE id = ?`, [unavailable]);
    const repos = listRepos(db, 'UTC');
    // On github.com the key is the provider path.
    for (const r of repos) expect(r.key).toBe(r.nameWithOwner);
    const byKey = new Map(repos.map((r) => [r.key, r]));
    expect(byKey.get('alice/app')).toMatchObject({ name: 'app', trackedBy: 'owned', addedAt: null, unavailable: null });
    expect(byKey.get('bob/app')).toMatchObject({ name: 'app', owner: 'bob', trackedBy: 'manual', addedAt: '2026-09-28T00:00:00Z', unavailable: null });
    expect(byKey.get('carol/tool')).toMatchObject({ trackedBy: 'manual', unavailable: { since: '2026-09-29T00:00:00Z', reason: 'Not found' } });
  });
});

describe('listRepos new stars', () => {
  it('counts stars of owned repos only, like activity and Insights', () => {
    const db = seedDb();
    // A manual repo keeps stars from when it was owned (transferred away, then added by hand).
    const kept = addManualRepo(db, 'bob/kept');
    upsertStar(db, kept, { login: 'zed', name: null, avatarUrl: null, starredAt: '2026-09-24T22:11:34Z' });
    const repos = listRepos(db, 'UTC', Date.parse('2026-09-27T12:00:00Z'));
    expect(repos.find((r) => r.key === 'bob/kept')!.stats.newStars30d).toBe(0);
  });
});
