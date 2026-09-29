// Why the token can't read a repository, from the GraphQL errors of a read, as provider/access AccessFailures in
// GitHub's words. Used by the repo lookup behind "Add repository" (message plus a hint for this kind of token) and by
// the sync, which stores the same wording as the reason a repo added by hand is unavailable.

import type { TokenKind } from '../../shared/api';
import type { AccessFailure } from '../provider/access';
import type { GqlError } from './types';

/** What a denied field of a repository holds, in words. */
const FIELD_WORDS: Record<string, string> = {
  openPrs: 'pull requests',
  latestPr: 'pull requests',
  pullRequests: 'pull requests',
  openIssues: 'issues',
  latestIssue: 'issues',
  issues: 'issues',
  defaultBranchRef: 'code history',
  releases: 'releases',
  latestReleases: 'releases',
};

const samePath = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const under = (path: readonly (string | number)[] | undefined, at: readonly (string | number)[]) =>
  !!path && path.length > at.length && at.every((x, i) => path[i] === x);

function list(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The repo can't be seen at all (it doesn't exist, or the token has no access): the wording of `problem: 'not-found'`. */
export function notFound(key: string, kind: TokenKind | null): AccessFailure {
  const owner = key.slice(0, key.lastIndexOf('/'));
  return {
    problem: 'not-found',
    message: `GitHub doesn't show ${key} to this token: it doesn't exist, or the token can't read it.`,
    hint:
      kind === 'fine-grained'
        ? `Fine-grained tokens read public repositories anywhere, but private ones only under the single owner chosen when the token was created. Create one for ${owner}, or use a classic token or GitHub CLI.`
        : 'Check the spelling, or ask for access.',
  };
}

/**
 * The access problem the errors report for the repository read at `at` (['repository'] for a lookup by name,
 * ['nodes', i] or ['node'] by node id), or null when there is none:
 *  - NOT_FOUND on the repository: not-found;
 *  - FORBIDDEN on the repository: sso when GitHub mentions SAML, else org-policy (GitHub's own words);
 *  - FORBIDDEN on one of its fields: permission (the token sees the repo, not its pull requests, issues, ...).
 */
export function accessFailure(errors: readonly GqlError[], at: readonly (string | number)[], key: string, kind: TokenKind | null): AccessFailure | null {
  const owner = key.slice(0, key.lastIndexOf('/'));
  const onRepo = errors.filter((e) => e.path && samePath(e.path, at));
  const forbidden = onRepo.find((e) => e.type === 'FORBIDDEN');
  if (forbidden && /\bSAML\b/i.test(forbidden.message)) {
    return {
      problem: 'sso',
      message: `${owner} requires SAML single sign-on.`,
      hint:
        kind === 'classic' ? `Authorize the token for ${owner} (github.com/settings/tokens → Configure SSO).`
        : kind === 'oauth' ? `Run \`gh auth refresh\` and authorize ${owner}.`
        : null,
    };
  }
  if (forbidden) {
    return {
      problem: 'org-policy',
      message: forbidden.message,
      hint: kind === 'oauth' && /OAuth App access restrictions/i.test(forbidden.message)
        ? `An owner of ${owner} must approve GitHub CLI, or use a personal access token.`
        : null,
    };
  }
  if (onRepo.some((e) => e.type === 'NOT_FOUND')) return notFound(key, kind);
  const denied = errors.filter((e) => e.type === 'FORBIDDEN' && under(e.path, at)).map((e) => String(e.path![at.length]));
  if (denied.length) {
    const words = [...new Set(denied.map((f) => FIELD_WORDS[f] ?? f))];
    return {
      problem: 'permission',
      message: `The token can see ${key} but not its ${list(words)}.`,
      hint: 'Grant read access to Pull requests, Issues and Contents.',
    };
  }
  return null;
}
