/**
 * Comment threads as Markdown: what "Copy as Markdown" in the diff viewer puts on the clipboard and what
 * GET .../threads?format=md returns, to paste into an issue, a chat or an agent's prompt. Shared, so both say the same.
 */
import type { CommentThread, ThreadComment } from './api';
import type { ThreadPlacement } from './comment-placement';

export interface ThreadsMarkdownOptions {
  /** Top heading, e.g. "gh-dash#12". */
  title?: string;
  /**
   * Placement in the diff on screen (the server has none): relocated threads show their current lines, outdated
   * ones are marked. Without it, threads show the lines they were made on.
   */
  placements?: ReadonlyMap<number, ThreadPlacement>;
}

/**
 * A fence longer than any backtick run inside `code`, so the snippet can't close it early. Counted in a loop: a
 * snippet can hold ~100k runs, too many to spread into Math.max's arguments.
 */
function fence(code: string): string {
  let longest = 0;
  for (const run of code.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const extension = (path: string) => /\.([\w+-]+)$/.exec(path)?.[1] ?? '';
const lineRange = (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start}–${end}`);

function heading(t: CommentThread, placement: ThreadPlacement | undefined): string {
  const notes: string[] = [];
  let where: string;
  if (t.path === null) where = t.kind === 'pr' ? 'Pull request' : 'Commit';
  else if (t.side === null || t.startLine === null || t.endLine === null) where = `\`${t.path}\``;
  else {
    const at = placement?.kind === 'line' ? placement : { startLine: t.startLine, endLine: t.endLine };
    where = `\`${t.path}\` ${lineRange(at.startLine, at.endLine)} (${t.side})`;
  }
  if (placement?.kind === 'outdated') notes.push(`outdated, made on ${t.commitOid.slice(0, 7)}`);
  if (t.status === 'resolved') notes.push('resolved');
  return `### ${where}${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
}

/** A list item; continuation lines are indented so multi-line bodies (and their code blocks) stay inside it. */
const comment = (c: ThreadComment) =>
  `- **${c.author.name}**: ${c.body.trim().split('\n').map((line, i) => (i && line ? `  ${line}` : line)).join('\n')}`;

/** General threads first, then by file and line (file-level threads before their file's lines). */
function compare(a: CommentThread, b: CommentThread): number {
  if (a.path !== b.path) return a.path === null ? -1 : b.path === null ? 1 : a.path < b.path ? -1 : 1;
  return (a.startLine ?? 0) - (b.startLine ?? 0) || a.id - b.id;
}

export function threadsMarkdown(threads: readonly CommentThread[], opts: ThreadsMarkdownOptions = {}): string {
  const parts: string[] = opts.title ? [`# ${opts.title}`] : [];
  for (const t of [...threads].sort(compare)) {
    const lines = [heading(t, opts.placements?.get(t.id))];
    if (t.snippet !== null && t.path !== null) {
      const f = fence(t.snippet);
      lines.push(`${f}${extension(t.path)}\n${t.snippet}\n${f}`);
    }
    lines.push(t.comments.map(comment).join('\n'));
    parts.push(lines.join('\n\n'));
  }
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}
