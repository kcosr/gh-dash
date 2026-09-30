// Diffs and file contents for tools, from the diff service (cached; fetched from the code host on a miss), under a
// deadline: an agent's call shouldn't hang on a slow host. A fetch that outlives the deadline still lands in the cache.

import type { BranchListResponse, Diff } from '../../shared/api';
import { payloadText } from '../diff/service';
import { HttpError } from '../lib/errors';
import type { McpDeps } from './tool';

export type DiffTarget =
  | { repo: string; kind: 'pr'; number: number }
  | { repo: string; kind: 'branch'; branch: string }
  | { repo: string; kind: 'commit'; oid: string };

/** How long a tool waits for a diff or a file by default. */
export const DIFF_WAIT_MS = 20_000;

/**
 * `p`, or a 504 after `ms`, or the signal's reason once it aborts. `p` is always handled: a fetch that fails after the wait
 * gave up (or when it was already over) must not be an unhandled rejection, which would stop the server.
 */
export function within<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => reject(signal.reason);
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
    if (signal.aborted) return onAbort();
    timer = setTimeout(() => reject(new HttpError(504, 'gh-dash is still fetching this from the code host; try again in a moment')), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A cancelled call starts no fetch. */
export async function loadDiff(deps: McpDeps, target: DiffTarget, signal: AbortSignal, ms = DIFF_WAIT_MS): Promise<Diff> {
  signal.throwIfAborted();
  const payload =
    target.kind === 'pr'
      ? deps.diffs.prDiff(target.repo, target.number)
      : target.kind === 'branch'
        ? deps.diffs.branchDiff(target.repo, target.branch)
        : deps.diffs.commitDiff(target.repo, target.oid);
  return JSON.parse(await payloadText(await within(payload, ms, signal))) as Diff;
}

/**
 * A branch diff's failure as an agent should read it: a branch the code host hasn't got (the diff service's "Branch x not
 * found on GitHub") is nearly always one that was never pushed, and gh-dash sees only what the host has.
 */
export function branchDiffError(err: HttpError): string {
  return err.status === 404 && err.message.startsWith('Branch ') ? `${err.message}: if it's local, push it first; else check the name` : err.message;
}

/** A repo's branches from the code host (the diff service keeps the list for a minute), under the same deadline. */
export async function loadBranches(deps: McpDeps, repo: string, query: string | null, signal: AbortSignal, ms = DIFF_WAIT_MS): Promise<BranchListResponse> {
  signal.throwIfAborted();
  return within(deps.diffs.branchList(repo, query), ms, signal);
}

/** A file's text at a revision. */
export async function loadBlob(deps: McpDeps, repo: string, oid: string, path: string, signal: AbortSignal, ms = DIFF_WAIT_MS): Promise<string> {
  signal.throwIfAborted();
  return payloadText(await within(deps.diffs.blob(repo, oid, path), ms, signal));
}
