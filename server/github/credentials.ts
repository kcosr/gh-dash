// GitHub's CredentialSpec: GITHUB_TOKEN, gh, and validation against github.com's GraphQL API (1 point).

import type { TokenKind } from '../../shared/api';
import { cliEnv, type ExecError, firstLine, homeDir } from '../credentials/cli';
import { EMPTY_CHECK, HEADER_SAFE, none } from '../credentials/provider';
import type { CliIo, CliSpec, CredentialSpec, TokenCheck } from '../credentials/types';
import { redact } from '../provider/transport';

/** gh can wait on a keyring prompt (it gives up after 60 s itself). */
const GH_TIMEOUT_MS = 60_000;
/** An expiry closer than this on a token that works is a GitHub glitch (it once reported "now + 1 minute"). */
const EXPIRY_SANITY_MS = 5 * 60_000;
const GRAPHQL = 'https://api.github.com/graphql';

const VIEWER_CHECK = `query {
  viewer {
    id login name avatarUrl
    repos: repositories(ownerAffiliations: OWNER, first: 1) { totalCount }
    privateRepos: repositories(ownerAffiliations: OWNER, privacy: PRIVATE, first: 1) { totalCount }
  }
}`;
interface ViewerCheckData {
  viewer?: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    repos: { totalCount: number } | null;
    privateRepos: { totalCount: number } | null;
  } | null;
}

/** Token kind from its prefix (GitHub's own table); the length isn't checked. */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('gho_')) return 'oauth';
  if (token.startsWith('ghu_') || token.startsWith('ghs_')) return 'app';
  return 'unknown';
}

/**
 * GitHub-Authentication-Token-Expiration: "2027-09-06 12:00:00 UTC", or with an offset ("2025-09-10 02:30:13 +0200").
 * null when absent, unparseable, or implausibly close for a token that just worked.
 */
export function parseTokenExpiration(value: string | null, now: number): string | null {
  const m = value?.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone && /^[+-]/.test(zone)) {
    const digits = zone.replace(':', '');
    ms -= (zone.startsWith('-') ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5))) * 60_000;
  }
  if (!Number.isFinite(ms) || ms - now < EXPIRY_SANITY_MS) return null;
  return new Date(ms).toISOString();
}

/** X-OAuth-Scopes: "repo, read:org" → ['repo', 'read:org']; null when the header is absent. */
function parseScopes(value: string | null): string[] | null {
  if (value === null) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The active login for `host` in gh's hosts.yml (`<host>: { user: <login> }`), without a YAML parser or an API call.
 * The file may hold a plain-text oauth_token: nothing but `user` is ever read out of it.
 */
export function ghLoginFromHosts(yaml: string, host = 'github.com'): string | null {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1/, '$2').trimEnd() === `${host}:`);
  if (start < 0) return null;
  let indent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const n = line.length - line.trimStart().length;
    if (n === 0) break;
    indent ??= n;
    if (n !== indent) continue;
    const m = line.trim().match(/^user:\s*(.*)$/);
    if (m) return m[1]!.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2') || null;
  }
  return null;
}

/** gh's active github.com login from hosts.yml; null when unknown. */
async function ghLogin(io: CliIo): Promise<string | null> {
  const j = io.path.join;
  const dir =
    io.envVar('GH_CONFIG_DIR') ||
    (io.envVar('XDG_CONFIG_HOME') ? j(io.envVar('XDG_CONFIG_HOME')!, 'gh') : null) ||
    (io.win && io.envVar('AppData') ? j(io.envVar('AppData')!, 'GitHub CLI') : null) ||
    j(homeDir(io), '.config', 'gh');
  try {
    return ghLoginFromHosts(await io.fs.readFile(j(dir, 'hosts.yml'), 'utf8'));
  } catch {
    return null;
  }
}

