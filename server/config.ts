import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TokenSource = 'env' | 'gh-cli' | 'none';

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  syncEnabled: boolean;
  apiKey: string | null;
  password: string | null;
  /** GH_DASH_MY_EMAILS: commit emails that always count as "me" (lower-cased), on top of settings.myEmails. */
  myEmails: string[];
  /** IANA zone used when the client sends no `tz`. */
  defaultTz: string;
  webDir: string;
  version: string;
}

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 4780);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const dbPath = env.GH_DASH_DB || 'data/gh-dash.db';
  return {
    port,
    host: env.HOST || '127.0.0.1',
    dbPath: dbPath === ':memory:' || isAbsolute(dbPath) ? dbPath : resolve(ROOT_DIR, dbPath),
    syncEnabled: (env.GH_DASH_SYNC ?? 'on').toLowerCase() !== 'off',
    apiKey: optionalEnv(env, 'GH_DASH_API_KEY'),
    password: optionalEnv(env, 'GH_DASH_PASSWORD'),
    myEmails: parseEmailList(env.GH_DASH_MY_EMAILS),
    defaultTz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    webDir: resolve(ROOT_DIR, 'dist/web'),
    version: (JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')) as { version: string }).version,
  };
}

/** Comma-separated list → trimmed, lower-cased, de-duplicated, empties dropped. */
export function parseEmailList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export interface ResolvedToken {
  token: string | null;
  source: TokenSource;
}

/** GITHUB_TOKEN env, else `gh auth token`, else none. The token is only ever held in memory. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): ResolvedToken {
  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return { token: out, source: 'gh-cli' };
  } catch {
    // gh not installed or not logged in
  }
  return { token: null, source: 'none' };
}
