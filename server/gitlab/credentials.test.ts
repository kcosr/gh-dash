import { describe, expect, it } from 'vitest';
import type { TokenChoice } from '../../shared/api';
import { gitlabTokenCreateUrl, gitlabWriteWarning } from '../../shared/credentials';
import { CredentialProvider } from '../credentials/provider';
import { execError, fakeExec, fakeFs, type FakeFile } from '../test/credentials';
import { BASE, fakeGitLab, graphql, type Handler } from '../test/gitlab';
import { gitlabExpiry, gitlabSpec, gitlabTokenEnv, gitlabTokenKind } from './credentials';

const HOST = 'gitlab.example.com';
const GLAB = '/usr/bin/glab';
const PAT = 'glpat-AbCdEf0123456789xyz';
const SELF = '/api/v4/personal_access_tokens/self';
const NOW = Date.parse('2026-09-28T12:00:00Z');

const user = (over: Record<string, unknown> = {}) => ({
  id: 'gid://gitlab/User/2', username: 'alice', name: 'Alice A', avatarUrl: '/gitlab/uploads/-/system/user/avatar/2/avatar.png',
  publicEmail: 'Alice@Example.com', commitEmail: 'alice@example.com', emails: { nodes: [{ email: 'alice@example.com' }, { email: 'a.work@example.org' }] },
  ...over,
});
const checkData = (over: Record<string, unknown> = {}) => ({
  currentUser: user(), metadata: { version: '19.3.3-ee', enterprise: true }, personal: { count: 56 }, ...over,
});
const pat = (over: Record<string, unknown> = {}) => ({
  id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['read_api'], user_id: 2, created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null, expires_at: '2026-12-31', ...over,
});

interface Setup {
  routes?: Record<string, Handler>;
  env?: NodeJS.ProcessEnv;
  choice?: TokenChoice | null;
  tokenFile?: string | null;
  tokenEnv?: string | null;
  files?: Record<string, FakeFile>;
  glab?: (args: string[]) => string | Promise<string>;
  baseUrl?: string;
}

function setup(o: Setup = {}) {
  const api = fakeGitLab(o.routes ?? { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat() } });
  const glab = fakeExec(o.glab ?? (() => `${PAT}\n`));
  const logs: string[] = [];
  const tokens = new CredentialProvider(
    gitlabSpec({ host: HOST, baseUrl: o.baseUrl ?? BASE }, { tokenEnv: o.tokenEnv === undefined ? 'GITLAB_TOKEN' : o.tokenEnv, glabPath: null, fetchImpl: api.fetchImpl, sleep: async () => {} }),
    {
      env: o.env ?? { HOME: '/home/u', PATH: '/usr/bin' },
      choice: o.choice === undefined ? 'glab' : o.choice,
      tokenFile: o.tokenFile,
      platform: 'linux',
      fs: fakeFs({ [GLAB]: { exec: true }, ...o.files }),
      exec: glab.exec,
      now: () => NOW,
      log: (line) => logs.push(line),
    },
  );
  return { tokens, api, glab, logs };
}

describe('GitLab credentials: resolution', () => {
  it('GITLAB_TOKEN locks the source only when it is the only GitLab source; tokenEnv names another variable', async () => {
    expect(gitlabTokenEnv(undefined, 1)).toBe('GITLAB_TOKEN');
    expect(gitlabTokenEnv(null, 2)).toBeNull();
    expect(gitlabTokenEnv(' WORK_GITLAB_TOKEN ', 2)).toBe('WORK_GITLAB_TOKEN');
    expect(gitlabTokenEnv('WORK_GITLAB_TOKEN', 1)).toBe('WORK_GITLAB_TOKEN');

    const locked = setup({ env: { GITLAB_TOKEN: ` ${PAT} `, PATH: '' }, choice: 'app' });
    expect(await locked.tokens.get()).toMatchObject({ token: PAT, source: 'env' });
    expect(await locked.tokens.account()).toMatchObject({ source: 'env', choice: 'app', locked: true, env: 'GITLAB_TOKEN', kind: 'personal' });
    expect(locked.glab.calls).toEqual([]);

    // One of several sources, without a tokenEnv: GITLAB_TOKEN isn't its, so its choice (glab) decides.
    const several = setup({ env: { GITLAB_TOKEN: 'glpat-other', PATH: '/usr/bin' }, tokenEnv: null });
    expect(await several.tokens.get()).toMatchObject({ token: PAT, source: 'glab' });
    expect(await several.tokens.account()).toMatchObject({ locked: false, env: null });

    const own = setup({ env: { WORK_GITLAB_TOKEN: 'glpat-work', GITLAB_TOKEN: 'glpat-other', PATH: '' }, tokenEnv: 'WORK_GITLAB_TOKEN' });
    expect(await own.tokens.get()).toMatchObject({ token: 'glpat-work', source: 'env' });
  });

  it('reads a token file (warning once about its mode), or the app token; never falls back to glab', async () => {
    const file = setup({ choice: 'file', tokenFile: '/home/u/gl-token', files: { '/home/u/gl-token': { text: `${PAT}\n`, mode: 0o100640 } } });
    expect(await file.tokens.get()).toMatchObject({ token: PAT, source: 'file' });
    await file.tokens.get({ fresh: true });
    expect(file.logs.filter((l) => l.includes('readable'))).toEqual([
      `[token ${HOST}] warning: token file /home/u/gl-token is readable by other users (mode 640); run chmod 600 on it`,
    ]);

    const broken = setup({ choice: 'file', tokenFile: '/home/u/missing' });
    expect(await broken.tokens.get()).toMatchObject({ token: null, error: 'Token file /home/u/missing does not exist' });
    expect(broken.glab.calls).toEqual([]);
    expect((await setup({ choice: 'file' }).tokens.get()).error).toBe('No token file is configured (tokenFile)');

    const app = setup({ choice: 'app' });
    expect(await app.tokens.get()).toMatchObject({ token: null, error: 'No token has been entered in the app' });
    app.tokens.setAppToken(` ${PAT} `);
    expect(await app.tokens.get()).toMatchObject({ token: PAT, source: 'app' });
    expect(app.glab.calls).toEqual([]);

    // Headless without a method: a file if one is configured, else nothing (glab only when chosen).
    const auto = setup({ choice: 'auto' });
    expect(await auto.tokens.get()).toMatchObject({
      token: null, error: 'No sign-in method is configured: set tokenSource or tokenFile for this source in config.json, or GITLAB_TOKEN',
    });
    expect(auto.glab.calls).toEqual([]);
  });

  it("asks glab for the URL's own host, port included", async () => {
    const { tokens, glab } = setup({ baseUrl: 'https://gitlab.example.com:8443/gitlab/' });
    expect(await tokens.get()).toMatchObject({ token: PAT, source: 'glab' });
    expect(glab.calls[0]!.args).toEqual(['config', 'get', 'token', '--host', 'gitlab.example.com:8443']);
    expect(tokens.spec.authHint).toBe('check the GitLab token in Settings → Sources, or run `glab auth login --hostname gitlab.example.com:8443`');
  });
});

