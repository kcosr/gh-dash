import { describe, expect, it } from 'vitest';
import type { ActivityEvent, Issue, PullRequest } from '../../shared/api';
import { activityCsv, prsCsv, toCsv } from './csv';
import { eventsMarkdown, firstParagraph, type MdContext, prsMarkdown, rangeLabel } from './markdown';

const ctx: MdContext = {
  tz: 'UTC',
  now: Date.parse('2026-09-27T12:00:00Z'), // a Sunday
  from: Date.parse('2026-09-10T00:00:00Z'),
  to: Date.parse('2026-09-28T00:00:00Z'),
};
const me = { login: 'alice', name: 'Alice', avatarUrl: null, isMe: true };

function pr(number: number, activityAt: string, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `app#${number}`, repo: 'app', number, title: `PR ${number}`, body: '', state: 'merged', isDraft: false, author: me,
    mergedBy: 'alice', createdAt: activityAt, updatedAt: activityAt, mergedAt: activityAt, closedAt: activityAt, activityAt,
    additions: 1, deletions: 1, changedFiles: 1, commitCount: 1, headRef: 'x', baseRef: 'main', labels: [],
    url: `https://github.com/alice/app/pull/${number}`, comments: { threads: 0, unresolved: 0 }, ...over,
  };
}

