// The diff service with two sources on one server (design §5): github.com over the GitHub fake, and gitlab.example.com
// over the fake GitLab instance, both behind the SourceRegistry. A repo's diffs come from the source it is on, are
// cached apart, and fail in that source's own terms.

import { describe, expect, it } from 'vitest';
import type { Diff } from '../../shared/api';
import { createApp } from '../api/app';
import { HttpError } from '../api/http';
import { loadConfig } from '../config';
import { upsertPr } from '../db/write';
import { GitHubDiffSources } from '../github/diff-source';
import { SourceError } from '../provider/errors';
import type { SourceConfig } from '../sources/config';
import { DiffRouter } from '../sources/diffs';
import { SourceRegistry } from '../sources/registry';
import { SyncManager } from '../sync/manager';
import commitsFixture from '../test/fixtures/gitlab/commits.json';
import commitDiffFixture from '../test/fixtures/gitlab/commit-diff.json';
import commitFixture from '../test/fixtures/gitlab/commit.json';
import versionFixture from '../test/fixtures/gitlab/mr-version.json';
import versionsFixture from '../test/fixtures/gitlab/mr-versions.json';
import { fakeGitHub, type Handler as GitHubRoute, page as ghPage, restFile, sha } from '../test/github';
import { BASE, type Handler as GitLabRoute, page as glPage } from '../test/gitlab';
import { fakeInstance } from '../test/gitlab-instance';
import { addManualRepo, prRecord, seedDb } from '../test/seed';
import { supplyOf, testTokens } from '../test/tokens';
import { DiffCache } from './cache';
import { DiffService, OPEN_PR_TTL_MS, type Payload, payloadText } from './service';

const HOST = 'gitlab.example.com';
const GL_KEY = `${HOST}/alice/app`;
const PAT = 'glpat-test-alice';
const APP = '/api/v4/projects/alice%2Fapp';
const A = sha('a');
const MERGE_BASE = sha('9');
const HEAD = commitsFixture[0]!.id;
/** The head and base of the merge request the fake instance serves (mr-revision.json, version 103). */
const MR_HEAD = versionsFixture[0]!.head_commit_sha;
const MR_BASE = versionsFixture[0]!.base_commit_sha;
const long = (c: string) => c.repeat(64);

const diffOf = async (p: Payload | Promise<Payload>) => JSON.parse(await payloadText(await p)) as Diff;
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as HttpError);

const gitlabConfig: SourceConfig = { kind: 'gitlab', host: HOST, baseUrl: BASE, tokenChoice: null, tokenFile: null, tokenEnv: 'GITLAB_TOKEN', from: 'file' };

/** What the fake instance answers to validating the token (registry.test's check data). */
const credentialCheck = () => ({
  currentUser: { id: 'gid://gitlab/User/2', username: 'alice', name: 'Alice A', avatarUrl: null, publicEmail: 'alice@example.com', commitEmail: null, emails: { nodes: [] } },
  metadata: { version: '19.3.3-ee', enterprise: true },
  personal: { count: 3 },
});

/** GitHub serving alice/app#2 at `head` (1 file), as service.test's pr2 does: its `pulls/2` answers a conditional read with 304. */
function githubPr(routes: Record<string, GitHubRoute>, head: string) {
  const body = {
    title: 'Add parser', html_url: 'https://github.com/alice/app/pull/2', changed_files: 1, additions: 12, deletions: 3, head: { sha: head }, base: { sha: sha('0'), ref: 'main' },
  };
  routes['/repos/alice/app/pulls/2'] = ({ headers }) => (headers['If-None-Match'] === 'W/"pr2"' ? { status: 304 } : { body, headers: { etag: 'W/"pr2"' } });
  routes[`/repos/alice/app/compare/${sha('0')}...${head}?per_page=1&page=2`] = { body: { merge_base_commit: { sha: MERGE_BASE }, commits: [] } };
  routes['/repos/alice/app/pulls/2/files?per_page=100'] = ghPage([restFile(1)], null);
}

/**
 * github.com (repo alice/app, PR 2) and one GitLab source (repo gitlab.example.com/alice/app, MR 2 of the fake
 * instance's fixtures), each on its own fake, with the diff service routed through the registry.
 */
