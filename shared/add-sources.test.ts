// Step 12: the Add dialog per source, and the top bar's per-source status. The helpers are the web's, pure.
import { describe, expect, it } from 'vitest';
import type { RepoCandidate, Source, SourceAccount, SourceSyncStatus, SyncStatus } from './api';
import { PROVIDERS } from './provider';
import { addDefault, firstTrouble, hostNames, noticeText, sourceLabel, sourceSettingsLink, sourceStatuses, troubleLabel, troubleOf, workSources } from '../web/src/lib/sources';
import type { WorkSource } from '../web/src/lib/sources';
import { backfillLine, inputKeyOn, matchCandidates } from '../web/src/lib/tracking';

const GL = 'gitlab.example.com';
const gitlab = { host: GL, baseUrl: `https://${GL}`, kind: 'gitlab' as const };
const rooted = { host: GL, baseUrl: `https://${GL}/gitlab`, kind: 'gitlab' as const };
const github = { host: 'github.com', baseUrl: 'https://github.com', kind: 'github' as const };

describe('input on a source', () => {
  it('reads GitHub input as before', () => {
    expect(inputKeyOn(github, 'charmbracelet/bubbletea')).toBe('charmbracelet/bubbletea');
    expect(inputKeyOn(github, 'https://github.com/charmbracelet/bubbletea/pull/3')).toBe('charmbracelet/bubbletea');
    expect(inputKeyOn(github, `https://${GL}/platform/team/svc`)).toBeNull();
    expect(inputKeyOn(github, 'platform/team/svc')).toBeNull();
  });

  it('turns a GitLab path, key, URL or ssh address into the key with its host', () => {
    const key = `${GL}/platform/team/svc`;
    expect(inputKeyOn(gitlab, 'platform/team/svc')).toBe(key);
    expect(inputKeyOn(gitlab, key)).toBe(key);
    expect(inputKeyOn(gitlab, `https://${GL}/platform/team/svc/-/merge_requests/3`)).toBe(key);
    expect(inputKeyOn(gitlab, `git@${GL}:platform/team/svc.git`)).toBe(key);
    expect(inputKeyOn(gitlab, 'alice')).toBeNull();
    expect(inputKeyOn(gitlab, 'https://github.com/a/b')).toBeNull();
  });

  it('needs the relative root in a URL, and drops it from the key', () => {
    expect(inputKeyOn(rooted, `https://${GL}/gitlab/platform/team/svc`)).toBe(`${GL}/platform/team/svc`);
    expect(inputKeyOn(rooted, `https://${GL}/platform/team/svc`)).toBeNull();
  });
});

describe('matching a GitLab source\'s candidates', () => {
  const gl = (path: string): Pick<RepoCandidate, 'key' | 'owner' | 'name'> => {
    const i = path.lastIndexOf('/');
    return { key: `${GL}/${path}`, owner: path.slice(0, i), name: path.slice(i + 1) };
  };
  const items = [gl('platform/team/api'), gl('infra/terraform/modules'), gl('docs/handbook')];

  it('never searches the host', () => {
    expect(matchCandidates(items, 'gitlab', 20, GL)).toEqual([]);
    expect(matchCandidates(items, 'gitlab', 20)).toHaveLength(3);
  });

  it('finds by name, namespace or path, and by a pasted key', () => {
    expect(matchCandidates(items, 'api', 20, GL).map((c) => c.name)).toEqual(['api']);
    expect(matchCandidates(items, 'infra', 20, GL).map((c) => c.name)).toEqual(['modules']);
    expect(matchCandidates(items, 'terraform/mod', 20, GL).map((c) => c.name)).toEqual(['modules']);
    expect(matchCandidates(items, `${GL}/platform/team/api`, 20, GL).map((c) => c.name)).toEqual(['api']);
  });
});

describe('the first-sync line', () => {
  const since = '2025-09-29T12:00:00Z';
  const gitlabCounts = { since, commits: null, prs: 24, issues: 31, releases: 3, requests: null };

  it('says GitLab does not count commits', () => {
    expect(backfillLine(gitlabCounts, PROVIDERS.gitlab)).toBe('Since Sep 29, 2025: 24 MRs · 31 issues · commits: size unknown');
  });

  it('leaves out what the project has turned off', () => {
    expect(backfillLine({ ...gitlabCounts, issues: 0 }, PROVIDERS.gitlab, ['issues'])).toBe('Since Sep 29, 2025: 24 MRs · commits: size unknown');
    expect(backfillLine({ ...gitlabCounts, prs: 0, issues: 0 }, PROVIDERS.gitlab, ['prs', 'issues'])).toBe('Since Sep 29, 2025: size unknown');
  });

  it('still says nothing of a size the host did not give', () => {
    expect(backfillLine({ ...gitlabCounts, prs: null }, PROVIDERS.gitlab)).toBe('Since Sep 29, 2025: size unknown');
    expect(backfillLine({ since, commits: 3, prs: 1, issues: 2, releases: 0, requests: null }, PROVIDERS.gitlab)).toBe('Since Sep 29, 2025: size unknown');
  });
});

