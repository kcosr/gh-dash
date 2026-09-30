import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { ConfigSource, TokenChoice } from '../shared/api';
import { DESKTOP_ENV } from '../shared/desktop';
import { CONFIG_ENV, type ConfigFile, type LoadedConfigFile, readConfigFile } from './config-file';
import { loadSources, type SourceConfig } from './sources/config';

export type { TokenSource } from '../shared/api';

export type ConfigKey = keyof ConfigFile;

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** Diff cache database (GH_DASH_CACHE_DB); by default next to the main database. */
  cacheDbPath: string;
  syncEnabled: boolean;
  apiKey: string | null;
  password: string | null;
  /** GH_DASH_MY_EMAILS: commit emails that always count as "me" (lower-cased), on top of settings.myEmails. */
  myEmails: string[];
  /** IANA zone used when the client sends no `tz`. */
  defaultTz: string;
  /**
   * GH_DASH_ALLOWED_HOSTS: host names (lower-case, no port) accepted in the Host header besides `localhost`,
   * `*.localhost` and IP literals. Requests with any other Host are refused (DNS rebinding protection).
   */
  allowedHosts: string[];
  webDir: string;
  version: string;
  /** Running as the desktop app's server child (GH_DASH_DESKTOP=1). */
  desktop: boolean;
  /** Run the TCP listener: always for a headless server; the desktop app's "Local API" setting (`listen`). */
  listen: boolean;
  /**
   * What the TCP listener serves: the REST API (/api/*, its docs, the web app, /login) and MCP (/mcp); /api/health
   * always. A headless server serves both. The desktop app's Local API has a switch for each (`restApi`, `mcp`).
   */
  restApi: boolean;
  mcp: boolean;
  /**
   * /mcp requires an agent token (always on a headless server). The desktop app may let a request without one act as
   * the built-in agent "Agent", only while its Local API listens on loopback; otherwise this is forced on.
   */
  mcpRequireTokens: boolean;
  /** GH_DASH_TOKEN_SOURCE: where the GitHub token comes from; null = not chosen yet (the desktop default). */
  tokenChoice: TokenChoice | null;
  /** GITHUB_TOKEN_FILE: a file holding just the token, re-read on use. */
  tokenFile: string | null;
  /** GH_DASH_GH_PATH: the gh executable, when it isn't on PATH or in a standard location. */
  ghPath: string | null;
  /** GH_DASH_GLAB_PATH: the glab executable, when it isn't on PATH or in a standard location. */
  glabPath: string | null;
  /**
   * The GitLab sources: config.json `sources`, and on a headless server the one GH_DASH_GITLAB_URL declares or
   * overrides. github.com is built in (tokenChoice, tokenFile, ghPath). The desktop child's `reload-sources` replaces
   * this and glabPath with a fresh read of config.json.
   */
  sourceConfigs: SourceConfig[];
  /** config.json that was read (whether or not it exists); null when none was. */
  configPath: string | null;
  /** Where each config.json-backed setting came from (for GET /api/v1/instance). */
  sources: Record<ConfigKey, ConfigSource>;
  /** Problems that don't stop the server (unknown config.json keys...), logged at startup. */
  warnings: string[];
}

/**
 * The app root: where package.json and dist/web live. GH_DASH_ROOT_DIR wins (the desktop app sets it, possibly
 * inside app.asar); otherwise the nearest package.json named gh-dash above this module, which works from server/
 * (tsx), from the dist/server/ bundle and inside an asar archive alike.
 */
export function rootDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[DESKTOP_ENV.root]?.trim();
  if (explicit) return resolve(explicit);
  const here = dirname(fileURLToPath(import.meta.url));
  foundRoot ??= findPackageRoot(here);
  if (!foundRoot) throw new Error(`Can't find gh-dash's package.json above ${here}; set ${DESKTOP_ENV.root}`);
  return foundRoot;
}
let foundRoot: string | null | undefined;

