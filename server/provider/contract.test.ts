// The provider contract itself: its types, checked by `npm run typecheck`, and the shared conformance suite
// (test/sync-source-contract.ts) run against a small in-memory source that follows it to the letter, so the suite is
// known to pass a correct source before GitHub's and GitLab's run it against their fakes.

import { describe, expectTypeOf, it } from 'vitest';
import type { CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import { GitHubDiffSource } from '../github/diff-source';
import { GitHubSyncSource } from '../github/sync-source';
import { GitHubError } from '../github/transport';
import { GitLabDiffSource } from '../gitlab/diff-source';
import { GitLabSyncSource } from '../gitlab/sync-source';
import { GitLabError } from '../gitlab/transport';
import { describeSyncSourceContract } from '../test/sync-source-contract';
import type { AccessFailure } from './access';
import { SourceError } from './errors';
import type {
  BackfillCounts,
  DiffSource,
  LookupRecord,
  Page,
  ProbeResult,
  RecheckResult,
  RefreshResult,
  RepoCandidateRecord,
  RepoCandidates,
  RepoRead,
  RoundRequest,
  RoundResult,
  SyncSource,
  TrackedRepo,
  ViewerAccount,
  ViewerInfo,
} from './types';

describe('provider types', () => {
  it('are implemented by the sources', () => {
    expectTypeOf<GitHubSyncSource>().toExtend<SyncSource>();
    expectTypeOf<GitLabSyncSource>().toExtend<SyncSource>();
    expectTypeOf<GitHubDiffSource>().toExtend<DiffSource>();
    expectTypeOf<GitLabDiffSource>().toExtend<DiffSource>();
    // Every provider's errors are SourceErrors, access verdict included.
    expectTypeOf<GitHubError>().toExtend<SourceError>();
    expectTypeOf<GitLabError>().toExtend<SourceError>();
    expectTypeOf<SourceError['access']>().toEqualTypeOf<AccessFailure | null>();
  });

  it('say what each read carries', () => {
    // A read is either a record (fields named by RepoRecord's keys) or the reason there is none.
    expectTypeOf<Extract<RepoRead, { ok: true }>['denied']>().toEqualTypeOf<(keyof RepoRecord)[]>();
    expectTypeOf<Extract<RepoRead, { ok: false }>>().toEqualTypeOf<{ ok: false; access: AccessFailure }>();
    expectTypeOf<Extract<LookupRecord, { ok: false }>['access']>().toEqualTypeOf<AccessFailure>();
    expectTypeOf<LookupRecord['viewer']>().toEqualTypeOf<ViewerInfo>();
    // A repo record can be offered as a candidate; a tracked repo is named by node id and stored path.
    expectTypeOf<RepoRecord>().toExtend<RepoCandidateRecord>();
    expectTypeOf<RepoRecord>().not.toExtend<TrackedRepo>();
    expectTypeOf<ViewerAccount>().toExtend<ViewerInfo>();
    expectTypeOf<SyncSource['viewer']>().returns.resolves.toEqualTypeOf<ViewerAccount>();
    expectTypeOf<SyncSource['probes']>().returns.resolves.toEqualTypeOf<ProbeResult>();
    expectTypeOf<SyncSource['refresh']>().returns.resolves.toEqualTypeOf<RefreshResult>();
    expectTypeOf<SyncSource['requestsFor']>().parameter(0).toEqualTypeOf<BackfillCounts>();
    expectTypeOf<PrRecord['mergeCommitOid']>().toEqualTypeOf<string | null>();
    expectTypeOf<PrRecord['squashCommitOid']>().toEqualTypeOf<string | null>();
  });
});

// ---------------------------------------------------------------------------
// A reference source: everything in memory, one item per page so every cursor is followed.
// ---------------------------------------------------------------------------

const sha = (c: string) => c.repeat(40).slice(0, 40);
const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T09:00:00Z`;
const alice = { login: 'alice', name: 'Alice A', email: 'alice@example.com', avatarUrl: null };

interface Stored {
  record: RepoRecord;
  probe: RepoProbe;
  prs: PrRecord[];
  issues: IssueRecord[];
  commits: CommitRecord[];
  releases: ReleaseRecord[];
  stars: StarRecord[];
}

function repo(owner: string, name: string, items: Partial<Omit<Stored, 'record' | 'probe'>> = {}): Stored {
  const record: RepoRecord = {
    nodeId: `R_${owner}/${name}`, name, nameWithOwner: `${owner}/${name}`, owner, description: null, url: `https://code.example.com/${owner}/${name}`,
    visibility: 'public', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
    stars: items.stars?.length ?? 0, forks: 0, createdAt: day(1), pushedAt: day(20),
  };
  const prs = items.prs ?? [];
  const issues = items.issues ?? [];
  const probe: RepoProbe = {
    openPrs: prs.filter((p) => p.state === 'open').length, openIssues: issues.filter((i) => i.state === 'open').length,
    latestPrUpdatedAt: prs[0]?.updatedAt ?? null, latestIssueUpdatedAt: issues[0]?.updatedAt ?? null,
    releaseTags: (items.releases ?? []).slice(0, 3).map((r) => r.tag), latestStarredAt: items.stars?.[0]?.starredAt ?? null,
  };
  return { record, probe, prs, issues, commits: [], releases: [], stars: [], ...items };
}

