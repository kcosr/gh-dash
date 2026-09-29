import { describe, expect, it } from 'vitest';
import { fakeGitHub } from '../test/github';
import { fakeExec, fakeFs } from '../test/credentials';
import { TokenProvider } from '../token';
import { CredentialProvider, EMPTY_CHECK, noTokenMessage } from './provider';
import type { CliSpec, CredentialSpec, TokenCheck } from './types';

const HOME = '/home/u';
const TOOL = '/usr/bin/tool';

/** A made-up provider: its CLI prints `cli_<n>`; validation is whatever `check` says. */
function spec(over: Partial<CredentialSpec> = {}, cli: Partial<CliSpec> = {}): CredentialSpec {
  return {
    provider: 'gitlab',
    name: 'GitLab',
    host: 'gitlab.example.com',
    label: 'GitLab (gitlab.example.com)',
    envVar: 'TOOL_TOKEN',
    fileSetting: 'tokenFile',
    noTokenHint: 'set one up in Settings → Sources',
    notConfigured: 'No sign-in method is configured',
    rejected: 'rejected',
    authHint: 'check it',
    logPrefix: '[token gitlab.example.com]',
    cli: {
      name: 'glab', choice: 'glab', source: 'glab', path: null, pathSetting: 'glabPath', windowsFolder: 'glab', notFound: 'glab not found',
      inAuto: false, login: null, token: async () => ({ token: 'glpat-fromcli', source: 'glab', error: null }), ...cli,
    },
    kind: (t) => (t.startsWith('glpat-') ? 'personal' : 'unknown'),
    validate: async (): Promise<TokenCheck> => ({ ...EMPTY_CHECK, ok: true, login: 'alice' }),
    ...over,
  };
}

function provider(s: CredentialSpec, opts: { env?: NodeJS.ProcessEnv; choice?: 'auto' | 'glab' | 'gh' | 'file' | 'app' | null; tokenFile?: string } = {}) {
  const logs: string[] = [];
  const exec = fakeExec(() => 'unused');
  const tokens = new CredentialProvider(s, {
    env: { HOME, PATH: '/usr/bin', ...opts.env },
    choice: opts.choice,
    tokenFile: opts.tokenFile,
    platform: 'linux',
    fs: fakeFs({ '/usr/bin/glab': { exec: true }, [TOOL]: { exec: true }, '/run/token': { text: 'glpat-file' } }),
    exec: exec.exec,
    now: () => Date.parse('2026-09-28T12:00:00Z'),
    log: (line) => logs.push(line),
  });
  return { tokens, logs };
}

describe('CredentialProvider', () => {
  it("uses the spec's variable as the lock, and none when the spec has none", async () => {
    const locked = provider(spec(), { env: { TOOL_TOKEN: ' glpat-env ' }, choice: 'app' });
    expect(await locked.tokens.account()).toMatchObject({ source: 'env', locked: true, env: 'TOOL_TOKEN', kind: 'personal' });

    const unlocked = provider(spec({ envVar: null }), { env: { TOOL_TOKEN: 'glpat-env', GITLAB_TOKEN: 'glpat-env' }, choice: 'glab' });
    expect(await unlocked.tokens.account()).toMatchObject({ source: 'glab', locked: false, env: null });
  });

  it("auto: the token file, else the CLI only when the spec allows it in auto; another provider's CLI is refused", async () => {
    expect(await provider(spec(), { tokenFile: '/run/token' }).tokens.get()).toMatchObject({ token: 'glpat-file', source: 'file' });
    expect(await provider(spec()).tokens.get()).toMatchObject({ token: null, source: 'none', error: 'No sign-in method is configured' });
    expect(await provider(spec({}, { inAuto: true })).tokens.get()).toMatchObject({ token: 'glpat-fromcli', source: 'glab' });
    expect(await provider(spec(), { choice: 'gh' }).tokens.get()).toMatchObject({ token: null, error: "gh can't supply a GitLab token" });
    expect(await provider(spec(), { choice: 'file' }).tokens.get()).toMatchObject({ error: 'No token file is configured (tokenFile)' });
  });

  it('reports a validation that throws, without the token, and logs the spec notes after a good one', async () => {
    const failing = provider(spec({ validate: async (t) => { throw new Error(`boom for ${t}`); } }), { choice: 'glab' });
    expect((await failing.tokens.check()).error).toBe("Couldn't check the GitLab (gitlab.example.com) token: boom for [token]");
    expect(failing.logs).toContain("[token gitlab.example.com] glab token check failed: Couldn't check the GitLab (gitlab.example.com) token: boom for [token]");

    const noted = provider(spec({ notes: (v) => [`note for @${v.login}`] }), { choice: 'glab' });
    await noted.tokens.check();
    expect(noted.logs).toEqual([
      '[token gitlab.example.com] using glab',
      '[token gitlab.example.com] glab token is for @alice (personal)',
      '[token gitlab.example.com] note for @alice',
    ]);
  });

  it("refines the kind from validation, and shows the spec's rejection after a 401", async () => {
    const { tokens } = provider(spec({ validate: async () => ({ ...EMPTY_CHECK, ok: true, login: 'alice', kind: 'oauth' }) }), { choice: 'glab' });
    expect(await tokens.check()).toMatchObject({ kind: 'oauth', login: 'alice' });
    tokens.invalidate('glpat-fromcli');
    expect(await tokens.account()).toMatchObject({ kind: 'personal', login: null, error: 'rejected' });
  });

  it('names the source in "no token" messages; the GitHub form is unchanged', async () => {
    const r = { token: null, source: 'none' as const, error: null };
    expect(noTokenMessage(r)).toBe('No GitHub token: connect a GitHub account in Settings');
    expect(noTokenMessage(spec(), r)).toBe('No GitLab token for gitlab.example.com: set one up in Settings → Sources');
    expect(noTokenMessage(spec(), { ...r, error: 'glab not found' })).toBe('No GitLab token for gitlab.example.com: glab not found');
    const { tokens } = provider(spec(), { choice: null });
    await tokens.get();
    expect(tokens.noTokenMessage()).toBe('No GitLab token for gitlab.example.com: set one up in Settings → Sources');
  });

  it("gives GitHub's credential as a SourceAccount too", async () => {
    const api = fakeGitHub({
      '/graphql': { body: { data: { viewer: { id: 'U_alice', login: 'alice', name: 'Alice', avatarUrl: null, repos: { totalCount: 3 }, privateRepos: { totalCount: 1 } } } }, headers: { 'x-oauth-scopes': 'repo' } },
    } as never);
    const github = new TokenProvider({
      env: { GITHUB_TOKEN: 'ghp_x', HOME, PATH: '' },
      platform: 'linux',
      fs: fakeFs({}),
      fetchImpl: api.fetchImpl,
      now: () => Date.parse('2026-09-28T12:00:00Z'),
      log: () => {},
    });
    expect(await github.credentials.check()).toEqual({
      source: 'env', choice: 'auto', locked: true, env: 'GITHUB_TOKEN', login: 'alice', name: 'Alice', avatarUrl: null,
      dbLogin: null, mismatch: false, kind: 'classic', expiresAt: null, scopes: ['repo'], canWrite: null,
      repos: { total: 3, private: 1 }, cli: { name: 'gh', available: false, path: null, login: null }, tokenFile: null,
      instance: null, error: null, checkedAt: '2026-09-28T12:00:00.000Z',
    });
    // One provider behind both views.
    expect((await github.account()).login).toBe('alice');
    expect(api.requests).toEqual(['/graphql']);
  });
});
