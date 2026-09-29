import { describe, expect, it } from 'vitest';
import type { Repo, Source, SourceAccount } from './api';
import { canonicalRepoUrl, contextPending, contextRewrite } from '../web/src/lib/canonicalUrl';
import { ALL, ctxOf, homePlace, parsePlaces, placeFor, presentSources, recordPlace, viewHref } from '../web/src/lib/contexts';
import type { Places } from '../web/src/lib/contexts';
import { activityParams, exportTarget, repoListParams, scopeParams } from '../web/src/lib/apiQuery';
import {
  canonicalQuery,
  carrySearch,
  contextSearch,
  keepRepoInScope,
  parseUrlState,
  passesRepoFilters,
  patchSearch,
  repoLinkSearch,
} from '../web/src/lib/urlState';

const GL = 'gitlab.example.com';
type R = Pick<Repo, 'source' | 'provider'>;
const gh: R = { source: 'github.com', provider: 'github' };
const gl = (host = GL): R => ({ source: host, provider: 'gitlab' });

describe('present sources', () => {
  it('lists each source with a repo once, github.com first, then by host', () => {
    expect(presentSources([gl(), gh, gl(), gh])).toEqual([
      { host: 'github.com', kind: 'github', name: 'GitHub' },
      { host: GL, kind: 'gitlab', name: 'GitLab' },
    ]);
    expect(presentSources([gl()])).toEqual([{ host: GL, kind: 'gitlab', name: 'GitLab' }]);
    expect(presentSources([])).toEqual([]);
  });

  it('names GitLab sources by host while there are several, like the server', () => {
    expect(presentSources([gl('gitlab2.example.com'), gh, gl()]).map((s) => s.name)).toEqual(['GitHub', GL, 'gitlab2.example.com']);
  });

  // GET /sources: a source set up here is present before its first repos land.
  type S = Pick<Source, 'host' | 'kind' | 'configured' | 'account'>;
  const acct = (source: SourceAccount['source']) => ({ source }) as SourceAccount;
  const github = (source: SourceAccount['source']): S => ({ host: 'github.com', kind: 'github', configured: true, account: acct(source) });
  const gitlab = (configured: boolean, host = GL): S => ({ host, kind: 'gitlab', configured, account: configured ? acct('none') : null });

  it('adds a GitLab this server configures, with or without a token, before it has repos', () => {
    expect(presentSources([gh], [github('gh-cli'), gitlab(true)]).map((s) => s.host)).toEqual(['github.com', GL]);
    expect(presentSources([], [github('none'), gitlab(true)]).map((s) => s.host)).toEqual([GL]);
  });

  it('adds github.com while it has a token, and never an empty GitHub nobody set up', () => {
    expect(presentSources([gl()], [github('gh-cli'), gitlab(true)]).map((s) => s.host)).toEqual(['github.com', GL]);
    expect(presentSources([gl()], [github('none'), gitlab(true)]).map((s) => s.host)).toEqual([GL]);
  });

  it('leaves out a GitLab another server configures unless it has repos here', () => {
    expect(presentSources([gh], [github('gh-cli'), gitlab(false)]).map((s) => s.host)).toEqual(['github.com']);
    expect(presentSources([gh, gl()], [github('gh-cli'), gitlab(false)]).map((s) => s.host)).toEqual(['github.com', GL]);
  });

  it('names by the sources present, whichever list they came from', () => {
    expect(presentSources([gh, gl()], [github('gh-cli'), gitlab(true), gitlab(true, 'gitlab2.example.com')]).map((s) => s.name))
      .toEqual(['GitHub', GL, 'gitlab2.example.com']);
  });
});

