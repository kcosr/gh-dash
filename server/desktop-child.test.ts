import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_ENV, type ServerToMain } from '../shared/desktop';
import { mainMessageHandler, type ParentPort, runDesktopChild } from './desktop-child';
import type { RunningServer } from './start';
import { fakeGitHub, type Reply } from './test/github';
import { testTokens } from './test/tokens';

const dirs: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const viewer = (login: string): Reply => ({
  body: { data: { viewer: { id: `U_${login}`, login, name: null, avatarUrl: null, repos: { totalCount: 3 }, privateRepos: { totalCount: 1 } } } },
});

describe('main → server messages', () => {
  function setup() {
    const gh = fakeGitHub({
      '/graphql': (req: { headers: Record<string, string> }) => (req.headers.Authorization === 'bearer github_pat_good' ? viewer('alice') : { status: 401, body: { message: 'Bad credentials' } }),
    } as never);
    const tokens = testTokens(null, { fetchImpl: gh.fetchImpl });
    const server = { tokens, close: vi.fn(async () => {}) };
    const posted: ServerToMain[] = [];
    const exit = vi.fn();
    return { handle: mainMessageHandler(server, (m) => posted.push(m), exit), tokens, server, posted, exit, gh };
  }

  it('validates a pasted token and reports whether GitHub accepted it', async () => {
    const { handle, posted, tokens } = setup();
    await handle({ type: 'set-token', id: 1, choice: 'app', token: 'github_pat_good' });
    expect(posted).toEqual([{ type: 'token-result', id: 1, ok: true, account: expect.objectContaining({ source: 'app', choice: 'app', login: 'alice', kind: 'fine-grained', error: null }) }]);
    await handle({ type: 'set-token', id: 2, choice: 'app', token: 'github_pat_bad' });
    expect(posted[1]).toEqual({ type: 'token-result', id: 2, ok: false, account: expect.objectContaining({ source: 'app', login: null, error: 'Bad credentials' }) });
    expect(tokens.getChoice()).toBe('app');
  });

  it('switches source without forgetting the app token, and signs out', async () => {
    const { handle, posted } = setup();
    await handle({ type: 'set-token', id: 1, choice: 'app', token: 'github_pat_good' });
    await handle({ type: 'set-token', id: 2, choice: null });
    expect(posted[1]).toMatchObject({ id: 2, ok: true, account: { source: 'none', choice: null, error: null } });
    // `token` absent: the pasted token is still there when switching back.
    await handle({ type: 'set-token', id: 3, choice: 'app' });
    expect(posted[2]).toMatchObject({ id: 3, ok: true, account: { source: 'app', login: 'alice' } });
    await handle({ type: 'set-token', id: 4, choice: 'app', token: null });
    expect(posted[3]).toMatchObject({ id: 4, ok: false, account: { source: 'none', error: 'No token has been entered in the app' } });
  });

  it('closes everything and exits 0 on shutdown; ignores anything else', async () => {
    const { handle, server, exit, posted } = setup();
    await handle({ type: 'bogus' });
    await handle(null);
    expect(posted).toEqual([]);
    await handle({ type: 'shutdown' });
    expect(server.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('runDesktopChild', () => {
  function fakePort() {
    let listener: ((e: { data: unknown }) => void) | null = null;
    const posted: ServerToMain[] = [];
    const port: ParentPort = {
      on: (_event, l) => { listener = l; },
      postMessage: (m) => posted.push(m as ServerToMain),
    };
    return { port, posted, send: (data: unknown) => listener!({ data }) };
  }
  function desktopEnv(): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), 'ghd-'));
    dirs.push(dir);
    return {
      HOME: dir,
      [DESKTOP_ENV.desktop]: '1',
      [DESKTOP_ENV.config]: join(dir, 'config.json'),
      [DESKTOP_ENV.dataDir]: join(dir, 'data'),
      // What main passes: a unix socket path, or a named pipe on Windows.
      [DESKTOP_ENV.socket]: process.platform === 'win32' ? `\\\\.\\pipe\\ghd-test-${randomBytes(8).toString('hex')}` : join(dir, 's'),
      [DESKTOP_ENV.secret]: 'e'.repeat(64),
    };
  }

  it('starts on the socket, says ready, then answers messages sent while it started', async () => {
    const { port, posted, send } = fakePort();
    const exit = vi.fn();
    const env = desktopEnv();
    const starting = runDesktopChild(port, env, exit);
    send({ type: 'set-token', id: 7, choice: null, token: null });
    const server = (await starting)!;
    running.push(server);
    expect(server.config).toMatchObject({ desktop: true, listen: false, dbPath: join(env[DESKTOP_ENV.dataDir]!, 'gh-dash.db') });
    expect(server.socketPath).toBe(env[DESKTOP_ENV.socket]);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual([
      { type: 'ready', apiUrl: null },
      { type: 'token-result', id: 7, ok: true, account: expect.objectContaining({ source: 'none', choice: null }) },
    ]);
    send({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('reports a bad config as fatal and exits 1', async () => {
    const { port, posted } = fakePort();
    const exit = vi.fn();
    const env = desktopEnv();
    writeFileSync(env[DESKTOP_ENV.config]!, '{"port": "nope"}');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDesktopChild(port, env, exit)).toBeNull();
    expect(posted).toEqual([{ type: 'fatal', message: expect.stringContaining(`${env[DESKTOP_ENV.config]}: port:`) }]);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    const missing = fakePort();
    expect(await runDesktopChild(missing.port, { ...env, [DESKTOP_ENV.socket]: '' }, vi.fn())).toBeNull();
    expect(missing.posted).toEqual([{ type: 'fatal', message: `${DESKTOP_ENV.socket} and ${DESKTOP_ENV.secret} must be set by the desktop app` }]);
    vi.restoreAllMocks();
  });
});