const status = (over: Partial<SourceSyncStatus> = {}): SourceSyncStatus => ({
  source: 'github.com', running: false, progress: null, lastSyncAt: null, lastResult: null, rateLimit: null, tokenSource: 'gh-cli', viewer: 'kcosr', problem: null, ...over,
});
const account = (over: Partial<SourceAccount> = {}): SourceAccount => ({
  source: 'gh-cli', choice: 'auto', locked: false, env: null, login: 'kcosr', name: null, avatarUrl: null, dbLogin: 'kcosr', mismatch: false,
  kind: 'oauth', expiresAt: null, scopes: null, canWrite: null, repos: null, cli: null, tokenFile: null, instance: null, error: null, checkedAt: null, ...over,
});
/** A `/sources` entry: its live status is `sync`, its account `account` (null: not configured here). */
const source = (sync: SourceSyncStatus, over: Partial<Source> = {}): Source => {
  const github = sync.source === 'github.com';
  return {
    host: sync.source, kind: github ? 'github' : 'gitlab', name: github ? 'GitHub' : 'GitLab', url: github ? 'https://github.com' : `https://${sync.source}/gitlab`,
    configured: true, removable: false, viewer: null, account: account({ source: sync.tokenSource }), sync, repos: { owned: 0, added: 0, hidden: 0 }, ...over,
  };
};
const ghOk = status();
const glOk = status({ source: GL, tokenSource: 'env', viewer: 'alice', lastSyncAt: '2026-09-29T10:00:00Z' });
const glNoToken = status({ source: GL, tokenSource: 'none', problem: `No GitLab token for ${GL}: glab has no login` });
const glMismatch = status({ source: GL, tokenSource: 'env', problem: "This database's GitLab account is @alice, but the token is for @carol." });
const glGone = status({ source: GL, tokenSource: 'none', problem: `GitLab (${GL}) isn't configured on this server` });
const ghNoToken = status({ tokenSource: 'none', problem: 'No GitHub token: gh is not signed in' });
const S = {
  ghOk: source(ghOk),
  glOk: source(glOk),
  glNoToken: source(glNoToken),
  glMismatch: source(glMismatch, { account: account({ source: 'env', login: 'carol', dbLogin: 'alice', mismatch: true }) }),
  glGone: source(glGone, { configured: false, removable: true, account: null }),
  ghNoToken: source(ghNoToken),
};
const repo = (source: string, _path: string) => ({ source, provider: source === 'github.com' ? 'github' as const : 'gitlab' as const });
/** The sources and their live statuses, as the hook passes them. */
const work = (sources: Source[], repos: ReturnType<typeof repo>[] = [], opts: { githubMismatch?: boolean } = {}) =>
  workSources(sources, sources.map((s) => s.sync), repos, opts);

describe('what stands in a source\'s way', () => {
  it('reads /sources: configured, the account, and the live status', () => {
    expect(troubleOf(S.ghOk, ghOk)).toBeNull();
    expect(troubleOf(S.glOk, glOk)).toBeNull();
    expect(troubleOf(S.glNoToken, glNoToken)).toBe('no-token');
    expect(troubleOf(S.glMismatch, glMismatch)).toBe('mismatch');
    expect(troubleOf(S.glGone, glGone)).toBe('not-configured');
    expect(troubleOf(S.ghNoToken, ghNoToken)).toBe('no-token');
  });

  it('never reads the problem\'s words', () => {
    // A configured source whose problem text happens to say "isn't configured" is still configured.
    expect(troubleOf(S.glNoToken, { ...glNoToken, problem: "glab isn't configured on this server" })).toBe('no-token');
    // An unconfigured source is so whatever its problem says, or with none.
    expect(troubleOf(S.glGone, { ...glGone, problem: null })).toBe('not-configured');
  });

  it('takes a token that just appeared in the live status, or one the account resolved, as a token', () => {
    expect(troubleOf(S.glNoToken, { ...glNoToken, tokenSource: 'glab', problem: null })).toBeNull();
    expect(troubleOf(source(glNoToken, { account: account({ source: 'glab' }) }), glNoToken)).toBeNull();
  });

  it('words it for the top bar', () => {
    const gitlabNoToken = { name: 'GitLab', trouble: 'no-token' as const };
    expect(troubleLabel(gitlabNoToken, true)).toBe('GitLab: no token');
    expect(troubleLabel(gitlabNoToken, false)).toBe('No token');
    expect(troubleLabel({ name: 'GitLab', trouble: 'mismatch' }, false)).toBe('Account mismatch');
    expect(troubleLabel({ name: 'GitLab', trouble: 'not-configured' }, true)).toBe('GitLab: not configured');
  });
});

