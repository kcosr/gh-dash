import { describe, expect, it, vi } from 'vitest';
import { fakeGitHub, type Reply } from './test/github';
import {
  type Exec,
  ghLoginFromHosts,
  noTokenMessage,
  parseTokenExpiration,
  TOKEN_CACHE_MS,
  type TokenFs,
  TokenProvider,
  type TokenProviderOptions,
  tokenKind,
} from './token';

type FakeFile = { text?: string; mode?: number; exec?: boolean };

function fakeFs(files: Record<string, FakeFile>): TokenFs & { files: Record<string, FakeFile> } {
  const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  return {
    files,
    async stat(path) {
      const f = files[path];
      if (!f) throw missing(path);
      return { mode: f.mode ?? 0o100600, isFile: () => true };
    },
    async access(path) {
      if (!files[path]?.exec) throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: 'EACCES' });
    },
    async readFile(path) {
      const f = files[path];
      if (!f) throw missing(path);
      if (f.text === undefined) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
      return f.text;
    },
  };
}

interface ExecCall {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** gh stand-in: `reply` gives stdout, or throws a child_process-like error. */
function fakeExec(reply: () => string | Promise<string> = () => 'gho_fromgh\n') {
  const calls: ExecCall[] = [];
  const exec: Exec = async (file, args, { env }) => {
    calls.push({ file, args, env });
    return { stdout: await reply(), stderr: '' };
  };
  return { exec, calls };
}

const execError = (stderr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Command failed: gh auth token\n${stderr}`), { code: 1, stderr, killed: false, signal: null, ...extra });

const HOME = '/home/u';
const GH = '/usr/bin/gh';

function setup(opts: Partial<TokenProviderOptions> & { files?: Record<string, FakeFile>; reply?: () => string | Promise<string>; github?: Record<string, Reply | ((r: never) => Reply)> } = {}) {
  const clock = { now: Date.parse('2026-09-28T12:00:00Z') };
  const fs = fakeFs({ [GH]: { exec: true }, ...opts.files });
  const gh = fakeExec(opts.reply);
  const api = fakeGitHub(opts.github as never);
  const logs: string[] = [];
  const tokens = new TokenProvider({
    env: { HOME, PATH: '/usr/local/bin:/usr/bin' },
    platform: 'linux',
    fs,
    exec: gh.exec,
    fetchImpl: api.fetchImpl,
    now: () => clock.now,
    log: (line) => logs.push(line),
    ...opts,
  });
  return { tokens, fs, gh, api, logs, clock };
}

const viewerReply = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}): Reply => ({
  body: {
    data: {
      viewer: {
        id: 'U_alice', login: 'alice', name: 'Alice', avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        repos: { totalCount: 42 }, privateRepos: { totalCount: 7 }, ...over,
      },
    },
  },
  headers,
});

describe('TokenProvider resolution', () => {
  it('prefers GITHUB_TOKEN over any choice and reports it as locked', async () => {
    const { tokens, gh } = setup({ env: { GITHUB_TOKEN: ' ghp_env \n', HOME, PATH: '/usr/bin' }, choice: 'app' });
    tokens.setAppToken('ghp_app');
    expect(await tokens.get()).toMatchObject({ token: 'ghp_env', source: 'env', error: null });
    expect(gh.calls).toEqual([]);
    const account = await tokens.account();
    expect(account).toMatchObject({ source: 'env', choice: 'app', locked: true, kind: 'classic', gh: { available: true, path: GH } });
  });

  it('auto: uses the token file when configured, else gh (without GH_TOKEN in its environment)', async () => {
    const file = setup({ tokenFile: '/run/token', files: { '/run/token': { text: 'github_pat_file\n' } } });
    expect(await file.tokens.get()).toEqual(expect.objectContaining({ token: 'github_pat_file', source: 'file', error: null }));
    expect(file.gh.calls).toEqual([]);

    const gh = setup({ env: { HOME, PATH: '/usr/bin', GH_TOKEN: 'ghp_shadow', GH_HOST: 'ghe.example.com' } });
    expect(await gh.tokens.get()).toMatchObject({ token: 'gho_fromgh', source: 'gh-cli' });
    expect(gh.gh.calls).toHaveLength(1);
    const call = gh.gh.calls[0]!;
    expect(call.file).toBe(GH);
    expect(call.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(call.env.GH_TOKEN).toBeUndefined();
    expect(call.env).toMatchObject({ HOME, GH_NO_UPDATE_NOTIFIER: '1' });
  });

  it("doesn't fall back to gh when the configured token file is unusable, and never quotes the file", async () => {
    const cases: [FakeFile | undefined, RegExp][] = [
      [undefined, /^Token file \/run\/token does not exist$/],
      [{ text: '  \n' }, /is empty$/],
      [{ text: 'GITHUB_TOKEN=abc def\n' }, /must hold just the token/],
      [{ text: undefined }, /^Can't read token file \/run\/token \(EACCES\)$/],
    ];
    for (const [f, error] of cases) {
      const { tokens, gh } = setup({ tokenFile: '/run/token', files: f ? { '/run/token': f } : {} });
      const r = await tokens.get();
      expect(r).toMatchObject({ token: null, source: 'none', error: expect.stringMatching(error) });
      expect(r.error).not.toContain('abc');
      expect(gh.calls).toEqual([]);
    }
    const { tokens } = setup({ choice: 'file' });
    expect((await tokens.get()).error).toBe('No token file is configured (GITHUB_TOKEN_FILE)');
  });

  it('warns once about a token file other users can read', async () => {
    const { tokens, logs, clock } = setup({ tokenFile: '/run/token', files: { '/run/token': { text: 'ghp_x', mode: 0o100644 } } });
    await tokens.get();
    clock.now += TOKEN_CACHE_MS;
    await tokens.get();
    expect(logs.filter((l) => l.includes('readable by other users'))).toEqual([
      '[token] warning: token file /run/token is readable by other users (mode 644); run chmod 600 on it',
    ]);
  });

  it('finds gh via GH_DASH_GH_PATH, PATH, then the standard install locations', async () => {
    const configured = setup({ ghPath: '/opt/gh/bin/gh', files: { '/opt/gh/bin/gh': { exec: true } } });
    expect((await configured.tokens.account()).gh).toEqual({ available: true, path: '/opt/gh/bin/gh', login: null });
    expect(configured.gh.calls[0]!.file).toBe('/opt/gh/bin/gh');

    const missing = setup({ ghPath: '/nope/gh' });
    expect(await missing.tokens.get()).toMatchObject({ source: 'none', error: 'gh not found at /nope/gh (GH_DASH_GH_PATH)' });

    const onPath = setup({ env: { HOME, PATH: '/tools/bin:relative:/usr/bin' }, files: { '/tools/bin/gh': { exec: true }, 'relative/gh': { exec: true } } });
    expect((await onPath.tokens.account()).gh.path).toBe('/tools/bin/gh');

    const notExecutable = setup({ env: { HOME, PATH: '/tools/bin' }, files: { [GH]: { exec: false }, '/tools/bin/gh': {}, [`${HOME}/.local/bin/gh`]: { exec: true } } });
    expect((await notExecutable.tokens.account()).gh.path).toBe(`${HOME}/.local/bin/gh`);

    const mac = setup({ platform: 'darwin', env: { HOME, PATH: '/usr/bin:/bin' }, files: { [GH]: {}, '/opt/homebrew/bin/gh': { exec: true } } });
    expect((await mac.tokens.account()).gh.path).toBe('/opt/homebrew/bin/gh');

    const win = setup({
      platform: 'win32',
      env: { Path: 'C:\\Windows\\system32', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      files: { 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe': {} },
    });
    expect((await win.tokens.account()).gh.path).toBe('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe');

    const none = setup({ files: { [GH]: { exec: false } }, env: { HOME, PATH: '' } });
    const account = await none.tokens.account();
    expect(account).toMatchObject({ source: 'none', gh: { available: false, path: null, login: null }, error: 'GitHub CLI (gh) not found: install it, or set GH_DASH_GH_PATH' });
  });

  it("explains gh's failures", async () => {
    const cases: [unknown, string][] = [
      [execError('no oauth token found for github.com'), 'gh is not logged in to github.com: run `gh auth login`'],
      [execError('', { killed: true, signal: 'SIGTERM' }), 'gh auth token timed out after 60 s (is it waiting for a keyring prompt?)'],
      [execError('error connecting to keyring\nmore'), 'gh auth token failed: error connecting to keyring'],
      [Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), "Couldn't run gh at /usr/bin/gh (EACCES)"],
    ];
    for (const [err, message] of cases) {
      const { tokens } = setup({ reply: () => Promise.reject(err) });
      expect(await tokens.get()).toMatchObject({ token: null, source: 'none', error: message });
    }
    const { tokens } = setup({ reply: () => 'not a\ntoken' });
    expect((await tokens.get()).error).toBe('gh auth token printed something other than a token');
  });

  it("reads gh's active login from hosts.yml", async () => {
    const hosts = 'github.com:\n    users:\n        old:\n            oauth_token: gho_secret\n        alice:\n    git_protocol: https\n    user: alice\nghe.example.com:\n    user: corp\n';
    expect(ghLoginFromHosts(hosts)).toBe('alice');
    expect(ghLoginFromHosts(hosts, 'ghe.example.com')).toBe('corp');
    expect(ghLoginFromHosts('"github.com":\n  user: "bob" # comment\n')).toBe('bob');
    expect(ghLoginFromHosts('github.com:\n  users:\n    x:\n      user: nested\n')).toBeNull();
    expect(ghLoginFromHosts('gitlab.com:\n  user: x\n')).toBeNull();

    const { tokens } = setup({ env: { HOME, PATH: '/usr/bin', GH_CONFIG_DIR: '/cfg/gh' }, files: { '/cfg/gh/hosts.yml': { text: hosts }, [`${HOME}/.config/gh/hosts.yml`]: { text: 'github.com:\n  user: wrong\n' } } });
    expect((await tokens.account()).gh.login).toBe('alice');
    const xdg = setup({ files: { [`${HOME}/.config/gh/hosts.yml`]: { text: 'github.com:\n  user: carol\n' } } });
    expect((await xdg.tokens.account()).gh.login).toBe('carol');
  });

  it("uses gh's Windows locations and has no file modes to warn about there", async () => {
    const { tokens, logs } = setup({
      platform: 'win32',
      tokenFile: 'C:\\Users\\u\\token.txt',
      env: { Path: '', ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\u' },
      files: {
        'C:\\Program Files\\GitHub CLI\\gh.exe': {},
        'C:\\Users\\u\\AppData\\Roaming\\GitHub CLI\\hosts.yml': { text: 'github.com:\n  user: dana\n' },
        'C:\\Users\\u\\token.txt': { text: 'ghp_x', mode: 0o100666 },
      },
    });
    expect(await tokens.account()).toMatchObject({ source: 'file', gh: { available: true, path: 'C:\\Program Files\\GitHub CLI\\gh.exe', login: 'dana' } });
    expect(logs.filter((l) => l.includes('readable by other users'))).toEqual([]);
  });

  it('caches for about 30 s; fresh, invalidate() and concurrent callers', async () => {
    const { tokens, gh, clock } = setup();
    await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(gh.calls).toHaveLength(1);
    clock.now += TOKEN_CACHE_MS - 1;
    await tokens.get();
    expect(gh.calls).toHaveLength(1);
    await tokens.get({ fresh: true });
    expect(gh.calls).toHaveLength(2);
    tokens.invalidate();
    await tokens.get();
    expect(gh.calls).toHaveLength(3);
    clock.now += TOKEN_CACHE_MS;
    await tokens.get();
    expect(gh.calls).toHaveLength(4);
  });

  it('peek() answers at once and refreshes in the background when stale', async () => {
    let token = 'gho_one';
    const { tokens, gh, clock } = setup({ reply: () => token });
    expect(tokens.peek()).toEqual({ token: null, source: 'none', error: null });
    await vi.waitFor(() => expect(tokens.peek()).toMatchObject({ token: 'gho_one', source: 'gh-cli' }));
    expect(gh.calls).toHaveLength(1);
    token = 'gho_two';
    clock.now += TOKEN_CACHE_MS;
    expect(tokens.peek().token).toBe('gho_one');
    await tokens.get();
    expect(gh.calls).toHaveLength(2);
    expect(tokens.peek().token).toBe('gho_two');
  });

  it('tells subscribers when the token or its source changes, not when it stays the same', async () => {
    let token = 'gho_one';
    const { tokens } = setup({ reply: () => token });
    const seen: (string | null)[] = [];
    const off = tokens.onChange((r) => seen.push(r.token));
    await tokens.get();
    await tokens.get({ fresh: true });
    token = 'gho_two';
    await tokens.get({ fresh: true });
    tokens.setChoice(null);
    await tokens.get();
    off();
    tokens.setChoice('gh');
    await tokens.get();
    expect(seen).toEqual(['gho_one', 'gho_two', null]);
  });

  it('switches choices at once, discarding a slow gh started for the old one', async () => {
    let release!: (out: string) => void;
    const { tokens, gh } = setup({ choice: 'gh', reply: () => new Promise<string>((r) => { release = r; }) });
    const slow = tokens.get();
    await vi.waitFor(() => expect(gh.calls).toHaveLength(1));
    tokens.setChoice('app');
    tokens.setAppToken(' github_pat_pasted ');
    expect(await tokens.get()).toMatchObject({ token: 'github_pat_pasted', source: 'app' });
    release('gho_late');
    // Callers of the superseded resolution get the current answer too.
    expect(await slow).toMatchObject({ token: 'github_pat_pasted', source: 'app' });
    expect(tokens.peek().source).toBe('app');
    expect(gh.calls).toHaveLength(1);

    tokens.setAppToken(null);
    expect(await tokens.get()).toMatchObject({ token: null, source: 'none', error: 'No token has been entered in the app' });
    tokens.setChoice(null);
    expect(await tokens.get()).toEqual(expect.objectContaining({ token: null, source: 'none', error: null }));
    expect((await tokens.account()).choice).toBeNull();
  });
});

describe('TokenProvider validation', () => {
  it('reports the account, repos, kind, expiry and scopes of a classic token', async () => {
    let auth = '';
    const { tokens, api } = setup({
      env: { GITHUB_TOKEN: 'ghp_classic', HOME, PATH: '' },
      github: {
        '/graphql': (req: { headers: Record<string, string>; body: { query: string } }) => {
          auth = req.headers.Authorization!;
          expect(req.body.query).toMatch(/^query \{/);
          return viewerReply({}, { 'github-authentication-token-expiration': '2027-09-06 12:00:00 UTC', 'x-oauth-scopes': 'repo, read:org, gist' });
        },
      },
    });
    const account = await tokens.check();
    expect(auth).toBe('bearer ghp_classic');
    expect(account).toEqual({
      source: 'env', choice: 'auto', locked: true, login: 'alice', name: 'Alice', avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      dbLogin: null, mismatch: false, kind: 'classic', expiresAt: '2027-09-06T12:00:00.000Z', scopes: ['repo', 'read:org', 'gist'],
      repos: { total: 42, private: 7 }, error: null, gh: { available: true, path: GH, login: null }, tokenFile: null,
      checkedAt: '2026-09-28T12:00:00.000Z',
    });
    // account() reuses the validation until the token changes; check() always asks again.
    await tokens.account();
    expect(api.requests).toEqual(['/graphql']);
    await tokens.check();
    expect(api.requests).toHaveLength(2);
  });

  it('validates each new token once in the background; account() never calls GitHub', async () => {
    let token = 'github_pat_one';
    const { tokens, api, clock } = setup({ reply: () => token, github: { '/graphql': viewerReply({}, { 'x-oauth-scopes': '' }) } });
    // The first call waits for the token (not for GitHub).
    expect(await tokens.account()).toMatchObject({ source: 'gh-cli', kind: 'fine-grained' });
    await vi.waitFor(async () => expect(await tokens.account()).toMatchObject({ login: 'alice', scopes: null, expiresAt: null, checkedAt: expect.any(String) }));
    await tokens.account();
    expect(api.requests).toHaveLength(1);

    // `gh auth switch`: a poll after the cache expires notices, and the new token is validated.
    token = 'gho_two';
    clock.now += TOKEN_CACHE_MS;
    expect(await tokens.account()).toMatchObject({ kind: 'fine-grained' });
    await vi.waitFor(async () => expect(await tokens.account()).toMatchObject({ kind: 'oauth', scopes: [], login: 'alice' }));
    expect(api.requests).toHaveLength(2);

    // GitHub answered 401 somewhere: shown as rejected, without asking GitHub again.
    tokens.invalidate('gho_stale');
    expect(await tokens.account()).toMatchObject({ login: 'alice', error: null });
    tokens.invalidate('gho_two');
    expect(await tokens.account()).toMatchObject({ source: 'gh-cli', login: null, error: 'Bad credentials' });
    await tokens.get();
    expect(api.requests).toHaveLength(2);
    expect((await tokens.check()).login).toBe('alice');
    expect(api.requests).toHaveLength(3);
  });

  it('reports bad credentials, GitHub errors and network failures without the token', async () => {
    const bad = setup({ env: { GITHUB_TOKEN: 'ghp_revoked', HOME }, github: { '/graphql': { status: 401, body: { message: 'Bad credentials' } } } });
    expect(await bad.tokens.check()).toMatchObject({ source: 'env', login: null, error: 'Bad credentials', checkedAt: '2026-09-28T12:00:00.000Z' });

    const limited = setup({ env: { GITHUB_TOKEN: 'ghp_x', HOME }, github: { '/graphql': { status: 403, body: { message: 'API rate limit exceeded' } } } });
    expect((await limited.tokens.check()).error).toBe('GitHub returned 403: API rate limit exceeded');

    const offline = new TokenProvider({
      env: { GITHUB_TOKEN: 'ghp_offline_token' },
      platform: 'linux',
      fs: fakeFs({}),
      log: () => {},
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com (token ghp_offline_token)'); },
    });
    expect((await offline.check()).error).toBe("Couldn't reach GitHub: getaddrinfo ENOTFOUND api.github.com (token [token])");
  });

  it('flags a token for another account than the database, by id or (for older databases) by login', async () => {
    let viewer: { login: string; id?: string | null } | null = null;
    const { tokens } = setup({ env: { GITHUB_TOKEN: 'ghp_x', HOME }, viewer: () => viewer, github: { '/graphql': viewerReply() } });
    expect(await tokens.check()).toMatchObject({ dbLogin: null, mismatch: false });
    viewer = { login: 'Alice' };
    expect(await tokens.account()).toMatchObject({ dbLogin: 'Alice', mismatch: false });
    viewer = { login: 'mallory' };
    expect((await tokens.account()).mismatch).toBe(true);
    // Renamed account: same id, new login.
    viewer = { login: 'alice-old', id: 'U_alice' };
    expect((await tokens.account()).mismatch).toBe(false);
    viewer = { login: 'alice', id: 'U_other' };
    expect((await tokens.account()).mismatch).toBe(true);
  });
});

describe('token helpers', () => {
  it('parses both expiry formats and ignores implausible ones', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(parseTokenExpiration('2027-09-06 12:00:00 UTC', now)).toBe('2027-09-06T12:00:00.000Z');
    expect(parseTokenExpiration('2026-10-10 02:30:13 +0200', now)).toBe('2026-10-10T00:30:13.000Z');
    expect(parseTokenExpiration('2026-10-10 02:30:13 -05:30', now)).toBe('2026-10-10T08:00:13.000Z');
    expect(parseTokenExpiration('2026-09-28 12:01:00 UTC', now)).toBeNull();
    expect(parseTokenExpiration('2020-01-01 00:00:00 UTC', now)).toBeNull();
    expect(parseTokenExpiration('next tuesday', now)).toBeNull();
    expect(parseTokenExpiration(null, now)).toBeNull();
  });

  it('names token kinds by prefix and explains a missing token', () => {
    expect(['github_pat_1', 'ghp_1', 'gho_1', 'ghu_1', 'ghs_1', 'abc'].map(tokenKind)).toEqual(['fine-grained', 'classic', 'oauth', 'app', 'app', 'unknown']);
    expect(noTokenMessage({ token: null, source: 'none', error: 'gh is not logged in' })).toBe('No GitHub token: gh is not logged in');
    expect(noTokenMessage({ token: null, source: 'none', error: null })).toBe('No GitHub token: connect a GitHub account in Settings');
  });
});
