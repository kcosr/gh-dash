// GET /branches: pushed branches with no PR yet, across the repos in scope, read from the branches the sync holds (see
// BranchQuery in shared/api.ts). Scoped, paged and counted like the PR list (db/lists.ts), which it stands in for in the
// web's "No PR yet" state. A capped listing's rows are listed too (branches_complete = 0: real branches as of that sync,
// only not all of them); only a repo's own branch list (DiffService.branchList) needs the whole listing.

import type { Branch } from '../../shared/api';
import { branchGroupSql } from './comments';
import type { Db } from './db';
import { addLike, addRange, addRepoScope, addWho, isMeFn, type QueryCtx, type Scope, Where } from './filters';
import { type ListResult, type Page, runPaged } from './lists';
import { repoKeySql } from './repo-key';
import { type BranchRow, toBranch } from './rows';

export const BRANCH_FROM = 'branches b JOIN repos r ON r.id = b.repo_id';

/**
 * The PRs from branch `b` of its own repo: the ones the sync says are, and the ones it hasn't said of yet (cross_repo
 * NULL), since they only hide a branch, which the sync brings back once it knows. A fork's PR from a branch of that name
 * is from another repo's branch. Found by the (repo_id, head_ref) index.
 */
const SAME_REPO_PRS = 'FROM pull_requests p WHERE p.repo_id = b.repo_id AND p.head_ref = b.name AND p.cross_repo IS NOT 1';

/**
 * SQL: branch `b` isn't reviewed as a PR: none from it is open, or has its current head as its own, whatever its state.
 * A branch whose PR was merged or closed and that has had commits since is new work, listed again.
 */
export const NO_PR_SQL = `NOT EXISTS (SELECT 1 ${SAME_REPO_PRS} AND (p.state = 'open' OR p.head_oid = b.head_oid))`;

// The threads its review shows (its branch's current group), as a PR's row counts its view's: per row of a page only.
const BRANCH_THREADS = `FROM comment_threads t WHERE t.repo_id = b.repo_id AND ${branchGroupSql('t', 'b.name')}`;
export const BRANCH_SELECT =
  `b.*, ${repoKeySql('r')} AS repo, r.source_id AS source_id, (SELECT kind FROM sources WHERE id = r.source_id) AS kind, ` +
  'r.url AS repo_url, r.default_branch AS default_branch, ' +
  `(SELECT count(*) ${BRANCH_THREADS}) AS threads, (SELECT count(*) ${BRANCH_THREADS} AND t.status = 'open') AS unresolved_threads`;

function branchWhere(ctx: QueryCtx, scope: Scope): Where {
  const w = new Where();
  addRepoScope(w, scope, ctx);
  // The default branch is what the others are compared with; a repo whose default branch the sync hasn't seen has
  // nothing to compare them with, and lists none.
  w.add('b.name <> r.default_branch');
  w.add(NO_PR_SQL);
  // A branch whose head the code host gave no date can't be in a range: it is never listed.
  addRange(w, 'b.committed_at', scope);
  addWho(w, scope.who, ctx, 'b.author_login', 'b.author_email');
  // Names are no text for the FTS index: a part of one, as the code hosts match it.
  addLike(w, scope.q, ['b.name']);
  return w;
}

/** Newest head commit first (tie-break repo, name), keyset-paged like the other lists; `total` counts every page. */
export function listBranches(db: Db, ctx: QueryCtx, scope: Scope, page: Page): ListResult<Branch> {
  const isMe = isMeFn(ctx);
  const { rows, next, total } = runPaged<BranchRow>(db, {
    from: BRANCH_FROM,
    select: BRANCH_SELECT,
    where: branchWhere(ctx, scope),
    at: 'b.committed_at',
    keys: [repoKeySql('r'), 'b.name'],
    // Listed branches have a date (branchWhere's range).
    cursorOf: (r) => [r.committed_at!, r.repo, r.name],
  }, page);
  return { items: rows.map((r) => toBranch(r, isMe)), nextCursor: next, total };
}
