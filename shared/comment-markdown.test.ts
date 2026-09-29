import { describe, expect, it } from 'vitest';
import type { CommentThread, Principal } from './api';
import { threadsMarkdown } from './comment-markdown';

const you: Principal = { id: 1, kind: 'self', name: 'You' };
const bot: Principal = { id: 2, kind: 'agent', name: 'Reviewer' };
let nextId = 1;

function thread(over: Partial<CommentThread>, bodies: [Principal, string][] = [[you, 'Why?']]): CommentThread {
  return {
    id: nextId++, kind: 'pr', repo: 'app', number: 2, commitOid: '0123456789'.repeat(4), baseOid: null,
    path: null, side: null, startLine: null, endLine: null, snippet: null, status: 'open', resolvedAt: null,
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
    expect(threadsMarkdown([thread({ kind: 'commit', number: null })])).toMatch(/^### Commit\n/);
    expect(threadsMarkdown([])).toBe('');
  });
});