describe('the context in the URL', () => {
  it('is source=<host>, lower-cased; absent or blank is All', () => {
    expect(parseUrlState('?source=GitLab.Example.com', 'prs').source).toBe(GL);
    expect(parseUrlState('?source=', 'prs').source).toBeNull();
    expect(parseUrlState('', 'prs').source).toBeNull();
    expect(ctxOf(`?who=me&source=${GL}`)).toBe(GL);
    expect(ctxOf('?source=%20')).toBe(ALL);
    expect(ctxOf('')).toBe(ALL);
  });

  it('is written first, carried across tabs, and part of a saved view', () => {
    expect(patchSearch('?who=everyone&repos=a/b', 'prs', { source: GL })).toBe(`?source=${GL}&repos=a/b&who=everyone`);
    expect(patchSearch(`?source=${GL}&who=everyone`, 'prs', { source: null })).toBe('?who=everyone');
    expect(carrySearch(`?state=open&source=${GL}&range=7d&pr=a/b%231`)).toBe(`?source=${GL}&range=7d`);
    expect(contextSearch(`?state=open&source=${GL}&range=7d`)).toBe(`?source=${GL}`);
    expect(contextSearch('?range=7d')).toBe('');
    expect(canonicalQuery(`range=7d&source=${GL}&pr=a/b%231`)).toBe(`range=7d&source=${GL}`);
    expect(repoLinkSearch(`${GL}/a/b`, GL)).toBe(`source=${GL}&repos=${GL}/a/b`);
    expect(repoLinkSearch('a/b', null)).toBe('repos=a/b');
  });

  it('is sent to the API by every scoped query, and not for a page about one repo', () => {
    const s = parseUrlState(`?source=${GL}&who=me`, 'prs');
    expect(scopeParams(s).source).toBe(GL);
    expect(activityParams(s).source).toBe(GL);
    expect(repoListParams(s).source).toBe(GL);
    expect(scopeParams(parseUrlState('', 'prs')).source).toBeUndefined();
    expect(exportTarget('repo', s, `${GL}/a/b`).params).toMatchObject({ repos: `${GL}/a/b` });
    expect(exportTarget('repo', s, `${GL}/a/b`).params.source).toBeUndefined();
  });

  it('narrows the repo filters, and follows a repo of another source', () => {
    const repo = { visibility: 'public' as const, trackedBy: 'owned' as const, source: 'github.com' };
    expect(passesRepoFilters(repo, { vis: 'all', own: 'all', source: GL })).toBe(false);
    expect(passesRepoFilters(repo, { vis: 'all', own: 'all', source: 'github.com' })).toBe(true);
    expect(passesRepoFilters(repo, { vis: 'all', own: 'all', source: null })).toBe(true);
    expect(keepRepoInScope(repo, { vis: 'all', own: 'all', source: GL })).toEqual({ source: 'github.com' });
    expect(keepRepoInScope(repo, { vis: 'all', own: 'all', source: null })).toEqual({});
  });
});

describe('context rules on the address bar', () => {
  const sources: Record<string, string> = { 'alice/app': 'github.com', 'alice/tool': 'github.com', [`${GL}/alice/app`]: GL, [`${GL}/team/svc`]: GL };
  const facts = { hosts: ['github.com', GL], sourceOf: (k: string) => sources[k] };
  const rw = (path: string, search: string) => contextRewrite(path, search, facts);

  it('leaves All and a context that fits alone', () => {
    expect(rw('/prs', '')).toBeNull();
    expect(rw('/prs', '?pr=alice/app%231')).toBeNull();
    expect(rw('/prs', `?source=${GL}&repos=${GL}/team/svc&pr=${GL}/alice/app%232`)).toBeNull();
    expect(rw(`/repos/${GL}/team/svc`, `?source=${GL}`)).toBeNull();
    expect(rw('/prs', `?source=${GL}&repos=alice/app,${GL}/team/svc`)).toBeNull(); // several: they just intersect
  });

  it('drops a source that isn\'t present, and lower-cases one that is', () => {
    expect(rw('/prs', '?source=gone.example.com&who=everyone')).toBe('?who=everyone');
    expect(rw('/prs', '?source=')).toBe('');
    expect(rw('/insights', '?source=GitLab.Example.com&range=ytd')).toBe(`?source=${GL}&range=ytd`);
  });

  it('waits for every source to be known before dropping one it hasn\'t seen (set up, no repos yet)', () => {
    const early = { ...facts, hosts: ['github.com'], complete: false };
    expect(contextRewrite('/prs', `?source=${GL}&who=everyone`, early)).toBeNull();
    expect(contextPending(`?source=${GL}&who=everyone`, early)).toBe(true);
    expect(contextPending(`?source=GitLab.Example.com`, early)).toBe(true);
    // Known already, or no source named: nothing to wait for.
    expect(contextPending('?source=github.com', early)).toBe(false);
    expect(contextPending('?who=me', early)).toBe(false);
    // Once complete, a source nobody has is dropped.
    const done = { ...early, complete: true };
    expect(contextPending(`?source=${GL}`, done)).toBe(false);
    expect(contextRewrite('/prs', `?source=${GL}&who=everyone`, done)).toBe('?who=everyone');
  });

  it('follows the repo a URL opens: its page, the diff, the drawer, a single repos= entry', () => {
    expect(rw('/repos/alice/app', `?source=${GL}`)).toBe('?source=github.com');
    expect(rw('/activity', `?source=${GL}&diff=alice/app@${'a'.repeat(40)}`)).toBe(`?source=github.com&diff=alice/app@${'a'.repeat(40)}`);
    expect(rw('/prs', `?source=github.com&pr=${GL}/alice/app%237`)).toBe(`?source=${GL}&pr=${GL}/alice/app%237`);
    expect(rw('/prs', `?source=github.com&repos=${GL}/team/svc`)).toBe(`?source=${GL}&repos=${GL}/team/svc`);
    // An unknown repo decides nothing; the next one named does.
    expect(rw('/prs', `?source=${GL}&pr=nope/x%231&repos=alice/tool`)).toBe('?source=github.com&repos=alice/tool&pr=nope/x%231');
  });

  it('keeps only the new source\'s repos, or the default selection when none are left', () => {
    expect(rw('/prs', `?source=${GL}&repos=${GL}/team/svc,${GL}/alice/app&pr=alice/app%231`)).toBe('?source=github.com&pr=alice/app%231');
    expect(rw('/prs', `?source=${GL}&repos=${GL}/team/svc,alice/tool&pr=alice/app%231`)).toBe('?source=github.com&repos=alice/tool&pr=alice/app%231');
    expect(rw('/prs', `?source=${GL}&repos=&pr=alice/app%231`)).toBe('?source=github.com&repos=&pr=alice/app%231');
  });

  it('runs after the legacy key rewrite, which it leaves alone', () => {
    const resolve = (r: string) => (r === 'app' ? 'alice/app' : null);
    expect(canonicalRepoUrl('/prs', `?source=${GL}&pr=app%231`, resolve)).toEqual({ pathname: '/prs', search: `?source=${GL}&pr=alice/app%231` });
    expect(rw('/prs', `?source=${GL}&pr=alice/app%231`)).toBe('?source=github.com&pr=alice/app%231');
  });
});