describe('firstParagraph', () => {
  it('skips headings, comments and code fences and flattens markdown', () => {
    expect(firstParagraph('<!-- template -->\n## Summary\n\nFixes the **login** flow for [SSO](https://x) users.\n\nMore.')).toBe(
      'Fixes the login flow for SSO users.',
    );
    expect(firstParagraph('```sh\nnpm i\n```\n\nAdds `foo` and _bar_')).toBe('Adds foo and bar.');
  });

  it('turns list items into sentences', () => {
    expect(firstParagraph('## Changes\n- Add parser\n- [x] Fix bug!\n1. Ship it')).toBe('Add parser. Fix bug! Ship it.');
  });

  it('handles empty bodies and truncates long ones', () => {
    expect(firstParagraph('')).toBe('');
    expect(firstParagraph('## Only a heading')).toBe('');
    const long = firstParagraph('word '.repeat(300), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('prsMarkdown', () => {
  const prs = [
    pr(3, '2026-09-26T10:00:00Z', { title: 'Add *stars*', body: 'Adds stars.\n\nDetails.' }),
    pr(2, '2026-09-18T10:00:00Z'),
    pr(1, '2026-09-11T10:00:00Z', { repo: 'lib', id: 'lib#1' }),
  ];

  it('groups by week with relative headings and one bullet per PR', () => {
    expect(prsMarkdown(prs, { state: 'merged', who: 'me', group: 'week' }, ctx)).toBe(
      [
        '## Merged PRs by me · Sep 10 – Sep 27, 2026',
        '',
        '### This week · Sep 21 – 27',
        '',
        '- **Add \\*stars\\*** ([app#3](https://github.com/alice/app/pull/3)) — Adds stars.',
        '',
        '### Last week · Sep 14 – 20',
        '',
        '- **PR 2** ([app#2](https://github.com/alice/app/pull/2))',
        '',
        '### Sep 7 – 13',
        '',
        '- **PR 1** ([lib#1](https://github.com/alice/app/pull/1))',
        '',
      ].join('\n'),
    );
  });

  it('supports day, month and repo grouping', () => {
    const headings = (group: 'day' | 'month' | 'repo') =>
      prsMarkdown(prs, { state: 'all', who: 'everyone', group }, ctx)
        .split('\n')
        .filter((l) => l.startsWith('#'));
    expect(headings('day')).toEqual(['## All PRs · Sep 10 – Sep 27, 2026', '### Yesterday · Sep 26', '### Friday · Sep 18', '### Friday · Sep 11']);
    expect(headings('month')).toEqual(['## All PRs · Sep 10 – Sep 27, 2026', '### September 2026']);
    expect(headings('repo')).toEqual(['## All PRs · Sep 10 – Sep 27, 2026', '### app', '### lib']);
  });

  it('says so when empty and labels ranges across years', () => {
    const md = prsMarkdown([], { state: 'open', who: 'others', group: 'week' }, { ...ctx, from: Date.parse('2025-12-20T00:00:00Z') });
    expect(md).toBe('## Open PRs by others · Dec 20, 2025 – Sep 27, 2026\n\n_No pull requests._\n');
    expect(rangeLabel({ ...ctx, from: Date.parse('2026-09-27T00:00:00Z') })).toBe('Sep 27, 2026');
  });
});

describe('eventsMarkdown', () => {
  it('writes one bullet per event under local day headings', () => {
    const events: ActivityEvent[] = [
      { type: 'star', at: '2026-09-27T01:30:00Z', repo: 'app', actor: { ...me, login: 'carol', isMe: false } },
      { type: 'pr', kind: 'merged', at: '2026-09-26T10:00:00Z', repo: 'app', actor: me, pr: pr(3, '2026-09-26T10:00:00Z') },
    ];
    expect(eventsMarkdown('Activity', events, { ...ctx, tz: 'America/New_York' })).toBe(
      [
        '## Activity · Sep 9 – Sep 27, 2026',
        '',
        '### Yesterday · Sep 26',
        '',
        '- 21:30 · **carol** starred app',
        '- 06:00 · **alice** merged PR [app#3](https://github.com/alice/app/pull/3): PR 3',
        '',
      ].join('\n'),
    );
  });
});

describe('eventsMarkdown: PR opened lines', () => {
  it('omits "opened" when the same PR merged or closed that local day, like the UI', () => {
    const ev = (kind: 'opened' | 'merged' | 'closed', n: number, at: string): ActivityEvent =>
      ({ type: 'pr', kind, at, repo: 'app', actor: me, pr: pr(n, at) });
    const events = [
      ev('merged', 5, '2026-09-26T20:00:00Z'), // Sep 26 in New York
      ev('closed', 6, '2026-09-26T19:00:00Z'),
      ev('opened', 5, '2026-09-26T14:00:00Z'), // same local day as its merge: hidden
      ev('opened', 6, '2026-09-26T13:00:00Z'), // same local day as its close: hidden
      ev('opened', 7, '2026-09-26T12:00:00Z'), // still open: kept
      ev('merged', 8, '2026-09-25T02:00:00Z'), // Sep 24 in New York
      ev('opened', 8, '2026-09-24T12:00:00Z'), // Sep 24 too: hidden
      ev('merged', 9, '2026-09-24T03:00:00Z'), // Sep 23 in New York
      ev('opened', 9, '2026-09-22T12:00:00Z'), // another day: kept
    ];
    const lines = eventsMarkdown('Activity', events, { ...ctx, tz: 'America/New_York' }).split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => /(opened|merged|closed) PR \[app#(\d+)/.exec(l)!.slice(1).join(' '))).toEqual([
      'merged 5', 'closed 6', 'opened 7', 'merged 8', 'merged 9', 'opened 9',
    ]);
  });
});

describe('csv', () => {
  it('quotes per RFC 4180 and neutralises spreadsheet formulas', () => {
    expect(toCsv(['a', 'b', 'c', 'd'], [['x,y', 'say "hi"', '=HYPERLINK("x")', null], [1, true, 'line\nbreak', '-3']])).toBe(
      'a,b,c,d\r\n"x,y","say ""hi""","\'=HYPERLINK(""x"")",\r\n1,true,"line\nbreak",\'-3\r\n',
    );
  });

  it('exports PRs and activity with stable columns', () => {
    const [header, row] = prsCsv([pr(1, '2026-09-26T10:00:00Z', { labels: [{ name: 'bug', color: 'f00' }, { name: 'ui', color: '0f0' }] })]).split('\r\n');
    expect(header).toBe('repo,number,title,state,draft,author,created_at,merged_at,closed_at,activity_at,additions,deletions,changed_files,commits,labels,url');
    expect(row).toContain(',bug;ui,');
    const star: ActivityEvent = { type: 'star', at: '2026-09-27T01:30:00Z', repo: 'app', actor: { ...me, login: 'carol' } };
    expect(activityCsv([star]).split('\r\n')[1]).toBe('2026-09-27T01:30:00Z,star,,app,carol,,,');
  });
});

describe('exports with GitLab repos', () => {
  const GL = 'gitlab.example.com/alice/app';
  const kindOf = (repo: string) => (repo.startsWith('gitlab.example.com/') ? 'gitlab' as const : 'github' as const);
  const mr = (n: number, at: string) =>
    pr(n, at, { id: `${GL}#${n}`, repo: GL, url: `https://gitlab.example.com/alice/app/-/merge_requests/${n}` });
  const issue: Issue = {
    id: `${GL}#4`, repo: GL, number: 4, title: 'Crash', body: '', state: 'closed', author: me, closedBy: me,
    createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-26T09:00:00Z', closedAt: '2026-09-26T09:00:00Z', labels: [],
    url: 'https://gitlab.example.com/alice/app/-/issues/4',
  };

  it('write MRs with ! and MR words, and neutral words when both hosts are listed', () => {
    const only = prsMarkdown([mr(3, '2026-09-26T10:00:00Z')], { state: 'merged', who: 'me', group: 'repo' }, { ...ctx, kindOf });
    expect(only.split('\n')).toEqual([
      '## Merged MRs by me · Sep 10 – Sep 27, 2026', '', `### ${GL}`, '',
      `- **PR 3** ([${GL}!3](https://gitlab.example.com/alice/app/-/merge_requests/3))`, '',
    ]);
    const both = prsMarkdown([mr(3, '2026-09-26T10:00:00Z'), pr(2, '2026-09-18T10:00:00Z')], { state: 'all', who: 'everyone', group: 'repo' }, { ...ctx, kindOf });
    expect(both.split('\n')[0]).toBe('## All PRs & MRs · Sep 10 – Sep 27, 2026');
    expect(both).toContain('([app#2](https://github.com/alice/app/pull/2))');
  });

  it('write MR events with ! and keep # for issues, in Markdown and in the CSV ref column', () => {
    const events: ActivityEvent[] = [
      { type: 'pr', kind: 'opened', at: '2026-09-26T10:00:00Z', repo: GL, actor: me, pr: mr(5, '2026-09-26T10:00:00Z') },
      { type: 'issue', kind: 'closed', at: '2026-09-26T09:00:00Z', repo: GL, actor: me, issue },
    ];
    const lines = eventsMarkdown('Activity', events, { ...ctx, kindOf }).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      `- 10:00 · **alice** opened MR [${GL}!5](https://gitlab.example.com/alice/app/-/merge_requests/5): PR 5`,
      `- 09:00 · **alice** closed issue [${GL}#4](https://gitlab.example.com/alice/app/-/issues/4): Crash`,
    ]);
    const rows = activityCsv(events, kindOf).split('\r\n');
    expect(rows[1]).toBe(`2026-09-26T10:00:00Z,pr,opened,${GL},alice,PR 5,!5,https://gitlab.example.com/alice/app/-/merge_requests/5`);
    expect(rows[2]).toContain(',#4,');
    // Without a lookup every repo is GitHub's, as before.
    expect(activityCsv(events).split('\r\n')[1]).toContain(',#5,');
  });
});
