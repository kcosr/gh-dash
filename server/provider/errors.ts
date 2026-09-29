// Errors any source (GitHub, GitLab, …) raises for a failed request. Callers branch on `kind`, never on the class of a
// particular provider's error, so the sync and the diff service treat every provider alike.

import type { AccessFailure } from './access';

/** 'forbidden': the provider knows the resource but refuses this token (SSO, an organization policy, missing permission). */
export type SourceErrorKind = 'auth' | 'rate-limit' | 'transient' | 'graphql' | 'http' | 'not-found' | 'forbidden';

export interface SourceErrorOptions {
  status?: number | null;
  resetAt?: string | null;
  access?: AccessFailure | null;
}

export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  /** HTTP status the provider answered with, when the error came from a response. */
  readonly status: number | null;
  /** For 'rate-limit': when requests may resume (ISO), if known. */
  readonly resetAt: string | null;
  /**
   * Why the token can't read the repository the request was about, when the source could tell: set on a failure of the
   * repository itself (it no longer exists or the token lost it), or on one of its sections ('permission'). Null for
   * everything else. See provider/access `accessLost`.
   */
  readonly access: AccessFailure | null;
  constructor(kind: SourceErrorKind, message: string, opts: SourceErrorOptions = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.resetAt = opts.resetAt ?? null;
    this.access = opts.access ?? null;
  }
}

/** Errors that stop a whole sync run rather than one repo: the token is bad, or the provider wants us to wait. */
export const isFatalSourceError = (err: unknown): boolean =>
  err instanceof SourceError && (err.kind === 'auth' || err.kind === 'rate-limit');