/** The nearest directory at or above `start` whose package.json is named gh-dash. */
export function findPackageRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    try {
      if ((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name === 'gh-dash') return dir;
    } catch { /* no package.json here, or not JSON */ }
    if (dirname(dir) === dir) return null;
  }
}

/** XDG paths must be absolute; empty or relative values use the standard home defaults. */
function xdgHome(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value && isAbsolute(value) ? value : join(env.HOME || homedir(), fallback);
}

/** The headless env file ($XDG_CONFIG_HOME/gh-dash/env). */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdgHome(env, 'XDG_CONFIG_HOME', '.config'), 'gh-dash', 'env');
}

/** config.json: GH_DASH_CONFIG (relative paths resolve against the app root), else $XDG_CONFIG_HOME/gh-dash/config.json. */
export function configJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[DESKTOP_ENV.config]?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(rootDir(env), explicit);
  return join(xdgHome(env, 'XDG_CONFIG_HOME', '.config'), 'gh-dash', 'config.json');
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

/**
 * Everything the server reads at startup: the process environment, the env file (headless only; the desktop app
 * never reads it) and config.json. Also returns the merged environment, which the token provider needs
 * (GITHUB_TOKEN may come from the env file; PATH and HOME locate gh).
 */
export function loadServerConfig(processEnv: NodeJS.ProcessEnv = process.env): { config: Config; env: NodeJS.ProcessEnv } {
  const desktop = processEnv[DESKTOP_ENV.desktop] === '1';
  const env = desktop ? processEnv : loadEnvironment(processEnv);
  // The desktop app keeps its own config.json; falling back to the headless one would mix the two.
  if (desktop && !isAbsolute(env[DESKTOP_ENV.config]?.trim() ?? '')) throw new Error(`${DESKTOP_ENV.config} must be an absolute path in the desktop app`);
  const file = readConfigFile(configJsonPath(env));
  const config = loadConfig(env, file);
  if (file.exists && (file.data.password || file.data.apiKey) && process.platform !== 'win32') {
    const mode = statSync(file.path).mode & 0o777;
    if (mode & 0o077) config.warnings.push(`${file.path} holds a password or API key but is readable by others (mode ${mode.toString(8)}); run chmod 600 on it`);
  }
  return { config, env };
}

