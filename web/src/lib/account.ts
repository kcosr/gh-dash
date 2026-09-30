/**
 * Pure helpers for the GitHub account and instance UI (Settings, the no-token card, API links).
 * Kept free of React so they're unit-tested (shared/account-view.test.ts).
 */
import type { AccountStatus, ConfigSource, InstanceInfo, TokenKind, TokenSource } from '../../../shared/api';
import { EXPIRY_WARN_DAYS } from '../../../shared/credentials';
import type { DesktopConfig, DesktopConfigPatch } from '../../../shared/desktop';
import { DAY, dayDiff, fmtDateY } from './time';

/** Shown wherever an API link or URL is unavailable because nothing listens on the network. */
export const API_OFF_HINT = 'Turn on the Local API in Settings';

/** Where the server's token comes from, in words. */
export function tokenSourceLabel(source: TokenSource, opts: { desktop?: boolean; remembered?: boolean; chosen?: boolean } = {}): string {
  switch (source) {
    case 'env': return opts.desktop ? 'GITHUB_TOKEN environment variable' : 'GITHUB_TOKEN (environment or env file)';
    case 'file': return 'Token file';
    case 'gh-cli': return 'GitHub CLI (gh auth token)';
    case 'glab': return 'GitLab CLI (glab)';
    case 'app': return opts.remembered ? 'Pasted token, saved in the OS keychain' : 'Pasted token, kept until gh-dash quits';
    case 'none': return opts.desktop && opts.chosen === false ? 'Not connected' : 'No token found';
  }
}

export function tokenKindLabel(kind: TokenKind): string {
  switch (kind) {
    case 'fine-grained': return 'Fine-grained personal access token';
    case 'classic': return 'Classic personal access token';
    case 'oauth': return 'OAuth token';
    case 'app': return 'GitHub App token';
    case 'personal': return 'Personal access token';
    case 'unknown': return 'Token';
  }
}

/**
 * What a classic or OAuth token (gh's kind) may do, from its scopes. `repo` is full read/write access to every
 * repository; without it only public repositories are readable. Fine-grained tokens report no scopes: their
 * permissions were picked on GitHub, so nothing is claimed.
 */
export function tokenAccess(scopes: string[] | null): 'full' | 'public' | null {
  if (!scopes) return null;
  return scopes.includes('repo') ? 'full' : 'public';
}

/** Tokens that expire when GitHub says nothing (personal access tokens have an expiry unless created without one). */
const PAT_KINDS: ReadonlySet<TokenKind> = new Set(['fine-grained', 'classic', 'personal']);
export { EXPIRY_WARN_DAYS };

/**
 * The token's expiry for display: "expires Oct 3, 2026" (warn within 14 days, with "in 5 days"), "expired …",
 * "never expires" for a personal access token without one; null when unknown or not applicable (gh's OAuth token).
 */
export function tokenExpiry(expiresAt: string | null, kind: TokenKind | null, now = Date.now()): { text: string; warn: boolean } | null {
  if (!expiresAt) return kind && PAT_KINDS.has(kind) ? { text: 'never expires', warn: false } : null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  const left = t - now;
  if (left <= 0) return { text: `expired ${fmtDateY(t)}`, warn: true };
  if (left > EXPIRY_WARN_DAYS * DAY) return { text: `expires ${fmtDateY(t)}`, warn: false };
  const days = dayDiff(new Date(now), new Date(t));
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return { text: `expires ${when} (${fmtDateY(t)})`, warn: true };
}

/** Why the "Use GitHub CLI" button is unavailable, or null when it can be used. */
export function ghUnavailable(a: Pick<AccountStatus, 'gh' | 'locked'>): string | null {
  if (a.locked) return 'GITHUB_TOKEN is set, so it is always used';
  if (!a.gh.available) return 'GitHub CLI (gh) not found';
  return null;
}

/** An absolute API link: base "http://127.0.0.1:4780" + path "/api/docs". null when there's no base. */
export function apiLink(base: string | null, path: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Base URL for API links (docs, curl, copied URLs). The server's answer wins; until it arrives a browser tab
 * is served by the API itself (its origin), while the desktop app has no URL of its own (app://).
 */
export function resolveApiBase(instance: Pick<InstanceInfo, 'apiUrl'> | undefined, desktop: boolean, origin: string): string | null {
  if (instance) return instance.apiUrl;
  return desktop ? null : origin;
}

/** The InstanceInfo settings that are one value with the place it came from (all but the list of GitLab sources). */
export type SettingKey = Exclude<keyof InstanceInfo['settings'], 'sources'>;

/** Environment variable behind each InstanceInfo setting (the env overrides config.json). */
export const SETTING_ENV: Record<SettingKey, string> = {
  host: 'HOST',
  port: 'PORT',
  dbPath: 'GH_DASH_DB',
  cacheDbPath: 'GH_DASH_CACHE_DB',
  sync: 'GH_DASH_SYNC',
  allowedHosts: 'GH_DASH_ALLOWED_HOSTS',
  tokenFile: 'GITHUB_TOKEN_FILE',
  defaultTz: 'TZ',
  glabPath: 'GH_DASH_GLAB_PATH',
};

/** "default", "config.json", or the environment variable that set it. */
export function settingSource(key: SettingKey, source: ConfigSource): string {
  return source === 'default' ? 'default' : source === 'file' ? 'config.json' : SETTING_ENV[key];
}

export function authLabel(auth: InstanceInfo['auth']): string {
  if (auth.password && auth.apiKey) return 'Password, and an API key for scripts';
  if (auth.password) return 'Password';
  if (auth.apiKey) return 'API key only (the dashboard itself has no password)';
  return 'None';
}

/** Electron wraps errors thrown in main: "Error invoking remote method 'gh-dash:set-token': Error: Bad credentials". */
export function bridgeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Z]\w*)?Error:\s*/, '') || 'Something went wrong';
}

