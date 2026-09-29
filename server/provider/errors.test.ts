import { describe, expect, it } from 'vitest';
import { GitHubError } from '../github/transport';
import { isFatalSourceError, SourceError } from './errors';

describe('SourceError', () => {
  it('is what GitHub errors are, so provider-neutral code can branch on kind', () => {
    const err = new GitHubError('rate-limit', 'limit exhausted', { status: 403, resetAt: '2026-09-29T12:00:00Z' });
    expect(err).toBeInstanceOf(SourceError);
    expect(err.name).toBe('GitHubError');
    expect([err.kind, err.status, err.resetAt]).toEqual(['rate-limit', 403, '2026-09-29T12:00:00Z']);
  });

  it('treats auth and rate-limit failures as fatal for a sync run', () => {
    expect(isFatalSourceError(new SourceError('auth', 'bad token'))).toBe(true);
    expect(isFatalSourceError(new GitHubError('rate-limit', 'wait'))).toBe(true);
    expect(isFatalSourceError(new SourceError('transient', 'try again'))).toBe(false);
    expect(isFatalSourceError(new Error('other'))).toBe(false);
  });
});
