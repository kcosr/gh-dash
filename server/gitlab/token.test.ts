import { describe, expect, it } from 'vitest';
import { BASE, fakeGitLab } from '../test/gitlab';
import { personalAccessToken } from './token';

const SELF = '/api/v4/personal_access_tokens/self';
const token = (over: Record<string, unknown> = {}) => ({
  id: 7, name: 'gh-dash', revoked: false, created_at: '2026-01-01T00:00:00.000Z', description: null, scopes: ['read_api'],
  user_id: 2, last_used_at: null, active: true, granular: false, expires_at: '2026-12-31', ...over,
});

describe('personalAccessToken', () => {
  it('reports scopes and expiry', async () => {
    const { fetchImpl, requests } = fakeGitLab({ [SELF]: { body: token() } });
    expect(await personalAccessToken({ baseUrl: BASE, token: 'glpat-x', fetchImpl })).toEqual({
      name: 'gh-dash', scopes: ['read_api'], canRead: true, expiresAt: '2026-12-31', active: true,
    });
    expect(requests).toEqual([SELF]);
  });

  it('tells a token that cannot read the API', async () => {
    const { fetchImpl } = fakeGitLab({ [SELF]: { body: token({ scopes: ['read_repository'], expires_at: null }) } });
    expect(await personalAccessToken({ baseUrl: BASE, token: 'glpat-x', fetchImpl })).toMatchObject({ canRead: false, expiresAt: null });
  });

  it('has nothing to say about other kinds of token, and fails on a bad one', async () => {
    const oauth = fakeGitLab({ [SELF]: { status: 400, body: { message: '400 Bad request - This endpoint requires token type to be a personal access token' } } });
    expect(await personalAccessToken({ baseUrl: BASE, token: 'oauth-x', fetchImpl: oauth.fetchImpl })).toBeNull();
    const revoked = fakeGitLab({ [SELF]: { status: 401, body: { error: 'invalid_token', error_description: 'Token was revoked. You have to re-authorize from the user.' } } });
    await expect(personalAccessToken({ baseUrl: BASE, token: 'glpat-x', fetchImpl: revoked.fetchImpl })).rejects.toMatchObject({ kind: 'auth' });
  });
});
