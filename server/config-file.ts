import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { GITHUB_HOST } from '../shared/api';
import { envKey } from './credentials/cli';
import { normalizeBaseUrl } from './gitlab/transport';

/** An environment variable's name, as a source's tokenEnv. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A GitLab source's base URL (normalizeBaseUrl: no trailing slash, relative root kept) and its identity: the URL's
 * lower-case host name, without the port. Refuses what can't be an identity (an IPv6 literal, a trailing dot), since
 * the host prefixes repo keys and names the desktop app's keychain file.
 */
export function sourceUrl(raw: string): { baseUrl: string; host: string } {
  const baseUrl = normalizeBaseUrl(raw);
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error(`GitLab URL's host must be a host name (letters, digits, dots and dashes): ${host}`);
  return { baseUrl, host };
}

/**
 * One GitLab instance (design §3.2). github.com is built in and configured by the top-level tokenSource, tokenFile and
 * ghPath. The URL's host is the source's identity; its credential method and reference stay here (and in env), never
 * in the database.
 */
export const sourceConfigSchema = z.object({
  kind: z.literal('gitlab'),
  /** The instance URL, with any relative root: https://gitlab.example.com, https://example.com/gitlab. */
  url: z.string().trim().min(1),
  /** How its token is found: glab, a token file, or the desktop app's. null = not chosen yet (desktop). */
  tokenSource: z.enum(['glab', 'file', 'app']).nullable().optional(),
  /** With `file`: an absolute path to a file holding just the token; re-read on use. */
  tokenFile: z.string().trim().min(1).nullable().optional(),
  /**
   * The variable that, when set, is the token and locks the method. Default on a headless server: GITLAB_TOKEN when
   * this is the only GitLab source (or the one GH_DASH_GITLAB_URL names); with several, none. The desktop app has no
   * default: it names GITLAB_TOKEN here only after asking.
   */
  tokenEnv: z.string().trim().regex(ENV_NAME, 'must be an environment variable name').nullable().optional(),
});

export type SourceConfigEntry = z.infer<typeof sourceConfigSchema>;

/** Per entry: a URL that parses, an absolute token file, and a tokenEnv that can't hand another secret to GitLab. */
function checkSourceEntry(entry: SourceConfigEntry, ctx: z.RefinementCtx, i: number): string | null {
  const issue = (key: keyof SourceConfigEntry, message: string) => ctx.addIssue({ code: 'custom', path: ['sources', i, key], message });
  let host: string | null = null;
  try {
    host = sourceUrl(entry.url).host;
  } catch (err) {
    issue('url', (err as Error).message);
  }
  if (host === GITHUB_HOST) issue('url', `${GITHUB_HOST} is built in; configure it with tokenSource`);
  if (entry.tokenFile && !isAbsolute(entry.tokenFile)) issue('tokenFile', `must be an absolute path: ${entry.tokenFile}`);
  const env = entry.tokenEnv?.trim();
  if (env && (env.toUpperCase() === 'GITHUB_TOKEN' || env.toUpperCase().startsWith('GH_DASH_'))) {
    issue('tokenEnv', `${env} holds another secret; name a variable for this source's token`);
  }
  return host === GITHUB_HOST ? null : host;
}

/**
 * config.json's keys: instance settings that must be known before the server starts. Each key mirrors an environment
 * variable, which overrides it. Headless servers read $XDG_CONFIG_HOME/gh-dash/config.json (or GH_DASH_CONFIG);
 * the desktop app keeps it in its userData folder and is the only thing that writes it (never over HTTP).
 * UI preferences (sync interval, emails...) stay in the database's settings table.
 */
const configFileKeys = z.object({
  /** HOST. Listen address for the TCP listener. */
  host: z.string().trim().min(1).optional(),
  /** PORT. */
  port: z.number().int().min(1).max(65535).optional(),
  /** GH_DASH_ALLOWED_HOSTS (comma-separated). Host names accepted besides loopback names and IP literals. */
  allowedHosts: z.array(z.string().trim().min(1)).optional(),
  /** GH_DASH_DB. Absolute path. */
  db: z.string().trim().min(1).optional(),
  /** GH_DASH_CACHE_DB. Absolute path. */
  cacheDb: z.string().trim().min(1).optional(),
  /** GH_DASH_SYNC (on/off). */
  sync: z.boolean().optional(),
  /** GH_DASH_PASSWORD. null = none. */
  password: z.string().min(1).nullable().optional(),
  /** GH_DASH_API_KEY. null = none. */
  apiKey: z.string().min(1).nullable().optional(),
  /** GH_DASH_MY_EMAILS. */
  myEmails: z.array(z.string().trim().min(1)).optional(),
  /** TZ: default timezone for API date grouping. */
  timezone: z.string().trim().min(1).optional(),
  /** GH_DASH_TOKEN_SOURCE. null = not chosen (desktop first run). */
  tokenSource: z.enum(['auto', 'gh', 'file', 'app']).nullable().optional(),
  /** GITHUB_TOKEN_FILE. A file the user owns holding just the token; re-read on use. */
  tokenFile: z.string().trim().min(1).nullable().optional(),
  /** GH_DASH_GH_PATH. The gh executable, when it isn't on PATH or in a standard location. */
  ghPath: z.string().trim().min(1).nullable().optional(),
  /** Desktop only: also listen on TCP (the "Local API"). Headless servers always listen. */
  listen: z.boolean().optional(),
  /**
   * Desktop only, with `listen`: serve the REST API (/api/*, its docs, the web app, /login) on the Local API's port.
   * Default true (as before it could be turned off). Off: that port answers 404 there, and listens on 127.0.0.1 only
   * (host, allowedHosts, password and apiKey are the REST API's). A headless server always serves it.
   */
  restApi: z.boolean().optional(),
  /** Desktop only, with `listen`: serve MCP (/mcp) for agents on the Local API's port. Default true. Headless: always. */
  mcp: z.boolean().optional(),
  /**
   * Desktop only: /mcp requires an agent's token (default true). false: a request without one acts as the built-in
   * agent "Agent" (one that sends a token still needs a valid one); only while the port listens on 127.0.0.1.
   */
  mcpRequireTokens: z.boolean().optional(),
  /** GH_DASH_GLAB_PATH. The glab executable, when it isn't on PATH or in a standard location. */
  glabPath: z.string().trim().min(1).nullable().optional(),
  /**
   * GitLab instances besides github.com. GH_DASH_GITLAB_URL declares (or overrides) one on a headless server. Hosts
   * are unique, and so are tokenEnv names.
   */
  sources: z.array(sourceConfigSchema).optional(),
});

