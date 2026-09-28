import { describe, expect, it } from 'vitest';
import probesFixture from '../test/fixtures/repo-probes.json';
import detailFixture from '../test/fixtures/repo-detail.json';
import reposFixture from '../test/fixtures/viewer-repos.json';
import { mapCommit, mapIssue, mapProbe, mapPullRequest, mapRelease, mapRepo, mapStar } from './map';
import type { RepoDetailData, RepoProbesData, ViewerReposData } from './types';

const repos = reposFixture as unknown as ViewerReposData;
const probes = probesFixture as unknown as RepoProbesData;
const detail = (detailFixture as unknown as RepoDetailData).repository!;

describe('GraphQL → rows', () => {
  it('maps repos, treating INTERNAL as private and empty descriptions as null', () => {
    const [app, corp] = repos.viewer.repositories.nodes.map(mapRepo);
    expect(app).toEqual({
      nodeId: 'R_app', name: 'app', nameWithOwner: 'alice/app', owner: 'alice', description: null, url: 'https://github.com/alice/app',
      visibility: 'public', isArchived: false, isFork: false, languageName: 'TypeScript', languageColor: '#3178c6', topics: ['dashboard'],
      defaultBranch: 'main', stars: 2, forks: 1, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-25T12:00:00Z',
    });
    expect(corp).toMatchObject({ visibility: 'private', isArchived: true, defaultBranch: null, languageName: null, pushedAt: null });
  });

  it('maps probes, ignoring draft releases', () => {
    expect(mapProbe(probes.nodes[0]!)).toEqual({
      openPrs: 1, openIssues: 1, latestPrUpdatedAt: '2026-09-22T09:00:00Z', latestIssueUpdatedAt: '2026-09-26T00:00:00Z',
      releaseTags: ['v1.0.0'], latestStarredAt: '2026-09-25T06:00:00Z',
    });
    expect(mapProbe(probes.nodes[1]!)).toMatchObject({ latestPrUpdatedAt: null, releaseTags: [], latestStarredAt: null });
  });

  it('maps commits: lower-cased emails, linked logins, PR numbers only from this repo', () => {
    const [merge, direct, upstream] = detail.defaultBranchRef!.target!.history!.nodes.map((n) => mapCommit(n, 'alice/app'));
    expect(merge).toMatchObject({ headline: 'Merge pull request #1 from alice/fix', body: 'Fix login flow', prNumber: 1, additions: 12 });
    expect(merge!.author).toEqual({ login: 'alice', name: 'Alice A', email: 'alice@example.com', avatarUrl: 'https://avatars.example/alice' });
    expect(direct!.author).toEqual({ login: null, name: 'Alice (laptop)', email: 'alice@work.example', avatarUrl: null });
    expect(direct!.prNumber).toBeNull();
    expect(upstream!.prNumber).toBeNull();
  });

  it('maps pull requests with state, activityAt, labels, closing issues and commits', () => {
    const [open, merged] = detail.pullRequests!.nodes.map(mapPullRequest);
    expect(open).toMatchObject({ number: 2, state: 'open', isDraft: true, activityAt: '2026-09-22T09:00:00Z', mergedBy: null, commitCount: 0 });
    expect(open!.author).toEqual({ login: 'bob', name: 'Bob B', email: null, avatarUrl: 'https://avatars.example/bob' });
    expect(merged).toMatchObject({
      state: 'merged', activityAt: '2026-09-21T10:00:00Z', mergedBy: 'alice', headRef: 'fix', baseRef: 'main', commitCount: 1,
      labels: [{ name: 'bug', color: 'd73a4a' }],
      closingIssues: [{ number: 10, title: 'Login broken', state: 'closed', url: 'https://github.com/alice/app/issues/10' }],
    });
    expect(merged!.commits[0]).toMatchObject({ oid: 'aaaa000000000000000000000000000000000000', headline: 'fix login', author: { login: 'alice' } });
  });

  it('maps issues with the closing actor', () => {
    const [open, closed] = detail.issues!.nodes.map(mapIssue);
    expect(open).toMatchObject({ state: 'open', closedBy: null, activityAt: '2026-09-26T00:00:00Z', labels: [{ name: 'enhancement', color: 'a2eeef' }] });
    expect(closed).toMatchObject({ state: 'closed', activityAt: '2026-09-22T12:00:00Z', author: { login: 'bob' }, closedBy: { login: 'alice', name: 'Alice A' } });
  });

  it('drops draft releases and maps stars', () => {
    const [draft, published] = detail.releases!.nodes.map(mapRelease);
    expect(draft).toBeNull();
    expect(published).toEqual({
      tag: 'v1.0.0', name: 'First', body: 'First release', author: { login: 'alice', name: 'Alice A', email: null, avatarUrl: null },
      publishedAt: '2026-09-23T15:00:00Z', isPrerelease: true, url: 'https://github.com/alice/app/releases/tag/v1.0.0',
    });
    expect(detail.stargazers!.edges.map(mapStar)).toEqual([
      { login: 'dave', name: null, avatarUrl: 'https://avatars.example/dave', starredAt: '2026-09-25T06:00:00Z' },
      { login: 'carol', name: 'Carol C', avatarUrl: 'https://avatars.example/carol', starredAt: '2026-09-20T00:00:00Z' },
    ]);
  });
});
