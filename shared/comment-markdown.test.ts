import { describe, expect, it } from 'vitest';
import type { CommentThread, Principal } from './api';
import { branchRef, commentExcerpt, threadsMarkdown } from './comment-markdown';
import { PROVIDERS } from './provider';

const you: Principal = { id: 1, kind: 'self', name: 'You' };
const bot: Principal = { id: 2, kind: 'agent', name: 'Reviewer' };
let nextId = 1;

function thread(over: Partial<CommentThread>, bodies: [Principal, string][] = [[you, 'Why?']]): CommentThread {
  return {
    id: nextId++, kind: 'pr', repo: 'app', number: 2, branch: null, commitOid: '0123456789'.repeat(4), baseOid: null,
    path: null, side: null, startLine: null, endLine: null, snippet: null, status: 'open', resolvedAt: null, resolvedBy: null,
    createdAt: '2026-09-29T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z',
    comments: bodies.map(([author, body], i) => ({ id: 100 + i, author, body, createdAt: '2026-09-29T10:00:00.000Z', editedAt: null })),
    ...over,
  };
}

describe('threadsMarkdown', () => {
  it('orders general, file and line threads and quotes the snippet', () => {
    const lines = thread({ path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, snippet: 'const a = 1;\nconst b = 2;' }, [
      [you, 'Why two?'],
      [bot, 'Because:\n\n```ts\nconst c = 3;\n```'],
    ]);
    const file = thread({ path: 'src/a.ts' }, [[you, 'Split this file.']]);
    const general = thread({ status: 'resolved' }, [[you, '  Looks good.  ']]);
    const oneLine = thread({ path: 'README.md', side: 'old', startLine: 7, endLine: 7, snippet: 'Use ```code```.' });
    expect(threadsMarkdown([lines, file, oneLine, general], { title: 'app#2' })).toBe(
      [
        '# app#2',
        '### Pull request · resolved',
        '- **You**: Looks good.',
        '### `README.md` line 7 (old)',
        '````md\nUse ```code```.\n````',
        '- **You**: Why?',
        '### `src/a.ts`',
        '- **You**: Split this file.',
        '### `src/a.ts` lines 3–4 (new)',
        '```ts\nconst a = 1;\nconst b = 2;\n```',
        '- **You**: Why two?\n- **Reviewer**: Because:\n\n  ```ts\n  const c = 3;\n  ```',
      ].join('\n\n') + '\n',
    );
  });

  it('fences a maximum-size snippet made of backtick runs', () => {
    // 256 KiB, the API's cap: 131,000 one-backtick runs, one of five, and padding.
    const snippet = ('`x'.repeat(131_000) + '`````').padEnd(256 * 1024, 'x');
    const md = threadsMarkdown([thread({ path: 'a.md', side: 'new', startLine: 1, endLine: 1, snippet })]);
    expect(md.startsWith(`### \`a.md\` line 1 (new)\n\n\`\`\`\`\`\`md\n${snippet}\n\`\`\`\`\`\`\n`)).toBe(true);
  });

  it('shows where the diff on screen placed each thread', () => {
    const moved = thread({ path: 'a.ts', side: 'new', startLine: 3, endLine: 3, snippet: 'x' });
    const gone = thread({ kind: 'commit', number: null, path: 'b.ts', side: 'new', startLine: 5, endLine: 6, snippet: 'y\nz', status: 'resolved' });
    const placements = new Map([
      [moved.id, { kind: 'line' as const, path: 'a.ts', side: 'new' as const, startLine: 9, endLine: 9, relocated: true }],
      [gone.id, { kind: 'outdated' as const, path: 'b.ts', reason: 'lines' as const }],
    ]);
    const md = threadsMarkdown([moved, gone], { placements });
    expect(md).toContain('### `a.ts` line 9 (new)\n');
    expect(md).toContain('### `b.ts` lines 5–6 (new) · outdated, made on 0123456 · resolved\n');
    expect(threadsMarkdown([thread({})])).toBe('### Pull request\n\n- **You**: Why?\n');
    expect(threadsMarkdown([thread({})], { provider: PROVIDERS.gitlab })).toBe('### Merge request\n\n- **You**: Why?\n');
    expect(threadsMarkdown([thread({ kind: 'commit', number: null })])).toMatch(/^### Commit\n/);
    expect(threadsMarkdown([thread({ kind: 'branch', number: null, branch: 'fix/login' })])).toMatch(/^### Branch\n/);
    expect(threadsMarkdown([])).toBe('');
  });

  it("says where a thread of the target's branch group was made, when it wasn't on the target itself", () => {
    const own = thread({ path: 'a.ts', branch: 'fix/login' }, [[you, 'Own']]);
    const otherPr = thread({ number: 1, path: 'a.ts', side: 'new', startLine: 2, endLine: 2, snippet: 'x', status: 'resolved', branch: 'fix/login' }, [[you, 'On #1']]);
    const otherPrWhole = thread({ number: 1, branch: 'fix/login' }, [[you, 'All of #1']]);
    const onBranch = thread({ kind: 'branch', number: null, branch: 'fix/login', path: 'b.ts' }, [[bot, 'On the branch']]);
    const onBranchWhole = thread({ kind: 'branch', number: null, branch: 'fix/login' }, [[bot, 'All of the branch']]);
    const all = [own, otherPr, otherPrWhole, onBranch, onBranchWhole];
    const headings = (md: string) => md.split('\n').filter((l) => l.startsWith('#'));
    expect(headings(threadsMarkdown(all, { title: 'app#2', target: { kind: 'pr', number: 2 } }))).toEqual([
      '# app#2',
      '### Pull request · from #1',
      '### Branch',
      '### `a.ts`',
      '### `a.ts` line 2 (new) · from #1 · resolved',
      '### `b.ts` · from the branch review',
    ]);
    expect(headings(threadsMarkdown(all, { target: { kind: 'branch', number: null } }))).toEqual([
      '### Pull request · from #1',
      '### Branch',
      '### `a.ts` · from #2',
      '### `a.ts` line 2 (new) · from #1 · resolved',
      '### `b.ts`',
    ]);
    expect(headings(threadsMarkdown([otherPr], { target: { kind: 'pr', number: 2 }, provider: PROVIDERS.gitlab }))).toEqual(['### `a.ts` line 2 (new) · from !1 · resolved']);
    // Without a target (the list of one target's own threads, as before branch groups), nothing is noted.
    expect(headings(threadsMarkdown(all))).toEqual(['### Pull request', '### Branch', '### `a.ts`', '### `a.ts` line 2 (new) · resolved', '### `b.ts`']);
  });

  it('names a branch as the other refs are named', () => {
    expect(branchRef('alice/app', 'fix/login')).toBe('alice/app branch fix/login');
  });
});

describe('commentExcerpt', () => {
  it("keeps a comment's words as one line of plain text", () => {
    expect(commentExcerpt('Why **two** `consts`?\n\nSee [the docs](https://x.example) and ~~this~~.')).toBe('Why two consts? See the docs and this.');
    expect(commentExcerpt('## Heading\n> quoted\n- [ ] task\n1. step\n<details><summary>More</summary>hidden</details><!-- note -->')).toBe(
      'Heading quoted task step Morehidden',
    );
    expect(commentExcerpt('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(commentExcerpt('a < b and c > d, ![alt](img.png)')).toBe('a < b and c > d, alt');
    expect(commentExcerpt('  \r\n  ')).toBe('');
  });

  it('stays quick on bodies made to be slow to parse', () => {
    for (const body of ['['.repeat(65_536), '!['.repeat(32_768), '<!--'.repeat(16_384), `${'a '.repeat(30_000)}[x](y)`]) {
      const t0 = performance.now();
      expect(commentExcerpt(body).length).toBeLessThanOrEqual(280);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });

  it('cuts at 280 characters with an ellipsis, never inside a character', () => {
    expect(commentExcerpt('x'.repeat(280))).toBe('x'.repeat(280));
    expect(commentExcerpt('x'.repeat(281))).toBe(`${'x'.repeat(279)}…`);
    const emoji = commentExcerpt('😀'.repeat(300));
    expect(Array.from(emoji)).toHaveLength(280);
    expect(emoji.endsWith('😀…')).toBe(true);
    expect(commentExcerpt('one two three', 8)).toBe('one two…');
  });
});
