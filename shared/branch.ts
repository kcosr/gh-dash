/**
 * Branch names, as git allows them for a branch (`git check-ref-format --branch`), so a name from a URL or an agent is
 * checked before it is put in a code host's API path or the database. Also the one place that knows which characters a
 * branch name can't contain: the web app's diff id uses one of them ('~') to separate the repo from the branch.
 */

/** Longest name accepted: git has no limit, but code hosts do (GitHub: 255 bytes for a ref). */
export const MAX_BRANCH_CHARS = 255;

/**
 * Whether `name` is a valid branch name: not empty or "@", no control characters, space or any of ~ ^ : ? * [ \,
 * no "..", "@{" or "//", no leading "-" or "/", no trailing "/" or ".", and no path component starting with "." or
 * ending with ".lock".
 */
export function isBranchName(name: string): boolean {
  if (!name || name.length > MAX_BRANCH_CHARS || name === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Whether `q` can narrow a branch list (GET /branches/:repo's `q`, which the code host matches anywhere in a name): so
 * not a whole name's rules ("feature/" and "/login" are fine), only the list's: not blank, and once trimmed at most
 * MAX_BRANCH_CHARS long, with no control characters.
 */
export function isBranchQuery(q: string): boolean {
  const t = q.trim();
  return t.length > 0 && t.length <= MAX_BRANCH_CHARS && !/[\x00-\x1f\x7f]/.test(t);
}
