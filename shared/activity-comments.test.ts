import { describe, expect, it } from 'vitest';
import type { ActivityEvent, CommentActivity, CommentEventKind, Principal } from './api';
import { EVENT_TYPES } from './api';
import { activityParams } from '../web/src/lib/apiQuery';
import { commentEventWords, commentPlace, commentSummary, groupFeed } from '../web/src/lib/grouping';
import type { CommentEvent } from '../web/src/lib/grouping';
import { parseUrlState, patchSearch } from '../web/src/lib/urlState';

const you: Principal = { id: 1, kind: 'self', name: 'You' };
const claude: Principal = { id: 3, kind: 'agent', name: 'Claude' };
const codex: Principal = { id: 4, kind: 'agent', name: 'Codex' };
let seq = 0;

/** A comment event `min` minutes after 10:00 local time on 2026-09-28 (a Monday). */
function ev(kind: CommentEventKind, by: Principal, o: Partial<CommentActivity> & { min?: number; day?: number; repo?: string } = {}): CommentEvent {
  const { min = 0, day = 28, repo = 'kcosr/sedes', ...c } = o;
  const eventId = c.eventId ?? ++seq;
  return {
    type: 'comment', kind, at: new Date(2026, 8, day, 10, min).toISOString(), repo,
    actor: { login: null, name: by.name, avatarUrl: null, isMe: by.kind === 'self' },
    comment: {
      eventId, threadId: 1, commentId: ['resolved', 'reopened', 'thread_deleted'].includes(kind) ? null : eventId * 10, live: true, by,
      target: { kind: 'pr', number: 17, title: 'Fix the race' }, commitOid: 'a'.repeat(40),
      path: 'packages/opencode/src/host.ts', side: 'new', startLine: 42, endLine: 44, excerpt: `comment ${eventId}`, view: { kind: 'pr', number: 17 }, ...c,
    },
  };
}

const rows = (events: ActivityEvent[]) => groupFeed([...events].sort((a, b) => b.at.localeCompare(a.at)), new Date(2026, 8, 29, 12));

