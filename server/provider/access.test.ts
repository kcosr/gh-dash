import { describe, expect, it } from 'vitest';
import { GitHubError, withRetries } from '../github/transport';
import { GitLabError, GitLabTransport } from '../gitlab/transport';
import { fakeGitLab } from '../test/gitlab';
import { type AccessFailure, accessLost, reasonOf } from './access';
import { SourceError } from './errors';

const gone: AccessFailure = { problem: 'not-found', message: "The host doesn't show alice/app to this token.", hint: 'Check the path.' };
const sections: AccessFailure = { problem: 'permission', message: 'The token can see alice/app but not its issues.', hint: null };

describe('AccessFailure', () => {
  it('is one line for the stored reason: the message, then the hint', () => {
    expect(reasonOf(gone)).toBe("The host doesn't show alice/app to this token. Check the path.");
    expect(reasonOf(sections)).toBe('The token can see alice/app but not its issues.');
  });

  it('marks a repository lost only when the failure is the repository itself, whatever the provider', () => {
    expect(accessLost(new SourceError('not-found', 'gone', { access: gone }))).toBe(gone);
    expect(accessLost(new GitLabError('forbidden', 'refused', { access: { ...gone, problem: 'org-policy' } }))).toMatchObject({ problem: 'org-policy' });
    // A section the token may not read, a failure without an access verdict, and other errors are ordinary errors.
    expect(accessLost(new GitHubError('forbidden', 'no issues', { access: sections }))).toBeNull();
    expect(accessLost(new SourceError('not-found', 'no such PR'))).toBeNull();
    expect(accessLost(new Error('boom'))).toBeNull();
    expect(new SourceError('transient', 'later').access).toBeNull();
  });

  it("survives each client's redaction of the error", async () => {
    const token = 'glpat-fake-token-0123';
    const github = await withRetries({ token, maxAttempts: 1, sleep: async () => {} }, async () => {
      throw new GitHubError('not-found', `lost with ${token}`, { access: gone });
    }).catch((e: unknown) => e as GitHubError);
    expect([github.message, github.access]).toEqual(['lost with [token]', gone]);

    const transport = new GitLabTransport({ baseUrl: 'https://gitlab.example.com', token, fetchImpl: fakeGitLab({ '/api/v4/x': { body: {} } }, 'https://gitlab.example.com').fetchImpl }, { maxAttempts: 1, maxRetryWaitMs: 0 });
    const gitlab = await transport.send(transport.url('/api/v4/x'), async () => {
      throw new GitLabError('not-found', `lost with ${token}`, { access: gone });
    }).catch((e: unknown) => e as GitLabError);
    expect([gitlab.message, gitlab.access]).toEqual(['lost with [token]', gone]);
  });
});