/**
 * config.json as validated on `platform`: its keys, and sources whose hosts are unique and whose tokenEnv names are
 * too, as the platform tells names apart (on Windows, TEAM_TOKEN and team_token are one variable, which credential
 * resolution would hand both sources).
 */
export function configFileSchemaFor(platform: NodeJS.Platform) {
  return configFileKeys.superRefine((data, ctx) => {
    const hosts = new Map<string, number>();
    const envs = new Map<string, { i: number; name: string }>();
    (data.sources ?? []).forEach((entry, i) => {
      const host = checkSourceEntry(entry, ctx, i);
      if (host !== null && hosts.has(host)) ctx.addIssue({ code: 'custom', path: ['sources', i, 'url'], message: `${host} is already sources[${hosts.get(host)}]` });
      else if (host !== null) hosts.set(host, i);
      const env = entry.tokenEnv?.trim();
      const other = env ? envs.get(envKey(env, platform)) : undefined;
      if (env && other) {
        const same = other.name === env ? '' : ` (${other.name}: Windows doesn't tell them apart)`;
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'tokenEnv'], message: `${env} is already sources[${other.i}]'s tokenEnv${same}` });
      } else if (env) envs.set(envKey(env, platform), { i, name: env });
    });
  });
}

/** config.json, as this platform validates it. */
export const configFileSchema = configFileSchemaFor(process.platform);

export type ConfigFile = z.infer<typeof configFileSchema>;

/** Environment variable for each config.json key (env wins over the file). */
export const CONFIG_ENV: Record<keyof ConfigFile, string> = {
  host: 'HOST',
  port: 'PORT',
  allowedHosts: 'GH_DASH_ALLOWED_HOSTS',
  db: 'GH_DASH_DB',
  cacheDb: 'GH_DASH_CACHE_DB',
  sync: 'GH_DASH_SYNC',
  password: 'GH_DASH_PASSWORD',
  apiKey: 'GH_DASH_API_KEY',
  myEmails: 'GH_DASH_MY_EMAILS',
  timezone: 'TZ',
  tokenSource: 'GH_DASH_TOKEN_SOURCE',
  tokenFile: 'GITHUB_TOKEN_FILE',
  ghPath: 'GH_DASH_GH_PATH',
  listen: 'GH_DASH_LISTEN',
  restApi: 'GH_DASH_REST_API',
  mcp: 'GH_DASH_MCP',
  mcpRequireTokens: 'GH_DASH_MCP_REQUIRE_TOKENS',
  glabPath: 'GH_DASH_GLAB_PATH',
  // Declares or overrides one source; GITLAB_TOKEN_FILE and GH_DASH_GITLAB_TOKEN_SOURCE go with it (headless only).
  sources: 'GH_DASH_GITLAB_URL',
};

/** The rest of the headless env declaration of a GitLab source (server/sources/config.ts). */
export const GITLAB_ENV = {
  url: CONFIG_ENV.sources,
  tokenFile: 'GITLAB_TOKEN_FILE',
  tokenSource: 'GH_DASH_GITLAB_TOKEN_SOURCE',
} as const;

export interface LoadedConfigFile {
  path: string;
  exists: boolean;
  data: ConfigFile;
  /** Unknown keys that were ignored. */
  unknownKeys: string[];
}

/** Reads and validates config.json. A missing file is an empty config; invalid JSON or values throw with the path. */
export function readConfigFile(path: string): LoadedConfigFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false, data: {}, unknownKeys: [] };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${(error as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: expected a JSON object`);
  const known = new Set(Object.keys(configFileSchema.shape));
  const unknownKeys = Object.keys(raw).filter((k) => !known.has(k));
  const entries = (raw as { sources?: unknown }).sources;
  if (Array.isArray(entries)) {
    const knownInSource = new Set(Object.keys(sourceConfigSchema.shape));
    entries.forEach((entry, i) => {
      if (entry && typeof entry === 'object') for (const k of Object.keys(entry)) if (!knownInSource.has(k)) unknownKeys.push(`sources[${i}].${k}`);
    });
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${path}: ${issues}`);
  }
  return { path, exists: true, data: parsed.data, unknownKeys };
}

/**
 * Writes config.json atomically (temp file + rename) with mode 0600: it can hold the API key and password.
 * Keys whose value is undefined are dropped. Validates first, so a bad patch never reaches the disk.
 */
export function writeConfigFile(path: string, data: ConfigFile): void {
  const clean = configFileSchema.parse(data);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
