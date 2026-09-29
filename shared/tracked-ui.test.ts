// T2 steps 7–8: the web's ownership filter, and the Add dialog / Remove confirmation helpers.
import { describe, expect, it } from 'vitest';
import type { RepoCandidate, TrackedBy, Visibility } from './api';
import { exportTarget, repoListParams, scopeParams } from '../web/src/lib/apiQuery';
import { backfillLine, inputKey, matchCandidates, removeRepoBody } from '../web/src/lib/tracking';
import { carrySearch, keepRepoInScope, parseUrlState, passesRepoFilters, patchSearch } from '../web/src/lib/urlState';

const repo = (visibility: Visibility, trackedBy: TrackedBy) => ({ visibility, trackedBy });

describe('ownership in the URL (own=)', () => {
  it('parses mine and others, defaults to all, and ignores anything else', () => {
    expect(parseUrlState('', 'prs').own).toBe('all');
    expect(parseUrlState('?own=mine', 'prs').own).toBe('mine');
    expect(parseUrlState('?own=others', 'insights').own).toBe('others');
    expect(parseUrlState('?own=everyone', 'prs').own).toBe('all');
  });

  it('writes own after vis, omits the default, and carries it across tabs with the rest of the scope', () => {
    expect(patchSearch('?who=me&vis=private', 'prs', { own: 'others' })).toBe('?vis=private&own=others');
    expect(patchSearch('?own=mine', 'prs', { own: 'all' })).toBe('');
    expect(carrySearch('?repos=alice/app&own=mine&state=open&vis=public')).toBe('?repos=alice/app&vis=public&own=mine');
  });

  it('keeps old vis= links working (the menu sets the same param)', () => {
    expect(parseUrlState('?vis=public', 'prs')).toMatchObject({ vis: 'public', own: 'all' });
    expect(parseUrlState('?vis=internal', 'repos').vis).toBe('internal');
  });

  it('sends ownership to the API for lists, stats and the repository inventory', () => {
    expect(scopeParams(parseUrlState('?own=mine', 'prs')).ownership).toBe('mine');
    expect(scopeParams(parseUrlState('', 'prs')).ownership).toBeUndefined();
    expect(repoListParams(parseUrlState('?own=others', 'repos')).ownership).toBe('others');
    expect(exportTarget('activity', parseUrlState('?own=others', 'activity')).params.ownership).toBe('others');
    expect(exportTarget('repos', parseUrlState('', 'repos')).params.ownership).toBeUndefined();
  });
});

describe('repo filters', () => {
  it('passesRepoFilters applies visibility and ownership together', () => {
    expect(passesRepoFilters(repo('public', 'manual'), { vis: 'all', own: 'all' })).toBe(true);
    expect(passesRepoFilters(repo('public', 'manual'), { vis: 'all', own: 'others' })).toBe(true);
    expect(passesRepoFilters(repo('public', 'manual'), { vis: 'all', own: 'mine' })).toBe(false);
    expect(passesRepoFilters(repo('private', 'owned'), { vis: 'private', own: 'mine' })).toBe(true);
    expect(passesRepoFilters(repo('internal', 'owned'), { vis: 'private', own: 'all' })).toBe(false);
  });

  it('keepRepoInScope resets the filters a repo would fail, internal included', () => {
    expect(keepRepoInScope(repo('public', 'owned'), { vis: 'private', own: 'all' })).toEqual({ vis: 'all' });
    expect(keepRepoInScope(repo('public', 'owned'), { vis: 'internal', own: 'all' })).toEqual({ vis: 'all' });
    expect(keepRepoInScope(repo('internal', 'manual'), { vis: 'internal', own: 'mine' })).toEqual({ own: 'all' });
    expect(keepRepoInScope(repo('private', 'owned'), { vis: 'public', own: 'others' })).toEqual({ vis: 'all', own: 'all' });
    expect(keepRepoInScope(repo('private', 'owned'), { vis: 'private', own: 'mine' })).toEqual({});
    expect(keepRepoInScope(undefined, { vis: 'private', own: 'mine' })).toEqual({});
  });
});

describe('Add dialog helpers', () => {
  const c = (key: string): Pick<RepoCandidate, 'key' | 'owner' | 'name'> => {
    const i = key.lastIndexOf('/');
    return { key, owner: key.slice(0, i), name: key.slice(i + 1) };
  };
  const items = ['acme/tools', 'acme/deploy', 'other/acme-cli', 'toolsmith/x', 'zed/my-tools'].map(c);

  it('ranks name prefixes, then owner prefixes, then substrings, keeping the given order within a rank', () => {
    expect(matchCandidates(items, 'tools').map((x) => x.key)).toEqual(['acme/tools', 'toolsmith/x', 'zed/my-tools']);
    expect(matchCandidates(items, 'acme').map((x) => x.key)).toEqual(['other/acme-cli', 'acme/tools', 'acme/deploy']);
    expect(matchCandidates(items, 'ACME/DE').map((x) => x.key)).toEqual(['acme/deploy']);
    expect(matchCandidates(items, '  ')).toEqual([]);
    expect(matchCandidates(items, 'a', 2)).toHaveLength(2);
  });

  it('reads a key from owner/name, a URL or an ssh address', () => {
    expect(inputKey('dlvhdr/gh-dash')).toBe('dlvhdr/gh-dash');
    expect(inputKey('https://github.com/dlvhdr/gh-dash/pulls?q=is%3Aopen')).toBe('dlvhdr/gh-dash');
    expect(inputKey('git@github.com:dlvhdr/gh-dash.git')).toBe('dlvhdr/gh-dash');
    expect(inputKey('gh-dash')).toBeNull();
    expect(inputKey('dlvhdr/')).toBeNull();
  });

  it('sizes the first sync, or says the size is unknown', () => {
    const since = '2025-09-29T12:00:00Z';
    expect(backfillLine({ since, commits: 1240, prs: 350, issues: 90, releases: 4, requests: 30 }))
      .toBe('Since Sep 29, 2025: ~1,240 commits · 350 PRs · 90 issues · about 30 GitHub requests');
    expect(backfillLine({ since, commits: 1, prs: 1, issues: 0, releases: 0, requests: 1 }))
      .toBe('Since Sep 29, 2025: ~1 commit · 1 PR · 0 issues · about 1 GitHub request');
    expect(backfillLine({ since, commits: 12, prs: null, issues: 3, releases: 0, requests: null })).toBe('Since Sep 29, 2025: size unknown');
  });

  it('names the comments that go with a removed repo once the count exists', () => {
    expect(removeRepoBody()).toBe('gh-dash stops syncing it and deletes its pull requests, issues, commits and releases from this dashboard. '
      + 'It also leaves your sets. Nothing changes on GitHub. Adding it again re-syncs from scratch.');
    expect(removeRepoBody(0)).toBe(removeRepoBody());
    expect(removeRepoBody(3)).toContain('from this dashboard, and your 3 comments. It also leaves your sets.');
    expect(removeRepoBody(1)).toContain('and your 1 comment.');
  });
});
