import { describe, expect, it } from 'vitest';
import { execError, fakeExec, fakeFs, type FakeFile } from '../test/credentials';
import { defaultExec } from './cli';
import { GLAB_TIMEOUT_MS, glabCli, glabEnv, glabToken, tokenFromAuthStatus } from './glab';
import { CredentialProvider, EMPTY_CHECK } from './provider';
import type { CredentialSpec } from './types';

const HOST = 'gitlab.example.com';
const GLAB = '/usr/bin/glab';
const PAT = 'glpat-AbCdEf0123456789xyz';
const OAUTH = 'a'.repeat(64);
/** A token a failing glab prints in its error: built here, so no token-shaped literal is in the file. */
const LEAKED = `glpat-${'Zq8'.repeat(7)}`;
const ENV = { HOME: '/home/u', PATH: '/usr/bin', GLAB_CONFIG_DIR: '/home/u/.glab', GITLAB_TOKEN: 'glpat-fromenv', GLAB_TOKEN: 'x', GITLAB_ACCESS_TOKEN: 'y', OAUTH_TOKEN: 'z' };

type Reply = string | { stdout: string; stderr?: string };
/** glab stand-in: `config` answers `config get token`, `status` answers `auth status … --show-token`. */
function glab(config: () => Reply | Promise<Reply>, status: () => Reply | Promise<Reply> = () => '') {
  return fakeExec((args) => (args[0] === 'config' ? config() : status()));
}

const run = (g: ReturnType<typeof glab>, env: NodeJS.ProcessEnv = ENV, win = false) => glabToken(GLAB, HOST, { env, exec: g.exec, win });

