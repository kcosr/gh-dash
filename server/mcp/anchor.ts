// Where add_comment puts a new thread: the revision it is made on, and for a line thread the text of its lines (the
// snippet that keeps it readable and relocates it on later pushes), read as the diff viewer reads them: from the diff's
// patch when it shows them, else from the file at that revision (the base's for the old side).

import type { CommentSide, Diff, DiffFile, ProviderKind } from '../../shared/api';
import { patchLines, snippetOf } from '../../shared/comment-placement';
import { PROVIDERS } from '../../shared/provider';
import type { RepoRef } from '../db/repo-key';
import { isFullSha } from '../diff/service';
import { HttpError } from '../lib/errors';
import { loadBlob, loadDiff } from './diffs';
import { targetRef } from './format';
import type { McpDeps } from './tool';

export interface AnchorArgs {
  path?: string;
  side: CommentSide;
  start_line?: number;
  end_line?: number;
  at_commit?: string;
}

/** A new thread's revision and anchor, as the comment service takes them. */
export interface Anchored {
  commitOid: string;
  baseOid: string | null;
  path: string | null;
  side: CommentSide | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  /** The diff the thread was made against, when there was one (to place the new thread). */
  diff: Diff | null;
}

const short = (oid: string) => oid.slice(0, 7);

/** Lines start..end of a file's text (1-based, inclusive), without CRs; 400 when the file is shorter. */
function linesOf(text: string, path: string, oid: string, start: number, end: number): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (end > lines.length) {
    throw new HttpError(400, `${path} has ${lines.length} line${lines.length === 1 ? '' : 's'} at ${short(oid)}: lines ${start}–${end} aren't there`);
  }
  return lines
    .slice(start - 1, end)
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .join('\n');
}

/** The file's lines at `oid`, from the code host (or the cache); failures say what to do instead. */
async function blobLines(deps: McpDeps, repo: string, oid: string, path: string, start: number, end: number, signal: AbortSignal): Promise<string> {
  let text: string;
  try {
    text = await loadBlob(deps, repo, oid, path, signal);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 404) throw new HttpError(400, `${path} isn't in the repository at ${short(oid)}`);
    if (err.status === 413 || err.status === 415) throw new HttpError(400, `${err.message}: comment on the file (leave start_line out) instead`);
    throw new HttpError(err.status, `gh-dash can't read ${path} at ${short(oid)} (${err.message}), so it can't anchor lines: comment on the file or the whole target instead`);
  }
  return linesOf(text, path, oid, start, end);
}

function lineRange(args: AnchorArgs): { start: number; end: number } | null {
  if (args.start_line === undefined) {
    if (args.end_line !== undefined) throw new HttpError(400, 'end_line needs start_line');
    return null;
  }
  const end = args.end_line ?? args.start_line;
  if (end < args.start_line) throw new HttpError(400, 'end_line must not be before start_line');
  return { start: args.start_line, end };
}

/** The diff's file at `path`; 400 listing a few of its files when it isn't there. */
function fileIn(diff: Diff, path: string, what: string): DiffFile {
  const file = diff.files.find((f) => f.path === path);
  if (file) return file;
  const names = diff.files.slice(0, 10).map((f) => f.path);
  const more = diff.files.length > names.length ? `, and ${diff.files.length - names.length} more` : '';
  throw new HttpError(400, `${path} isn't in ${what}'s diff at ${short(diff.headOid)} (its files: ${names.join(', ') || 'none'}${more})`);
}

/** Checks the side is there for `file` in this diff. */
function checkSide(file: DiffFile, side: CommentSide, what: string): void {
  if (side === 'old' && file.status === 'added') throw new HttpError(400, `${file.path} is new in ${what}: it has no old side`);
  if (side === 'new' && file.status === 'removed') throw new HttpError(400, `${file.path} is deleted in ${what}: comment on its old side (side "old")`);
}

/** A line anchor of `file` (or of `path` when the diff isn't known) on `side`; null lines: a file anchor. */
async function lineAnchor(
  deps: McpDeps,
  repo: string,
  args: AnchorArgs,
  file: DiffFile | null,
  path: string,
  oids: { new: string; old: string | null },
  signal: AbortSignal,
): Promise<Pick<Anchored, 'path' | 'side' | 'startLine' | 'endLine' | 'snippet'>> {
  const range = lineRange(args);
  if (!range) return { path, side: null, startLine: null, endLine: null, snippet: null };
  const oid = oids[args.side];
  if (oid === null) throw new HttpError(400, 'A root commit has no old side');
  // The patch has the lines when it shows them all (it is this revision's); lines outside it (the diff shows them as
  // expandable context) come from the file itself, which a rename names by its old path on the old side.
  const fromPatch = file?.patch ? snippetOf(patchLines(file.patch)[args.side], range.start, range.end) : null;
  const blobPath = args.side === 'old' ? (file?.previousPath ?? path) : path;
  const snippet = fromPatch ?? (await blobLines(deps, repo, oid, blobPath, range.start, range.end, signal));
  return { path, side: args.side, startLine: range.start, endLine: range.end, snippet };
}

/**
 * A new thread on a PR: at `at_commit` (the head by default; an earlier push of the PR also works, a commit the code host
 * hasn't got doesn't), on the whole PR, a file of its diff, or lines of one of its sides.
 */
