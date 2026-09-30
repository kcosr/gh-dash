// list_prs, find_pr, get_pr: pull requests (GitLab merge requests) as the last sync stored them, plus the diff's
// revisions and files when gh-dash can get them.

import { z } from 'zod';
import type { Diff, ProviderKind, PullRequest } from '../../../shared/api';
import { isBranchName } from '../../../shared/branch';
import type { Db } from '../../db/db';
import { isMeFn, loadQueryCtx } from '../../db/filters';
import { PR_FROM, PR_SELECT } from '../../db/lists';
import { resolveRepo } from '../../db/repo-key';
import { type PrRow, toPr } from '../../db/rows';
import { HttpError } from '../../lib/errors';
import { prDetail, queryPrs, repoKinds } from '../../services/lists';
import { loadDiff } from '../diffs';
import { clip, commitArg, limitArg, prArg, repoArg, targetRef } from '../format';
import { readTool, type ToolContext } from '../tool';

/** The compact PR every tool returns. */
function prItem(pr: PullRequest, kind: ProviderKind, headOid: string | null) {
  return {
    id: pr.id,
    repo: pr.repo,
    number: pr.number,
    ref: targetRef(kind, pr.repo, { number: pr.number }),
    title: pr.title,
    state: pr.state,
    ...(pr.isDraft ? { draft: true } : {}),
    author: pr.author.login ?? pr.author.name,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    headOid,
    updatedAt: pr.updatedAt,
    comments: pr.comments,
    url: pr.url,
  };
}

