/**
 * The desktop app's GitLab sources (design §8), the parts without Electron: what the renderer may send (a URL and a
 * sign-in method, never a path or a variable name), the config.json entry each method stands for, whether GITLAB_TOKEN
 * can sign a source in, and where glab is.
 */
import * as fsp from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { type ConfigFile, type SourceConfigEntry, sourceUrl } from '../server/config-file';
import { defaultExec, findCli } from '../server/credentials/cli';
import { glabCli } from '../server/credentials/glab';
import { GITLAB_TOKEN_ENV, gitlabTokenEnv } from '../server/gitlab/credentials';
import type { CredentialDraft, DesktopState, SourceDraft, SourceMethod } from '../shared/desktop';
import { ConfigInputError } from './config';

const MAX_URL = 2048;
const MAX_TOKEN = 512;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function plainObject(input: unknown, what: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigInputError(`Expected ${what}.`);
  return input as Record<string, unknown>;
}

/** Refuses keys the renderer has no business sending: a token file or a variable name above all (design §8). */
function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ConfigInputError(`Unexpected ${extra.join(', ')}.`);
}

/** A source's host from the renderer (setSourceCredential, removeSource...): lower-cased, a plain host name. */
export function parseHostInput(input: unknown): string {
  const host = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!host || host.length > 253 || !HOST.test(host)) throw new ConfigInputError('That is not a source.');
  return host;
}

/** How the renderer asks to sign a GitLab source in. A pasted token is ASCII without spaces (it goes in a header). */
export function parseCredentialDraft(input: unknown): CredentialDraft {
  const raw = plainObject(input, 'a sign-in method');
  switch (raw.method) {
    case 'app': {
      onlyKeys(raw, ['method', 'token', 'remember']);
      const token = typeof raw.token === 'string' ? raw.token.trim() : '';
      if (!token) throw new ConfigInputError('Paste a GitLab token.');
      if (token.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(token)) throw new ConfigInputError('That does not look like a GitLab token.');
      if (typeof raw.remember !== 'boolean') throw new ConfigInputError('remember must be true or false.');
      return { method: 'app', token, remember: raw.remember };
    }
    case 'glab':
    case 'file':
    case 'env':
      onlyKeys(raw, ['method']);
      return { method: raw.method };
    default:
      throw new ConfigInputError('Choose how to sign in: a pasted token, glab, a token file or GITLAB_TOKEN.');
  }
}

/** A GitLab source to test or add: `kind`, `url` and a credential (parseCredentialDraft). */
export function parseSourceDraft(input: unknown): SourceDraft {
  const raw = plainObject(input, 'a GitLab source');
  if (raw.kind !== 'gitlab') throw new ConfigInputError('Only GitLab sources can be added.');
  if (typeof raw.url !== 'string' || !raw.url.trim()) throw new ConfigInputError("Enter the GitLab instance's URL.");
  if (raw.url.length > MAX_URL) throw new ConfigInputError('That URL is too long.');
  const { kind: _kind, url, ...credential } = raw;
  return { kind: 'gitlab', url: raw.url.trim(), ...parseCredentialDraft(credential) };
}

/** The URL as it would be saved, and the host that is the source's identity. A user-facing error when it can't be one. */
export function draftTarget(url: string): { baseUrl: string; host: string } {
  let target: { baseUrl: string; host: string };
  try {
    target = sourceUrl(url);
  } catch (error) {
    throw new ConfigInputError((error as Error).message);
  }
  if (target.host === 'github.com') throw new ConfigInputError('github.com is built in: connect it under GitHub.');
  return target;
}

const hostOf = (entry: SourceConfigEntry): string | null => {
  try {
    return sourceUrl(entry.url).host;
  } catch {
    return null;
  }
};

/** Where the source's entry is in config.json's `sources`; -1 when it has none. */
export function sourceIndex(config: ConfigFile, host: string): number {
  return (config.sources ?? []).findIndex((entry) => hostOf(entry) === host);
}

const envSet = (env: NodeJS.ProcessEnv, name: string) => !!env[name]?.trim();

