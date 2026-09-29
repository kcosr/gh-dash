// GitLab's per-file diff text in the shape the app's DiffFile.patch has (GitHub's): hunks only, no file headers.

/**
 * The hunks of a file's diff, from its first "@@" line, without the trailing newline. Whatever precedes that line is
 * header ("--- a/…" / "+++ b/…" with unidiff=true, git's "diff --git" / "index" lines). null when there is no hunk:
 * binary files ("Binary files … differ"), and changes without content such as mode changes or pure renames.
 */
export function hunks(diff: string | null | undefined): string | null {
  if (!diff) return null;
  const start = /^@@/m.exec(diff)?.index;
  if (start === undefined) return null;
  return diff.slice(start).replace(/\r?\n$/, '');
}

/** Added and removed lines of a patch (GitLab reports no per-file counts). Hunk headers and "\ No newline" don't count. */
export function countLines(patch: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  if (patch) {
    for (const line of patch.split('\n')) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}
