import { describe, expect, it } from 'vitest';
import { seedDb } from '../test/seed';
import { listRepos } from './repos';
import { upsertRepo, upsertStar } from './write';

describe('listRepos lastActivityAt', () => {
  it('is the latest push / PR / issue / release activity; stars do not count', () => {
    const db = seedDb();
    // An inactive repository: last pushed in January, starred in September.
    const dusty = upsertRepo(db, {
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