function setup(o: { github?: Record<string, GitHubRoute>; gitlab?: Record<string, GitLabRoute>; ghToken?: string | null; config?: Partial<SourceConfig> } = {}) {
  const db = seedDb();
  const gh = fakeGitHub({ ...o.github });
  const gl = fakeInstance(
    {
      // The fixture merge request has no number of its own: serve its versions as this one's too.
      [`${APP}/merge_requests/2/versions`]: glPage(versionsFixture, null),
      [`${APP}/merge_requests/2/versions/103`]: { body: versionFixture },
      ...o.gitlab,
    },
    BASE,
    { CredentialCheck: credentialCheck },
  );
  const ghToken = supplyOf(() => o.ghToken ?? 'ghp_test_token');
  const githubDiffs = new GitHubDiffSources({ tokens: ghToken, fetchImpl: gh.fetchImpl, sleep: async () => {}, log: () => {} });
  const registry = new SourceRegistry({
    db,
    env: { GITLAB_TOKEN: PAT, PATH: '/usr/bin' },
    github: { tokens: testTokens('ghp_test_token').credentials, diffs: githubDiffs },
    log: () => {},
    seams: { fetchImpl: gl.fetchImpl, sleep: async () => {} },
  });
  const [runtime] = registry.apply({ glabPath: null, sources: [{ ...gitlabConfig, ...o.config }] });
  // The same path on both hosts, and the same PR number: only the source tells them apart.
  const repoId = addManualRepo(db, 'alice/app', { source: runtime!.row });
  upsertPr(db, repoId, prRecord(2, { state: 'open', createdAt: '2026-09-22T09:00:00Z', headOid: MR_HEAD, baseRef: 'main' }));
  db.run("UPDATE pull_requests SET head_oid = ? WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE key = 'alice/app')", [A]);

  const logs: string[] = [];
  const clock = { t: Date.parse('2026-09-28T00:00:00Z') };
  let tick = 0;
  const cache = new DiffCache(':memory:', () => clock.t + tick++);
  const svc = new DiffService({ db, cache, sources: new DiffRouter(registry), log: (line) => logs.push(line), now: () => clock.t });
  /** What each fake was asked while `fn` ran. */
  const spent = async <T>(fn: () => Promise<T>) => {
    gh.requests.length = 0;
    gl.requests.length = 0;
    const out = await fn();
    return { out, github: [...gh.requests], gitlab: [...gl.requests] };
  };
  const ready = async () => {
    // Validated before the tests count requests: a token seen for the first time is checked in the background.
    await runtime!.tokens.check();
    gl.requests.length = 0;
  };
  return { db, gh, gl, svc, registry, runtime: runtime!, ghToken, logs, clock, cache, spent, ready };
}

