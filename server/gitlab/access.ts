// Why the token can't read a GitLab project, as provider/access AccessFailures in GitLab's words. GitLab doesn't say
// why it hides a project (it answers null for one that doesn't exist and for one the token may not see alike), so
// 'not-found' names both; a project it does show can still hide sections, which is 'permission'. Used by the Add
// dialog's lookup, and by the sync, which stores the same wording as the reason a project added by hand is unavailable.
// A REST 403 for a token without the read_api scope is not here: the transport raises it as an 'auth' error.

import type { AccessFailure } from '../provider/access';
import type { GqlLookup } from './types';

/** What a project shows the token, in words. */
type Section = 'code' | 'merge requests' | 'issues';

function list(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** GitLab shows no project at `path`: it doesn't exist, or the token's account isn't a member of it. */
export function notFound(path: string): AccessFailure {
  return {
    problem: 'not-found',
    message: `GitLab doesn't show ${path} to this token: it doesn't exist, or you aren't a member.`,
    hint: 'Private projects need membership (Reporter or higher). Check the path, or ask a maintainer.',
  };
}

/** The token sees the project at `path` but not these parts of it. */
export function permissionDenied(path: string, sections: Section[]): AccessFailure {
  return {
    problem: 'permission',
    message: `The token can see ${path} but not its ${list(sections)}.`,
    hint: "Guests can't read a private project's code; ask for Reporter access.",
  };
}

/**
 * What the token can't read of a project it sees: its code (a Guest of a private project), its merge requests, its
 * issues (turned off, or not readable at its role). Null when it can read all three; a permission GitLab didn't report
 * counts as readable.
 */
export function unreadable(path: string, p: Pick<GqlLookup, 'userPermissions' | 'issuesEnabled'>): AccessFailure | null {
  const denied: Section[] = [];
  if (p.userPermissions?.downloadCode === false) denied.push('code');
  if (p.userPermissions?.readMergeRequest === false) denied.push('merge requests');
  if (p.issuesEnabled === false) denied.push('issues');
  return denied.length ? permissionDenied(path, denied) : null;
}