describe('Activity: comment events', () => {
  it('is an event type of its own, asked for like the others', () => {
    expect(EVENT_TYPES).toContain('comment');
    expect(parseUrlState('', 'activity').types).toContain('comment');
    // All types: no `types=`. The other five: an explicit list without comments.
    expect(activityParams(parseUrlState('', 'activity')).types).toBeUndefined();
    expect(activityParams(parseUrlState('?types=commit,pr,issue,release,star', 'activity')).types).toBe('commit,pr,issue,release,star');
    expect(activityParams(parseUrlState('?types=comment', 'activity')).types).toBe('comment');
    expect(patchSearch('', 'activity', { types: EVENT_TYPES.filter((t) => t !== 'comment') })).toBe('?types=commit,pr,issue,release,star');
  });

  it('groups per person or agent, per PR or commit, per day', () => {
    const feed = rows([
      ev('replied', claude, { min: 1, threadId: 1 }),
      ev('replied', claude, { min: 2, threadId: 2 }),
      ev('replied', claude, { min: 3, threadId: 3 }),
      ev('resolved', you, { min: 4, threadId: 1 }),
      // Another agent, another PR, another day, a commit: rows of their own.
      ev('replied', codex, { min: 5, threadId: 1 }),
      ev('replied', claude, { min: 6, threadId: 9, target: { kind: 'pr', number: 18, title: null } }),
      ev('replied', claude, { min: 7, threadId: 1, day: 27 }),
      ev('thread_opened', claude, { min: 8, threadId: 5, target: { kind: 'commit', oid: 'b'.repeat(40), title: 'Tidy' } }),
    ]);
    expect(feed.map((d) => d.key)).toEqual(['2026-09-28', '2026-09-27']);
    const day = feed[0]!;
    expect(day.count).toBe(7);
    const shape = day.rows.map((r) => (r.kind === 'comments' ? [r.actor.name, r.target.kind === 'pr' ? `#${r.target.number}` : '@', r.events.map((e) => e.comment.threadId)] : r.kind));
    expect(shape).toEqual([
      ['Claude', '@', [5]],
      ['Claude', '#18', [9]],
      ['Codex', '#17', [1]],
      ['You', '#17', [1]],
      ['Claude', '#17', [3, 2, 1]],
    ]);
    // Newest first within a row; the row is as new as its newest event.
    const claude17 = day.rows[4]!;
    expect(claude17.at.getMinutes()).toBe(3);
  });

  it("groups a branch's events per branch, apart from a PR from it", () => {
    const feed = rows([
      ev('thread_opened', you, { min: 1, threadId: 1, target: { kind: 'branch', branch: 'fix/a', title: null } }),
      ev('replied', you, { min: 2, threadId: 2, target: { kind: 'branch', branch: 'fix/a', title: null } }),
      ev('replied', you, { min: 3, threadId: 3, target: { kind: 'branch', branch: 'fix/b', title: null } }),
      ev('replied', you, { min: 4, threadId: 4 }),
    ]);
    const shape = feed[0]!.rows.map((r) => (r.kind === 'comments' ? [r.target.kind === 'branch' ? r.target.branch : r.target.kind, r.events.map((e) => e.comment.threadId)] : r.kind));
    expect(shape).toEqual([['pr', [4]], ['fix/b', [3]], ['fix/a', [2, 1]]]);
  });

  it('keeps an event once, however the pages overlap', () => {
    const e = ev('replied', claude, { eventId: 900 });
    const feed = rows([e, { ...e }]);
    expect(feed[0]!.count).toBe(1);
  });

  it("sits among the day's other events in time order", () => {
    const star: ActivityEvent = { type: 'star', at: new Date(2026, 8, 28, 10, 5).toISOString(), repo: 'kcosr/sedes', actor: { login: 'bob', name: null, avatarUrl: null, isMe: false } };
    const feed = rows([ev('replied', claude, { min: 1 }), star, ev('replied', claude, { min: 9, threadId: 2 })]);
    expect(feed[0]!.rows.map((r) => r.kind)).toEqual(['comments', 'stars']);
  });

  it('names one event by its place, several by what was done to how many', () => {
    expect(commentSummary([ev('resolved', you)])).toBe('resolved host.ts:42–44');
    expect(commentSummary([ev('thread_opened', claude, { startLine: 7, endLine: 7 })])).toBe('commented on host.ts:7');
    expect(commentSummary([ev('replied', claude, { path: null, side: null, startLine: null, endLine: null })])).toBe('replied');
    expect(commentSummary([ev('thread_deleted', claude, { startLine: null, endLine: null })])).toBe('deleted a thread on host.ts');
    // Two replies on one thread: still its place.
    expect(commentSummary([ev('replied', claude), ev('replied', claude)])).toBe('replied on host.ts:42–44');
    expect(commentSummary([1, 2, 3].map((threadId) => ev('replied', claude, { threadId })))).toBe('replied to 3 threads');
    expect(commentSummary([ev('thread_opened', claude, { threadId: 1 }), ev('thread_opened', claude, { threadId: 2 }), ev('replied', claude, { threadId: 3 }), ev('replied', claude, { threadId: 4 }), ev('replied', claude, { threadId: 5 })]))
      .toBe('opened 2 threads and replied to 3');
    expect(commentSummary([ev('resolved', you, { threadId: 1 }), ev('thread_opened', you, { threadId: 2 })])).toBe('opened a thread and resolved one');
    expect(commentSummary([ev('edited', claude), ev('edited', claude), ev('resolved', claude, { threadId: 2 })])).toBe('edited 2 comments and resolved a thread');
    // One comment edited twice is one comment; two of a thread's comments deleted are two.
    expect(commentSummary([ev('edited', claude, { commentId: 7 }), ev('edited', claude, { commentId: 7 }), ev('resolved', claude, { threadId: 2 })]))
      .toBe('edited a comment and resolved a thread');
    expect(commentSummary([ev('edited', claude, { commentId: 7 }), ev('edited', claude, { commentId: 7 })])).toBe('edited a comment on host.ts:42–44');
    expect(commentSummary([ev('comment_deleted', you, { commentId: 7 }), ev('comment_deleted', you, { commentId: 8 })])).toBe('deleted 2 comments');
    expect(commentSummary([ev('replied', claude, { threadId: 1 }), ev('edited', claude), ev('reopened', claude, { threadId: 2 })])).toBe('replied to a thread, edited a comment and reopened a thread');
  });

  it("words places as the diff's comments do: the file's name and its lines", () => {
    expect(commentPlace({ path: 'a/b/c.ts', startLine: 3, endLine: 3 })).toBe('c.ts:3');
    expect(commentPlace({ path: 'README.md', startLine: 3, endLine: 6 })).toBe('README.md:3–6');
    expect(commentPlace({ path: 'README.md', startLine: null, endLine: null })).toBe('README.md');
    expect(commentPlace({ path: null, startLine: null, endLine: null })).toBeNull();
    expect(commentEventWords(ev('comment_deleted', you))).toBe('deleted a comment on host.ts:42–44');
    expect(commentEventWords(ev('reopened', you, { path: null }))).toBe('reopened a thread');
  });
});
