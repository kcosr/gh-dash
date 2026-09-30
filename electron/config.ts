/**
 * The desktop app's view of config.json: translates between the Settings form (DesktopConfig / DesktopConfigPatch)
 * and the file (ConfigFile), and validates patches coming over IPC. Pure: no Electron, no file access.
 */
import { dirname, join, posix, resolve, win32 } from 'node:path';
import type { ConfigFile } from '../server/config-file';
import type { DesktopConfig, DesktopConfigPatch } from '../shared/desktop';

/** The server's default PORT. */
export const DEFAULT_PORT = 4780;
export const DB_FILE = 'gh-dash.db';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;
export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host.trim());

export class ConfigInputError extends Error {}

/** config.json → the Settings form. Secrets are reduced to whether they are set. */
export function toDesktopConfig(file: ConfigFile, defaultDataDir: string): DesktopConfig {
  return {
    dataDir: file.db ? dirname(file.db) : defaultDataDir,
    listen: file.listen ?? false,
    // Configs from before the switches: a Local API that is on serves both, tokens required, as it always did.
    restApi: file.restApi ?? true,
    mcp: file.mcp ?? true,
    mcpRequireTokens: file.mcpRequireTokens ?? true,
    network: file.host !== undefined && !isLoopbackHost(file.host),
    port: file.port ?? DEFAULT_PORT,
    allowedHosts: file.allowedHosts ?? [],
    apiKeySet: !!file.apiKey,
    passwordSet: !!file.password,
  };
}

/**
 * Applies a validated patch to config.json's contents. Only the keys the patch names change; hand-edited keys
 * (timezone, tokenFile...) are kept. Refuses a REST API on all interfaces without a password, and MCP without agent
 * tokens while other devices can connect.
 */
export function applyDesktopPatch(file: ConfigFile, patch: DesktopConfigPatch, defaultDataDir: string): ConfigFile {
  const next: ConfigFile = { ...file };
  const current = toDesktopConfig(file, defaultDataDir);
  if (patch.dataDir !== undefined && resolve(patch.dataDir) !== resolve(current.dataDir)) {
    // The cache follows the database (gh-dash-cache.db beside it); the default folder needs no entry at all.
    delete next.cacheDb;
    if (resolve(patch.dataDir) === resolve(defaultDataDir)) delete next.db;
    else next.db = join(resolve(patch.dataDir), DB_FILE);
  }
  if (patch.listen !== undefined) next.listen = patch.listen;
  for (const key of ['restApi', 'mcp', 'mcpRequireTokens'] as const) if (patch[key] !== undefined) next[key] = patch[key];
  if (patch.network !== undefined) next.host = patch.network ? '0.0.0.0' : '127.0.0.1';
  if (patch.port !== undefined) next.port = patch.port;
  if (patch.allowedHosts !== undefined) {
    if (patch.allowedHosts.length) next.allowedHosts = patch.allowedHosts;
    else delete next.allowedHosts;
  }
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === null) delete next.apiKey;
    else next.apiKey = patch.apiKey;
  }
  if (patch.password !== undefined) {
    if (patch.password === null) delete next.password;
    else next.password = patch.password;
  }
  const result = toDesktopConfig(next, defaultDataDir);
  // Other devices reach the port only while it serves the REST API (without it, the server listens on 127.0.0.1).
  const shared = result.network && result.listen && result.restApi;
  if (result.network && !result.passwordSet && (shared || patch.network === true)) {
    throw new ConfigInputError('Set a password before opening the Local API to other devices on the network.');
  }
  if (shared && result.mcp && !result.mcpRequireTokens) {
    throw new ConfigInputError('Agents need their tokens while other devices can connect: keep "Require agent tokens" on.');
  }
  return next;
}

/**
 * "Turn on MCP": the Local API on and its MCP switch on. A Local API that was off comes on for agents alone (its REST
 * API stays off); one that was on keeps its REST API as it was.
 */
export function enableMcpPatch(current: DesktopConfig): DesktopConfigPatch {
  if (!current.listen) return { listen: true, restApi: false, mcp: true };
  return current.mcp ? {} : { mcp: true };
}

// ---------------------------------------------------------------------------
// IPC input validation: the renderer is trusted code, but check shapes and sizes anyway.
// ---------------------------------------------------------------------------

const PATCH_KEYS = new Set<keyof DesktopConfigPatch>(['dataDir', 'listen', 'restApi', 'mcp', 'mcpRequireTokens', 'network', 'port', 'allowedHosts', 'apiKey', 'password']);
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
/** Printable ASCII without spaces: it travels in an Authorization header. */
const API_KEY = /^[\x21-\x7e]{16,256}$/;
export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
const MAX_PATH = 1024;
const MAX_HOSTS = 50;

