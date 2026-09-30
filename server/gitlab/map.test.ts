import { describe, expect, it } from 'vitest';
import commitsFixture from '../test/fixtures/gitlab/commits.json';
import issuesFixture from '../test/fixtures/gitlab/issues.json';
import memberProjectsFixture from '../test/fixtures/gitlab/member-projects.json';
import mergeRequestsFixture from '../test/fixtures/gitlab/merge-requests.json';
import ownedFixture from '../test/fixtures/gitlab/owned-projects.json';
import probesFixture from '../test/fixtures/gitlab/probes.json';
import projectFixture from '../test/fixtures/gitlab/project.json';
import releasesFixture from '../test/fixtures/gitlab/releases.json';
import starrersFixture from '../test/fixtures/gitlab/starrers.json';
import viewerAccountFixture from '../test/fixtures/gitlab/viewer-account.json';
import viewerFixture from '../test/fixtures/gitlab/viewer.json';
import { BASE } from '../test/gitlab';
import {
  labelColor,
  mapCandidate,
  mapCommit,
  mapIssue,
  mapMergeRequest,
  mapProbe,
  mapProject,
  mapRelease,
  mapStar,
  mapViewer,
  mapViewerEmails,
  mapVisibility,
  messageParts,
  releaseCreatedAt,
  utc,
} from './map';
import type {
  MergeRequestsData,
  OwnedProjectsData,
  ProbesData,
  ProjectData,
  ReleasesData,
  RestCommit,
  RestIssue,
  RestProject,
  RestStarrer,
  ViewerAccountData,
  ViewerData,
} from './types';

const owned = (ownedFixture as unknown as OwnedProjectsData).projects.nodes;
const project = (projectFixture as unknown as ProjectData).project!;
const probes = (probesFixture as unknown as ProbesData).projects.nodes;
const mrs = (mergeRequestsFixture as unknown as MergeRequestsData).project!.mergeRequests!.nodes;
const releases = (releasesFixture as unknown as ReleasesData).project!.releases!.nodes;
const issues = issuesFixture as unknown as RestIssue[];
const commits = commitsFixture as unknown as RestCommit[];
const starrers = starrersFixture as unknown as RestStarrer[];

describe('GitLab → rows: helpers', () => {
  it('normalizes timestamps to UTC seconds, whatever offset or precision GitLab sends', () => {
    expect(utc('2026-09-21T12:00:00.000+02:00')).toBe('2026-09-21T10:00:00Z');
    expect(utc('2026-09-26T00:00:00.123Z')).toBe('2026-09-26T00:00:00Z');
    expect(utc('2026-09-26T00:00:00Z')).toBe('2026-09-26T00:00:00Z');
  });

  it('keeps internal visibility, and treats a visibility GitLab did not give as private', () => {
    expect([mapVisibility('public'), mapVisibility('internal'), mapVisibility('private'), mapVisibility(null)]).toEqual([
      'public',
      'internal',
      'private',
      'private',
    ]);
  });

  it('stores label colors as GitHub-style hex: lower case, no #, six digits', () => {
    expect([labelColor('#F0AD4E'), labelColor('#f00'), labelColor('d9534f'), labelColor('red')]).toEqual(['f0ad4e', 'ff0000', 'd9534f', 'ededed']);
  });

  it('splits commit messages like GitHub does', () => {
    expect(messageParts('Title\r\n\r\nBody line\n  indented\n\n')).toEqual({ headline: 'Title', body: 'Body line\n  indented' });
    expect(messageParts('Only a title\n')).toEqual({ headline: 'Only a title', body: '' });
  });
});