export async function prAnchor(deps: McpDeps, ref: RepoRef, kind: ProviderKind, number: number, args: AnchorArgs, signal: AbortSignal): Promise<Anchored> {
  const { db } = deps;
  const what = targetRef(kind, ref.key, { number });
  const pr = db.get<{ id: number; head_oid: string | null }>('SELECT id, head_oid FROM pull_requests WHERE repo_id = ? AND number = ?', [ref.id, number]);
  if (!pr) throw new HttpError(404, `${what} isn't in gh-dash (not synced yet, or not a ${PROVIDERS[kind].pr.one} of this repository)`);
  let diff: Diff | null = null;
  let diffError = '';
  try {
    diff = await loadDiff(deps, { repo: ref.key, kind: 'pr', number }, signal);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    diffError = err.message;
  }
  const head = diff?.headOid ?? pr.head_oid;

  let commitOid: string;
  if (args.at_commit !== undefined) {
    const at = args.at_commit.toLowerCase();
    const pushed = db.all<{ oid: string }>('SELECT oid FROM pr_commits WHERE pr_id = ?', [pr.id]).map((r) => r.oid.toLowerCase());
    const known = [...new Set([diff?.headOid, pr.head_oid, ...pushed].filter((o): o is string => !!o))];
    const hits = known.filter((o) => o.startsWith(at));
    if (hits.length > 1) throw new HttpError(400, `at_commit ${at} is ambiguous in ${what}: give more of the SHA`);
    if (hits.length === 0) {
      throw new HttpError(
        400,
        `${at} isn't a commit of ${what} that gh-dash knows. If it's local, push it first (gh-dash sees what the code host has)` +
          (head ? `, or comment on the PR head ${head}.` : '.'),
      );
    }
    commitOid = hits[0]!;
  } else {
    if (!head) throw new HttpError(503, `gh-dash doesn't know ${what}'s head commit yet${diffError ? ` (${diffError})` : ''}`);
    commitOid = head;
  }
  const atDiff = diff !== null && commitOid === diff.headOid;
  const out = { commitOid, baseOid: atDiff ? diff!.baseOid : null, diff };
  if (args.path === undefined) {
    if (args.start_line !== undefined || args.end_line !== undefined) throw new HttpError(400, 'start_line needs a path');
    return { ...out, path: null, side: null, startLine: null, endLine: null, snippet: null };
  }

  let file: DiffFile | null = null;
  if (atDiff) {
    file = fileIn(diff!, args.path, what);
    if (args.start_line !== undefined) checkSide(file, args.side, what);
  } else if (args.start_line !== undefined && args.side === 'old') {
    throw new HttpError(400, `Old-side lines are anchored on ${what}'s current diff only: leave at_commit out`);
  } else if (args.start_line !== undefined && !diff) {
    throw new HttpError(503, `gh-dash can't get ${what}'s diff (${diffError}), so it can't anchor lines: comment on the file or the whole PR instead`);
  }
  const lines = await lineAnchor(deps, ref.key, args, atDiff ? file : null, args.path, { new: commitOid, old: atDiff ? diff!.baseOid : null }, signal);
  return { ...out, ...lines };
}

/** A new thread on a commit: on the whole commit, a file of its diff, or lines of one of its sides. */
export async function commitAnchor(deps: McpDeps, ref: RepoRef, kind: ProviderKind, oid: string, args: AnchorArgs, signal: AbortSignal): Promise<Anchored> {
  let diff: Diff | null = null;
  let diffError = '';
  try {
    diff = await loadDiff(deps, { repo: ref.key, kind: 'commit', oid }, signal);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 404) {
      throw new HttpError(404, `Commit ${oid} isn't on ${PROVIDERS[kind].name}: if it's local, push it first; else check the SHA`);
    }
    diffError = err.message;
  }
  const full = diff?.headOid ?? (isFullSha(oid) ? oid : null);
  if (!full) throw new HttpError(503, `gh-dash can't reach ${PROVIDERS[kind].name} to find commit ${oid} (${diffError}): give its full SHA`);
  if (args.at_commit !== undefined && !full.startsWith(args.at_commit.toLowerCase())) {
    throw new HttpError(400, "A commit's comments are on the commit itself: leave at_commit out");
  }
  const what = targetRef(kind, ref.key, { oid: full });
  const out = { commitOid: full, baseOid: diff?.baseOid ?? null, diff };
  if (args.path === undefined) {
    if (args.start_line !== undefined || args.end_line !== undefined) throw new HttpError(400, 'start_line needs a path');
    return { ...out, path: null, side: null, startLine: null, endLine: null, snippet: null };
  }
  let file: DiffFile | null = null;
  if (diff) {
    file = fileIn(diff, args.path, what);
    if (args.start_line !== undefined) checkSide(file, args.side, what);
  } else if (args.start_line !== undefined) {
    throw new HttpError(503, `gh-dash can't get ${what}'s diff (${diffError}), so it can't anchor lines: comment on the file or the whole commit instead`);
  }
  const lines = await lineAnchor(deps, ref.key, args, file, args.path, { new: full, old: diff?.baseOid ?? null }, signal);
  return { ...out, ...lines };
}