/**
 * Whether GITLAB_TOKEN can sign in the source at `host` (null: a new one), by the server's rules (server/sources/config.ts):
 * it is the default variable of the only GitLab source, and a source's own `tokenEnv` otherwise.
 * - `unset`: it isn't set in the app's environment.
 * - `locks`: the source is (or would be) the only one, so the variable is always its token, whatever else is chosen.
 * - `in-use`: another source's token.
 * - `offered`: free, as one of the ways to sign in (written as the entry's `tokenEnv`).
 */
export function gitlabEnvState(config: ConfigFile, env: NodeJS.ProcessEnv, host: string | null = null): DesktopState['gitlabEnv'] {
  if (!envSet(env, GITLAB_TOKEN_ENV)) return 'unset';
  const entries = config.sources ?? [];
  const i = host === null ? -1 : sourceIndex(config, host);
  const count = i < 0 ? entries.length + 1 : entries.length;
  const others = entries.filter((_, j) => j !== i);
  // With two sources or more nothing gets GITLAB_TOKEN by default, except the only source so far, which keeps it by
  // naming it when a second one is added (addEntry).
  const pinned = i < 0 && others.length === 1;
  const taken = others.some((e) => (e.tokenEnv?.trim() || (pinned ? GITLAB_TOKEN_ENV : null)) === GITLAB_TOKEN_ENV);
  if (taken) return 'in-use';
  const own = i < 0 ? null : entries[i]!.tokenEnv?.trim() || null;
  if (count === 1 && (own === null || own === GITLAB_TOKEN_ENV)) return 'locks';
  return 'offered';
}

/** The variable that locks the source at config.json `sources[i]` right now, if it is set; null when nothing does. */
export function lockingEnv(config: ConfigFile, i: number, env: NodeJS.ProcessEnv): string | null {
  const entries = config.sources ?? [];
  const name = gitlabTokenEnv(entries[i]?.tokenEnv, entries.length);
  return name && envSet(env, name) ? name : null;
}

/**
 * The source's entry signing in with `method` (null: signed out). The token file only goes with `file`, and
 * GITLAB_TOKEN is named only for `env` (a variable named by hand stays). The URL, kind and anything else are kept.
 */
export function withMethod(entry: SourceConfigEntry, method: SourceMethod | null, tokenFile: string | null): SourceConfigEntry {
  const next: SourceConfigEntry = { ...entry };
  delete next.tokenFile;
  if (next.tokenEnv === GITLAB_TOKEN_ENV) delete next.tokenEnv;
  if (method === 'env') {
    delete next.tokenSource;
    next.tokenEnv = GITLAB_TOKEN_ENV;
  } else {
    next.tokenSource = method;
    if (method === 'file') {
      if (!tokenFile) throw new ConfigInputError('Choose the token file first.');
      next.tokenFile = tokenFile;
    }
  }
  return next;
}

/**
 * config.json with a new source at the end. When the only source so far relies on GITLAB_TOKEN by default (and it is
 * set), that source keeps it by naming it: with two sources the default no longer applies.
 */
export function addEntry(config: ConfigFile, entry: SourceConfigEntry, env: NodeJS.ProcessEnv): ConfigFile {
  const entries = [...(config.sources ?? [])];
  if (entries.length === 1 && !entries[0]!.tokenEnv?.trim() && envSet(env, GITLAB_TOKEN_ENV)) entries[0] = { ...entries[0]!, tokenEnv: GITLAB_TOKEN_ENV };
  return { ...config, sources: [...entries, entry] };
}

/** config.json without the source at `sources[i]` (and without `sources` once empty). */
export function removeEntry(config: ConfigFile, i: number): ConfigFile {
  const next: ConfigFile = { ...config, sources: (config.sources ?? []).filter((_, j) => j !== i) };
  if (!next.sources!.length) delete next.sources;
  return next;
}

/**
 * Where glab is, for Settings: glabPath when it is executable, else the first on PATH (the login shell's, merged at
 * startup) or in the usual install folders; null when not found.
 */
export function findGlab(glabPath: string | null, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const win = platform === 'win32';
  const envVar = (name: string) => (win ? Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1] : env[name]);
  return findCli(glabCli('', glabPath), { env, exec: defaultExec, fs: fsp, platform, win, path: win ? win32 : posix, envVar });
}
