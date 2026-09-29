// A GitLab source's CredentialSpec: its env variable, glab, and validation against the instance (2 requests).

import type { TokenKind } from '../../shared/api';
import { EXPIRY_WARN_DAYS, gitlabCanRead, gitlabTokenCreateUrl, gitlabWriteScopes, gitlabWriteWarning } from '../../shared/credentials';
import { glabCli } from '../credentials/glab';
import { EMPTY_CHECK } from '../credentials/provider';
import type { CredentialSpec, TokenCheck, Validation } from '../credentials/types';
import { GitLabClient } from './client';
import { mapViewer } from './map';
import { personalAccessToken } from './token';
import { GitLabError, type GitLabOptions, GitLabTransport, normalizeBaseUrl } from './transport';
import type { GqlViewer } from './types';

/** The variable that locks a GitLab source when it is the only one and names no tokenEnv of its own. */
export const GITLAB_TOKEN_ENV = 'GITLAB_TOKEN';

const DAY_MS = 86_400_000;

/**
 * Who the token is for, its emails ("me"), the instance and the personal namespace's size. `emails` needs a recent
 * GitLab; smoke v2 checks it on the real instance.
 */
export const CREDENTIAL_CHECK = `
query CredentialCheck {
  currentUser { id username name avatarUrl publicEmail commitEmail emails { nodes { email } } }
  metadata { version enterprise }
  personal: projects(personal: true) { count }
}`;

interface CredentialCheckData {
  currentUser: (GqlViewer & { publicEmail?: string | null; commitEmail?: string | null; emails?: { nodes: ({ email: string | null } | null)[] } | null }) | null;
  metadata: { version: string; enterprise: boolean } | null;
  personal: { count: number } | null;
}

/** glpat- is a personal (or group/project) access token; anything else is unknown until validation tells. */
export function gitlabTokenKind(token: string): TokenKind {
  return token.startsWith('glpat-') ? 'personal' : 'unknown';
}

/**
 * The variable that locks a GitLab source: its own `tokenEnv`, else GITLAB_TOKEN when it is the only GitLab source.
 * With several, a source without `tokenEnv` has no env lock (GITLAB_TOKEN can't say which one it is for).
 */
export function gitlabTokenEnv(tokenEnv: string | null | undefined, gitlabSources: number): string | null {
  const own = tokenEnv?.trim();
  if (own) return own;
  return gitlabSources === 1 ? GITLAB_TOKEN_ENV : null;
}

/** "GitLab (gitlab.example.com)": what logs and errors call the source. */
export function gitlabLabel(host: string): string {
  return `GitLab (${host})`;
}

/** After GitLab rejects the token: what to do (for 503s from diffs and tracking). */
export function gitlabAuthHint(glabHost: string): string {
  return `check the GitLab token in Settings → Sources, or run \`glab auth login --hostname ${glabHost}\``;
}

/**
 * A token's expiry as GitLab gives it, a day ("2026-12-31"), as the moment it stops working: GitLab expires tokens at
 * the start of that day, UTC. null when there is none or it doesn't parse.
 */
