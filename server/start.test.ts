import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_SECRET_HEADER } from '../shared/desktop';
import { type Config, loadConfig } from './config';
import { localApiUrl, type RunningServer, startServer } from './start';

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
});