describe('GitLab credentials: validation', () => {
  it('reports the account, instance, personal projects, scopes, expiry and write access of a personal token', async () => {
    const { tokens, api, logs } = setup({
      routes: { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat({ scopes: ['api', 'read_repository', 'write_repository'] }) } },
    });
    expect(await tokens.check()).toEqual({
      source: 'glab', choice: 'glab', locked: false, env: 'GITLAB_TOKEN',
      login: 'alice', name: 'Alice A', avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/2/avatar.png',
      dbLogin: null, mismatch: false, kind: 'personal', expiresAt: '2026-12-31T00:00:00.000Z',
      scopes: ['api', 'read_repository', 'write_repository'], canWrite: true, repos: { total: 56, private: null },
      cli: { name: 'glab', available: true, path: GLAB, login: null }, tokenFile: null,
      instance: { version: '19.3.3-ee', enterprise: true }, error: null, checkedAt: '2026-09-28T12:00:00.000Z',
    });
    expect([...api.requests].sort()).toEqual([SELF, 'graphql CredentialCheck']);
    expect(api.calls.every((c) => c.headers.Authorization === `Bearer ${PAT}`)).toBe(true);
    expect((await tokens.snapshot()).validation?.emails).toEqual(['alice@example.com', 'a.work@example.org']);
    expect(logs).toEqual([
      `[token ${HOST}] using glab`,
      `[token ${HOST}] glab token is for @alice (personal, expires 2026-12-31)`,
      `[token ${HOST}] note: This token can change things on GitLab (api and write_repository scopes). gh-dash only reads: a read_api token is enough. Create one: ${BASE}/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api`,
    ]);
  });

  it('can write with api or write_repository; read_api alone is read-only and says nothing more', async () => {
    const scoped = async (scopes: string[]) => {
      const { tokens, logs } = setup({ routes: { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat({ scopes }) } } });
      return { account: await tokens.check(), logs };
    };
    expect((await scoped(['api'])).account).toMatchObject({ canWrite: true, error: null });
    expect((await scoped(['read_api', 'write_repository'])).account).toMatchObject({ canWrite: true, error: null });
    const readOnly = await scoped(['read_api', 'read_repository']);
    expect(readOnly.account).toMatchObject({ canWrite: false, error: null, login: 'alice' });
    expect(readOnly.logs.filter((l) => /note|warning/.test(l))).toEqual([]);
  });

  it('treats a token GitLab won\'t describe (400) as OAuth: scopes and expiry unknown', async () => {
    const { tokens } = setup({
      glab: () => 'a'.repeat(64),
      routes: {
        '/api/graphql': graphql({ CredentialCheck: () => checkData({ currentUser: user({ emails: null, publicEmail: null }) }) }),
        [SELF]: { status: 400, body: { message: '400 Bad request - This endpoint requires token type to be a personal access token' } },
      },
    });
    expect(await tokens.check()).toMatchObject({ login: 'alice', kind: 'oauth', scopes: null, expiresAt: null, canWrite: null, error: null });
    expect((await tokens.snapshot()).validation?.emails).toEqual(['alice@example.com']);
    // Before validation, a token without a prefix is just a token.
    expect(gitlabTokenKind('a'.repeat(64))).toBe('unknown');
    expect(gitlabTokenKind(PAT)).toBe('personal');
  });

  it('fails a token without read_api, naming what it has', async () => {
    const { tokens } = setup({
      routes: {
        '/api/graphql': { status: 403, body: { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the access token.' } },
        [SELF]: { body: pat({ scopes: ['read_repository', 'write_repository'] }) },
      },
    });
    expect(await tokens.check()).toMatchObject({
      login: null, kind: 'personal', scopes: ['read_repository', 'write_repository'], canWrite: true,
      error: 'The token needs the read_api scope (it has read_repository, write_repository)',
    });
  });

  it("names the source in GitLab's own errors: an expired token, no account, the instance unreachable", async () => {
    const expired = { status: 401, body: { error: 'invalid_token', error_description: `Token is expired. You can either do re-authorization or token refresh. (${PAT})` } };
    const gone = setup({ routes: { '/api/graphql': expired, [SELF]: expired } });
    expect((await gone.tokens.check()).error).toBe(
      `GitLab (${HOST}) rejected the token (401): Token is expired. You can either do re-authorization or token refresh. ([token])`,
    );
    expect(gone.logs.at(-1)).toBe(`[token ${HOST}] glab token check failed: GitLab (${HOST}) rejected the token (401): Token is expired. You can either do re-authorization or token refresh. ([token])`);

    const nobody = setup({ routes: { '/api/graphql': graphql({ CredentialCheck: () => checkData({ currentUser: null }) }), [SELF]: { body: pat() } } });
    expect((await nobody.tokens.check()).error).toBe(`GitLab (${HOST}) returned no account for this token`);

    const inactive = setup({ routes: { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat({ active: false }) } } });
    expect((await inactive.tokens.check()).error).toBe('The token is not active: it was revoked or has expired');

    const offline = new CredentialProvider(
      gitlabSpec({ host: HOST, baseUrl: BASE }, { tokenEnv: 'GITLAB_TOKEN', glabPath: null, sleep: async () => {}, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
      { env: { GITLAB_TOKEN: PAT }, platform: 'linux', fs: fakeFs({}), log: () => {} },
    );
    expect((await offline.check()).error).toBe(`Couldn't reach GitLab (${HOST}): getaddrinfo ENOTFOUND`);
  });

  it('warns in the log when the token expires within 14 days', async () => {
    const soon = setup({ routes: { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat({ expires_at: '2026-10-05' }) } } });
    expect(await soon.tokens.check()).toMatchObject({ expiresAt: '2026-10-05T00:00:00.000Z', error: null });
    expect(soon.logs.filter((l) => l.includes('warning'))).toEqual([
      `[token ${HOST}] warning: the token expires 2026-10-05 (in 7 days); create a new one: ${BASE}/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api`,
    ]);
    const never = setup({ routes: { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat({ expires_at: null }) } } });
    expect(await never.tokens.check()).toMatchObject({ expiresAt: null, kind: 'personal' });
    expect(never.logs.filter((l) => l.includes('warning'))).toEqual([]);
  });

  it('reads GitLab expiry days as the start of that day, UTC', () => {
    expect(gitlabExpiry('2026-12-31')).toBe('2026-12-31T00:00:00.000Z');
    expect(gitlabExpiry('2026-12-31T08:00:00.000+02:00')).toBe('2026-12-31T06:00:00.000Z');
    expect(gitlabExpiry(null)).toBeNull();
    expect(gitlabExpiry('someday')).toBeNull();
  });
});

