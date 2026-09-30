// list_branches, get_branch: a repository's pushed branches as the code host has them, and one branch in full: the
// review target of work that has no PR (yet), with the diff's revisions and files when gh-dash can get them.

import { z } from 'zod';
import type { BranchSummary, ProviderKind } from '../../../shared/api';
import { PROVIDERS } from '../../../shared/provider';
import { branchGroupSql } from '../../db/comments';
import { HttpError } from '../../lib/errors';
import { repoKinds } from '../../services/lists';
import { branchDiffError, loadBranches, loadDiff } from '../diffs';
import { branchArg, limitArg, repoArg, targetRef } from '../format';
import { requireRepo } from '../reach';
import { readTool } from '../tool';
import { diffFiles, STALE_NOTE } from './prs';

/** The PR from a branch, as branch results name it. */
const branchPr = (kind: ProviderKind, repo: string, pr: NonNullable<BranchSummary['pr']>) => ({
  number: pr.number,
  ref: targetRef(kind, repo, { number: pr.number }),
  state: pr.state,
  title: pr.title,
});

export const listBranches = readTool({
  name: 'list_branches',
  title: 'List branches',
  description:
    "A repository's branches on the code host (the default branch left out), newest commit first, each with the newest PR " +
    'from it that gh-dash has synced, if any. `more`: the host has more matching branches (narrow them with `query`). ' +
    'get_branch reads one in full.',
  input: z
    .object({
      repo: repoArg,
      query: z.string().max(200).optional().describe('Text in the branch name'),
      limit: limitArg(100, 30),
    })
    .strict(),
  run: async ({ repo, query, limit }, ctx) => {
    const { deps, signal } = ctx;
    const ref = requireRepo(ctx, repo);
    const kind = repoKinds(deps.db)(ref.key);
    const listed = await loadBranches(deps, ref.key, query ?? null, signal);
    const more = listed.more || listed.items.length > limit;
    return {
      defaultBranch: listed.defaultBranch,
      items: listed.items.slice(0, limit).map((b) => ({
        name: b.name,
        headOid: b.headOid,
        ...(b.committedAt ? { committedAt: b.committedAt } : {}),
        ...(b.pr ? { pr: branchPr(kind, ref.key, b.pr) } : {}),
      })),
      ...(more ? { more: true } : {}),
    };
  },
});

export const getBranch = readTool({
  name: 'get_branch',
  title: 'Get a branch',
  description:
    'One pushed branch, to review it before or without a PR: headOid (its head commit), baseOid (the merge base) and baseRef ' +
    '(the default branch) of its diff (`git diff <baseOid>...<headOid>`), its changed files, the newest PR from it that ' +
    'gh-dash has synced, and the comment thread counts of its review (the PRs from it share those threads). Fetch it with ' +
    "`git fetch origin <fetch>`. Head, base and files come from the diff gh-dash fetches from the code host: when it can't, " +
    'they are left out with a note. `moreFiles`: changed files not listed (at least: a host may cut a big diff short). ' +
    'Comment on it with add_comment (branch).',
  input: z.object({ repo: repoArg, branch: branchArg }).strict(),
  run: async ({ repo, branch }, ctx) => {
    const { deps, signal } = ctx;
    const { db } = deps;
    const ref = requireRepo(ctx, repo);
    const kind = repoKinds(db)(ref.key);
    const row = db.get<{ url: string; default_branch: string | null }>('SELECT url, default_branch FROM repos WHERE id = ?', [ref.id])!;
    const pr = db.get<NonNullable<BranchSummary['pr']>>(
      'SELECT number, state, title FROM pull_requests WHERE repo_id = ? AND head_ref = ? AND cross_repo = 0 ORDER BY number DESC LIMIT 1',
      [ref.id, branch],
    );
    // The current group's threads, which are what the branch's review shows (its PRs' among them).
    const threads = db.get<{ threads: number; unresolved: number | null }>(
      `SELECT count(*) AS threads, sum(t.status = 'open') AS unresolved FROM comment_threads t WHERE t.repo_id = ? AND ${branchGroupSql('t', '?')}`,
      [ref.id, branch],
    )!;
    const out: Record<string, unknown> = {
      repo: ref.key,
      name: branch,
      ref: targetRef(kind, ref.key, { branch }),
      ...(row.default_branch ? { baseRef: row.default_branch, url: PROVIDERS[kind].link.compare(row.url.replace(/\/+$/, ''), row.default_branch, branch) } : {}),
      fetch: branch,
      comments: { threads: threads.threads, unresolved: threads.unresolved ?? 0 },
      ...(pr ? { pr: branchPr(kind, ref.key, pr) } : {}),
    };
    try {
      const diff = await loadDiff(deps, { repo: ref.key, kind: 'branch', branch }, signal);
      out.headOid = diff.headOid;
      out.baseOid = diff.baseOid;
      Object.assign(out, diffFiles(diff));
      if (diff.stale) out.note = STALE_NOTE;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      // The default branch (or a name that isn't a branch's) has nothing to compare: a mistake, not a diff that is out of reach.
      if (err.status === 400) throw err;
      out.note = `No diff (${branchDiffError(err)}): headOid, baseOid and files are left out`;
    }
    return out;
  },
});
