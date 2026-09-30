import { describe, expect, it } from 'vitest';
import { exportTarget, exportUrl, threadCountParams, threadListParams } from '../web/src/lib/apiQuery';
import { canonicalQuery, carrySearch, parseAuthor, parseUrlState, patchSearch } from '../web/src/lib/urlState';

describe('Comments: Author and Waiting on you in the URL', () => {
  it('reads author and waiting on /comments only', () => {
    expect(parseUrlState('?author=self&waiting=you', 'comments')).toMatchObject({ author: 'self', waiting: true });
    expect(parseUrlState('?author=agents', 'comments')).toMatchObject({ author: 'agents', waiting: false });
    expect(parseUrlState('?author=12', 'comments').author).toBe(12);
    // Anything else is anyone, and waiting only for `you`.
    for (const v of ['me', 'you', '0', '-1', '1.5', 'x', '']) expect(parseAuthor(v), v).toBeNull();
    expect(parseUrlState('?waiting=1', 'comments').waiting).toBe(false);
    for (const view of ['prs', 'issues', 'activity', 'repos', 'insights'] as const) {
      expect(parseUrlState('?author=self&waiting=you', view), view).toMatchObject({ author: null, waiting: false });
    }
  });

  it('writes them after the status and kind, and leaves them out when off', () => {
    expect(patchSearch('?status=all&q=x', 'comments', { author: 3, waiting: true })).toBe('?status=all&author=3&waiting=you&q=x');
    expect(patchSearch('?author=3&waiting=you', 'comments', { author: null, waiting: false })).toBe('');
    expect(patchSearch('', 'comments', { author: 'agents' })).toBe('?author=agents');
  });

  it("means nothing on the other views, which drop them, and isn't carried across tabs", () => {
    expect(patchSearch('?author=self&waiting=you&state=open', 'prs', {})).toBe('?state=open');
    expect(carrySearch('?source=github.com&author=self&waiting=you')).toBe('?source=github.com');
  });

  it('asks the API for them, exports them, and leaves the tab count alone', () => {
    const s = parseUrlState('?repos=alice/app&author=agents&waiting=you&status=open', 'comments');
    expect(threadListParams(s)).toMatchObject({ repos: 'alice/app', status: 'open', author: 'agents', waiting: 'you' });
    expect(threadListParams(parseUrlState('?author=7', 'comments')).author).toBe(7);
    const none = threadListParams(parseUrlState('', 'comments'));
    expect([none.author, none.waiting]).toEqual([undefined, undefined]);
    expect(exportUrl(exportTarget('comments', parseUrlState('?author=7&waiting=you', 'comments')))).toBe('/api/v1/threads?status=open&author=7&waiting=you');
    expect(threadCountParams(s)).toEqual({ source: undefined, repos: 'alice/app', visibility: undefined, ownership: undefined, status: 'open', limit: 1 });
  });

  it('is part of a saved view (they compare with it)', () => {
    expect(canonicalQuery('?waiting=you&author=self&diff=a%23%31')).toBe('author=self&waiting=you');
  });
});
