import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_SECRET_HEADER } from '../shared/desktop';
import { type Config, loadConfig } from './config';
import { readConfigFile, writeConfigFile } from './config-file';
import { getSource } from './db/sources';
import { localApiUrl, type RunningServer, startServer } from './start';
import { payloadText } from './diff/service';
import commitsFixture from './test/fixtures/gitlab/commits.json';
import { BASE, fakeGitLab, graphql } from './test/gitlab';
import { fakeInstance } from './test/gitlab-instance';
import { addManualRepo } from './test/seed';

const dirs: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  // Short: unix socket paths are limited to about 100 bytes.
  const dir = mkdtempSync(join(tmpdir(), 'ghd-'));
  dirs.push(dir);
  return dir;
}

const windows = process.platform === 'win32';
/** The desktop transport, as main names it: a unix socket in a private folder, or a named pipe on Windows. */
function socketPath() {
  return windows ? `\\\\.\\pipe\\ghd-test-${randomBytes(8).toString('hex')}` : join(temp(), 's');
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const noFiles = {
  stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  access: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
};

async function start(over: Partial<Config> = {}, opts: { socket?: { path: string; secret: string }; tcp?: boolean } = {}) {
  const dir = temp();
  const config = { ...loadConfig({ GH_DASH_DB: join(dir, 'dash.db'), GH_DASH_SYNC: 'off' }), webDir: '/nonexistent', port: 0, ...over };
  const logs: string[] = [];
  const server = await startServer({
    config,
    env: {},
    ...opts,
    log: (line) => logs.push(line),
    tokenOptions: {
      fs: noFiles,
      exec: async () => { throw new Error('gh must not run in tests'); },
      fetchImpl: async () => { throw new Error('no network in tests'); },
    },
  });
  running.push(server);
  return { server, logs, dir };
}

/** GET over the desktop socket or pipe, as the desktop app's main process does. */
function socketGet(socketPath: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startServer', () => {
  it('serves TCP and the desktop socket from one set of databases, and closes both', async () => {
    const socket = socketPath();
    const secret = 'f'.repeat(64);
    const { server, logs } = await start({}, { tcp: true, socket: { path: socket, secret } });
    expect(server.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.socketPath).toBe(socket);
    expect(await (await fetch(`${server.apiUrl}/api/health`)).json()).toMatchObject({ ok: true });
    // Only this user may connect: a unix socket has a file mode; a pipe has no file (the secret guards both).
    if (!windows) expect(statSync(socket).mode & 0o777).toBe(0o600);

    const headers = { host: 'gh-dash', [DESKTOP_SECRET_HEADER]: secret };
    const instance = await socketGet(socket, '/api/v1/instance', headers);
    expect(instance.status).toBe(200);
    expect(JSON.parse(instance.body)).toMatchObject({ apiUrl: server.apiUrl });
    const viaTcp = await (await fetch(`${server.apiUrl}/api/v1/instance`)).json();
    expect(viaTcp.apiUrl).toBe(server.apiUrl);

    const listener = escapeRegExp(windows ? socket : `unix:${socket}`);
    expect(logs.at(-1)).toMatch(
      new RegExp(`^gh-dash \\S+ on http://127\\.0\\.0\\.1:\\d+ and ${listener} · token: none · viewer: unknown · sync: off · me-emails: 0 from env · db: .*dash\\.db · diff cache: .*dash-cache\\.db$`),
    );

    await server.close();
    await server.close();
    await expect(socketGet(socket, '/api/v1/instance', headers)).rejects.toThrow();
    // The socket file is removed; a pipe goes away with its listener.
    if (!windows) expect(existsSync(socket)).toBe(false);
    await expect(fetch(`${server.apiUrl}/api/health`)).rejects.toThrow();
  });

  it('reports the desktop app on both of its listeners', async () => {
    const socket = socketPath();
    const secret = 'd'.repeat(64);
    const { server } = await start({ desktop: true, listen: true }, { socket: { path: socket, secret } });
    const viaSocket = JSON.parse((await socketGet(socket, '/api/v1/instance', { host: 'gh-dash', [DESKTOP_SECRET_HEADER]: secret })).body);
    const viaTcp = await (await fetch(`${server.apiUrl}/api/v1/instance`)).json();
    expect(viaSocket).toMatchObject({ desktop: true, apiUrl: server.apiUrl });
    expect(viaTcp).toMatchObject({ desktop: true, apiUrl: server.apiUrl });
  });

  it('listens on the socket alone unless the Local API is on', async () => {
    const socket = socketPath();
    const { server } = await start({ listen: false }, { socket: { path: socket, secret: 'x'.repeat(64) } });
    expect(server.apiUrl).toBeNull();
    const instance = await socketGet(socket, '/api/v1/instance', { host: 'gh-dash', [DESKTOP_SECRET_HEADER]: 'x'.repeat(64) });
    expect(JSON.parse(instance.body).apiUrl).toBeNull();
  });

  // Unix only: a named pipe goes away with the process that listened on it.
  it.skipIf(windows)('replaces a socket left by a dead process, but nothing else', async () => {
    const socket = socketPath();
    // A child that dies (SIGKILL) while listening leaves its socket file behind.
    spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    expect(statSync(socket).isSocket()).toBe(true);
    const { server } = await start({ listen: false }, { socket: { path: socket, secret: 's'.repeat(64) } });
    expect(server.socketPath).toBe(socket);
    await server.close();

    writeFileSync(socket, 'not a socket');
    await expect(start({ listen: false }, { socket: { path: socket, secret: 's'.repeat(64) } })).rejects.toThrow(`${socket} is already in use`);
    expect(existsSync(socket)).toBe(true);
  });

  it.runIf(windows)('fails clearly when the pipe is taken', async () => {
    const pipe = socketPath();
    await start({ listen: false }, { socket: { path: pipe, secret: 'p'.repeat(64) } });
    await expect(start({ listen: false }, { socket: { path: pipe, secret: 'p'.repeat(64) } })).rejects.toThrow(`${pipe} is already in use`);
  });

  it('fails clearly when the port is taken, releasing what it opened', async () => {
    const { server } = await start();
    const port = Number(new URL(server.apiUrl!).port);
    const dbPath = join(temp(), 'second.db');
    await expect(start({ port, dbPath, cacheDbPath: join(temp(), 'second-cache.db') })).rejects.toThrow(`127.0.0.1:${port} is already in use`);
    // The databases were closed: another instance can open them for writing.
    const again = await start({ dbPath, cacheDbPath: join(temp(), 'third-cache.db') });
    expect(again.server.apiUrl).not.toBeNull();
  });

  it('logs config warnings and gives local clients a loopback URL for wildcard listeners', async () => {
    const { logs } = await start({ warnings: ['unknown key "colour" ignored'] });
    expect(logs[0]).toBe('[config] warning: unknown key "colour" ignored');
    expect(localApiUrl('0.0.0.0', 4780)).toBe('http://127.0.0.1:4780');
    expect(localApiUrl('::', 4780)).toBe('http://[::1]:4780');
    expect(localApiUrl('192.168.1.5', 4780)).toBe('http://192.168.1.5:4780');
    expect(localApiUrl('localhost', 1)).toBe('http://localhost:1');
  });

  it('builds the GitLab sources from config, checks their tokens at startup, and reloads them from config.json', async () => {
    const dir = temp();
    const configPath = join(dir, 'config.json');
    const first = { kind: 'gitlab' as const, url: BASE, tokenSource: 'file' as const, tokenFile: '/run/secrets/gitlab' };
    writeConfigFile(configPath, { sources: [first] });
    const env = { GITLAB_TOKEN: 'glpat-test-alice', GH_DASH_DB: join(dir, 'dash.db'), GH_DASH_SYNC: 'off' };
    const config = { ...loadConfig(env, readConfigFile(configPath)), webDir: '/nonexistent', port: 0 };
    const api = fakeGitLab({
      '/api/graphql': graphql({
        CredentialCheck: () => ({
          currentUser: { id: 'gid://gitlab/User/2', username: 'alice', name: null, avatarUrl: null, publicEmail: null, commitEmail: null, emails: { nodes: [] } },
          metadata: { version: '19.3.3-ee', enterprise: true },
          personal: { count: 3 },
        }),
      }),
      '/api/v4/personal_access_tokens/self': { body: { id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['api'], expires_at: '2026-10-05' } },
    });
    const logs: string[] = [];
    const server = await startServer({
      config,
      env,
      log: (line) => logs.push(line),
      tokenOptions: { fs: noFiles, exec: async () => { throw new Error('gh must not run in tests'); }, fetchImpl: async () => { throw new Error('no network in tests'); } },
      sourceOptions: { fs: noFiles, exec: async () => { throw new Error('glab must not run in tests'); }, fetchImpl: api.fetchImpl, sleep: async () => {}, now: () => Date.parse('2026-09-28T12:00:00Z') },
    });
    running.push(server);

    const gl = server.sources.byHost('gitlab.example.com')!;
    expect(gl).toMatchObject({ configured: true, config: { tokenChoice: 'file', tokenEnv: 'GITLAB_TOKEN', from: 'file' } });
    expect(getSource(server.db, gl.id)).toMatchObject({ kind: 'gitlab', host: 'gitlab.example.com', baseUrl: BASE, name: 'GitLab' });
    expect(server.sources.github().tokens).toBe(server.tokens.credentials);
    const p = '[token gitlab.example.com]';
    await vi.waitFor(() => expect(logs).toContain(`${p} env token is for @alice (personal, expires 2026-10-05)`));
    expect(logs).toEqual(expect.arrayContaining([
      `[sources] GitLab (gitlab.example.com) at ${BASE} · token: GITLAB_TOKEN (locked)`,
      expect.stringMatching(/^\[token gitlab\.example\.com\] warning: the token expires 2026-10-05 \(in 7 days\)/),
      expect.stringMatching(/^\[token gitlab\.example\.com\] note: This token can change things on GitLab \(api scope\)/),
    ]));
    // GitHub's own line is as it was.
    expect(logs.find((line) => line.startsWith('gh-dash '))).toMatch(/ · token: none · viewer: unknown · sync: off · /);

    // A second source: GITLAB_TOKEN can't say which it is for any more, so the first goes back to its token file.
    writeConfigFile(configPath, { glabPath: '/opt/glab', sources: [first, { kind: 'gitlab', url: 'https://gitlab2.example.com', tokenSource: 'glab' }] });
    expect(server.reloadSources().map((r) => [r.host, r.configured])).toEqual([['github.com', true], ['gitlab.example.com', true], ['gitlab2.example.com', true]]);
    expect(server.config).toMatchObject({ glabPath: '/opt/glab', sourceConfigs: [{ host: 'gitlab.example.com', tokenEnv: null }, { host: 'gitlab2.example.com', tokenChoice: 'glab' }] });
    expect(server.sources.byHost('gitlab.example.com')).not.toBe(gl);
    expect(await server.sources.byHost('gitlab.example.com')!.tokens.get()).toMatchObject({ token: null, error: 'Token file /run/secrets/gitlab does not exist' });
    expect(await server.sources.byHost('gitlab2.example.com')!.tokens.get()).toMatchObject({ token: null, error: 'glab not found at /opt/glab (glabPath)' });

    // A config.json that doesn't validate changes nothing.
    writeFileSync(configPath, JSON.stringify({ sources: [{ kind: 'gitlab', url: 'https://github.com' }] }));
    expect(() => server.reloadSources()).toThrow(/github\.com is built in/);
    expect(server.sources.list()).toHaveLength(3);
    expect(server.config.glabPath).toBe('/opt/glab');
  });

  it('says where the glab path and the sources came from again after a reload', async () => {
    const dir = temp();
    const configPath = join(dir, 'config.json');
    writeConfigFile(configPath, {});
    const env = { GH_DASH_DB: join(dir, 'dash.db'), GH_DASH_SYNC: 'off' };
    const config = { ...loadConfig(env, readConfigFile(configPath)), webDir: '/nonexistent', port: 0 };
    const logs: string[] = [];
    const server = await startServer({
      config,
      env,
      log: (line) => logs.push(line),
      tokenOptions: { fs: noFiles, exec: async () => { throw new Error('gh must not run in tests'); }, fetchImpl: async () => { throw new Error('no network in tests'); } },
      sourceOptions: { fs: noFiles, exec: async () => { throw new Error('glab must not run in tests'); }, fetchImpl: async () => { throw new Error('no network in tests'); }, sleep: async () => {} },
    });
    running.push(server);
    expect(server.config).toMatchObject({ glabPath: null, sourceConfigs: [], sources: { glabPath: 'default', sources: 'default' } });

    writeConfigFile(configPath, { glabPath: '/opt/glab', sources: [{ kind: 'gitlab', url: BASE, tokenSource: 'glab' }] });
    server.reloadSources();
    expect(server.config).toMatchObject({ glabPath: '/opt/glab', sources: { glabPath: 'file', sources: 'file' } });
    expect(server.config.sourceConfigs.map((c) => [c.host, c.from])).toEqual([['gitlab.example.com', 'file']]);
    // The rebuilt source's token check runs in the background: let it finish before the server closes.
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith('[token gitlab.example.com] no token'))).toBe(true));
  });

  it("tells every listener's open streams of a comment, and ends them at once on shutdown", async () => {
    const socket = socketPath();
    const secret = 'e'.repeat(64);
    const { server } = await start({}, { tcp: true, socket: { path: socket, secret } });
    addManualRepo(server.db, 'alice/app');
    // One window on the Local API, one on the desktop socket: one bus.
    const tcp = await fetch(`${server.apiUrl}/api/v1/stream`);
    expect(tcp.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const reader = tcp.body!.getReader();
    const decoder = new TextDecoder();
    let tcpText = '';
    const readUntil = async (text: string) => {
      while (!tcpText.includes(text)) {
        const { value, done } = await reader.read();
        if (done) return false;
        tcpText += decoder.decode(value);
      }
      return true;
    };
    let socketText = '';
    const socketEnded = new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: socket, path: '/api/v1/stream', headers: { host: 'gh-dash', [DESKTOP_SECRET_HEADER]: secret } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (socketText += chunk));
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    expect(await readUntil(': connected')).toBe(true);
    await vi.waitFor(() => expect(server.bus.windows).toBe(2));

    const oid = 'c'.repeat(40);
    const res = await fetch(`${server.apiUrl}/api/v1/commits/alice%2Fapp/${oid}/threads`, { method: 'POST', body: JSON.stringify({ body: 'Nit' }) });
    const thread = (await res.json()) as { id: number };
    const message = { type: 'comments', repo: 'alice/app', kind: 'commit', number: null, commitOid: oid, threadId: thread.id, event: 'thread_opened', by: { id: 1, kind: 'self', name: 'You' } };
    expect(await readUntil('}\n\n')).toBe(true);
    expect(tcpText).toContain(`data: ${JSON.stringify(message)}\n\n`);
    await vi.waitFor(() => expect(socketText).toContain(`data: ${JSON.stringify(message)}\n\n`));

    // Shutdown doesn't wait out the 2 s grace period for the open streams: they end first.
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    await socketEnded;
    expect(await readUntil('never')).toBe(false);
  });

  it("fetches a repo's diffs from the source it is on", async () => {
    const dir = temp();
    const env = { GITLAB_TOKEN: 'glpat-test-alice', GH_DASH_GITLAB_URL: BASE, GH_DASH_DB: join(dir, 'dash.db'), GH_DASH_SYNC: 'off' };
    const config = { ...loadConfig(env), webDir: '/nonexistent', port: 0 };
    const api = fakeInstance({}, BASE, {
      CredentialCheck: () => ({
        currentUser: { id: 'gid://gitlab/User/2', username: 'alice', name: null, avatarUrl: null, publicEmail: null, commitEmail: null, emails: { nodes: [] } },
        metadata: { version: '19.3.3-ee', enterprise: true },
        personal: { count: 3 },
      }),
    });
    const server = await startServer({
      config,
      env,
      log: () => {},
      tokenOptions: { fs: noFiles, exec: async () => { throw new Error('gh must not run in tests'); }, fetchImpl: async () => { throw new Error('no network in tests'); } },
      sourceOptions: { fs: noFiles, exec: async () => { throw new Error('glab must not run in tests'); }, fetchImpl: api.fetchImpl, sleep: async () => {} },
    });
    running.push(server);
    addManualRepo(server.db, 'alice/app', { source: server.sources.byHost('gitlab.example.com')!.row });
    addManualRepo(server.db, 'alice/tool');

    // GitLab's repo is read from GitLab with GitLab's token; GitHub's has no token here, and says so.
    const head = commitsFixture[0]!.id;
    const diff = JSON.parse(await payloadText(await server.diffs.commitDiff('gitlab.example.com/alice/app', head))) as { repo: string; headOid: string };
    expect(diff).toMatchObject({ repo: 'gitlab.example.com/alice/app', headOid: head });
    expect(api.calls.find((c) => c.url.pathname.endsWith(`/repository/commits/${head}`))?.headers.Authorization).toBe('Bearer glpat-test-alice');
    expect(await server.diffs.commitDiff('alice/tool', head).catch((e: Error) => e)).toMatchObject({ status: 503, message: expect.stringContaining('No GitHub token') });
  });
});
