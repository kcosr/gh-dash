import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { type AppDeps, createApp } from './api/app';
import type { Config } from './config';
import { type Db, openDb } from './db/db';
import { getMeta } from './db/meta';
import { type DiffCache, openDiffCache } from './diff/cache';
import { DiffService } from './diff/service';
import { GitHubDiffSources } from './github/diff-source';
import { SyncManager } from './sync/manager';
import { TokenProvider, type TokenProviderOptions } from './token';

/** How long startup waits for the token and viewer before logging without them (gh may be waiting on a keyring). */
const STARTUP_WAIT_MS = 1000;
/** In-flight requests get this long to finish on close before their connections are cut. */
const CLOSE_GRACE_MS = 2000;

export interface StartOptions {
  config: Config;
  /** The environment the token provider reads (GITHUB_TOKEN, PATH, HOME...): loadServerConfig's `env`. */
  env: NodeJS.ProcessEnv;
  /** Listen on TCP at config.host:config.port (transport `tcp`). Default: config.listen. */
  tcp?: boolean;
  /** The desktop app's socket: a unix socket path or a \\.\pipe\ name, and the secret every request must carry. */
  socket?: { path: string; secret: string };
  log?: (line: string) => void;
  /** Test seams for the token provider (exec, fetchImpl, fs...). */
  tokenOptions?: Partial<TokenProviderOptions>;
}

export interface RunningServer {
  config: Config;
  db: Db;
  tokens: TokenProvider;
  sync: SyncManager;
  diffs: DiffService;
  /** The TCP listener's local URL (http://127.0.0.1:<port> even when bound to all interfaces); null without one. */
  apiUrl: string | null;
  /** The socket or pipe the desktop transport listens on; null without one. */
  socketPath: string | null;
  /** Stops the scheduler, then closes the listeners and databases. Idempotent. */
  close(): Promise<void>;
}

/**
 * Opens the databases and starts the token provider, the sync scheduler, the diff service and one app instance per
 * listener: TCP (headless server, or the desktop app's Local API) and/or the desktop socket. They share everything
 * but the transport. Nothing here handles signals: the CLI (main.ts) and the desktop child (desktop.ts) do.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const log = opts.log ?? ((line) => console.log(line));
  for (const warning of config.warnings) log(`[config] warning: ${warning}`);

  const db = openDb(config.dbPath, { allowDestructiveMigrations: config.syncEnabled });
  let cache: DiffCache | null = null;
  const servers: Server[] = [];
  let socketPath: string | null = null;
  const closeAll = async () => {
    await Promise.all(servers.map(closeServer));
    if (socketPath) removeSocket(socketPath);
    db.close();
    cache?.close();
  };

  try {
    cache = openDiffCache(config.cacheDbPath);
    const tokens = new TokenProvider({
      env: opts.env,
      choice: config.tokenChoice,
      tokenFile: config.tokenFile,
      ghPath: config.ghPath,
      viewer: () => getMeta(db, 'viewer'),
      log,
      ...opts.tokenOptions,
    });
    // Resolved and validated in the background: nothing below needs the token, and gh can take a while.
    let tokenSettled = false;
    const tokenReady = tokens.check().then(() => {
      tokenSettled = true;
    });
    const sync = new SyncManager({ db, schedule: config.syncEnabled, tokens, log });
    const diffs = new DiffService({ db, cache, sources: new GitHubDiffSources({ tokens, log }), log });
    diffs.evict();
    const viewerReady = sync.ensureViewer().catch((err: Error) => log(`[startup] could not fetch GitHub viewer: ${err.message}`));
    const deps: AppDeps = { db, config, sync, diffs, tokens };

    let apiUrl: string | null = null;
    let bound: string | null = null;
    if (opts.tcp ?? config.listen) {
      const server = createAdaptorServer({ fetch: createApp({ ...deps, transport: { kind: 'tcp' } }).fetch }) as Server;
      servers.push(server);
      await listen(server, (done) => server.listen(config.port, config.host, done), hostPort(config.host, config.port));
      const { port } = server.address() as AddressInfo;
      bound = `http://${hostPort(config.host, port)}`;
      apiUrl = localApiUrl(config.host, port);
    }
    if (opts.socket) {
      const { path, secret } = opts.socket;
      const app = createApp({ ...deps, transport: { kind: 'desktop', secret }, localApiUrl: () => apiUrl });
      const server = createAdaptorServer({ fetch: app.fetch }) as Server;
      servers.push(server);
      removeStaleSocket(path);
      await listen(server, (done) => server.listen(path, done), path);
      socketPath = path;
      // Other local users mustn't connect (the secret guards it too); the folder main creates is private as well.
      if (process.platform !== 'win32') chmodSync(path, 0o600);
    }

    await Promise.race([Promise.all([tokenReady, viewerReady]), new Promise((r) => setTimeout(r, STARTUP_WAIT_MS).unref())]);
    const listeners = [bound, socketPath && (process.platform === 'win32' ? socketPath : `unix:${socketPath}`)].filter(Boolean);
    const fromFile = Object.values(config.sources).includes('file');
    log(
      `gh-dash ${config.version} on ${listeners.join(' and ') || 'no listener'} · token: ${tokenSettled ? tokens.peek().source : 'resolving'} · ` +
        `viewer: ${getMeta(db, 'viewer')?.login ?? 'unknown'} · sync: ${config.syncEnabled ? 'on' : 'off'} · ` +
        `me-emails: ${config.myEmails.length} from ${config.sources.myEmails === 'file' ? 'config' : 'env'} · db: ${config.dbPath} · ` +
        `diff cache: ${cache.path}${fromFile ? ` · config: ${config.configPath}` : ''}`,
    );
    sync.startScheduler();

    let closing: Promise<void> | null = null;
    return {
      config, db, tokens, sync, diffs, apiUrl, socketPath,
      close: () =>
        (closing ??= (async () => {
          await sync.shutdown();
          await closeAll();
        })()),
    };
  } catch (err) {
    await closeAll().catch(() => {});
    throw err;
  }
}

/** "127.0.0.1:4780", "[::1]:4780". */
function hostPort(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

/** The URL a local client uses for a listener on `host`: loopback for the wildcard addresses. */
export function localApiUrl(host: string, port: number): string {
  const local = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' || host === '[::]' ? '::1' : host;
  return `http://${hostPort(local, port)}`;
}

function listen(server: Server, start: (done: () => void) => void, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`${what} is already in use`));
      else if (err.code === 'EACCES') reject(new Error(`No permission to listen on ${what}`));
      else if (err.code === 'EADDRNOTAVAIL') reject(new Error(`${what} isn't an address of this computer`));
      else reject(new Error(`Can't listen on ${what}: ${err.message}`));
    };
    server.once('error', failed);
    start(() => {
      server.off('error', failed);
      resolve();
    });
  });
}

/** Stops accepting connections, lets idle keep-alive ones go at once and cuts the rest after a grace period. */
function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** A socket left by a process that died refuses the listen (EADDRINUSE): remove it, but never anything that isn't a socket. */
function removeStaleSocket(path: string): void {
  if (process.platform === 'win32') return; // named pipes go away with their process
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function removeSocket(path: string): void {
  if (process.platform === 'win32') return;
  try {
    unlinkSync(path);
  } catch { /* already gone */ }
}