describe('GitLab → rows: viewer and projects', () => {
  it('maps the viewer with its global id and an absolute avatar URL', () => {
    expect(mapViewer((viewerFixture as ViewerData).currentUser!, BASE)).toEqual({
      id: 'gid://gitlab/User/2',
      login: 'alice',
      name: 'Alice A',
      avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/2/avatar.png',
    });
  });

  it("maps the viewer's addresses: public, commit and other, lower-cased, once each, only real addresses", () => {
    expect(mapViewerEmails((viewerAccountFixture as ViewerAccountData).currentUser!)).toEqual([
      'alice@example.com',
      '2-alice@users.noreply.gitlab.example.com',
      'alice@corp.example.com',
    ]);
    expect(mapViewerEmails({ ...(viewerAccountFixture as ViewerAccountData).currentUser!, publicEmail: null, commitEmail: ' ', emails: null })).toEqual([]);
  });

  it('maps projects: path as name, namespace as owner, the head commit and its date as pushedAt', () => {
    const [app, tools] = owned.map((p) => mapProject(p, BASE));
    expect(app).toEqual({
      nodeId: 'gid://gitlab/Project/11', name: 'app', nameWithOwner: 'alice/app', owner: 'alice', description: null,
      url: 'https://gitlab.example.com/gitlab/alice/app', visibility: 'public', isArchived: false, isFork: false,
      languageName: 'TypeScript', languageColor: '#3178c6', topics: ['dashboard'], defaultBranch: 'main', stars: 2, forks: 1,
      createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-21T10:00:00Z', headOid: '3'.repeat(40),
    });
    // Internal, archived fork with an empty repository: no default branch or head, and pushedAt falls back to the last activity.
    expect(tools).toMatchObject({
      name: 'corp.tools', visibility: 'internal', isArchived: true, isFork: true, languageName: null, languageColor: null,
      defaultBranch: null, pushedAt: '2025-06-01T09:30:00Z', headOid: null,
    });
  });

  it('keeps nested groups in the owner', () => {
    expect(mapProject(project, BASE)).toMatchObject({ name: 'api', owner: 'team/platform', nameWithOwner: 'team/platform/api', defaultBranch: 'develop' });
  });

  it('maps probes, leaving out upcoming releases', () => {
    // One opened merge request and one locked (being merged): both open.
    expect(mapProbe(probes[0]!)).toEqual({
      openPrs: 2, openIssues: 1, latestPrUpdatedAt: '2026-09-22T09:00:00Z', latestIssueUpdatedAt: '2026-09-26T00:00:00Z',
      releaseTags: ['v1.1.0', 'v1.0.0'], latestStarredAt: null,
    });
    expect(mapProbe(probes[1]!)).toEqual({ openPrs: 0, openIssues: 0, latestPrUpdatedAt: null, latestIssueUpdatedAt: null, releaseTags: [], latestStarredAt: null });
    expect(mapProbe(project).releaseTags).toEqual(['v2.1.0', 'v2.0.0']);
  });

  it('counts locked merge requests (being merged) as open, as mapMergeRequest does', () => {
    const locked = { ...probes[1]!, lockedMergeRequests: { count: 2 } };
    expect(mapProbe(locked).openPrs).toBe(2);
    expect(mapProbe({ ...locked, openMergeRequests: { count: 3 } }).openPrs).toBe(5);
    expect(mapProbe({ ...locked, lockedMergeRequests: null }).openPrs).toBe(0);
  });
});

