// Errors any source (GitHub, GitLab, …) raises for a failed request. Callers branch on `kind`, never on the class of a
// particular provider's error, so the sync and the diff service treat every provider alike.

export type SourceErrorKind = 'auth' | 'rate-limit' | 'transient' | 'graphql' | 'http' | 'not-found';

export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  /** HTTP status the provider answered with, when the error came from a response. */
  readonly status: number | null;
  /** For 'rate-limit': when requests may resume (ISO), if known. */
  readonly resetAt: string | null;
  constructor(kind: SourceErrorKind, message: string, opts: { status?: number | null; resetAt?: string | null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.resetAt = opts.resetAt ?? null;
  }
}

/** Errors that stop a whole sync run rather than one repo: the token is bad, or the provider wants us to wait. */
export const isFatalSourceError = (err: unknown): boolean =>
  err instanceof SourceError && (err.kind === 'auth' || err.kind === 'rate-limit');
