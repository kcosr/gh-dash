// The SyncSource contract (server/provider/types.ts) as tests any source runs against its own fake:
//
//   describeSyncSourceContract('GitLabSyncSource', { setup: () => ({ source: new GitLabSyncSource(…) }), … });
//
// The harness describes the scenario the fake holds (who the token belongs to, what it owns, which repo has items).
// Parts a source doesn't answer yet are left out of the harness and show as todo; provider-specific behaviours (a
// failing probe request, a denied field, a transferred PR) run when the setup offers a hook for them. The check*
// functions are exported for a source's own tests.

import { describe, expect, it } from 'vitest';
import type { CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import type { AccessFailure } from '../provider/access';
import type {
  BackfillCounts,
  Page,
  RepoCandidateRecord,
  RepoRead,
  RoundRequest,
  RoundResult,
  SyncSource,
  TrackedRepo,
  ViewerInfo,
} from '../provider/types';

/** A source over a fresh fake, and hooks into that fake for the cases that need one. */
export interface ContractSetup {
  source: SyncSource;
  /** From now on, probing `nodeId` fails with an error that isn't fatal (say, a server error for its request). */
  failProbe?(nodeId: string): void;
  /**
   * From now on, the token may not read one field of the repo added by hand (`manual.readable`); returns the
   * RepoRecord keys that field fills, which a read must list as `denied`.
   */
  denyField?(): (keyof RepoRecord)[];
  /** Moves PR `number` of the busy repo to another repository, where a recheck must no longer find it. */
  transferPr?(number: number): void;
}

export interface SyncSourceHarness {
  /**
   * A source over a fresh fake holding the scenario below; each case builds its own. The fake must page consistently:
   * following a section's cursors ends.
   */
  setup(): ContractSetup;
  account: {
    /** The login of the token's account. */
    viewer: string;
    /** Paths (nameWithOwner) of every repo it owns. */
    owned: string[];
    /** `repo()`'s argument for one of them (GitHub: its short name; GitLab: its path), and one that names nothing. */
    repo: { found: string; missing: string };
  };
  /** An owned repo with items: rounds from `since`, and rechecks of a PR and an issue it has and numbers it hasn't. */
  busy: { path: string; since: string; pr: number; issue: number; missingPr: number; missingIssue: number };
  /** Repos added by hand: one the token reads (someone else's) and one it can't see. Omitted: refresh/repoByNode todo. */
  manual?: { readable: TrackedRepo; missing: TrackedRepo };
  /** The Add dialog: paths of a repo the token reads (someone else's) and of one it can't see. Omitted: todo. */
  tracking?: { readable: string; missing: string; since: string };
}

const ISO_SEC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** A full commit SHA: SHA-1, or SHA-256 repositories' 64 characters. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const URL_RE = /^https?:\/\/\S+$/;
const PROBLEMS = ['not-found', 'sso', 'org-policy', 'permission'];

const count = (n: unknown, what: string) => expect(Number.isInteger(n) && (n as number) >= 0, `${what}: ${String(n)}`).toBe(true);
const time = (t: unknown, what: string) => expect(t, what).toMatch(ISO_SEC);
const timeOrNull = (t: unknown, what: string) => t === null || time(t, what);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function checkViewer(v: ViewerInfo, login?: string): void {
  expect(typeof v.login === 'string' && v.login.length > 0, `viewer login: ${v.login}`).toBe(true);
  if (login) expect(same(v.login, login), `viewer ${v.login}, expected ${login}`).toBe(true);
  expect(v.id === null || typeof v.id === 'string').toBe(true);
  expect(v.name === null || typeof v.name === 'string').toBe(true);
  if (v.avatarUrl !== null) expect(v.avatarUrl, 'avatarUrl').toMatch(URL_RE);
}

/** Every timestamp is whole seconds in UTC ("…T09:00:00Z"): the sync compares them as strings. */
export function checkRepoRecord(r: RepoRecord | RepoCandidateRecord): void {
  const at = `repo ${r.nameWithOwner}`;
  expect(r.nodeId, `${at}: nodeId`).toBeTruthy();
  expect(r.nameWithOwner, `${at}: nameWithOwner is owner/name`).toBe(`${r.owner}/${r.name}`);
  expect(['public', 'private', 'internal'], `${at}: visibility`).toContain(r.visibility);
  expect([typeof r.isArchived, typeof r.isFork], at).toEqual(['boolean', 'boolean']);
  count(r.stars, `${at}: stars`);
  timeOrNull(r.pushedAt, `${at}: pushedAt`);
  if (!('url' in r)) return;
  expect(r.url, `${at}: url`).toMatch(URL_RE);
  expect(Array.isArray(r.topics) && r.topics.every((t) => typeof t === 'string'), `${at}: topics`).toBe(true);
  expect(r.defaultBranch === null || (typeof r.defaultBranch === 'string' && r.defaultBranch.length > 0), `${at}: defaultBranch`).toBe(true);
  count(r.forks, `${at}: forks`);
  time(r.createdAt, `${at}: createdAt`);
}

export function checkProbe(p: RepoProbe, probesStars: boolean): void {
  count(p.openPrs, 'probe openPrs');
  count(p.openIssues, 'probe openIssues');
  timeOrNull(p.latestPrUpdatedAt, 'probe latestPrUpdatedAt');
  timeOrNull(p.latestIssueUpdatedAt, 'probe latestIssueUpdatedAt');
  expect(p.releaseTags.every((t) => typeof t === 'string' && t.length > 0), 'probe releaseTags').toBe(true);
  if (probesStars) timeOrNull(p.latestStarredAt, 'probe latestStarredAt');
  else expect(p.latestStarredAt, 'probe latestStarredAt without probesStars').toBeNull();
}

export function checkPage<T>(page: Page<T>, check: (item: T) => void, what: string): void {
  expect(Array.isArray(page.items), `${what}: items`).toBe(true);
  expect(typeof page.hasMore, `${what}: hasMore`).toBe('boolean');
  // The sync continues from endCursor whenever hasMore says so.
  if (page.hasMore) expect(typeof page.endCursor === 'string' && page.endCursor.length > 0, `${what}: endCursor with hasMore`).toBe(true);
  page.items.forEach(check);
}

export function checkPr(p: PrRecord): void {
  const at = `PR ${p.number}`;
  expect(Number.isInteger(p.number) && p.number > 0, at).toBe(true);
  expect(['open', 'closed', 'merged'], `${at}: state`).toContain(p.state);
  expect([typeof p.title, typeof p.body, typeof p.isDraft], at).toEqual(['string', 'string', 'boolean']);
  for (const k of ['createdAt', 'updatedAt', 'activityAt'] as const) time(p[k], `${at}: ${k}`);
  if (p.state === 'merged') time(p.mergedAt, `${at}: mergedAt`);
  else expect(p.mergedAt, `${at}: mergedAt when not merged`).toBeNull();
  timeOrNull(p.closedAt, `${at}: closedAt`);
  for (const k of ['additions', 'deletions', 'changedFiles', 'commitCount'] as const) count(p[k], `${at}: ${k}`);
  // A provider may not know an MR's head yet (GitLab, before its first diff).
  if (p.headOid !== '') expect(p.headOid, `${at}: headOid`).toMatch(OID);
  for (const c of p.commits) {
    expect(c.oid, `${at}: commit oid`).toMatch(OID);
    time(c.committedAt, `${at}: commit committedAt`);
  }
  for (const k of ['mergeCommitOid', 'squashCommitOid'] as const) {
    if (p[k] !== null) expect(p[k], `${at}: ${k}`).toMatch(OID);
    if (p.state !== 'merged') expect(p[k], `${at}: ${k} when not merged`).toBeNull();
  }
}

export function checkIssue(i: IssueRecord): void {
  const at = `issue ${i.number}`;
  expect(Number.isInteger(i.number) && i.number > 0, at).toBe(true);
  expect(['open', 'closed'], `${at}: state`).toContain(i.state);
  for (const k of ['createdAt', 'updatedAt', 'activityAt'] as const) time(i[k], `${at}: ${k}`);
  timeOrNull(i.closedAt, `${at}: closedAt`);
}

export function checkCommit(c: CommitRecord, linksCommits: boolean): void {
  expect(c.oid, 'commit oid').toMatch(OID);
  time(c.committedAt, `commit ${c.oid}: committedAt`);
  count(c.additions, `commit ${c.oid}: additions`);
  count(c.deletions, `commit ${c.oid}: deletions`);
  if (!linksCommits) expect(c.prNumber, `commit ${c.oid}: prNumber without linksCommits`).toBeNull();
}

export function checkRelease(r: ReleaseRecord): void {
  expect(r.tag, 'release tag').toBeTruthy();
  time(r.publishedAt, `release ${r.tag}: publishedAt`);
  expect(typeof r.isPrerelease).toBe('boolean');
}

export function checkStar(s: StarRecord): void {
  expect(s.login, 'star login').toBeTruthy();
  time(s.starredAt, `star ${s.login}: starredAt`);
}

export function checkAccess(a: AccessFailure, problem?: AccessFailure['problem'], names?: string): void {
  expect(PROBLEMS).toContain(a.problem);
  if (problem) expect(a.problem).toBe(problem);
  expect(typeof a.message === 'string' && a.message.length > 0, 'access message').toBe(true);
  if (names) expect(a.message, 'access message names the repo').toContain(names);
  expect(a.hint === null || (typeof a.hint === 'string' && a.hint.length > 0), 'access hint').toBe(true);
}

export function checkCounts(c: BackfillCounts): void {
  for (const k of ['commits', 'prs', 'issues'] as const) if (c[k] !== null) count(c[k], `counts ${k}`);
  for (const k of ['releases', 'openPrs', 'openIssues'] as const) count(c[k], `counts ${k}`);
}

/** Every section of `res` is well formed, and exactly the ones `req` asked for are there. */
export function checkRound(req: RoundRequest, res: RoundResult, source: Pick<SyncSource, 'linksCommits'>): void {
  expect(Object.keys(res).sort(), 'sections answered').toEqual(Object.keys(req).sort());
  if (res.commits) checkPage(res.commits, (c) => checkCommit(c, source.linksCommits), 'commits');
  if (res.prs) checkPage(res.prs, checkPr, 'prs');
  if (res.issues) checkPage(res.issues, checkIssue, 'issues');
  if (res.openPrs) {
    checkPage(res.openPrs, checkPr, 'openPrs');
    expect(res.openPrs.items.filter((p) => p.state !== 'open').map((p) => p.number), 'openPrs that are not open').toEqual([]);
  }
  if (res.openIssues) {
    checkPage(res.openIssues, checkIssue, 'openIssues');
    expect(res.openIssues.items.filter((i) => i.state !== 'open').map((i) => i.number), 'openIssues that are not open').toEqual([]);
  }
  if (res.releases) {
    checkPage(res.releases, checkRelease, 'releases');
    timeOrNull(res.releases.oldestCreatedAt, 'releases oldestCreatedAt');
  }
  if (res.stars) {
    checkPage(res.stars, checkStar, 'stars');
    count(res.stars.totalCount, 'stars totalCount');
  }
}

function checkRead(read: RepoRead | undefined, want: TrackedRepo, probesStars: boolean): void {
  expect(read, `a read of ${want.path}`).toBeDefined();
  if (!read!.ok) throw new Error(`${want.path} can't be read: ${read!.access.message}`);
  expect(read!.record.nodeId).toBe(want.nodeId);
  checkRepoRecord(read!.record);
  if (read!.probe) checkProbe(read!.probe, probesStars);
}

function checkUnreadable(read: RepoRead | undefined, want: TrackedRepo): void {
  expect(read, `a read of ${want.path}`).toBeDefined();
  if (read!.ok) throw new Error(`${want.path} was read: ${read!.record.nameWithOwner}`);
  checkAccess(read!.access, 'not-found', want.path);
}

const SECTIONS = ['commits', 'prs', 'issues', 'openPrs', 'openIssues', 'releases', 'stars'] as const;

export function describeSyncSourceContract(name: string, h: SyncSourceHarness): void {
  /** Which hooks the setup offers: the cases that need one run only then. */
  const hooks = h.setup();
  const ownedRecords = async (source: SyncSource) => (await source.ownedRepos()).repos;
  const busyRecord = async (source: SyncSource) => {
    const found = (await ownedRecords(source)).find((r) => same(r.nameWithOwner, h.busy.path));
    if (!found) throw new Error(`the fake's owned repos don't include ${h.busy.path}`);
    return found;
  };
  const firstPages = (): RoundRequest => ({
    commits: { after: null, since: h.busy.since },
    ...Object.fromEntries(SECTIONS.filter((s) => s !== 'commits').map((s) => [s, { after: null }])),
  });

  describe(`${name}: the SyncSource contract`, () => {
    describe('account', () => {
      it("viewer(): the token's account and its commit emails; counters and flags", async () => {
        const { source } = h.setup();
        expect(['github', 'gitlab']).toContain(source.kind);
        expect([typeof source.probesStars, typeof source.linksCommits]).toEqual(['boolean', 'boolean']);
        const before = source.requests;
        const v = await source.viewer();
        checkViewer(v, h.account.viewer);
        expect(v.emails.every((e) => typeof e === 'string' && e.includes('@') && e === e.toLowerCase()), `emails ${v.emails.join(', ')}`).toBe(true);
        expect(source.requests).toBeGreaterThan(before);
        expect(source.points === null || (typeof source.points === 'number' && source.points >= 0)).toBe(true);
      });

      it('ownedRepos(): every owned repo once, with the viewer the list belongs to', async () => {
        const { source } = h.setup();
        const { viewer, repos } = await source.ownedRepos();
        checkViewer(viewer, h.account.viewer);
        repos.forEach(checkRepoRecord);
        expect(repos.map((r) => r.nameWithOwner.toLowerCase()).sort()).toEqual(h.account.owned.map((p) => p.toLowerCase()).sort());
        expect(new Set(repos.map((r) => r.nodeId)).size).toBe(repos.length);
      });

      it('repo(): an owned repo with its probe, or none, and the viewer either way', async () => {
        const { source } = h.setup();
        const hit = await source.repo(h.account.repo.found);
        checkViewer(hit.viewer, h.account.viewer);
        expect(hit.found, `repo(${h.account.repo.found})`).not.toBeNull();
        checkRepoRecord(hit.found!.record);
        checkProbe(hit.found!.probe, source.probesStars);
        const miss = await source.repo(h.account.repo.missing);
        checkViewer(miss.viewer, h.account.viewer);
        expect(miss.found).toBeNull();
      });
    });

    describe('probes', () => {
      it('probes(): one per repo, no errors; nothing asked, nothing spent', async () => {
        const { source } = h.setup();
        const repos = await ownedRecords(source);
        const { probes, errors } = await source.probes(repos);
        expect(errors).toEqual([]);
        expect([...probes.keys()].sort()).toEqual(repos.map((r) => r.nodeId).sort());
        for (const p of probes.values()) checkProbe(p, source.probesStars);
        const spent = source.requests;
        expect(await source.probes([])).toEqual({ probes: new Map(), errors: [] });
        expect(source.requests).toBe(spent);
      });

      if (hooks.failProbe) it('probes(): a request that fails leaves its repos out and says why, without failing the call', async () => {
        const s = h.setup();
        const repos = await ownedRecords(s.source);
        const busy = repos.find((r) => same(r.nameWithOwner, h.busy.path))!;
        s.failProbe!(busy.nodeId);
        const { probes, errors } = await s.source.probes(repos);
        expect(probes.has(busy.nodeId)).toBe(false);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every((e) => typeof e === 'string' && e.length > 0)).toBe(true);
      });
    });

    describe('rounds', () => {
      it('round(): exactly the sections asked for, each a well-formed page', async () => {
        const { source } = h.setup();
        const repo = await busyRecord(source);
        const all = firstPages();
        checkRound(all, await source.round(repo, all), source);
        for (const s of SECTIONS) {
          const one = { [s]: all[s] } as RoundRequest;
          checkRound(one, await source.round(repo, one), source);
        }
      });

      it('round(): every section ends when followed by its cursors', async () => {
        const { source } = h.setup();
        const repo = await busyRecord(source);
        let req = firstPages();
        for (let n = 0; Object.keys(req).length > 0; n++) {
          if (n >= 50) throw new Error(`still paging after 50 rounds: ${Object.keys(req).join(', ')}`);
          const res = await source.round(repo, req);
          checkRound(req, res, source);
          const next: RoundRequest = {};
          for (const s of SECTIONS) {
            const page = res[s];
            if (page?.hasMore) Object.assign(next, { [s]: { ...req[s]!, after: page.endCursor } });
          }
          req = next;
        }
      });
    });

    describe('recheck', () => {
      it('recheck(): exactly the numbers asked for, null for what is gone; nothing asked, nothing spent', async () => {
        const { source } = h.setup();
        const repo = await busyRecord(source);
        const { pr, missingPr, issue, missingIssue } = h.busy;
        const res = await source.recheck(repo, [pr, missingPr], [issue, missingIssue]);
        expect([...res.prs.keys()].sort()).toEqual([pr, missingPr].sort());
        expect([...res.issues.keys()].sort()).toEqual([issue, missingIssue].sort());
        expect(res.prs.get(pr)?.number).toBe(pr);
        checkPr(res.prs.get(pr)!);
        expect(res.issues.get(issue)?.number).toBe(issue);
        checkIssue(res.issues.get(issue)!);
        expect([res.prs.get(missingPr), res.issues.get(missingIssue)]).toEqual([null, null]);
        const spent = source.requests;
        expect(await source.recheck(repo, [], [])).toEqual({ prs: new Map(), issues: new Map() });
        expect(source.requests).toBe(spent);
      });

      if (hooks.transferPr) it('recheck(): a PR moved to another repository is gone from this one', async () => {
        const s = h.setup();
        const repo = await busyRecord(s.source);
        s.transferPr!(h.busy.pr);
        expect((await s.source.recheck(repo, [h.busy.pr], [])).prs.get(h.busy.pr)).toBeNull();
      });
    });

    const manual = h.manual;
    if (!manual) {
      describe('repos added by hand', () => it.todo('refresh(), repoByNode()'));
    } else {
      describe('repos added by hand', () => {
        it("refresh(): each by node id, or why it can't be read; nothing asked, nothing spent", async () => {
          const { source } = h.setup();
          const { reads, errors } = await source.refresh([manual.readable, manual.missing]);
          expect(errors).toEqual([]);
          expect([...reads.keys()].sort()).toEqual([manual.readable.nodeId, manual.missing.nodeId].sort());
          const ok = reads.get(manual.readable.nodeId);
          checkRead(ok, manual.readable, source.probesStars);
          expect(ok!.ok && [ok!.denied, ok!.problem]).toEqual([[], null]);
          checkUnreadable(reads.get(manual.missing.nodeId), manual.missing);
          const spent = source.requests;
          expect(await source.refresh([])).toEqual({ reads: new Map(), errors: [] });
          expect(source.requests).toBe(spent);
        });

        it('repoByNode(): one by node id, with the viewer', async () => {
          const { source } = h.setup();
          const hit = await source.repoByNode(manual.readable);
          checkViewer(hit.viewer, h.account.viewer);
          checkRead(hit.read, manual.readable, source.probesStars);
          const miss = await source.repoByNode(manual.missing);
          checkViewer(miss.viewer, h.account.viewer);
          checkUnreadable(miss.read, manual.missing);
        });

        if (hooks.denyField) it('refresh(): a field the token may not read is denied, with the problem, and no probe', async () => {
          const s = h.setup();
          const denied = s.denyField!();
          const read = (await s.source.refresh([manual.readable])).reads.get(manual.readable.nodeId);
          checkRead(read, manual.readable, s.source.probesStars);
          if (!read?.ok) return;
          expect([...read.denied].sort()).toEqual([...denied].sort());
          expect(typeof read.problem === 'string' && read.problem.length > 0).toBe(true);
          expect(read.probe).toBeNull();
        });
      });
    }

    const tracking = h.tracking;
    if (!tracking) {
      describe('the Add dialog', () => it.todo('candidates(), lookup(), requestsFor()'));
    } else {
      describe('the Add dialog', () => {
        it("candidates(): others' repos the token reads, with the viewer", async () => {
          const { source } = h.setup();
          const c = await source.candidates();
          checkViewer(c.viewer, h.account.viewer);
          expect(typeof c.truncated).toBe('boolean');
          [...c.items, ...c.suggested].forEach(checkRepoRecord);
          const owned = new Set(h.account.owned.map((p) => p.toLowerCase()));
          expect(c.items.filter((r) => owned.has(r.nameWithOwner.toLowerCase())).map((r) => r.nameWithOwner)).toEqual([]);
        });

        it("lookup(): a readable repo with its size, one it can't see, and one the viewer owns", async () => {
          const { source } = h.setup();
          const hit = await source.lookup(tracking.readable, tracking.since);
          checkViewer(hit.viewer, h.account.viewer);
          if (!hit.ok) throw new Error(`lookup(${tracking.readable}): ${hit.access.message}`);
          expect(same(hit.record.nameWithOwner, tracking.readable)).toBe(true);
          checkRepoRecord(hit.record);
          checkProbe(hit.probe, source.probesStars);
          checkCounts(hit.counts);
          expect(hit.owned).toBe(false);
          const miss = await source.lookup(tracking.missing, tracking.since);
          checkViewer(miss.viewer, h.account.viewer);
          if (miss.ok) throw new Error(`lookup(${tracking.missing}) found ${miss.record.nameWithOwner}`);
          checkAccess(miss.access, 'not-found', tracking.missing);
          expect(miss.path).toBe(tracking.missing);
          const own = await source.lookup(h.busy.path, tracking.since);
          expect(own.ok && own.owned).toBe(true);
        });

        it('requestsFor(): at least one request, more for more, or null when it cannot tell', () => {
          const { source } = h.setup();
          const small: BackfillCounts = { commits: 0, prs: 0, issues: 0, releases: 0, openPrs: 0, openIssues: 0 };
          const big: BackfillCounts = { commits: 5000, prs: 800, issues: 800, releases: 90, openPrs: 120, openIssues: 300 };
          const [a, b, unknown] = [small, big, { ...big, commits: null }].map((c) => source.requestsFor(c));
          for (const n of [a, b, unknown]) expect(n === null || (Number.isInteger(n) && n >= 1), String(n)).toBe(true);
          if (a !== null && b !== null) expect(b).toBeGreaterThan(a);
        });
      });
    }
  });
}