/** Validates and normalizes an updateConfig argument; throws ConfigInputError with a user-facing message. */
export function parseDesktopPatch(input: unknown, platform: NodeJS.Platform = process.platform): DesktopConfigPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigInputError('Expected a settings object.');
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !PATCH_KEYS.has(k as keyof DesktopConfigPatch));
  if (unknown.length) throw new ConfigInputError(`Unknown setting: ${unknown.join(', ')}`);
  const patch: DesktopConfigPatch = {};
  if (raw.dataDir !== undefined) patch.dataDir = parseDataDir(raw.dataDir, platform);
  for (const key of ['listen', 'restApi', 'mcp', 'mcpRequireTokens', 'network'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new ConfigInputError(`${key} must be true or false.`);
    patch[key] = raw[key];
  }
  if (raw.port !== undefined) {
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      throw new ConfigInputError('The port must be a whole number from 1 to 65535.');
    }
    patch.port = raw.port;
  }
  if (raw.allowedHosts !== undefined) patch.allowedHosts = parseHosts(raw.allowedHosts);
  if (raw.apiKey !== undefined) {
    if (raw.apiKey !== null && (typeof raw.apiKey !== 'string' || !API_KEY.test(raw.apiKey))) {
      throw new ConfigInputError('The API key must be 16 to 256 printable characters without spaces.');
    }
    patch.apiKey = raw.apiKey;
  }
  if (raw.password !== undefined) {
    if (raw.password !== null) {
      if (typeof raw.password !== 'string') throw new ConfigInputError('The password must be text.');
      if (raw.password.length < PASSWORD_MIN || raw.password.length > PASSWORD_MAX) {
        throw new ConfigInputError(`The password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
      }
      if (raw.password.trim() !== raw.password) throw new ConfigInputError('The password must not start or end with a space.');
    }
    patch.password = raw.password;
  }
  return patch;
}

function parseDataDir(value: unknown, platform: NodeJS.Platform): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigInputError('Choose a data folder.');
  const dir = value.trim();
  if (dir.length > MAX_PATH || dir.includes('\0')) throw new ConfigInputError('That data folder path is not valid.');
  // Drive letter or UNC path on Windows (win32.isAbsolute also accepts "\foo", relative to the current drive).
  const absolute = platform === 'win32' ? /^([a-z]:[\\/]|\\\\[^\\])/i.test(dir) : posix.isAbsolute(dir);
  if (!absolute) throw new ConfigInputError('The data folder must be an absolute path.');
  return (platform === 'win32' ? win32 : posix).resolve(dir);
}

function parseHosts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ConfigInputError('Allowed hosts must be a list of host names.');
  if (value.length > MAX_HOSTS) throw new ConfigInputError(`At most ${MAX_HOSTS} allowed hosts.`);
  const hosts = value.map((h) => {
    if (typeof h !== 'string') throw new ConfigInputError('Allowed hosts must be host names.');
    // Same normalization as the server's GH_DASH_ALLOWED_HOSTS: lower case, no port, no trailing dot.
    const host = h.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!HOST_NAME.test(host)) throw new ConfigInputError(`Not a host name: ${h.slice(0, 80)}`);
    return host;
  });
  return [...new Set(hosts)];
}

/** setToken's arguments. GitHub tokens are ASCII without whitespace; anything else is a paste accident. */
export function parseTokenInput(token: unknown, remember: unknown): { token: string; remember: boolean } {
  if (typeof token !== 'string') throw new ConfigInputError('Paste a GitHub token.');
  const value = token.trim();
  if (!value) throw new ConfigInputError('Paste a GitHub token.');
  if (value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) throw new ConfigInputError('That does not look like a GitHub token.');
  if (typeof remember !== 'boolean') throw new ConfigInputError('remember must be true or false.');
  return { token: value, remember };
}

/**
 * An agent token the user chose (addAgent, regenerateAgentToken): undefined = generate one. Checked here and again in
 * the server (server/db/agents.ts agentToken), which also refuses one another agent has.
 */
export function parseAgentTokenInput(token: unknown): string | undefined {
  if (token === undefined || token === null) return undefined;
  if (typeof token !== 'string') throw new ConfigInputError('The token must be text.');
  if (token.length < 24 || token.length > 256) throw new ConfigInputError('A token has 24 to 256 characters.');
  if (!/^[\x21-\x7e]+$/.test(token)) throw new ConfigInputError('A token is printable ASCII without spaces (it goes in an Authorization header).');
  return token;
}
