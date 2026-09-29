// T2 step 7: the web's ownership filter.
import { describe, expect, it } from 'vitest';
import type { TrackedBy, Visibility } from './api';
import { exportTarget, repoListParams, scopeParams } from '../web/src/lib/apiQuery';
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
