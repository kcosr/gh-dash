import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

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

/** XDG paths must be absolute; empty or relative values use the standard home defaults. */
function xdgHome(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value && isAbsolute(value) ? value : join(env.HOME || homedir(), fallback);
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdgHome(env, 'XDG_CONFIG_HOME', '.config'), 'gh-dash', 'env');
}

/** Optional dotenv-style config. Process variables (including empty values) take precedence. */
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let file: NodeJS.ProcessEnv;
  try {
    file = parseEnv(readFileSync(configFilePath(env), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    file = {};
  }
  const explicit = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  return { ...file, ...explicit };
}

function defaultTimezone(tz: string | undefined): string {
  if (tz) {
    try {
      return Intl.DateTimeFormat(undefined, { timeZone: tz.replace(/^:/, '') }).resolvedOptions().timeZone;
    } catch { /* POSIX TZ forms and paths are resolved by Node's process timezone instead. */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function loadConfig(env: NodeJS.ProcessEnv = loadEnvironment()): Config {
  const port = Number(env.PORT ?? 4780);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const dbPath = env.GH_DASH_DB || join(xdgHome(env, 'XDG_STATE_HOME', '.local/state'), 'gh-dash', 'gh-dash.db');
  return {
    port,
    host: env.HOST || '127.0.0.1',
    dbPath: dbPath === ':memory:' || isAbsolute(dbPath) ? dbPath : resolve(ROOT_DIR, dbPath),
    syncEnabled: (env.GH_DASH_SYNC ?? 'on').toLowerCase() !== 'off',
    apiKey: optionalEnv(env, 'GH_DASH_API_KEY'),
    password: optionalEnv(env, 'GH_DASH_PASSWORD'),
    myEmails: parseEmailList(env.GH_DASH_MY_EMAILS),
    defaultTz: defaultTimezone(env.TZ),
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
    const out = execFileSync('gh', ['auth', 'token'], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return { token: out, source: 'gh-cli' };
  } catch {
    // gh not installed or not logged in
  }
  return { token: null, source: 'none' };
}
