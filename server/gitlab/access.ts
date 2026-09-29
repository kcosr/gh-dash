// Why the token can't read a GitLab project, as provider/access AccessFailures in GitLab's words. GitLab doesn't say
// why it hides a project (it answers null for one that doesn't exist and for one the token may not see alike), so
// 'not-found' names both; a project it does show can still hide its code, which is 'permission'. Used by the Add
// dialog's lookup, and by the sync, which stores the same wording as the reason a project added by hand is unavailable.
//
// Merge requests or issues that are turned off, or hidden at the token's role, are not an access problem: the project is
// still worth tracking for the rest, and those sections are simply empty (`unavailable` below reports them). That departs
// from design 4.8's table, which made them 'permission'.
//
// A REST 403 for a token without the read_api scope is not here either: the transport raises it as an 'auth' error.

import type { AccessFailure } from '../provider/access';
import type { GqlLookup } from './types';

/** GitLab shows no project at `path`: it doesn't exist, or the token's account isn't a member of it. */
export function notFound(path: string): AccessFailure {
  return {
    problem: 'not-found',
    message: `GitLab doesn't show ${path} to this token: it doesn't exist, or you aren't a member.`,
    hint: 'Private projects need membership (Reporter or higher). Check the path, or ask a maintainer.',
  };
}

/** The token sees the project at `path` but not its code (a Guest of a private project): there is nothing to sync. */
export function codeHidden(path: string): AccessFailure {
  return {
    problem: 'permission',
    message: `The token can see ${path} but not its code.`,
    hint: "Guests can't read a private project's code; ask for Reporter access.",
  };
}

/** Whether the token can't read the code of a project it sees. A permission GitLab didn't report counts as readable. */
export function unreadable(path: string, p: Pick<GqlLookup, 'userPermissions'>): AccessFailure | null {
  return p.userPermissions?.downloadCode === false ? codeHidden(path) : null;
}

/** The parts of a project the token gets nothing of: merge requests or issues, turned off or hidden at its role. */
export function unavailable(p: Pick<GqlLookup, 'userPermissions' | 'issuesEnabled'>): ('prs' | 'issues')[] {
  return [...(p.userPermissions?.readMergeRequest === false ? (['prs'] as const) : []), ...(p.issuesEnabled === false ? (['issues'] as const) : [])];
}