// ---------------------------------------------------------------------------------------------- desktop instance

/** The editable instance settings in the desktop app. Secrets: undefined = unchanged, null = clear, string = new. */
export interface InstanceForm {
  dataDir: string;
  listen: boolean;
  restApi: boolean;
  mcp: boolean;
  mcpRequireTokens: boolean;
  network: boolean;
  port: number;
  allowedHosts: string[];
  apiKey?: string | null;
  password?: string | null;
}

export const instanceForm = (c: DesktopConfig): InstanceForm => ({
  dataDir: c.dataDir, listen: c.listen, restApi: c.restApi, mcp: c.mcp, mcpRequireTokens: c.mcpRequireTokens, network: c.network, port: c.port,
  allowedHosts: c.allowedHosts,
});

/** Other devices reach the port: it listens beyond this computer, which it does only while serving the REST API. */
export const reachesNetwork = (f: Pick<InstanceForm, 'listen' | 'restApi' | 'network'>) => f.listen && f.restApi && f.network;

/**
 * Whether MCP may do without agent tokens: only while the port serves this computer alone (the server requires them
 * otherwise, whatever the setting). The reason when not, for the switch.
 */
export const tokensOptionalProblem = (f: Pick<InstanceForm, 'listen' | 'restApi' | 'network'>): string | null =>
  reachesNetwork(f) ? 'Other devices can connect: agents need their tokens.' : null;

/** Only what changed, for DesktopBridge.updateConfig. */
export function instancePatch(c: DesktopConfig, f: InstanceForm): DesktopConfigPatch {
  const p: DesktopConfigPatch = {};
  if (f.dataDir !== c.dataDir) p.dataDir = f.dataDir;
  if (f.listen !== c.listen) p.listen = f.listen;
  if (f.restApi !== c.restApi) p.restApi = f.restApi;
  if (f.mcp !== c.mcp) p.mcp = f.mcp;
  if (f.mcpRequireTokens !== c.mcpRequireTokens) p.mcpRequireTokens = f.mcpRequireTokens;
  if (f.network !== c.network) p.network = f.network;
  if (f.port !== c.port) p.port = f.port;
  if (f.allowedHosts.join(',') !== c.allowedHosts.join(',')) p.allowedHosts = f.allowedHosts;
  if (f.apiKey !== undefined && !(f.apiKey === null && !c.apiKeySet)) p.apiKey = f.apiKey;
  if (f.password !== undefined && !(f.password === null && !c.passwordSet)) p.password = f.password;
  return p;
}

/** Whether a password will be set after saving. */
export const willHavePassword = (c: DesktopConfig, f: InstanceForm) => (f.password === undefined ? c.passwordSet : !!f.password);

/** Same limits the desktop app's main process enforces (electron/config.ts). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

/** What's wrong with the form, per field; empty when it can be saved. */
export function instanceProblems(
  c: DesktopConfig,
  f: InstanceForm,
): { port?: string; network?: string; dataDir?: string; password?: string } {
  const out: { port?: string; network?: string; dataDir?: string; password?: string } = {};
  if (!f.dataDir.trim()) out.dataDir = 'Choose a data folder.';
  if (f.listen && (!Number.isInteger(f.port) || f.port < 1 || f.port > 65535)) out.port = 'A port from 1 to 65535.';
  if (reachesNetwork(f) && !willHavePassword(c, f)) out.network = 'Set a password to allow other devices.';
  if (f.mcp && !f.mcpRequireTokens && tokensOptionalProblem(f)) out.network ??= 'Agents need their tokens while other devices can connect.';
  if (typeof f.password === 'string') {
    if (f.password.length < PASSWORD_MIN || f.password.length > PASSWORD_MAX) out.password = `${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`;
    else if (f.password.trim() !== f.password) out.password = 'No spaces at the start or end.';
  }
  return out;
}

/** Host names as the server compares them: lower-case, no port, no trailing dot. Invalid entries are dropped. */
export function parseHosts(text: string): string[] {
  return text.split(/[\s,;]+/)
    .map((h) => h.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, ''))
    .filter((h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h));
}