describe('places', () => {
  const empty = parsePlaces(null);

  it('reads nothing unexpected from storage', () => {
    expect(empty).toEqual({ v: 1, last: ALL, places: {}, views: {} });
    for (const raw of ['', 'nope', '[]', '{"v":2,"last":"all","places":{}}', '{"v":1,"places":{}}']) expect(parsePlaces(raw), raw).toEqual(empty);
    expect(parsePlaces('{"v":1,"last":"x","places":{"all":"/prs","x":42,"y":"javascript:1"}}')).toEqual({ v: 1, last: 'x', places: { all: '/prs' }, views: {} });
  });

  it('remembers each context\'s last place, overlays included, and the last context', () => {
    let p: Places = empty;
    p = recordPlace(p, '/prs', `?source=${GL}&who=everyone&pr=${GL}/a/b%233&diff=${GL}/a/b%233&file=src/x.ts`);
    p = recordPlace(p, '/insights', '?source=github.com&range=ytd');
    p = recordPlace(p, '/activity', '');
    expect(p).toEqual({
      v: 1,
      last: ALL,
      places: { [GL]: `/prs?source=${GL}&who=everyone&pr=${GL}/a/b%233&diff=${GL}/a/b%233&file=src/x.ts`, 'github.com': '/insights?source=github.com&range=ytd', all: '/activity' },
      views: { [GL]: { prs: `/prs?source=${GL}&who=everyone` }, 'github.com': { insights: '/insights?source=github.com&range=ytd' }, all: { activity: '/activity' } },
    });
    expect(recordPlace(p, '/activity', '')).toBe(p); // nothing new: no write
  });

  it('never records the root, which only redirects to a place, and forgets one stored before', () => {
    const p = recordPlace(parsePlaces(null), '/insights', '?range=ytd');
    expect(recordPlace(p, '/', '')).toBe(p);
    expect(recordPlace(p, '/', `?source=${GL}`)).toBe(p);
    expect(parsePlaces(JSON.stringify({ v: 1, last: ALL, places: { all: '/', [GL]: '/?who=me', 'github.com': '/prs' } })))
      .toEqual({ v: 1, last: ALL, places: { 'github.com': '/prs' }, views: {} });
    // So `/` never redirects to itself.
    expect(homePlace(parsePlaces(JSON.stringify({ v: 1, last: ALL, places: { all: '/' } })))).toBe('/prs');
  });

  it('never records Settings, and forgets contexts no longer present', () => {
    const p = recordPlace(recordPlace(empty, '/prs', `?source=${GL}`), '/prs', '?source=old.example.com');
    expect(recordPlace(p, '/settings', '')).toBe(p);
    expect(recordPlace(p, '/issues', '', ['github.com', GL]).places).toEqual({ [GL]: `/prs?source=${GL}`, all: '/issues' });
  });

  describe('each view\'s last settings', () => {
    const at = (p: Places, ...visits: [string, string][]) => visits.reduce((q, [path, search]) => recordPlace(q, path, search), p);

    it('are kept per context and view, the latest visit winning', () => {
      const p = at(empty, ['/prs', '?state=open'], ['/issues', '?state=closed'], ['/prs', `?source=${GL}&group=repo`], ['/prs', '?state=all']);
      expect(p.views).toEqual({ all: { prs: '/prs?state=all', issues: '/issues?state=closed' }, [GL]: { prs: `/prs?source=${GL}&group=repo` } });
      // Each visit also makes the place, as before.
      expect(p.places).toEqual({ all: '/prs?state=all', [GL]: `/prs?source=${GL}&group=repo` });
    });

    it('leave out the drawer and the diff, which are not settings', () => {
      const p = at(empty, ['/prs', `?state=open&pr=a/b%231&diff=a/b%231&file=x.ts&thread=3&only=unresolved&group=repo`]);
      expect(p.views).toEqual({ all: { prs: '/prs?state=open&group=repo' } });
      expect(p.places.all).toContain('pr=a/b%231');
      // Another drawer, or none, changes the place but not the view's settings.
      expect(recordPlace(p, '/prs', '?state=open&group=repo&pr=c/d%232').views).toEqual(p.views);
      expect(recordPlace(p, '/prs', '?state=open&group=repo').views).toEqual(p.views);
    });

    it('are written in the canonical order, one place whichever the order visited', () => {
      const p = at(empty, ['/activity', '?types=push&range=7d&source=github.com&x=1&density=full']);
      expect(p.views['github.com']).toEqual({ activity: '/activity?source=github.com&range=7d&density=full&types=push&x=1' });
      expect(recordPlace(p, '/activity', '?source=github.com&types=push&density=full&range=7d&x=1').views).toEqual(p.views);
    });

    it('cover the top-level lists, and not Settings, the root or a repository\'s page', () => {
      const p = at(empty, ['/prs', ''], ['/issues', ''], ['/activity', ''], ['/repos', '?sort=stars'], ['/insights', '?range=ytd']);
      expect(Object.keys(p.views.all!)).toEqual(['prs', 'issues', 'activity', 'repos', 'insights']);
      const q = at(p, ['/settings', '?source=github.com'], ['/', ''], ['/', `?source=${GL}`], ['/repos/alice/app', `?source=${GL}&repos=alice/app`], [`/repos/${GL}/team/svc`, '']);
      expect(q.views).toEqual(p.views);
      // A repo's page is still a place of its context, as before; the others are not places at all.
      expect(q.places[GL]).toBe(`/repos/alice/app?source=${GL}&repos=alice/app`);
      expect(q.places['github.com']).toBeUndefined();
      // The list keeps its own memory across a visit to a repo's page.
      expect(q.views.all!.repos).toBe('/repos?sort=stars');
    });

    it('take a path however it is written, and nothing that is not a tab', () => {
      expect(at(empty, ['/prs/', '?state=open']).views).toEqual({ all: { prs: '/prs?state=open' } });
      expect(at(empty, ['/Activity', '']).views).toEqual({ all: { activity: '/activity' } });
      expect(at(empty, ['/nowhere', '?state=open']).views).toEqual({});
      expect(at(empty, ['/repos/', '?sort=name']).views).toEqual({ all: { repos: '/repos?sort=name' } });
    });

    it('go with the contexts no longer present', () => {
      const p = at(empty, ['/prs', `?source=${GL}`], ['/prs', '?source=old.example.com&state=open'], ['/issues', '?source=github.com']);
      expect(Object.keys(p.views).sort()).toEqual(['github.com', GL, 'old.example.com'].sort());
      const kept = recordPlace(p, '/activity', '', ['github.com', GL]);
      expect(kept.views).toEqual({ [GL]: { prs: `/prs?source=${GL}` }, 'github.com': { issues: '/issues?source=github.com' }, all: { activity: '/activity' } });
      // Also when only the views mention it (a stored value from before it was dropped from the places).
      const odd = parsePlaces(JSON.stringify({ v: 1, last: ALL, places: {}, views: { 'old.example.com': { prs: '/prs' } } }));
      expect(recordPlace(odd, '/prs', '', ['github.com']).views).toEqual({ all: { prs: '/prs' } });
      // The current context stays even when it isn't in the list (it is about to be rewritten).
      expect(recordPlace(p, '/prs', '?source=old.example.com&state=open', ['github.com']).views['old.example.com']).toEqual({ prs: '/prs?source=old.example.com&state=open' });
    });

    it('read back from storage, and from a value stored before they were kept', () => {
      const p = at(empty, ['/prs', `?source=${GL}&state=open`], ['/insights', '?range=ytd']);
      expect(parsePlaces(JSON.stringify(p))).toEqual(p);
      const old = { v: 1, last: GL, places: { [GL]: `/prs?source=${GL}&pr=a/b%231`, all: '/insights' } };
      expect(parsePlaces(JSON.stringify(old))).toEqual({ ...old, views: {} });
      expect(homePlace(parsePlaces(JSON.stringify(old)))).toBe(`/prs?source=${GL}&pr=a/b%231`);
    });

    it('read as nothing where malformed, without losing the places', () => {
      const good = { all: { prs: '/prs?state=open' } };
      const parse = (views: unknown) => parsePlaces(JSON.stringify({ v: 1, last: ALL, places: { all: '/prs' }, views }));
      for (const views of [null, 'x', 7, [], [1], { all: 'x' }, { all: null }, { all: [] }, { all: { prs: 42 } }]) {
        expect(parse(views), JSON.stringify(views)).toEqual({ v: 1, last: ALL, places: { all: '/prs' }, views: {} });
      }
      expect(parse(good).views).toEqual(good);
      // Entries are judged one by one, and must be the view's own place.
      const mixed = { all: { prs: '/prs?state=open', issues: '/prs', activity: 'https://x.test/activity', repos: '/repos/a/b', insights: '/insightsx', settings: '/settings', prs2: '/prs' }, [GL]: 'nope' };
      expect(parse(mixed).views).toEqual(good);
    });
  });

  describe('a link to a view', () => {
    const at = (...visits: [string, string][]) => visits.reduce((q, [path, search]) => recordPlace(q, path, search), empty);
    const remembered = at(
      ['/prs', '?state=open&group=repo&density=full&pr=a/b%231'],
      ['/activity', '?range=7d&types=push&who=me'],
      ['/issues', `?source=${GL}&state=closed`],
      ['/repos', '?sort=stars&layout=list&repos=a/b'],
    );

    it('goes to the view as it was left, under the scope of the page', () => {
      expect(viewHref(remembered, ALL, '/prs', '/activity', '?range=30d')).toBe('/prs?range=30d&state=open&group=repo&density=full');
      expect(viewHref(remembered, ALL, '/activity', '/prs', '?repos=a/b,c/d&vis=public&own=mine&state=all')).toBe('/activity?repos=a/b,c/d&vis=public&own=mine&types=push');
      expect(viewHref(remembered, GL, '/issues', '/prs', `?source=${GL}&who=everyone`)).toBe(`/issues?source=${GL}&who=everyone&state=closed`);
    });

    it('lets the page\'s scope win, a param it lacks included', () => {
      // Remembered: range=7d and who=me. The page has neither, so the view doesn't either.
      expect(viewHref(remembered, ALL, '/activity', '/prs', '?state=all')).toBe('/activity?types=push');
      // And the remembered repos= is dropped where the page has no selection.
      expect(viewHref(remembered, ALL, '/repos', '/prs', '?state=all')).toBe('/repos?sort=stars&layout=list');
      expect(viewHref(remembered, ALL, '/repos', '/prs', '?repos=')).toBe('/repos?repos=&sort=stars&layout=list');
      expect(viewHref(remembered, ALL, '/repos', '/prs', '?repos=c/d')).toBe('/repos?repos=c/d&sort=stars&layout=list');
    });

    it('never brings the drawer or the diff back, whatever is stored', () => {
      const stored = parsePlaces(JSON.stringify({ v: 1, last: ALL, places: {}, views: { all: { prs: '/prs?pr=a/b%231&state=open&diff=a/b%231&file=x&thread=2&only=commented' } } }));
      expect(viewHref(stored, ALL, '/prs', '/issues', '')).toBe('/prs?state=open');
      expect(viewHref(stored, ALL, '/prs', '/settings', '')).toBe('/prs?state=open');
      // Nor does the page's own drawer come along, as before.
      expect(viewHref(remembered, ALL, '/prs', '/prs', '?pr=a/b%231&diff=a/b%231&range=7d')).toBe('/prs?range=7d&state=open&group=repo&density=full');
    });

    it('reads the context\'s own memory, and is today\'s link where it has none', () => {
      expect(viewHref(remembered, GL, '/prs', '/issues', `?source=${GL}&range=7d`)).toBe(`/prs?source=${GL}&range=7d`);
      expect(viewHref(remembered, ALL, '/issues', '/prs', '?range=7d&state=open&pr=a/b%231')).toBe('/issues?range=7d');
      expect(viewHref(empty, ALL, '/insights', '/prs', `?who=me&state=open&range=7d&repos=a/b&from=2024-01-01`)).toBe('/insights?repos=a/b&who=me&range=7d&from=2024-01-01');
    });

    it('from Settings goes to the remembered place as stored, else to the context', () => {
      expect(viewHref(remembered, ALL, '/prs', '/settings', '')).toBe('/prs?state=open&group=repo&density=full');
      expect(viewHref(remembered, ALL, '/activity', '/settings', '')).toBe('/activity?who=me&range=7d&types=push');
      expect(viewHref(remembered, ALL, '/repos', '/settings', '')).toBe('/repos?repos=a/b&sort=stars&layout=list');
      expect(viewHref(remembered, GL, '/issues', '/settings', '')).toBe(`/issues?source=${GL}&state=closed`);
      // Nothing remembered there: the view in the context, as the tabs led back before.
      expect(viewHref(remembered, GL, '/prs', '/settings', '')).toBe(`/prs?source=${GL}`);
      expect(viewHref(remembered, 'github.com', '/prs', '/settings', '')).toBe('/prs?source=github.com');
      expect(viewHref(empty, ALL, '/prs', '/settings', '')).toBe('/prs');
      // What Settings' own URL carries doesn't matter: it has no scope.
      expect(viewHref(remembered, ALL, '/prs', '/settings', '?source=github.com&range=1d')).toBe('/prs?state=open&group=repo&density=full');
    });

    it('is the link of a repository\'s page like any other page, with its own scope', () => {
      expect(viewHref(remembered, ALL, '/repos', '/repos/a/b', '?range=90d')).toBe('/repos?range=90d&sort=stars&layout=list');
      expect(viewHref(remembered, ALL, '/prs', '/repos/a/b', '?repos=a/b')).toBe('/prs?repos=a/b&state=open&group=repo&density=full');
    });

    it('stays today\'s link for what is not a tab, Settings included', () => {
      expect(viewHref(remembered, ALL, '/settings', '/prs', '?state=open&range=7d')).toBe('/settings?range=7d');
      expect(viewHref(remembered, GL, '/settings', '/settings', '')).toBe('/settings');
      expect(viewHref(remembered, ALL, '/repos/a/b', '/prs', '?range=7d')).toBe('/repos/a/b?range=7d');
    });

    it('follows the memory as it changes', () => {
      const before = viewHref(empty, ALL, '/prs', '/activity', '?range=7d');
      const after = viewHref(recordPlace(empty, '/prs', '?state=open'), ALL, '/prs', '/activity', '?range=7d');
      expect([before, after]).toEqual(['/prs?range=7d', '/prs?range=7d&state=open']);
    });
  });

  it('switches to a context\'s place, else to this view in it', () => {
    const p = recordPlace(empty, '/insights', `?source=${GL}&range=ytd`);
    expect(placeFor(p, GL, '/prs')).toBe(`/insights?source=${GL}&range=ytd`);
    expect(placeFor(p, 'github.com', '/activity')).toBe('/activity?source=github.com');
    expect(placeFor(p, ALL, '/issues')).toBe('/issues');
    expect(placeFor(p, 'github.com', '/repos/alice/app')).toBe('/prs?source=github.com');
    expect(placeFor(p, ALL, '/settings')).toBe('/prs');
    expect(placeFor(p, 'github.com', '/repos')).toBe('/repos?source=github.com');
  });

  it('sends / to the last context\'s place', () => {
    expect(homePlace(empty)).toBe('/prs');
    const p = recordPlace(recordPlace(empty, '/activity', ''), '/insights', `?source=${GL}`);
    expect(homePlace(p)).toBe(`/insights?source=${GL}`);
  });
});
