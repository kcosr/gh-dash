/**
 * Comment threads as Markdown: what "Copy as Markdown" in the diff viewer puts on the clipboard and what
 * GET .../threads?format=md returns, to paste into an issue, a chat or an agent's prompt. Shared, so both say the same.
 */
import type { CommentThread, ThreadComment } from './api';
import type { ThreadPlacement } from './comment-placement';
import { capitalize, PROVIDERS, type Provider } from './provider';

export interface ThreadsMarkdownOptions {
  /** Top heading, e.g. "gh-dash#12" (or "app!12" for a GitLab merge request). */
  title?: string;
  /** The repo's code host: a PR-level thread is headed "Pull request" or "Merge request". GitHub when absent. */
  provider?: Pick<Provider, 'pr'>;
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

/** The most an excerpt holds: what Activity and agents see of a comment. */
export const EXCERPT_CHARS = 280;

/**
 * A comment as one line of plain text, at most `max` characters (an ellipsis marks a cut). Markdown's syntax goes: links
 * and images keep their text, code fences and inline code their code; quote, list and heading marks and HTML tags go;
 * whitespace collapses. Counted in code points, so a cut never splits one.
 */
export function commentExcerpt(body: string, max = EXCERPT_CHARS): string {
  // Only the start can show: a bounded input keeps the patterns below cheap on any body (a 64k run of `[` included).
  const plain = body
    .slice(0, max * 16)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*(?:```|~~~).*$/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^<>\n]*>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const extension = (path: string) => /\.([\w+-]+)$/.exec(path)?.[1] ?? '';
const lineRange = (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start}–${end}`);

function heading(t: CommentThread, placement: ThreadPlacement | undefined, p: Pick<Provider, 'pr'>): string {
  const notes: string[] = [];
  let where: string;
  if (t.path === null) where = t.kind === 'pr' ? capitalize(p.pr.one) : 'Commit';
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
    const lines = [heading(t, opts.placements?.get(t.id), opts.provider ?? PROVIDERS.github)];
    if (t.snippet !== null && t.path !== null) {
      const f = fence(t.snippet);
      lines.push(`${f}${extension(t.path)}\n${t.snippet}\n${f}`);
    }
    lines.push(t.comments.map(comment).join('\n'));
    parts.push(lines.join('\n\n'));
  }
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}