function pr(number: number, state: PrRecord['state'], at: string): PrRecord {
  return {
    number, title: `PR ${number}`, body: '', state, isDraft: false, author: alice, mergedBy: state === 'merged' ? 'alice' : null,
    createdAt: at, updatedAt: at, mergedAt: state === 'merged' ? at : null, closedAt: state === 'open' ? null : at, activityAt: at,
    additions: 1, deletions: 0, changedFiles: 1, commitCount: 1, headRef: 'topic', headOid: sha(String(number)), baseRef: 'main',
    labels: [], closingIssues: [], url: `https://code.example.com/pr/${number}`, commits: [],
    mergeCommitOid: null, squashCommitOid: null,
  };
}

function issue(number: number, state: IssueRecord['state'], at: string): IssueRecord {
  return {
    number, title: `Issue ${number}`, body: '', state, author: alice, closedBy: state === 'closed' ? alice : null,
    createdAt: at, updatedAt: at, closedAt: state === 'closed' ? at : null, activityAt: at, labels: [], url: `https://code.example.com/issues/${number}`,
  };
}

const commit = (c: string, at: string, prNumber: number | null): CommitRecord => ({
  oid: sha(c), headline: `Commit ${c}`, body: '', author: alice, committedAt: at, url: `https://code.example.com/c/${c}`, additions: 1, deletions: 0, prNumber,
});

class MemorySource implements SyncSource {
  readonly kind = 'github';
  readonly rateLimit = null;
  readonly points = null;
  readonly probesStars = true;
  readonly linksCommits = true;
  requests = 0;
  /** Node ids whose probe request fails, and the one whose description the token may not read. */
  readonly failing = new Set<string>();
  deniedDescription: string | null = null;
  private readonly me: ViewerAccount = { id: 'U_alice', login: 'alice', name: 'Alice A', avatarUrl: null, emails: ['alice@example.com'] };

  constructor(readonly repos: Stored[]) {}

  private spend<T>(value: T): T {
    this.requests++;
    return value;
  }

  private owned(): Stored[] {
    return this.repos.filter((r) => r.record.owner === this.me.login);
  }

  private read(t: TrackedRepo): RepoRead {
    const found = this.repos.find((r) => r.record.nodeId === t.nodeId);
    if (!found) return { ok: false, access: { problem: 'not-found', message: `The host doesn't show ${t.path} to this token.`, hint: null } };
    if (this.deniedDescription !== t.nodeId) return { ok: true, record: found.record, probe: found.probe, denied: [], problem: null };
    return { ok: true, record: { ...found.record, description: null }, probe: null, denied: ['description'], problem: `The token can't read the description of ${t.path}.` };
  }

  async viewer() {
    return this.spend(this.me);
  }

  async ownedRepos() {
    return this.spend({ viewer: this.me, repos: this.owned().map((r) => r.record) });
  }

  async refresh(repos: TrackedRepo[]): Promise<RefreshResult> {
    if (!repos.length) return { reads: new Map(), errors: [] };
    return this.spend({ reads: new Map(repos.map((t) => [t.nodeId, this.read(t)])), errors: [] });
  }

  async repoByNode(t: TrackedRepo) {
    return this.spend({ viewer: this.me, read: this.read(t) });
  }

  async repo(name: string) {
    const found = this.owned().find((r) => r.record.name === name);
    return this.spend({ viewer: this.me, found: found ? { record: found.record, probe: found.probe } : null });
  }

  async probes(repos: RepoRecord[]): Promise<ProbeResult> {
    const out: ProbeResult = { probes: new Map(), errors: [] };
    for (const r of repos) {
      this.requests++;
      if (this.failing.has(r.nodeId)) out.errors.push(`${r.nameWithOwner}: server error`);
      else out.probes.set(r.nodeId, this.repos.find((s) => s.record.nodeId === r.nodeId)!.probe);
    }
    return out;
  }

