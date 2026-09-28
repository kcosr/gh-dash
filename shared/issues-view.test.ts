import { describe, expect, it } from 'vitest';
import { exportTarget, issueListParams } from '../web/src/lib/apiQuery';
import { carrySearch, parseUrlState, patchSearch, viewFromPath } from '../web/src/lib/urlState';

describe('Issues URL state and navigation', () => {
  it('has issue defaults and rejects the PR-only merged state', () => {
    expect(viewFromPath('/issues/')).toBe('issues');
    expect(parseUrlState('', 'issues')).toMatchObject({ state: 'open', who: 'everyone' });
    expect(parseUrlState('?state=merged', 'issues').state).toBe('open');
    expect(parseUrlState('', 'prs')).toMatchObject({ state: 'merged', who: 'me' });
  });

  it('carries repository scope across every tab without leaking PR filters or details', () => {
    const search = '?repos=app,secret&vis=private&state=merged&density=full&q=bug&pr=app%231';
    for (const view of ['prs', 'issues', 'activity', 'repos', 'insights'] as const) {
      const next = parseUrlState(carrySearch(search), view);
      expect(next).toMatchObject({ repos: ['app', 'secret'], vis: 'private', q: '', pr: null });
    }
    expect(parseUrlState(carrySearch(search), 'issues').state).toBe('open');
    expect(parseUrlState(carrySearch('?repos='), 'repos').repos).toEqual([]);
  });

  it('exports the same issue filters as the list fetches, and preserves them when selecting a repo', () => {
    const search = '?state=closed&who=others&range=custom&from=2026-09-01&to=2026-09-30&q=crash';
    const s = parseUrlState(patchSearch(search, 'issues', { repos: ['secret'] }), 'issues');
    const fetch = issueListParams(s);
    expect(fetch).toMatchObject({ state: 'closed', who: 'others', repos: 'secret', from: '2026-09-01', to: '2026-09-30', q: 'crash' });
    expect(exportTarget('issues', s)).toMatchObject({ endpoint: 'issues', md: true, params: fetch });
  });

  it('exports repository scope, search and sort without date or author restrictions', () => {
    const s = parseUrlState('?repos=hidden,old&vis=public&q=type&sort=stars&who=me&range=7d', 'repos');
    expect(exportTarget('repos', s)).toEqual({ endpoint: 'repos', md: false, label: 'repositories', params: {
      scope: 'default', repos: 'hidden,old', visibility: 'public', q: 'type', sort: 'stars',
    } });
  });

  it('drops retired repository toggles when filters change', () => {
    const next = new URLSearchParams(patchSearch('?archived=1&forks=1&repos=old&extra=value', 'repos', { sort: 'name' }));
    expect(next.has('archived')).toBe(false);
    expect(next.has('forks')).toBe(false);
    expect(next.get('repos')).toBe('old');
    expect(next.get('extra')).toBe('value');
  });
});