function defaultTimezone(tz: string | undefined): string {
  if (tz) {
    try {
      return Intl.DateTimeFormat(undefined, { timeZone: tz.replace(/^:/, '') }).resolvedOptions().timeZone;
    } catch { /* POSIX TZ forms and paths are resolved by Node's process timezone instead. */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** gh-dash.db → gh-dash-cache.db in the same directory; an in-memory database gets an in-memory cache. */
export function defaultCachePath(dbPath: string): string {
  if (dbPath === ':memory:') return dbPath;
  const ext = extname(dbPath);
  return join(dirname(dbPath), `${basename(dbPath, ext)}-cache${ext || '.db'}`);
}

const TOKEN_CHOICES: readonly TokenChoice[] = ['auto', 'gh', 'file', 'app'];

/** A loopback listen address: the only kind the desktop app's Local API may use without a password. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Builds the configuration from `env` layered over config.json (`file`): defaults < config.json < env. An environment
 * variable that is set wins even when empty (empty means the default, or "none" for secrets), as it does over the env
 * file. Reads no files except package.json; loadServerConfig does the reading.
 */
export function loadConfig(env: NodeJS.ProcessEnv, file: LoadedConfigFile | null = null): Config {
  const desktop = env[DESKTOP_ENV.desktop] === '1';
  const root = rootDir(env);
  const data: ConfigFile = file?.data ?? {};
  const sources = {} as Record<ConfigKey, ConfigSource>;
  const warnings = (file?.unknownKeys ?? []).map((key) => `${file!.path}: unknown key "${key}" ignored`);

  /** Env (even empty) beats config.json beats the default; records the source before converting, for error messages. */
  function layer<K extends ConfigKey, T>(key: K, fromEnv: (raw: string) => T, fromFile: (value: NonNullable<ConfigFile[K]> | null) => T, fallback: () => T): T {
    const raw = env[CONFIG_ENV[key]];
    if (raw !== undefined) {
      sources[key] = 'env';
      return fromEnv(raw);
    }
    if (data[key] !== undefined) {
      sources[key] = 'file';
      return fromFile(data[key] as NonNullable<ConfigFile[K]> | null);
    }
    sources[key] = 'default';
    return fallback();
  }
  const where = (key: ConfigKey) => (sources[key] === 'file' ? `${key} in ${file!.path}` : CONFIG_ENV[key]);
  // Relative paths resolve against the app root, as they always have; the desktop app only writes absolute ones.
  const path = (key: ConfigKey, value: string) => {
    if (value === ':memory:' || isAbsolute(value)) return value;
    if (desktop) throw new Error(`${where(key)} must be an absolute path: ${value}`);
    return resolve(root, value);
  };
  const defaultDb = () => {
    if (!desktop) return join(xdgHome(env, 'XDG_STATE_HOME', '.local/state'), 'gh-dash', 'gh-dash.db');
    const dir = env[DESKTOP_ENV.dataDir]?.trim();
    if (!dir || !isAbsolute(dir)) throw new Error(`${DESKTOP_ENV.dataDir} must be an absolute path when no database path is configured`);
    return join(dir, 'gh-dash.db');
  };

  const port = layer('port', (raw) => Number(raw), (v) => v ?? 4780, () => 4780);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const host = layer('host', (raw) => raw || '127.0.0.1', (v) => v ?? '127.0.0.1', () => '127.0.0.1');
  const dbPath = layer('db', (raw) => (raw ? path('db', raw) : defaultDb()), (v) => (v ? path('db', v) : defaultDb()), defaultDb);
  const cacheDbPath = layer(
    'cacheDb',
    (raw) => (raw ? path('cacheDb', raw) : defaultCachePath(dbPath)),
    (v) => (v ? path('cacheDb', v) : defaultCachePath(dbPath)),
    () => defaultCachePath(dbPath),
  );
  if (cacheDbPath === dbPath && dbPath !== ':memory:') throw new Error('GH_DASH_CACHE_DB must not be the main database (GH_DASH_DB)');
  const secret = (key: 'password' | 'apiKey') => layer(key, (raw) => raw.trim() || null, (v) => v, () => null);
  const tokenChoice = layer('tokenSource', (raw) => parseTokenChoice(raw, desktop), (v) => v, () => (desktop ? null : 'auto'));
  const tokenFile = layer('tokenFile', (raw) => (raw.trim() ? path('tokenFile', raw.trim()) : null), (v) => (v ? path('tokenFile', v) : null), () => null);
  const ghPath = layer('ghPath', (raw) => raw.trim() || null, (v) => v, () => null);
  if (ghPath && desktop && !isAbsolute(ghPath)) throw new Error(`${where('ghPath')} must be an absolute path: ${ghPath}`);
  const gitlab = loadSources(env, file);
  sources.glabPath = gitlab.from.glabPath;
  sources.sources = gitlab.from.sources;
  warnings.push(...gitlab.warnings);
  const listenSetting = layer('listen', (raw) => parseSwitch(raw, CONFIG_ENV.listen), (v) => !!v, () => false);
  if (!desktop && sources.listen !== 'default' && !listenSetting) warnings.push(`${where('listen')} is ignored: a headless server always listens`);
  // The desktop app's Local API switches: what its port serves. A headless server serves everything, tokens required.
  const onSwitch = (key: 'restApi' | 'mcp' | 'mcpRequireTokens') => layer(key, (raw) => parseSwitch(raw, CONFIG_ENV[key]), (v) => v !== false, () => true);
  const restApi = onSwitch('restApi');
  const mcp = onSwitch('mcp');
  let mcpRequireTokens = onSwitch('mcpRequireTokens');
  if (!desktop) {
    for (const key of ['restApi', 'mcp', 'mcpRequireTokens'] as const) {
      if (sources[key] !== 'default') warnings.push(`${where(key)} is ignored: it is the desktop app's; a headless server serves the REST API and MCP, with agent tokens`);
    }
  }
  const password = secret('password');
  // Without the REST API the desktop's port serves agents alone, on this computer only: host and its password are the REST API's.
  const effectiveHost = desktop && listenSetting && !restApi ? '127.0.0.1' : host;
  if (desktop && listenSetting && mcp && !mcpRequireTokens && !isLoopbackHost(effectiveHost)) {
    mcpRequireTokens = true;
    warnings.push(`${where('mcpRequireTokens')} is off, but the Local API listens on ${effectiveHost} (beyond this computer): agents need their tokens`);
  }

  const config: Config = {
    port,
    host: effectiveHost,
    dbPath,
    cacheDbPath,
    syncEnabled: layer('sync', (raw) => raw.toLowerCase() !== 'off', (v) => v ?? true, () => true),
    apiKey: secret('apiKey'),
    password,
    myEmails: layer('myEmails', (raw) => parseEmailList(raw), (v) => parseEmailList(v?.join(',')), () => []),
    defaultTz: layer('timezone', (raw) => defaultTimezone(raw), (v) => fileTimezone(v, warnings), () => defaultTimezone(undefined)),
    allowedHosts: layer('allowedHosts', (raw) => parseHostList(raw), (v) => parseHostList(v?.join(',')), () => []),
    webDir: resolve(root, 'dist/web'),
    version: packageVersion(root),
    desktop,
    listen: desktop ? listenSetting : true,
    restApi: desktop ? restApi : true,
    mcp: desktop ? mcp : true,
    mcpRequireTokens: desktop ? mcpRequireTokens : true,
    tokenChoice,
    tokenFile,
    ghPath,
    glabPath: gitlab.glabPath,
    sourceConfigs: gitlab.sources,
    configPath: file?.path ?? null,
    sources,
    warnings,
  };
  if (desktop && config.listen && !password && !isLoopbackHost(config.host)) {
    throw new Error(`The Local API can listen on ${host} (beyond this computer) only with a password; set one, or listen on 127.0.0.1`);
  }
  return config;
}

function packageVersion(root: string): string {
  const path = resolve(root, 'package.json');
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
  } catch (error) {
    throw new Error(`Can't read the app's ${path} (${(error as Error).message}); check ${DESKTOP_ENV.root}`);
  }
}

function fileTimezone(value: string | null, warnings: string[]): string {
  const tz = defaultTimezone(value ?? undefined);
  if (value && tz !== value) warnings.push(`timezone "${value}" is not an IANA time zone; using ${tz}`);
  return tz;
}

/** GH_DASH_TOKEN_SOURCE: one of the choices; empty means the default. */
function parseTokenChoice(raw: string, desktop: boolean): TokenChoice | null {
  const value = raw.trim().toLowerCase();
  if (!value) return desktop ? null : 'auto';
  if (!(TOKEN_CHOICES as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${CONFIG_ENV.tokenSource}: ${raw} (expected ${TOKEN_CHOICES.join(', ')})`);
  }
  return value as TokenChoice;
}

function parseSwitch(raw: string, name: string): boolean {
  const value = raw.trim().toLowerCase();
  if (['', 'off', 'false', '0', 'no'].includes(value)) return false;
  if (['on', 'true', '1', 'yes'].includes(value)) return true;
  throw new Error(`Invalid ${name}: ${raw} (expected on or off)`);
}

/** Comma-separated list → trimmed, lower-cased, de-duplicated, empties dropped. */
export function parseEmailList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/** Comma-separated host names → lower-cased, ports and trailing dots dropped, de-duplicated. */
export function parseHostList(value: string | undefined): string[] {
  const hosts = (value ?? '').split(',').map((h) => h.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')).filter(Boolean);
  return [...new Set(hosts)];
}
