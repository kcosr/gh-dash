// The token glab has for one GitLab host: the `glab` credential method. Lifted from the smoke tool's glabToken
// (server/gitlab/smoke.ts), keeping only the token path: glab isn't run for status output.

import { cliEnv, type ExecError, firstLine } from './cli';
import { HEADER_SAFE, none } from './provider';
import type { CliIo, CliSpec, ResolvedToken } from './types';

/** glab can wait on a keyring prompt; it answers from its config or keyring in well under a second otherwise. */
export const GLAB_TIMEOUT_MS = 15_000;
/** Variables glab would take a token from: gone from its environment, so it can't just hand GITLAB_TOKEN back. */
export const GLAB_TOKEN_VARS: readonly string[] = ['GITLAB_TOKEN', 'GLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'];
/**
 * What glab prints as a token: glpat-… (whose newer forms have dots), or another long opaque string such as an OAuth
 * token. Not a row of asterisks, and without the smoke tool's dots in the second form, so a host name isn't one.
 */
export const TOKEN_LIKE = /^(?:gl[a-z]+-[\w.-]{10,}|[A-Za-z0-9_-]{20,})$/;

/** glab's environment: without the token variables, never prompting, no colour codes. */
export function glabEnv(env: NodeJS.ProcessEnv, win: boolean): NodeJS.ProcessEnv {
  return cliEnv(env, win, GLAB_TOKEN_VARS, { NO_PROMPT: '1', NO_COLOR: '1' });
}

/**
 * The token in `glab auth status --hostname <host> --show-token` output: the last word of a line that mentions "token"
 * and looks like one (and isn't the host). null when there is none (not logged in, or a masked token).
 */
export function tokenFromAuthStatus(output: string, host: string): string | null {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter((l) => /token/i.test(l));
  const words = lines.map((l) => l.trim().split(/\s+/).at(-1) ?? '');
  return words.find((t) => TOKEN_LIKE.test(t) && !t.toLowerCase().includes(host.toLowerCase())) ?? null;
}

/**
 * The token glab (at `path`) has for `host` (the GitLab URL's host, with its port if any). One method, two commands:
 *  1. `glab config get token --host <host>`: a non-empty, header-safe stdout is the token (glab 1.119 prints it even
 *     when the token is in the OS keyring);
 *  2. only when that printed nothing: `glab auth status --hostname <host> --show-token` (glab has no `auth token`).
 * A spawn failure or a timeout stops there. Output is never quoted, except the first line of a failure's stderr.
 */
export async function glabToken(path: string, host: string, io: Pick<CliIo, 'env' | 'exec' | 'win'>): Promise<ResolvedToken> {
  const env = glabEnv(io.env, io.win);
  const run = (args: string[]) => io.exec(path, args, { env, timeout: GLAB_TIMEOUT_MS });

  let stored = '';
  let configFailed: string | null = null;
  try {
    stored = (await run(['config', 'get', 'token', '--host', host])).stdout.trim();
  } catch (err) {
    const e = err as ExecError;
    const fatal = runFailure(e, path);
    if (fatal) return none(fatal);
    // What glab said, if anything (not Node's "Command failed: …", which only repeats the command).
    configFailed = e.stderr?.trim() ? firstLine(e) : null;
  }
  if (stored) {
    if (!HEADER_SAFE.test(stored)) return none('glab config get token printed something other than a token');
    return { token: stored, source: 'glab', error: null };
  }

  let output: string;
  try {
    const out = await run(['auth', 'status', '--hostname', host, '--show-token']);
    output = `${out.stdout}\n${out.stderr}`;
  } catch (err) {
    const e = err as ExecError;
    const fatal = runFailure(e, path);
    if (fatal) return none(fatal);
    // auth status exits non-zero when a host has a problem, and still says what it knows.
    output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  const token = tokenFromAuthStatus(output, host);
  if (token) return { token, source: 'glab', error: null };
  if (/unknown flag:?\s*-*show-token/i.test(output)) {
    return none(`this glab can't print its token for ${host} (no auth status --show-token): upgrade glab, or use a token file`);
  }
  const why = configFailed ? ` (glab config get token failed: ${configFailed})` : '';
  return none(`glab has no token for ${host}: run \`glab auth login --hostname ${host}\`${why}`);
}

/** Failures that end the method: glab didn't run, or didn't answer in time. null for a command that ran and failed. */
function runFailure(e: ExecError, path: string): string | null {
  if (e.code === 'ENOENT' || e.code === 'EACCES') return `Couldn't run glab at ${path} (${e.code})`;
  if (e.killed || e.signal === 'SIGTERM') return `glab timed out after ${GLAB_TIMEOUT_MS / 1000} s (is it waiting for a keyring prompt?)`;
  return null;
}

/**
 * glab as a CliSpec for the GitLab source at `host` (the URL's host). glab is only used when chosen: `auto` never falls
 * to it. Its login isn't read from its config (the token's validation names the account).
 */
export function glabCli(host: string, glabPath: string | null): CliSpec {
  return {
    name: 'glab',
    choice: 'glab',
    source: 'glab',
    path: glabPath,
    pathSetting: 'glabPath',
    windowsFolder: 'glab',
    notFound: 'glab not found: install it, or set its location (Settings → Sources → Locate glab…, or glabPath)',
    inAuto: false,
    login: null,
    token: (path, io) => glabToken(path, host, io),
  };
}
