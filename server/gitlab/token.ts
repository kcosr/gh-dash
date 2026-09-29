import { GitLabRestClient } from './rest';
import { GitLabError, GitLabTransport, type GitLabOptions } from './transport';
import type { RestTokenInfo } from './types';

export interface GitLabTokenInfo {
  name: string;
  scopes: string[];
  /** Whether the scopes let the dashboard read (read_api, or the broader api). */
  canRead: boolean;
  /** The day it stops working ("2026-12-31"); null if it never expires. */
  expiresAt: string | null;
  active: boolean;
}

/**
 * What GitLab says about an access token (personal, or a group or project token, which are a bot user's personal
 * token), e.g. to warn before it expires or name a missing scope. null for other kinds, such as OAuth tokens, which
 * GitLab won't describe (400).
 */
export async function personalAccessToken(opts: GitLabOptions, signal?: AbortSignal): Promise<GitLabTokenInfo | null> {
  const rest = new GitLabRestClient(new GitLabTransport(opts, { maxAttempts: 3, maxRetryWaitMs: 10_000 }));
  try {
    const t = await rest.json<RestTokenInfo>('/personal_access_tokens/self', { signal });
    return { name: t.name, scopes: t.scopes, canRead: t.scopes.includes('read_api') || t.scopes.includes('api'), expiresAt: t.expires_at, active: t.active };
  } catch (err) {
    if (err instanceof GitLabError && err.status === 400) return null;
    throw err;
  }
}
