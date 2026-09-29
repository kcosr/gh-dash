// Diffs and file contents for tools, from the diff service (cached; fetched from the code host on a miss), under a
// deadline: an agent's call shouldn't hang on a slow host. A fetch that outlives the deadline still lands in the cache.

import type { Diff } from '../../shared/api';
import { payloadText } from '../diff/service';
import { HttpError } from '../lib/errors';
import type { McpDeps } from './tool';

export type DiffTarget = { repo: string; kind: 'pr'; number: number } | { repo: string; kind: 'commit'; oid: string };

/** How long a tool waits for a diff or a file by default. */
export const DIFF_WAIT_MS = 20_000;

/** `p`, or a 504 after `ms`, or the signal's reason once it aborts. */
export function within<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => reject(new HttpError(504, 'gh-dash is still fetching this from the code host; try again in a moment')), ms);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export async function loadDiff(deps: McpDeps, target: DiffTarget, signal: AbortSignal, ms = DIFF_WAIT_MS): Promise<Diff> {
  const payload = target.kind === 'pr' ? deps.diffs.prDiff(target.repo, target.number) : deps.diffs.commitDiff(target.repo, target.oid);
  return JSON.parse(await payloadText(await within(payload, ms, signal))) as Diff;
}

/** A file's text at a revision. */
export async function loadBlob(deps: McpDeps, repo: string, oid: string, path: string, signal: AbortSignal, ms = DIFF_WAIT_MS): Promise<string> {
  return payloadText(await within(deps.diffs.blob(repo, oid, path), ms, signal));
}
