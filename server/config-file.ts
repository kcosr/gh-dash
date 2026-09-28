import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * config.json: instance settings that must be known before the server starts. Each key mirrors an environment
 * variable, which overrides it. Headless servers read $XDG_CONFIG_HOME/gh-dash/config.json (or GH_DASH_CONFIG);
 * the desktop app keeps it in its userData folder and is the only thing that writes it (never over HTTP).
 * UI preferences (sync interval, emails...) stay in the database's settings table.
 */
export const configFileSchema = z.object({
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
});

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
};

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
