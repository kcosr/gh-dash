/**
 * Credential rules shared by the server (validation, logs) and the web (Settings): when to warn about expiry, and
 * what a GitLab token's scopes allow. Pure, so both sides agree.
 */

/** Warn this long before a token expires. */
export const EXPIRY_WARN_DAYS = 14;

/** GitLab scopes that let gh-dash read everything it syncs (read_api, or the broader api). */
export const GITLAB_READ_SCOPES: readonly string[] = ['read_api', 'api'];
/** GitLab scopes that can change things: gh-dash never needs them. */
export const GITLAB_WRITE_SCOPES: readonly string[] = ['api', 'write_repository'];

export function gitlabCanRead(scopes: readonly string[]): boolean {
  return scopes.some((s) => GITLAB_READ_SCOPES.includes(s));
}

/** The token's scopes that can change things on GitLab (empty when none, or when the scopes are unknown). */
export function gitlabWriteScopes(scopes: readonly string[] | null): string[] {
  return (scopes ?? []).filter((s) => GITLAB_WRITE_SCOPES.includes(s));
}

/** "This token can change things on GitLab (api scope). …", or null when it can't (or its scopes are unknown). */
export function gitlabWriteWarning(scopes: readonly string[] | null): string | null {
  const write = gitlabWriteScopes(scopes);
  if (!write.length) return null;
  const which = write.length === 1 ? `${write[0]} scope` : `${write.join(' and ')} scopes`;
  return `This token can change things on GitLab (${which}). gh-dash only reads: a read_api token is enough.`;
}

/** The instance's new-token page, pre-filled for gh-dash with just read_api. `baseUrl` has no trailing slash. */
export function gitlabTokenCreateUrl(baseUrl: string): string {
  return `${baseUrl}/-/user_settings/personal_access_tokens?name=gh-dash&scopes=read_api`;
}