  async round(r: RepoRecord, req: RoundRequest): Promise<RoundResult> {
    const s = this.repos.find((x) => x.record.nodeId === r.nodeId);
    if (!s) throw new SourceError('not-found', `${r.nameWithOwner} is gone`, { access: { problem: 'not-found', message: `${r.nameWithOwner} is gone.`, hint: null } });
    const page = <T>(items: T[], after: string | null): Page<T> => {
      const at = after ? Number(after) : 0;
      return { items: items.slice(at, at + 1), hasMore: at + 1 < items.length, endCursor: at + 1 < items.length ? String(at + 1) : null };
    };
    const out: RoundResult = {};
    if (req.commits) out.commits = page(s.commits.filter((c) => c.committedAt >= req.commits!.since), req.commits.after);
    if (req.prs) out.prs = page(s.prs, req.prs.after);
    if (req.issues) out.issues = page(s.issues, req.issues.after);
    if (req.openPrs) out.openPrs = page(s.prs.filter((p) => p.state === 'open'), req.openPrs.after);
    if (req.openIssues) out.openIssues = page(s.issues.filter((i) => i.state === 'open'), req.openIssues.after);
    if (req.releases) {
      const p = page(s.releases, req.releases.after);
      out.releases = { ...p, oldestCreatedAt: p.items.at(-1)?.publishedAt ?? null };
    }
    if (req.stars) out.stars = { ...page(s.stars, req.stars.after), totalCount: s.stars.length };
    return this.spend(out);
  }

  async recheck(r: RepoRecord, prs: number[], issues: number[]): Promise<RecheckResult> {
    if (!prs.length && !issues.length) return { prs: new Map(), issues: new Map() };
    const s = this.repos.find((x) => x.record.nodeId === r.nodeId)!;
    return this.spend({
      prs: new Map(prs.map((n) => [n, s.prs.find((p) => p.number === n) ?? null])),
      issues: new Map(issues.map((n) => [n, s.issues.find((i) => i.number === n) ?? null])),
    });
  }

  async candidates(): Promise<RepoCandidates> {
    const items = this.repos.filter((r) => r.record.owner !== this.me.login).map((r) => r.record);
    return this.spend({ viewer: this.me, items, suggested: items.slice(0, 1), truncated: false });
  }

  async lookup(path: string, since: string): Promise<LookupRecord> {
    const s = this.repos.find((r) => r.record.nameWithOwner.toLowerCase() === path.toLowerCase());
    if (!s) return this.spend({ ok: false, viewer: this.me, path, access: { problem: 'not-found', message: `The host doesn't show ${path} to this token.`, hint: null } });
    const counts: BackfillCounts = {
      commits: s.commits.filter((c) => c.committedAt >= since).length, prs: s.prs.filter((p) => p.updatedAt >= since).length,
      issues: s.issues.filter((i) => i.updatedAt >= since).length, releases: s.releases.length, openPrs: s.probe.openPrs, openIssues: s.probe.openIssues,
    };
    return this.spend({ ok: true, viewer: this.me, record: s.record, probe: s.probe, owned: s.record.owner === this.me.login, counts });
  }

  requestsFor(c: BackfillCounts): number | null {
    if (c.commits === null || c.prs === null || c.issues === null) return null;
    return Math.max(1, Math.ceil(c.commits / 100), Math.ceil(c.prs / 50), Math.ceil(c.issues / 50)) + Math.ceil(c.openPrs / 50) + Math.ceil(c.openIssues / 50);
  }
}

const fixtures = () => [
  repo('alice', 'app', {
    prs: [pr(2, 'open', day(20)), pr(1, 'merged', day(12))],
    issues: [issue(4, 'open', day(21)), issue(3, 'closed', day(11))],
    commits: [commit('b', day(19), 1), commit('a', day(10), null), commit('0', '2025-01-01T00:00:00Z', null)],
    releases: [
      { tag: 'v2', name: null, body: '', author: alice, publishedAt: day(18), isPrerelease: false, url: 'https://code.example.com/r/v2' },
      { tag: 'v1', name: 'One', body: '', author: alice, publishedAt: day(9), isPrerelease: true, url: 'https://code.example.com/r/v1' },
    ],
    stars: [{ login: 'bob', name: null, avatarUrl: null, starredAt: day(17) }, { login: 'carol', name: 'Carol', avatarUrl: null, starredAt: day(8) }],
  }),
  repo('alice', 'notes'),
  repo('bob', 'tool', { prs: [pr(5, 'closed', day(3))] }),
];

describeSyncSourceContract('An in-memory source', {
  setup() {
    const source = new MemorySource(fixtures());
    const app = () => source.repos.find((r) => r.record.name === 'app')!;
    return {
      source,
      failProbe: (nodeId) => source.failing.add(nodeId),
      denyField: () => {
        source.deniedDescription = 'R_bob/tool';
        return ['description'];
      },
      transferPr: (n) => (app().prs = app().prs.filter((p) => p.number !== n)),
    };
  },
  account: { viewer: 'alice', owned: ['alice/app', 'alice/notes'], repo: { found: 'app', missing: 'nothing' } },
  busy: { path: 'alice/app', since: day(1), pr: 1, issue: 3, missingPr: 99, missingIssue: 98 },
  manual: { readable: { nodeId: 'R_bob/tool', path: 'bob/tool' }, missing: { nodeId: 'R_carol/gone', path: 'carol/gone' } },
  tracking: { readable: 'bob/tool', missing: 'carol/gone', since: day(1) },
});