describe('glab resolver', () => {
  it('takes the token from `glab config get token --host` and asks nothing else', async () => {
    const g = glab(() => `${PAT}\n`);
    expect(await run(g)).toEqual({ token: PAT, source: 'glab', error: null });
    expect(g.calls.map((c) => [c.file, c.args])).toEqual([[GLAB, ['config', 'get', 'token', '--host', HOST]]]);
  });

  it('falls back to `glab auth status --show-token` only when config get printed nothing', async () => {
    // glab colours and decorates its status; exit 1 (another host logged out) still says what it knows.
    const status = `\x1b[1m${HOST}\x1b[0m\n  \x1b[32m✓\x1b[0m Logged in to ${HOST} as alice (/home/u/.glab/config.yml)\n  ✓ Token found in OS keyring for ${HOST}.internal.example.org\n  ✓ Token: ${OAUTH}\n`;
    const g = glab(() => '  \n', () => Promise.reject(execError(status, { stdout: '' })));
    expect(await run(g)).toEqual({ token: OAUTH, source: 'glab', error: null });
    expect(g.calls.map((c) => c.args)).toEqual([
      ['config', 'get', 'token', '--host', HOST],
      ['auth', 'status', '--hostname', HOST, '--show-token'],
    ]);

    const failed = glab(() => Promise.reject(execError('could not read config')), () => ({ stdout: '', stderr: `✓ Token: ${PAT}` }));
    expect(await run(failed)).toMatchObject({ token: PAT, source: 'glab' });
  });

  it("names the host and what to do when glab has no token for it; masked tokens and host names aren't tokens", async () => {
    const masked = `${HOST}\n  x ${HOST} has not been authenticated with glab. Run \`glab auth login --hostname ${HOST}\`\n  ! Token found: **************************\n`;
    expect(await run(glab(() => '', () => masked))).toEqual({
      token: null, source: 'none', error: `glab has no token for ${HOST}: run \`glab auth login --hostname ${HOST}\``,
    });
    const both = glab(() => Promise.reject(execError('keyring: the collection is locked\nmore')), () => Promise.reject(execError('')));
    expect((await run(both)).error).toBe(`glab has no token for ${HOST}: run \`glab auth login --hostname ${HOST}\` (glab config get token failed: keyring: the collection is locked)`);
    const old = glab(() => '', () => Promise.reject(execError('unknown flag: --show-token')));
    expect((await run(old)).error).toBe(`this glab can't print its token for ${HOST} (no auth status --show-token): upgrade glab, or use a token file`);
  });

  it('takes anything that looks like a token out of a failure it quotes, before cutting it to 200 characters', async () => {
    const cases: [string, string][] = [
      [`error: could not save ${LEAKED} to the keyring`, 'error: could not save [token] to the keyring'],
      [`401: token ${'f0'.repeat(32)} was revoked`, '401: token [token] was revoked'],
      // Cut first, the token's first characters would be left at the end.
      [`${'word '.repeat(38)}${LEAKED}`, `${'word '.repeat(38)}[token]`],
    ];
    for (const [stderr, quoted] of cases) {
      const { error } = await run(glab(() => Promise.reject(execError(stderr)), () => ''));
      expect(error).toBe(`glab has no token for ${HOST}: run \`glab auth login --hostname ${HOST}\` (glab config get token failed: ${quoted})`);
    }
  });

  it("refuses output that isn't a token, without quoting it or trying the fallback", async () => {
    const g = glab(() => 'Error: something went\nwrong');
    expect(await run(g)).toEqual({ token: null, source: 'none', error: 'glab config get token printed something other than a token' });
    expect(g.calls).toHaveLength(1);
  });

  it('gives up after 15 s, or when glab cannot run, without the second command', async () => {
    const slow = glab(() => Promise.reject(execError('', { killed: true, signal: 'SIGTERM' })));
    expect((await run(slow)).error).toBe('glab timed out after 15 s (is it waiting for a keyring prompt?)');
    expect(slow.calls.map((c) => c.timeout)).toEqual([GLAB_TIMEOUT_MS]);

    const slowStatus = glab(() => '', () => Promise.reject(execError('', { killed: true, signal: 'SIGTERM' })));
    expect((await run(slowStatus)).error).toMatch(/^glab timed out after 15 s/);
    expect(slowStatus.calls.map((c) => c.timeout)).toEqual([GLAB_TIMEOUT_MS, GLAB_TIMEOUT_MS]);

    const gone = glab(() => Promise.reject(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
    expect((await run(gone)).error).toBe(`Couldn't run glab at ${GLAB} (EACCES)`);
    expect(gone.calls).toHaveLength(1);
  });

  it("runs glab without the token variables, never prompting and without colour", async () => {
    const g = glab(() => '', () => `Token: ${PAT}`);
    await run(g);
    for (const call of g.calls) {
      expect(call.env).toEqual({ HOME: '/home/u', PATH: '/usr/bin', GLAB_CONFIG_DIR: '/home/u/.glab', NO_PROMPT: '1', NO_COLOR: '1' });
    }
    // Windows variables aren't case-sensitive.
    expect(glabEnv({ Path: 'C:\\bin', Gitlab_Token: 'x', glab_token: 'y', USERPROFILE: 'C:\\Users\\u' }, true)).toEqual({
      Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\u', NO_PROMPT: '1', NO_COLOR: '1',
    });
    expect(glabEnv({ Gitlab_Token: 'kept elsewhere' }, false)).toMatchObject({ Gitlab_Token: 'kept elsewhere' });
  });

  it('reads the token out of status lines', () => {
    expect(tokenFromAuthStatus(`  ✓ Token: ${PAT}`, HOST)).toBe(PAT);
    expect(tokenFromAuthStatus('  ✓ Token: glpat-abc.01.defghijklmnop', HOST)).toBe('glpat-abc.01.defghijklmnop');
    expect(tokenFromAuthStatus(`  ✓ Logged in to ${HOST} as alice\n  ✓ Git operations will use https`, HOST)).toBeNull();
    expect(tokenFromAuthStatus('  ✓ Token found in the keyring of averyveryverylonghostname-example-org', 'averyveryverylonghostname-example-org')).toBeNull();
  });
});

/** A GitLab-ish spec around glabCli, to drive discovery through CredentialProvider. */
function glabProvider(
  opts: { glabPath?: string | null; files?: Record<string, FakeFile>; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exec?: ReturnType<typeof fakeExec>; log?: (line: string) => void } = {},
) {
  const exec = opts.exec ?? fakeExec((args) => (args[0] === 'config' ? PAT : ''));
  const spec: CredentialSpec = {
    provider: 'gitlab', name: 'GitLab', host: HOST, label: `GitLab (${HOST})`, envVar: null, fileSetting: 'tokenFile',
    noTokenHint: 'set one up in Settings → Sources', notConfigured: 'No sign-in method is configured', rejected: 'rejected', authHint: '',
    logPrefix: `[token ${HOST}]`, cli: glabCli(HOST, opts.glabPath ?? null), kind: () => 'personal',
    validate: async () => ({ ...EMPTY_CHECK, ok: true, login: 'alice' }),
  };
  const tokens = new CredentialProvider(spec, {
    env: opts.env ?? { HOME: '/home/u', PATH: '/usr/local/bin:/usr/bin' },
    choice: 'glab',
    platform: opts.platform ?? 'linux',
    fs: fakeFs(opts.files ?? {}),
    exec: exec.exec,
    log: opts.log ?? (() => {}),
  });
  return { tokens, exec };
}

describe('glab discovery', () => {
  it('finds glab via glabPath, PATH, then the standard install locations', async () => {
    const configured = glabProvider({ glabPath: '/opt/glab/glab', files: { '/opt/glab/glab': { exec: true }, [GLAB]: { exec: true } } });
    expect(await configured.tokens.get()).toMatchObject({ token: PAT, source: 'glab' });
    expect((await configured.tokens.account()).cli).toEqual({ name: 'glab', available: true, path: '/opt/glab/glab', login: null });
    expect(configured.exec.calls[0]!.file).toBe('/opt/glab/glab');

    const missing = glabProvider({ glabPath: '/nope/glab', files: { [GLAB]: { exec: true } } });
    expect(await missing.tokens.get()).toMatchObject({ token: null, error: 'glab not found at /nope/glab (glabPath)' });
    expect(missing.exec.calls).toEqual([]);

    const onPath = glabProvider({ files: { '/usr/local/bin/glab': { exec: true }, [GLAB]: { exec: true } } });
    expect((await onPath.tokens.account()).cli?.path).toBe('/usr/local/bin/glab');

    const mac = glabProvider({ platform: 'darwin', env: { HOME: '/Users/u', PATH: '/usr/bin:/bin' }, files: { '/opt/homebrew/bin/glab': { exec: true } } });
    expect((await mac.tokens.account()).cli?.path).toBe('/opt/homebrew/bin/glab');

    const win = glabProvider({ platform: 'win32', env: { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\u' }, files: { 'C:\\Program Files\\glab\\glab.exe': {} } });
    expect((await win.tokens.account()).cli?.path).toBe('C:\\Program Files\\glab\\glab.exe');

    const none = glabProvider({ env: { HOME: '/home/u', PATH: '' } });
    expect(await none.tokens.account()).toMatchObject({
      source: 'none', cli: { name: 'glab', available: false, path: null, login: null },
      error: 'glab not found: install it, or set its location (Settings → Sources → Locate glab…, or glabPath)',
    });
  });
});

describe('a failing glab', () => {
  it("never puts a token in the logs, the account's error or the no-token message", async () => {
    // What glab handed out before: too short to look like a token, but this provider knows it.
    const earlier = 'Tok3n-99xz';
    let failing = false;
    const exec = fakeExec((args) => {
      if (args[0] !== 'config') return '';
      return failing ? Promise.reject(execError(`cannot refresh ${earlier}: ${LEAKED} was rejected\nmore`)) : earlier;
    });
    const logs: string[] = [];
    const { tokens } = glabProvider({ files: { [GLAB]: { exec: true } }, env: { HOME: '/home/u', PATH: '/usr/bin' }, exec, log: (line) => logs.push(line) });
    expect((await tokens.get()).token).toBe(earlier);

    failing = true;
    const resolved = await tokens.get({ fresh: true });
    const account = await tokens.account();
    expect(resolved.token).toBeNull();
    expect(account.error).toBe(`glab has no token for ${HOST}: run \`glab auth login --hostname ${HOST}\` (glab config get token failed: cannot refresh [token]: [token] was rejected)`);
    expect(logs.at(-1)).toBe(`[token ${HOST}] no token: ${account.error}`);
    for (const text of [...logs, resolved.error, account.error, tokens.noTokenMessage()]) {
      expect(text).not.toContain(earlier);
      expect(text).not.toMatch(/glpat|Zq8/);
    }
  });
});

describe('defaultExec', () => {
  it("closes the command's stdin, so nothing waits for input", async () => {
    const script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));";
    const started = Date.now();
    expect(await defaultExec(process.execPath, ['-e', script], { env: {}, timeout: 5000 })).toEqual({ stdout: 'eof', stderr: '' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects with the output of a failed command', async () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);";
    await expect(defaultExec(process.execPath, ['-e', script], { env: {}, timeout: 5000 })).rejects.toMatchObject({ code: 3, stdout: 'out', stderr: 'err' });
  });
});
