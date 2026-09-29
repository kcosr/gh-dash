// Why a source's token can't read a repository, in words a person can act on. The repo lookup behind "Add repository"
// shows it (message plus a hint for this kind of token), and the sync stores the same line as the reason a repo added
// by hand is unavailable. Each source builds these from its own API's answers (GitHub: GraphQL error paths; GitLab: a
// null project, its permissions); everything downstream only reads them.

import type { AccessProblem } from '../../shared/api';
import { SourceError } from './errors';

export interface AccessFailure {
  /**
   * 'not-found': the token can't see the repository (it doesn't exist, or it's private to others);
   * 'sso' / 'org-policy': its owner refuses the token; 'permission': the token sees it but not some of its sections.
   */
  problem: AccessProblem;
  /** One sentence naming the repository by its provider path. */
  message: string;
  /** What to do about it, for this kind of token; null when there is nothing useful to add. */
  hint: string | null;
}

/** One line for `unavailable_reason` and sync errors: the message, then what to do about it. */
export const reasonOf = (f: AccessFailure): string => (f.hint ? `${f.message} ${f.hint}` : f.message);

/**
 * The repository itself can no longer be read (rather than one of its sections): why, from a failed request. The sync
 * marks a repo added by hand unavailable with it. Null for every other failure, a section the token may not read
 * ('permission') included, which stays an ordinary error of that repo.
 */
export function accessLost(err: unknown): AccessFailure | null {
  return err instanceof SourceError && err.access && err.access.problem !== 'permission' ? err.access : null;
}