/** `gh auth token --hostname github.com`, without GH_TOKEN / GITHUB_TOKEN (with those set, gh just prints them back). */
function ghCli(ghPath: string | null): CliSpec {
  return {
    name: 'gh',
    choice: 'gh',
    source: 'gh-cli',
    path: ghPath,
    pathSetting: 'ghPath',
    windowsFolder: 'GitHub CLI',
    notFound: 'GitHub CLI (gh) not found: install it, or set its location (ghPath)',
    inAuto: true,
    login: ghLogin,
    async token(path, io) {
      const env = cliEnv(io.env, io.win, ['GH_TOKEN', 'GITHUB_TOKEN'], { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' });
      try {
        // --hostname: GH_HOST may point gh at an Enterprise server; gh-dash only talks to github.com.
        const { stdout } = await io.exec(path, ['auth', 'token', '--hostname', 'github.com'], { env, timeout: GH_TIMEOUT_MS });
        const token = stdout.trim();
        if (!token) return none('gh auth token printed no token');
        if (!HEADER_SAFE.test(token)) return none('gh auth token printed something other than a token');
        return { token, source: 'gh-cli', error: null };
      } catch (err) {
        return none(ghError(err as ExecError, path));
      }
    },
  };
}

function ghError(e: ExecError, path: string): string {
  if (e.code === 'ENOENT' || e.code === 'EACCES') return `Couldn't run gh at ${path} (${e.code})`;
  if (e.killed || e.signal === 'SIGTERM') return `gh auth token timed out after ${GH_TIMEOUT_MS / 1000} s (is it waiting for a keyring prompt?)`;
  if (/no oauth token/i.test((e.stderr ?? '').trim().split('\n')[0]!)) return 'gh is not logged in to github.com: run `gh auth login`';
  return `gh auth token failed: ${firstLine(e)}`;
}

/** Who the token is for, its repos, expiry and scopes: 1 GraphQL point. Never rejects. */
async function fetchViewer(token: string, signal: AbortSignal, fetchImpl: typeof fetch, now: () => number): Promise<TokenCheck> {
  const fail = (error: string): TokenCheck => ({ ...EMPTY_CHECK, error: redact(token, error) });
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(GRAPHQL, {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gh-dash' },
      body: JSON.stringify({ query: VIEWER_CHECK }),
      signal,
    });
    text = await res.text();
  } catch (err) {
    return fail(`Couldn't reach GitHub: ${(err as Error).message}`);
  }
  if (res.status === 401) return fail('Bad credentials');
  let body: { data?: ViewerCheckData | null; errors?: { message: string }[]; message?: string };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(res.ok ? 'Invalid response from GitHub' : `GitHub returned ${res.status}`);
  }
  if (!res.ok) return fail(`GitHub returned ${res.status}${body.message ? `: ${body.message}` : ''}`);
  const viewer = body.data?.viewer;
  if (!viewer) return fail(body.errors?.map((e) => e.message).join('; ') || 'GitHub returned no account for this token');
  return {
    ...EMPTY_CHECK,
    ok: true,
    id: viewer.id,
    login: viewer.login,
    name: viewer.name ?? null,
    avatarUrl: viewer.avatarUrl ?? null,
    expiresAt: parseTokenExpiration(res.headers.get('github-authentication-token-expiration'), now()),
    scopes: tokenKind(token) === 'fine-grained' ? null : parseScopes(res.headers.get('x-oauth-scopes')),
    repos: viewer.repos && viewer.privateRepos ? { total: viewer.repos.totalCount, private: viewer.privateRepos.totalCount } : null,
  };
}

export interface GitHubCredentialOptions {
  /** GH_DASH_GH_PATH / ghPath: the gh executable, when it isn't on PATH or in a standard location. */
  ghPath?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** github.com's credentials: GITHUB_TOKEN, GITHUB_TOKEN_FILE / tokenFile, gh, or the desktop app's token. */
export function githubSpec(opts: GitHubCredentialOptions = {}): CredentialSpec {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  return {
    provider: 'github',
    name: 'GitHub',
    host: 'github.com',
    label: 'GitHub',
    envVar: 'GITHUB_TOKEN',
    fileSetting: 'GITHUB_TOKEN_FILE',
    noTokenHint: 'connect a GitHub account in Settings',
    notConfigured: 'No token file is configured (GITHUB_TOKEN_FILE)',
    rejected: 'Bad credentials',
    authHint: 'check GITHUB_TOKEN or run `gh auth login`',
    logPrefix: '[token]',
    cli: ghCli(opts.ghPath ?? null),
    kind: tokenKind,
    validate: (token, signal) => fetchViewer(token, signal, fetchImpl, now),
  };
}