describe('GitLab credentials: messages name the source', () => {
  it('when there is no token, after a 401, and for glab failures', async () => {
    const unchosen = setup({ choice: null });
    await unchosen.tokens.get();
    expect(unchosen.tokens.noTokenMessage()).toBe(`No GitLab token for ${HOST}: set one up in Settings → Sources`);

    const noGlab = setup({ glab: () => Promise.reject(execError('')) });
    await noGlab.tokens.get();
    expect(noGlab.tokens.noTokenMessage()).toBe(`No GitLab token for ${HOST}: glab has no token for ${HOST}: run \`glab auth login --hostname ${HOST}\``);
    expect(noGlab.logs).toEqual([`[token ${HOST}] no token: glab has no token for ${HOST}: run \`glab auth login --hostname ${HOST}\``]);

    const { tokens } = setup();
    await tokens.check();
    tokens.invalidate(PAT);
    expect(await tokens.account()).toMatchObject({ login: null, error: `GitLab (${HOST}) rejected the token (401)` });
    expect(tokens.label).toBe(`GitLab (${HOST})`);
  });

  it('builds the write warning and the read_api token page', () => {
    expect(gitlabWriteWarning(['api', 'read_user'])).toBe('This token can change things on GitLab (api scope). gh-dash only reads: a read_api token is enough.');
    expect(gitlabWriteWarning(['read_api'])).toBeNull();
    expect(gitlabWriteWarning(null)).toBeNull();
    expect(gitlabTokenCreateUrl('https://gitlab.example.com')).toBe('https://gitlab.example.com/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api');
  });
});