describe('the sources worth working with', () => {
  it('lists github.com, then the others, with their names and where they live', () => {
    const ws = work([S.glOk, S.ghOk], [repo('github.com', 'kcosr/sedes'), repo(GL, 'platform/team/api')]);
    expect(ws.map((w) => [w.host, w.kind, w.name])).toEqual([['github.com', 'github', 'GitHub'], [GL, 'gitlab', 'GitLab']]);
    expect(ws[1]!.baseUrl).toBe(`https://${GL}/gitlab`);
    expect(ws[0]!.baseUrl).toBe('https://github.com');
  });

  it('reads pasted addresses against the source\'s URL, relative root included, before it has any repos', () => {
    const ws = work([S.ghOk, S.glOk], []);
    expect(ws[1]!.baseUrl).toBe(`https://${GL}/gitlab`);
    expect(inputKeyOn(ws[1]!, `https://${GL}/gitlab/platform/team/svc`)).toBe(`${GL}/platform/team/svc`);
  });

  it('names several GitLabs by host', () => {
    const other = status({ source: 'gitlab2.example.com', tokenSource: 'file', viewer: 'bob' });
    const ws = work([S.ghOk, S.glOk, source(other, { url: 'https://gitlab2.example.com' })]);
    expect(ws.map((w) => w.name)).toEqual(['GitHub', GL, 'gitlab2.example.com']);
    expect(ws[2]!.baseUrl).toBe('https://gitlab2.example.com');
  });

  it('leaves out a GitHub nobody set up, and a GitLab this server does not have unless it has repos', () => {
    expect(work([S.ghNoToken, S.glOk]).map((w) => w.host)).toEqual([GL]);
    expect(work([S.ghNoToken, S.glOk], [repo('github.com', 'kcosr/sedes')]).map((w) => w.host)).toEqual(['github.com', GL]);
    expect(work([S.ghOk, S.glGone]).map((w) => w.host)).toEqual(['github.com']);
    expect(work([S.ghOk, S.glGone], [repo(GL, 'a/b')]).map((w) => [w.host, w.trouble])).toEqual([['github.com', null], [GL, 'not-configured']]);
  });

  it('keeps a configured GitLab that has no token yet, so its problem shows', () => {
    expect(work([S.ghOk, S.glNoToken]).map((w) => [w.host, w.trouble])).toEqual([['github.com', null], [GL, 'no-token']]);
  });

  it('says which source is waiting for its first sync', () => {
    const fresh = status({ source: GL, tokenSource: 'glab', viewer: null });
    const ws = work([S.ghOk, source(fresh)], [repo('github.com', 'kcosr/sedes')]);
    expect(ws.map((w) => [w.host, w.awaitingFirstSync])).toEqual([['github.com', false], [GL, true]]);
    // Synced once, or with repos, or in trouble: not waiting.
    expect(work([S.glOk]).map((w) => w.awaitingFirstSync)).toEqual([false]);
    expect(work([source(fresh)], [repo(GL, 'a/b')]).map((w) => w.awaitingFirstSync)).toEqual([false]);
    expect(work([S.glNoToken]).map((w) => w.awaitingFirstSync)).toEqual([false]);
  });

  it('is never empty: github.com stands in', () => {
    expect(work([S.ghNoToken, S.glGone]).map((w) => [w.host, w.trouble])).toEqual([['github.com', 'no-token']]);
    expect(workSources([], [], []).map((w) => [w.host, w.trouble])).toEqual([['github.com', 'no-token']]);
    expect(workSources(null, [], [])).toEqual([]);
  });

  it('knows github.com alone, from its sync status, until /sources answers', () => {
    expect(workSources(null, [ghNoToken, glOk], []).map((w) => [w.host, w.trouble])).toEqual([['github.com', 'no-token']]);
    expect(workSources(null, [ghOk, glOk], []).map((w) => [w.host, w.trouble])).toEqual([['github.com', null]]);
  });

  it('takes the account check\'s word for a GitHub mismatch', () => {
    expect(work([S.ghOk], [], { githubMismatch: true })[0]!.trouble).toBe('mismatch');
    expect(workSources(null, [ghOk], [], { githubMismatch: true })[0]!.trouble).toBe('mismatch');
  });

  it('names the first source in trouble', () => {
    expect(firstTrouble(work([S.ghOk, S.glNoToken]))?.host).toBe(GL);
    expect(firstTrouble(work([S.ghOk, S.glOk]))).toBeNull();
  });

  it('names the code hosts once each', () => {
    expect(hostNames(work([S.ghOk, S.glOk]))).toBe('GitHub and GitLab');
    expect(hostNames(work([S.glOk]))).toBe('GitLab');
    expect(hostNames([{ kind: 'gitlab' }, { kind: 'gitlab' }])).toBe('GitLab');
    expect(hostNames([])).toBe('');
  });
});