describe('GitLab → rows: merge requests', () => {
  const [draft, merged, closed, locked] = mrs.map((m) => mapMergeRequest(m, BASE));

  it('maps an open draft: iid as number, no merger (mergeUser is who set auto-merge), commits oldest first', () => {
    expect(draft).toMatchObject({
      number: 7, state: 'open', isDraft: true, mergedBy: null, mergedAt: null, closedAt: null, activityAt: '2026-09-22T08:00:00Z',
      additions: 10, deletions: 2, changedFiles: 3, commitCount: 2, headRef: 'settings', baseRef: 'main',
      headOid: '7777777777777777777777777777777777777777', labels: [{ name: 'UX', color: 'f0ad4e' }], closingIssues: [],
      url: 'https://gitlab.example.com/gitlab/alice/app/-/merge_requests/7',
    });
    expect(draft!.author).toEqual({ login: 'bob', name: 'Bob B', email: null, avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/3/avatar.png' });
    expect(draft!.commits.map((c) => c.oid)).toEqual(['6666666666666666666666666666666666666666', '7777777777777777777777777777777777777777']);
    expect(draft!.commits[0]!.author).toEqual({ login: null, name: 'Bob (laptop)', email: 'bob@laptop.example', avatarUrl: null });
    expect(draft!.commits[1]).toEqual({
      oid: '7777777777777777777777777777777777777777', headline: 'Wire the settings form', committedAt: '2026-09-22T07:50:00Z',
      url: 'https://gitlab.example.com/gitlab/alice/app/-/commit/7777777777777777777777777777777777777777',
      author: { login: 'bob', name: 'Bob B', email: 'bob@example.com', avatarUrl: 'https://secure.gravatar.com/avatar/b0b' },
    });
  });

  it('maps a merged MR: merger, merge time as closedAt and activityAt, closing issues, label colors', () => {
    expect(merged).toMatchObject({
      number: 5, state: 'merged', mergedBy: 'alice', mergedAt: '2026-09-21T10:00:00Z', closedAt: '2026-09-21T10:00:00Z',
      activityAt: '2026-09-21T10:00:00Z', updatedAt: '2026-09-21T10:00:05Z',
      labels: [{ name: 'bug', color: 'd9534f' }, { name: 'priority::high', color: 'ff0000' }],
      closingIssues: [{ number: 3, title: 'Login broken', state: 'closed', url: 'https://gitlab.example.com/gitlab/alice/app/-/issues/3' }],
    });
  });

  it('reads the commits a merged MR landed as, and none for one that has not merged', () => {
    expect([merged!.mergeCommitOid, merged!.squashCommitOid]).toEqual(['3333333333333333333333333333333333333333', null]);
    // Case is normalized. GitLab 19.3 has no squash SHA to read, so squashCommitOid is always null.
    const upper = mapMergeRequest({ ...mrs[1]!, mergeCommitSha: 'ABCDEF0000000000000000000000000000000000' }, BASE);
    expect([upper.mergeCommitOid, upper.squashCommitOid]).toEqual(['abcdef0000000000000000000000000000000000', null]);
    // Only a merged MR has landed commits, whatever GitLab holds for the others.
    const open = mapMergeRequest({ ...mrs[0]!, mergeCommitSha: 'a'.repeat(40) }, BASE);
    expect([open.mergeCommitOid, open.squashCommitOid]).toEqual([null, null]);
    expect([draft, closed, locked].map((p) => [p!.mergeCommitOid, p!.squashCommitOid])).toEqual([[null, null], [null, null], [null, null]]);
  });

  it('maps a closed MR with missing optional data', () => {
    expect(closed).toMatchObject({
      number: 4, state: 'closed', body: '', closedAt: '2026-09-20T11:00:00Z', activityAt: '2026-09-20T11:00:00Z', mergedBy: null,
      additions: 0, deletions: 0, changedFiles: 0, commitCount: 0, headOid: '', labels: [], closingIssues: [], commits: [],
    });
  });

  it("maps whether the source branch is in another project: a fork's MR is cross-repo, one from the project's own branch is not", () => {
    expect([draft, merged, closed, locked].map((p) => [p!.number, p!.headRef, p!.crossRepo])).toEqual([
      [7, 'settings', false], [5, 'fix', false], [4, 'attempt', true], [2, 'deps', false],
    ]);
    expect(mrs.map((m) => [m.sourceProjectId, m.targetProjectId])).toEqual([[40, 40], [40, 40], [57, 40], [40, 40]]);
  });

  it("counts an MR from a fork that was deleted (no source project) as cross-repo: its branch is not the project's", () => {
    expect(mapMergeRequest({ ...mrs[1]!, sourceProjectId: null }, BASE).crossRepo).toBe(true);
    // Whichever way they differ.
    expect(mapMergeRequest({ ...mrs[1]!, sourceProjectId: 41 }, BASE).crossRepo).toBe(true);
    expect(mapMergeRequest({ ...mrs[2]!, sourceProjectId: 40 }, BASE).crossRepo).toBe(false);
  });

  it('counts a locked MR (mid-merge) as open', () => {
    expect(locked).toMatchObject({ number: 2, state: 'open', mergedBy: null, activityAt: '2026-09-18T09:00:00Z', labels: [], commits: [], commitCount: 1 });
  });
});

describe('GitLab → rows: issues, commits, releases, stars', () => {
  it('maps issues from REST, with who closed them', () => {
    const [open, closed] = issues.map((i) => mapIssue(i, BASE));
    expect(open).toEqual({
      number: 9, title: 'Dark mode', body: 'Please add a dark mode.', state: 'open',
      author: { login: 'dave', name: 'Dave D', email: null, avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/4/avatar.png' },
      closedBy: null, createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-26T00:00:00Z', closedAt: null, activityAt: '2026-09-25T10:00:00Z',
      labels: [{ name: 'enhancement', color: 'a2eeef' }], url: 'https://gitlab.example.com/gitlab/alice/app/-/issues/9',
    });
    expect(closed).toMatchObject({
      number: 3, body: '', state: 'closed', closedAt: '2026-09-21T10:00:01Z', activityAt: '2026-09-21T10:00:01Z',
      closedBy: { login: 'alice', name: 'Alice A', email: null, avatarUrl: null }, author: { login: 'bob' },
    });
  });

  it('maps commits: UTC dates, lower-cased emails, no login or MR number', () => {
    const [merge, direct] = commits.map(mapCommit);
    expect(merge).toEqual({
      oid: '3333333333333333333333333333333333333333', headline: "Merge branch 'fix' into 'main'", body: 'Fix login flow\n\nSee merge request alice/app!5',
      author: { login: null, name: 'Alice A', email: 'alice@example.com', avatarUrl: null }, committedAt: '2026-09-21T10:00:00Z',
      url: 'https://gitlab.example.com/gitlab/alice/app/-/commit/3333333333333333333333333333333333333333', additions: 12, deletions: 3, prNumber: null,
    });
    expect(direct).toMatchObject({ headline: 'Tweak config', body: '', committedAt: '2026-09-21T03:30:00Z', author: { email: 'alice@work.example' } });
  });

  it('maps a project of the membership list as a candidate: visibility, fork and last activity', () => {
    const listed = new Map((memberProjectsFixture as unknown as RestProject[]).map(mapCandidate).map((c) => [c.nameWithOwner, c]));
    expect(listed.get('team/platform/api')).toEqual({
      nodeId: 'gid://gitlab/Project/40', name: 'api', nameWithOwner: 'team/platform/api', owner: 'team/platform', description: 'Platform API',
      visibility: 'private', isArchived: false, isFork: false, stars: 5, pushedAt: '2026-09-27T10:00:00Z',
    });
    expect(listed.get('bob/tool')).toMatchObject({ nodeId: 'gid://gitlab/Project/23', visibility: 'internal', isFork: true, description: "Bob's helper scripts" });
    expect(listed.get('team/docs')).toMatchObject({ name: 'docs', description: null, visibility: 'public' });
    expect(listed.get('alice/corp.tools')).toMatchObject({ isArchived: true });
  });

  it('drops upcoming releases like drafts, and publishes historical ones at their release date', () => {
    const [upcoming, unnamed, historical] = releases.map((r) => mapRelease(r, BASE));
    expect(upcoming).toBeNull();
    expect(unnamed).toEqual({
      tag: 'v1.1.0', name: null, body: '', author: null, publishedAt: '2026-09-23T15:00:00Z', isPrerelease: false,
      url: 'https://gitlab.example.com/gitlab/alice/app/-/releases/v1.1.0',
    });
    expect(historical).toMatchObject({
      tag: 'v1.0.0', name: 'First', publishedAt: '2025-02-01T12:00:00Z',
      author: { login: 'alice', avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/2/avatar.png' },
    });
    expect(releases.map(releaseCreatedAt)).toEqual(['2026-09-24T10:00:00Z', '2026-09-23T15:00:00Z', '2026-09-20T09:00:00Z']);
  });

  it('maps starrers', () => {
    expect(starrers.map((s) => mapStar(s, BASE))).toEqual([
      { login: 'carol', name: 'Carol C', avatarUrl: 'https://secure.gravatar.com/avatar/ca401', starredAt: '2026-09-20T00:00:00Z' },
      { login: 'dave', name: null, avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/6/avatar.png', starredAt: '2026-09-25T06:00:00Z' },
    ]);
  });
});
