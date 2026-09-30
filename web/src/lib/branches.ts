/** Branch lists as the repo page's card and the palette narrow them. Pure, for tests. */
import type { BranchListResponse } from '../../../shared/api';
import { isBranchQuery } from '../../../shared/branch';

/**
 * What to ask the host for, past the branches it listed: the filter, when the host has more than it listed and the
 * filter can narrow a list (any part of a name: "feature/" and "/login" are no names, but match some); else nothing.
 */
export function hostBranchQuery(listed: Pick<BranchListResponse, 'more'> | undefined, filter: string): string | null {
  const q = filter.trim();
  return listed?.more && isBranchQuery(q) ? q : null;
}