describe('the notice on a source\'s context', () => {
  const at = (w: WorkSource | undefined) => (w ? noticeText(w)?.text ?? null : null);
  const gitlabOf = (sync: SourceSyncStatus, over: Partial<Source> = {}) => work([S.ghOk, source(sync, over)], [repo('github.com', 'kcosr/sedes')]).find((w) => w.host === GL);

  it('says what stands in the way, naming the host', () => {
    expect(at(gitlabOf(glNoToken))).toBe(`GitLab (${GL}) has no token`);
    expect(noticeText(gitlabOf(glNoToken)!)?.setUp).toBe(true);
    expect(at(gitlabOf(glMismatch, { account: account({ source: 'env', mismatch: true }) }))).toBe(`GitLab (${GL})'s token is for another account, so it isn't synced`);
    expect(at(work([S.ghOk, S.glGone], [repo(GL, 'a/b')])[1])).toBe(`GitLab (${GL}) isn't configured here, so it isn't synced`);
    expect(at(work([S.ghNoToken, S.glOk], [repo('github.com', 'kcosr/sedes')])[0])).toBe('GitHub has no token');
  });

  it('says a source is waiting for its first sync, or running it', () => {
    const fresh = status({ source: GL, tokenSource: 'glab', viewer: null });
    expect(at(gitlabOf(fresh))).toBe(`GitLab (${GL}) hasn't synced yet`);
    expect(at(gitlabOf({ ...fresh, running: true }))).toBe(`GitLab (${GL}): first sync in progress`);
  });

  it('says nothing when all is well', () => {
    expect(at(gitlabOf(glOk))).toBeNull();
    expect(at(work([S.ghOk], [repo('github.com', 'kcosr/sedes')])[0])).toBeNull();
  });

  it('links to the source\'s own block in Settings → Sources', () => {
    expect(sourceSettingsLink(GL)).toBe(`/settings#source-${GL}`);
    expect(sourceSettingsLink('github.com')).toBe('/settings#account');
    expect(sourceLabel({ host: GL, kind: 'gitlab' })).toBe(`GitLab (${GL})`);
    expect(sourceLabel({ host: 'github.com', kind: 'github' })).toBe('GitHub');
  });
});

describe('the sync status of an older server', () => {
  it('reads as github.com alone, from the run-level fields', () => {
    const old = { running: true, progress: { done: 1, total: 2, current: 'a/b' }, lastSyncAt: 't', lastResult: null, rateLimit: null, tokenSource: 'none', viewer: 'kcosr' } as unknown as SyncStatus;
    const [only, ...rest] = sourceStatuses(old);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ source: 'github.com', running: true, tokenSource: 'none', viewer: 'kcosr', problem: null });
    expect(sourceStatuses(undefined)).toEqual([]);
  });
});

describe('where the Add dialog starts', () => {
  const sources = [{ host: 'github.com' }, { host: GL }];
  it('is the context\'s source, else the last used, else GitHub, else the first', () => {
    expect(addDefault(sources, GL, 'github.com')?.host).toBe(GL);
    expect(addDefault(sources, null, GL)?.host).toBe(GL);
    expect(addDefault(sources, null, null)?.host).toBe('github.com');
    expect(addDefault(sources, 'gone.example.com', 'gone2.example.com')?.host).toBe('github.com');
    expect(addDefault([{ host: GL }], null, null)?.host).toBe(GL);
    expect(addDefault([], null, null)).toBeNull();
  });
});