/** Head commits (as of the last sync) of these PRs, by PullRequest.id. */
function headOids(db: Db, ids: string[]): Map<string, string | null> {
  const rows = db.all<{ id: string; head_oid: string | null }>(
    `SELECT r.key || '#' || p.number AS id, p.head_oid FROM ${PR_FROM}
     WHERE r.removed_at IS NULL AND r.key || '#' || p.number IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );
  return new Map(rows.map((r) => [r.id, r.head_oid]));
}

/** The live repo a tool argument names; 404 names it. */
export function requireRepo(db: Db, key: string) {
  const ref = resolveRepo(db, key);
  if (!ref) throw new HttpError(404, `Repository ${key} isn't tracked in gh-dash (list_repos lists the ones that are)`);
  return ref;
}

export const listPrs = readTool({
  name: 'list_prs',
  title: 'List pull requests',
  description:
    'Pull requests (GitLab: merge requests) gh-dash has synced, most recent activity first; without `repo`, across the ' +
    "user's default selection of repositories. `ref` is how the host writes it (owner/app#12, group/app!12). " +
    '`comments` counts gh-dash comment threads. Pass `cursor` from nextCursor for the next page.',
  input: z
    .object({
      repo: repoArg.optional(),
      state: z.enum(['open', 'merged', 'closed', 'all']).default('open'),
      comments: z.enum(['any', 'unresolved']).optional().describe('Only PRs with gh-dash comment threads (any, or at least one unresolved)'),
      q: z.string().max(200).optional().describe('Words in the title or description'),
      limit: limitArg(200, 30),
      cursor: z.string().max(2000).optional(),
    })
    .strict(),
  run: ({ repo, state, comments, q, limit, cursor }, { deps }) => {
    if (repo) requireRepo(deps.db, repo);
    // Every date: an open PR stays open however old it is (the range is the API's widest).
    const out = queryPrs(deps, { repos: repo, state, comments, q, limit, cursor, from: '-20y' });
    if (out.format !== 'json') throw new Error('unreachable');
    const { items, nextCursor, total } = out.body;
    const kindOf = repoKinds(deps.db);
    const heads = headOids(deps.db, items.map((p) => p.id));
    return { items: items.map((p) => prItem(p, kindOf(p.repo), heads.get(p.id) ?? null)), total, nextCursor };
  },
});

/** Hex prefix range: `[prefix, prefix + 'g')` holds every lower-case oid that starts with it, and uses an index. */
const prefixRange = (col: string) => `(${col} >= ? AND ${col} < ?)`;

export const findPr = readTool({
  name: 'find_pr',
  title: 'Find pull requests by branch or commit',
  description:
    'Pull requests of a repository whose head branch is `branch` (open ones first), or that contain `commit` (as their ' +
    'head, one of their commits, or the commit they were merged or squashed as). Give one of branch or commit: typically ' +
    '`git branch --show-current` or `git rev-parse HEAD` in your clone. A branch with no PR can be reviewed on its own ' +
    '(get_branch, add_comment with branch).',
  input: z
    .object({
      repo: repoArg,
      branch: z.string().min(1).max(500).optional().describe('Head branch name as on the remote'),
      commit: commitArg.optional(),
    })
    .strict()
    .refine((a) => (a.branch === undefined) !== (a.commit === undefined), 'give exactly one of branch or commit'),
  run: ({ repo, branch, commit }, { deps }) => {
    const { db } = deps;
    const ref = requireRepo(db, repo);
    type Row = PrRow & { match: 'branch' | 'head' | 'merged' | 'commit' };
    let rows: Row[];
    const order = "ORDER BY p.state = 'open' DESC, p.updated_at DESC LIMIT 20";
    const name = branch?.replace(/^refs\/heads\//, '');
    if (name !== undefined) {
      rows = db.all<Row>(`SELECT ${PR_SELECT}, 'branch' AS match FROM ${PR_FROM} WHERE p.repo_id = ? AND p.head_ref = ? ${order}`, [ref.id, name]);
    } else {
      const range = [commit!, `${commit!}g`];
      rows = db.all<Row>(
        `SELECT ${PR_SELECT},
           CASE WHEN ${prefixRange('p.head_oid')} THEN 'head'
                WHEN ${prefixRange('p.merge_commit_oid')} OR ${prefixRange('p.squash_commit_oid')} THEN 'merged'
                ELSE 'commit' END AS match
         FROM ${PR_FROM}
         WHERE p.repo_id = ? AND (${prefixRange('p.head_oid')} OR ${prefixRange('p.merge_commit_oid')} OR ${prefixRange('p.squash_commit_oid')}
           OR p.id IN (SELECT pr_id FROM pr_commits WHERE ${prefixRange('oid')})) ${order}`,
        [...range, ...range, ...range, ref.id, ...range, ...range, ...range, ...range],
      );
    }
    const isMe = isMeFn(loadQueryCtx(db, deps.config.myEmails));
    const kind = repoKinds(db)(ref.key);
    const items = rows.map((r) => ({ ...prItem(toPr(r, isMe), kind, r.head_oid), match: r.match }));
    const out: Record<string, unknown> = { items };
    // A branch no PR is from can be reviewed on its own (not the default branch: it is what branches are compared against).
    if (name !== undefined && items.length === 0 && isBranchName(name) && !db.get('SELECT 1 FROM repos WHERE id = ? AND default_branch = ?', [ref.id, name])) {
      out.note =
        `No pull request from ${name} in gh-dash. If it's pushed, get_branch reads it and add_comment with branch comments on it ` +
        '(shared with a PR opened from it later); if it only exists locally, push it first.';
    }
    return out;
  },
});

/** Most files get_pr and get_branch list; the rest are counted. */
const MAX_FILES = 300;

/**
 * The files of a diff, as the get tools give them: at most MAX_FILES, and `moreFiles` counts those not listed, whether
 * the tool cut them or the code host never sent them (totalFiles beyond the files: GitHub's cap on a big diff, or a
 * GitLab comparison that timed out, which sets it one above what it listed to say some are missing).
 */
export function diffFiles(diff: Diff): Record<string, unknown> {
  const listed = diff.files.slice(0, MAX_FILES);
  const out: Record<string, unknown> = {
    files: listed.map((f) => ({
      path: f.path,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
  const more = Math.max(diff.totalFiles, diff.files.length) - listed.length;
  if (more > 0) out.moreFiles = more;
  return out;
}

/** What a stale diff (served from the cache because the code host couldn't be asked) says about its files and revisions. */
export const STALE_NOTE = "The code host couldn't be asked: files and revisions are from gh-dash's cache and may be behind";

export const getPr = readTool({
  name: 'get_pr',
  title: 'Get a pull request',
  description:
    'One pull request: its state, branches, exact revisions and changed files. headOid is the head commit and baseOid the ' +
    'merge base the diff is against (`git diff <baseOid>...<headOid>`); fetch the head with `git fetch origin <fetch>`. ' +
    'Files and baseOid come from the diff gh-dash fetches from the code host: when it can\'t, they are left out with a ' +
    'note. `moreFiles`: changed files not listed (at least: a host may cut a big diff short).',
  input: z.object({ repo: repoArg, number: prArg }).strict(),
  run: async ({ repo, number }, ctx: ToolContext) => {
    const { deps, signal } = ctx;
    const { db } = deps;
    const ref = requireRepo(db, repo);
    const pr = prDetail(deps, ref.key, number);
    const kind = repoKinds(db)(ref.key);
    const syncedHead = db.get<{ head_oid: string | null }>('SELECT head_oid FROM pull_requests WHERE repo_id = ? AND number = ?', [ref.id, number])?.head_oid ?? null;
    const out: Record<string, unknown> = {
      ...prItem(pr, kind, syncedHead),
      fetch: kind === 'gitlab' ? `merge-requests/${number}/head` : `pull/${number}/head`,
      commits: pr.commits.length || pr.commitCount,
      body: clip(pr.body, 2000),
    };
    try {
      const diff = await loadDiff(deps, { repo: ref.key, kind: 'pr', number }, signal);
      out.headOid = diff.headOid;
      out.baseOid = diff.baseOid;
      Object.assign(out, diffFiles(diff));
      if (diff.stale) out.note = STALE_NOTE;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      out.note = `No diff (${err.message}): files and baseOid are left out; headOid is from the last sync`;
    }
    return out;
  },
});