export function gitlabExpiry(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * GitLab's message with the source in it: "GitLab rejected the token (401): Token is expired" becomes "GitLab
 * (gitlab.example.com) rejected the token (401): Token is expired"; anything else gets the label in front.
 */
function named(label: string, err: unknown): string {
  const message = (err as Error).message;
  if (err instanceof GitLabError && err.kind === 'transient' && message.startsWith('network error: ')) {
    return `Couldn't reach ${label}: ${message.slice('network error: '.length)}`;
  }
  return message.startsWith('GitLab ') ? `${label}${message.slice('GitLab'.length)}` : `${label}: ${message}`;
}

interface CheckContext {
  baseUrl: string;
  label: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Validates a GitLab token with 2 read-only requests, sent together: the GraphQL account check, and
 * /personal_access_tokens/self for its scopes and expiry (400 means an OAuth token, such as glab's browser login:
 * scopes and expiry unknown). A token without read_api (or api) fails, whatever else it can do.
 */
export async function checkGitLabToken(c: CheckContext, token: string, signal: AbortSignal): Promise<TokenCheck> {
  const opts: GitLabOptions = { baseUrl: c.baseUrl, token, fetchImpl: c.fetchImpl, sleep: c.sleep, maxAttempts: 2 };
  const graphql = new GitLabClient(new GitLabTransport(opts, { maxAttempts: 2, maxRetryWaitMs: 10_000 }));
  const [user, pat] = await Promise.allSettled([graphql.query<CredentialCheckData>(CREDENTIAL_CHECK, {}, signal), personalAccessToken(opts, signal)]);

  const info = pat.status === 'fulfilled' ? pat.value : null;
  const facts: Pick<TokenCheck, 'kind' | 'scopes' | 'expiresAt' | 'canWrite'> = {
    kind: info ? 'personal' : pat.status === 'fulfilled' ? 'oauth' : null,
    scopes: info?.scopes ?? null,
    expiresAt: gitlabExpiry(info?.expiresAt ?? null),
    canWrite: info ? gitlabWriteScopes(info.scopes).length > 0 : null,
  };
  const fail = (error: string): TokenCheck => ({ ...EMPTY_CHECK, ...facts, error });
  if (info && !gitlabCanRead(info.scopes)) {
    return fail(`The token needs the read_api scope${info.scopes.length ? ` (it has ${info.scopes.join(', ')})` : ''}`);
  }
  if (info && !info.active) return fail('The token is not active: it was revoked or has expired');
  if (user.status === 'rejected') return fail(named(c.label, user.reason));
  // The account check passed; a rejection here only matters if it is about the token (other failures: scopes unknown).
  if (pat.status === 'rejected' && pat.reason instanceof GitLabError && pat.reason.kind === 'auth') return fail(named(c.label, pat.reason));
  const data = user.value;
  if (!data.currentUser) return fail(`${c.label} returned no account for this token`);
  const u = data.currentUser;
  const viewer = mapViewer(u, normalizeBaseUrl(c.baseUrl));
  const emails = [u.publicEmail, u.commitEmail, ...(u.emails?.nodes ?? []).map((n) => n?.email)]
    .map((e) => e?.trim().toLowerCase())
    .filter((e): e is string => !!e);
  return {
    ...EMPTY_CHECK,
    ...facts,
    ok: true,
    id: viewer.id,
    login: viewer.login,
    name: viewer.name,
    avatarUrl: viewer.avatarUrl,
    repos: data.personal ? { total: data.personal.count, private: null } : null,
    instance: data.metadata ? { version: data.metadata.version, enterprise: data.metadata.enterprise } : null,
    emails: [...new Set(emails)],
  };
}

/** Log lines after a good validation: an expiry within EXPIRY_WARN_DAYS, and scopes that can change things. */
export function gitlabNotes(baseUrl: string, v: Validation, now: number): string[] {
  const notes: string[] = [];
  const expires = v.expiresAt ? Date.parse(v.expiresAt) : NaN;
  if (Number.isFinite(expires) && expires - now <= EXPIRY_WARN_DAYS * DAY_MS) {
    const days = Math.max(0, Math.ceil((expires - now) / DAY_MS));
    notes.push(`warning: the token expires ${v.expiresAt!.slice(0, 10)} (in ${days} day${days === 1 ? '' : 's'}); create a new one: ${gitlabTokenCreateUrl(baseUrl)}`);
  }
  const write = gitlabWriteWarning(v.scopes);
  if (write) notes.push(`note: ${write} Create one: ${gitlabTokenCreateUrl(baseUrl)}`);
  return notes;
}

export interface GitLabCredentialConfig {
  /** The variable that locks this source (see gitlabTokenEnv); null = none. */
  tokenEnv: string | null;
  /** GH_DASH_GLAB_PATH / glabPath: the glab executable, when it isn't on PATH or in a standard location. */
  glabPath: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The CredentialSpec for the GitLab source at `source.host` (its identity: lower-case, no port) and `source.baseUrl`
 * (the instance URL, relative root included). The env variable, when set, is the token; otherwise the source's choice
 * (a token file, the app's token, or glab) decides. glab is asked for the URL's own host, port included.
 */
export function gitlabSpec(source: { host: string; baseUrl: string }, config: GitLabCredentialConfig): CredentialSpec {
  const baseUrl = normalizeBaseUrl(source.baseUrl);
  const glabHost = new URL(baseUrl).host;
  const label = gitlabLabel(source.host);
  const envVar = config.tokenEnv;
  return {
    provider: 'gitlab',
    name: 'GitLab',
    host: source.host,
    label,
    envVar,
    fileSetting: 'tokenFile',
    noTokenHint: 'set one up in Settings → Sources',
    notConfigured: `No sign-in method is configured: set tokenSource or tokenFile for this source in config.json${envVar ? `, or ${envVar}` : ''}`,
    rejected: `${label} rejected the token (401)`,
    authHint: gitlabAuthHint(glabHost),
    logPrefix: `[token ${source.host}]`,
    cli: glabCli(glabHost, config.glabPath),
    kind: gitlabTokenKind,
    validate: (token, signal) => checkGitLabToken({ baseUrl, label, fetchImpl: config.fetchImpl, sleep: config.sleep }, token, signal),
    notes: (v, now) => gitlabNotes(baseUrl, v, now),
  };
}
