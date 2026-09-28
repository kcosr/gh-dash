import { serve } from '@hono/node-server';
import { createApp } from './api/app';
import { loadConfig, loadEnvironment, resolveToken } from './config';
import { openDb } from './db/db';
import { getMeta } from './db/meta';
import { openDiffCache } from './diff/cache';
import { DiffService } from './diff/service';
import { SyncManager } from './sync/manager';

const env = loadEnvironment();
const config = loadConfig(env);
const db = openDb(config.dbPath, { allowDestructiveMigrations: config.syncEnabled });
const sync = new SyncManager({ db, schedule: config.syncEnabled, resolveToken: () => resolveToken(env) });
const cache = openDiffCache(config.cacheDbPath);
const diffs = new DiffService({ db, cache, resolveToken: () => resolveToken(env) });
diffs.evict();

try {
  await sync.ensureViewer();
} catch (err) {
  console.warn(`[startup] could not fetch GitHub viewer: ${(err as Error).message}`);
}

const app = createApp({ db, config, sync, diffs });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const viewer = getMeta(db, 'viewer')?.login ?? 'unknown';
  console.log(
    `gh-dash ${config.version} on http://${config.host}:${info.port} · token: ${sync.getTokenSource()} · viewer: ${viewer} · ` +
      `sync: ${config.syncEnabled ? 'on' : 'off'} · me-emails: ${config.myEmails.length} from env · db: ${config.dbPath} · diff cache: ${cache.path}`,
  );
  sync.startScheduler();
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[shutdown] ${signal}`);
  await sync.shutdown();
  server.close();
  db.close();
  cache.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