describe('the diff service across sources', () => {
  const C = sha('c');
  const githubCommit = (oid: string) => ({
    sha: oid, html_url: `https://github.com/alice/app/commit/${oid}`, commit: { message: 'Fix\n\nBody' }, parents: [{ sha: sha('p') }],
    stats: { additions: 1, deletions: 1 }, files: [restFile(1)],
  });

  it('builds a PR diff from the source the repo is on, and caches the two apart', async () => {
    const routes: Record<string, GitHubRoute> = {};
    githubPr(routes, A);
    const { svc, spent, logs, ready } = setup({ github: routes });
    await ready();

    const gh = await spent(() => diffOf(svc.prDiff('alice/app', 2)));
    expect(gh.gitlab).toEqual([]);
    expect(gh.github[0]).toBe('/repos/alice/app/pulls/2');
    expect(gh.out).toMatchObject({ kind: 'pr', repo: 'alice/app', number: 2, title: 'Add parser', headOid: A, baseOid: MERGE_BASE, totalFiles: 1 });

    const gl = await spent(() => diffOf(svc.prDiff(GL_KEY, 2)));
    expect(gl.github).toEqual([]);
    expect(gl.gitlab).toEqual(['graphql MrRevision', `${APP}/merge_requests/2/versions?per_page=20`, `${APP}/merge_requests/2/versions/103`]);
    expect(gl.out).toMatchObject({ kind: 'pr', repo: GL_KEY, number: 2, title: 'Fix login flow', headOid: MR_HEAD, baseOid: MR_BASE, totalFiles: 8 });
    expect(gl.out.files).toHaveLength(8);
    expect(gl.out.url).toMatch(/\/merge_requests\/5\/diffs$/);
    expect(logs.filter((l) => l.startsWith('[diff]'))).toEqual([
      expect.stringMatching(/^\[diff\] alice\/app#2: \d GitHub requests in [\d.]+s/),
      expect.stringMatching(new RegExp(`^\\[diff\\] ${GL_KEY.replaceAll('.', '\\.')}#2: 3 GitLab requests in [\\d.]+s$`)),
    ]);

    // Same number, same path, two sources: two entries, each served again without asking anyone.
    const again = await spent(async () => [await diffOf(svc.prDiff('alice/app', 2)), await diffOf(svc.prDiff(GL_KEY, 2))]);
    expect([again.github, again.gitlab]).toEqual([[], []]);
    expect(again.out.map((d) => [d.repo, d.headOid])).toEqual([['alice/app', A], [GL_KEY, MR_HEAD]]);
    expect(svc.stats().entries).toBe(2);
  });

  it('builds a commit diff from the source the repo is on, and expands abbreviations within the repo', async () => {
    const { svc, spent, ready } = setup({
      github: { [`/repos/alice/app/commits/${C}`]: { body: githubCommit(C) }, [`/repos/alice/app/commits/${sha('e')}`]: { status: 422, body: { message: 'No commit found' } } },
    });
    await ready();

    const gh = await spent(() => diffOf(svc.commitDiff('alice/app', C)));
    expect(gh.gitlab).toEqual([]);
    expect(gh.github).toHaveLength(1);
    expect(gh.out).toMatchObject({ kind: 'commit', repo: 'alice/app', headOid: C, title: 'Fix', baseOid: sha('p') });

    const gl = await spent(() => diffOf(svc.commitDiff(GL_KEY, HEAD)));
    expect(gl.github).toEqual([]);
    expect(gl.gitlab).toEqual([`${APP}/repository/commits/${HEAD}`, `${APP}/repository/commits/${HEAD}/diff?per_page=100&page=1`]);
    expect(gl.out).toMatchObject({ kind: 'commit', repo: GL_KEY, headOid: HEAD, title: commitFixture.title, baseOid: commitFixture.parent_ids[0] });
    expect(gl.out.files).toHaveLength(commitDiffFixture.length);

    // From each repo's own cached commits: a prefix of one repo's commit names nothing in the other.
    const cached = await spent(async () => [await diffOf(svc.commitDiff('alice/app', C.slice(0, 7))), await diffOf(svc.commitDiff(GL_KEY, HEAD.slice(0, 7)))]);
    expect([cached.github, cached.gitlab]).toEqual([[], []]);
    expect(cached.out.map((d) => d.headOid)).toEqual([C, HEAD]);
    expect((await failure(svc.commitDiff(GL_KEY, C.slice(0, 7))))?.status).toBe(404);
    expect((await failure(svc.commitDiff('alice/app', HEAD.slice(0, 7))))?.status).toBe(404);

    // A commit the source doesn't have is not found on that source.
    expect(await failure(svc.commitDiff('alice/app', sha('e')))).toMatchObject({ status: 404, message: `Commit ${sha('e')} not found on GitHub` });
    expect(await failure(svc.commitDiff(GL_KEY, sha('e')))).toMatchObject({ status: 404, message: `Commit ${sha('e')} not found on GitLab` });
  });

  it('reads file contents from the source the repo is on, and keeps those at a full SHA', async () => {
    const { svc, spent, ready } = setup({ github: { [`/repos/alice/app/contents/src/login.ts?ref=${C}`]: { text: 'from github\n' } } });
    await ready();

    const gh = await spent(async () => payloadText(await svc.blob('alice/app', C, 'src/login.ts')));
    expect(gh).toEqual({ out: 'from github\n', github: [`/repos/alice/app/contents/src/login.ts?ref=${C}`], gitlab: [] });
    const gl = await spent(async () => payloadText(await svc.blob(GL_KEY, HEAD, 'src/login.ts')));
    expect(gl.github).toEqual([]);
    expect(gl.gitlab).toEqual([`${APP}/repository/files/src%2Flogin%2Ets/raw?ref=${HEAD}`]);
    expect(gl.out).toBe("import { login } from './auth';\nconst retries = 3;\nexport { login };\n");

    const again = await spent(async () => [await payloadText(await svc.blob('alice/app', C, 'src/login.ts')), await payloadText(await svc.blob(GL_KEY, HEAD, 'src/login.ts'))]);
    expect([again.github, again.gitlab]).toEqual([[], []]);
    expect(again.out[0]).toBe('from github\n');
    // A file GitLab hasn't got is a 404 of the file, not of the host.
    expect(await failure(svc.blob(GL_KEY, HEAD, 'src/gone.ts'))).toMatchObject({ status: 404, message: `src/gone.ts not found at ${HEAD.slice(0, 7)}` });
  });

  it('serves 64-character SHAs from a GitLab repo, cached under the whole SHA', async () => {
    const S = long('5');
    const P = long('4');
    const { svc, spent, ready } = setup({
      gitlab: {
        [`${APP}/repository/commits/${S}`]: { body: { ...commitFixture, id: S, short_id: S.slice(0, 8), parent_ids: [P] } },
        [`${APP}/repository/commits/${S}/diff`]: glPage(commitDiffFixture, null, { 'x-total': String(commitDiffFixture.length) }),
        [`${APP}/repository/files/src%2Flogin%2Ets/raw`]: { text: 'export {};\n' },
      },
    });
    await ready();

    const miss = await spent(() => diffOf(svc.commitDiff(GL_KEY, S.toUpperCase())));
    expect(miss.gitlab).toEqual([`${APP}/repository/commits/${S}`, `${APP}/repository/commits/${S}/diff?per_page=100&page=1`]);
    expect(miss.out).toMatchObject({ headOid: S, baseOid: P });
    // The whole SHA and any abbreviation of it (a SHA-256 repository's run to 63) come from the cache.
    for (const ref of [S, S.slice(0, 7), S.slice(0, 45), S.slice(0, 63)]) expect((await spent(() => svc.commitDiff(GL_KEY, ref))).gitlab, ref).toEqual([]);

    expect(await payloadText(await svc.blob(GL_KEY, S, 'src/login.ts'))).toBe('export {};\n');
    expect((await spent(() => svc.blob(GL_KEY, S, 'src/login.ts'))).gitlab).toEqual([]);
    // An abbreviation of the cached commit is expanded to it, and finds the same entry.
    expect((await spent(() => svc.blob(GL_KEY, S.slice(0, 45), 'src/login.ts'))).gitlab).toEqual([]);
    expect(svc.stats().entries).toBe(2);
  });
});

describe('a source this server is not configured for', () => {
  it('answers 503 naming it, for anything that needs the source, and serves what is cached', async () => {
    const routes: Record<string, GitHubRoute> = {};
    githubPr(routes, A);
    const { svc, spent, registry, clock, ready, gh, gl } = setup({ github: routes });
    await ready();
    const fetched = await diffOf(svc.prDiff(GL_KEY, 2));
    await svc.commitDiff(GL_KEY, HEAD);

    // Its config is gone (or this is another instance sharing the database): the row and the repo stay.
    expect(registry.apply({ glabPath: null, sources: [] })).toHaveLength(1);
    const message = `No GitLab credential is configured on this server for ${HOST}`;
    const now = await spent(async () => [
      await failure(svc.prDiff(GL_KEY, 2, true)),
      await failure(svc.commitDiff(GL_KEY, sha('d'))),
      await failure(svc.blob(GL_KEY, HEAD, 'src/login.ts')),
    ]);
    expect(now.out.map((e) => [e?.status, e?.message])).toEqual([[503, message], [503, message], [503, message]]);
    expect([now.github, now.gitlab]).toEqual([[], []]);

    // The cache needs no source, and a PR diff that the last sync still agrees with beats the error once it is due.
    expect((await spent(async () => diffOf(svc.commitDiff(GL_KEY, HEAD)))).gitlab).toEqual([]);
    expect(await diffOf(svc.prDiff(GL_KEY, 2))).toEqual(fetched);
    clock.t += OPEN_PR_TTL_MS + 1;
    expect(await diffOf(svc.prDiff(GL_KEY, 2))).toEqual({ ...fetched, stale: true });

    // github.com is unaffected.
    expect((await diffOf(svc.prDiff('alice/app', 2))).headOid).toBe(A);
    expect(gh.requests.length).toBeGreaterThan(0);

    // Configured again: asked again, with the same token.
    gl.requests.length = 0;
    registry.apply({ glabPath: null, sources: [gitlabConfig] });
    expect(await diffOf(svc.prDiff(GL_KEY, 2, true))).toMatchObject({ headOid: MR_HEAD, fetchedAt: new Date(clock.t).toISOString() });
    expect(gl.requests).toContain('graphql MrRevision');
  });

  it('answers 503 with the credential problem for a configured source that has no token, and leaves github.com alone', async () => {
    const routes: Record<string, GitHubRoute> = {};
    githubPr(routes, A);
    const { svc, spent, gl } = setup({ github: routes, config: { tokenEnv: null, tokenChoice: null } });
    const err = await failure(svc.prDiff(GL_KEY, 2));
    expect(err?.status).toBe(503);
    expect(err?.message).toMatch(new RegExp(`^No GitLab token for ${HOST.replaceAll('.', '\\.')}: `));
    expect(gl.requests).toEqual([]);
    expect((await spent(() => diffOf(svc.prDiff('alice/app', 2)))).out.headOid).toBe(A);
  });

  it('answers 503 for a source the registry does not know at all', async () => {
    const router = new DiffRouter({ byId: () => null });
    const err = await router.get({ sourceId: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toBe("This repository's source isn't known on this server");
    router.authFailed({} as never);
  });
});

describe('a rejected token', () => {
  it("is invalidated on its own source and no other, with that source's hint", async () => {
    const { svc, runtime, ghToken, ready } = setup({
      github: { [`/repos/alice/app/commits/${sha('f')}`]: { status: 401, body: { message: 'Bad credentials' } } },
      gitlab: { [`${APP}/repository/commits/${sha('f')}`]: { status: 401, body: { message: '401 Unauthorized' } } },
    });
    await ready();
    expect((await runtime.tokens.account()).error).toBeNull();

    const github = await failure(svc.commitDiff('alice/app', sha('f')));
    expect(github).toMatchObject({ status: 503, message: 'GitHub rejected the token (401); check GITHUB_TOKEN or run `gh auth login`' });
    expect(ghToken.invalidated).toBe(1);
    expect((await runtime.tokens.account()).error).toBeNull();

    const gitlab = await failure(svc.commitDiff(GL_KEY, sha('f')));
    expect(gitlab).toMatchObject({ status: 503 });
    expect(gitlab!.message).toMatch(/^GitLab rejected the token \(401\)/);
    expect(gitlab!.message).toMatch(/; check the GitLab token in Settings → Sources, or run `glab auth login --hostname gitlab\.example\.com`$/);
    expect(ghToken.invalidated).toBe(1);
    expect((await runtime.tokens.account()).error).toBe(`GitLab (${HOST}) rejected the token (401)`);
  });
});

describe('the HTTP routes', () => {
  it('serve a GitLab repo by its host key, and mark a 64-character SHA immutable', async () => {
    const S = long('6');
    const setupApp = setup({
      gitlab: { [`${APP}/repository/files/src%2Flogin%2Ets/raw`]: { text: 'export {};\n' } },
    });
    const { db, registry, svc, ready } = setupApp;
    await ready();
    const tokens = testTokens('ghp_test_token');
    const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
    const app = createApp({ db, config: { ...loadConfig({}), webDir: '/nonexistent' }, sync, diffs: svc, tokens, sources: registry });
    const key = encodeURIComponent(GL_KEY);

    const pr = await app.request(`/api/v1/prs/${key}/2/diff`);
    expect(pr.status).toBe(200);
    expect(await pr.json()).toMatchObject({ kind: 'pr', repo: GL_KEY, number: 2, headOid: MR_HEAD });
    const commit = await app.request(`/api/v1/commits/${key}/${HEAD}/diff`);
    expect(await commit.json()).toMatchObject({ kind: 'commit', repo: GL_KEY, headOid: HEAD });
    const blob = await app.request(`/api/v1/blob/${key}?ref=${S}&path=src/login.ts`);
    expect([blob.status, await blob.text()]).toEqual([200, 'export {};\n']);
    expect(blob.headers.get('cache-control')).toContain('immutable');
    const abbreviated = await app.request(`/api/v1/blob/${key}?ref=${S.slice(0, 45)}&path=src/login.ts`);
    expect(abbreviated.headers.get('cache-control')).toBeNull();

    registry.apply({ glabPath: null, sources: [] });
    const gone = await app.request(`/api/v1/prs/${key}/2/diff?refresh=1`);
    expect(gone.status).toBe(503);
    expect(await gone.json()).toEqual({ error: `No GitLab credential is configured on this server for ${HOST}` });
  });
});
