import { describe, expect, it } from 'vitest';
import type { TrackedBy } from './api';
import { repoResolver } from './repos';
import { canonicalRepoUrl } from '../web/src/lib/canonicalUrl';
import { parseUrlState, patchSearch, viewFromPath, repoFromPath } from '../web/src/lib/urlState';

const r = (key: string, trackedBy: TrackedBy = 'owned') => ({ key, name: key.slice(key.lastIndexOf('/') + 1), trackedBy, source: 'github.com' });
const repos = [r('kcosr/gh-dash'), r('kcosr/sedes'), r('dlvhdr/gh-dash', 'manual'), r('acme/only-manual', 'manual'), r('org/team/proj', 'manual')];
const resolve = repoResolver(repos);
const canon = (pathname: string, search = '') => canonicalRepoUrl(pathname, search, resolve);

describe('repoFromPath', () => {
  it.each([
    ['/repos/gh-dash', 'gh-dash'],
    ['/repos/gh-dash/', 'gh-dash'],
    ['/repos/kcosr/gh-dash', 'kcosr/gh-dash'],
    ['/repos/kcosr/gh-dash/', 'kcosr/gh-dash'],
    ['/repos/org/team/proj', 'org/team/proj'],
    ['/repos/kcosr%2Fgh-dash', 'kcosr/gh-dash'],
    ['/repos/a%20b/c%23d', 'a b/c#d'],
    ['/repos/my.repo_x', 'my.repo_x'],
    ['/repos/%E0%A4%A', '%E0%A4%A'], // malformed escapes are left as they are
    ['/repos/ok/%E0%A4%A', 'ok/%E0%A4%A'],
  ])('%s -> %s', (path, key) => {
    expect(repoFromPath(path)).toBe(key);
    expect(viewFromPath(path)).toBe('repo');
  });

  it.each(['/repos', '/repos/', '/repos//', '/prs', '/prs/kcosr/gh-dash', '/', '/repositories/x'])('%s is not a repo page', (path) => {
    expect(repoFromPath(path)).toBeUndefined();
  });
});

describe('canonicalRepoUrl (legacy bare names in the address bar)', () => {
  it('leaves URLs that already hold keys, or nothing about repos, alone', () => {
    expect(canon('/prs')).toBeNull();
    expect(canon('/prs', '?repos=kcosr/gh-dash,dlvhdr/gh-dash&who=me&pr=kcosr/gh-dash%2312')).toBeNull();
    expect(canon('/repos/kcosr/gh-dash')).toBeNull();
    expect(canon('/repos/kcosr%2Fgh-dash')).toBeNull();
    expect(canon('/repos')).toBeNull();
    expect(canon('/settings', '?x=%2B')).toBeNull();
  });

  it('leaves entries that name no known repo alone, including a bare name that only a manual repo has', () => {
    expect(canon('/prs', '?repos=nope,acme/nope')).toBeNull();
    expect(canon('/prs', '?repos=only-manual')).toBeNull();
    expect(canon('/prs', '?pr=nope%233&diff=nope%233')).toBeNull();
    expect(canon('/repos/only-manual')).toBeNull();
    expect(canon('/repos/nope/none')).toBeNull();
  });

  it('rewrites repos= entries and keeps the rest of the list', () => {
    expect(canon('/prs', '?repos=gh-dash,sedes&who=me')).toEqual({ pathname: '/prs', search: '?repos=kcosr/gh-dash,kcosr/sedes&who=me' });
    expect(canon('/prs', '?repos=nope,gh-dash,only-manual')).toEqual({ pathname: '/prs', search: '?repos=nope,kcosr/gh-dash,only-manual' });
    expect(canon('/activity', '?repos=GH-DASH,dlvhdr/gh-dash')).toEqual({ pathname: '/activity', search: '?repos=kcosr/gh-dash,dlvhdr/gh-dash' });
    expect(canon('/prs', '?repos=gh-dash,kcosr/gh-dash')).toEqual({ pathname: '/prs', search: '?repos=kcosr/gh-dash' }); // duplicates collapse
  });

  it('rewrites the repo part of pr= and diff=', () => {
    expect(canon('/prs', '?pr=gh-dash%2312')).toEqual({ pathname: '/prs', search: '?pr=kcosr/gh-dash%2312' });
    expect(canon('/prs', '?pr=gh-dash%2312&diff=gh-dash%2312&file=web/src/App.tsx')).toEqual({
      pathname: '/prs', search: '?pr=kcosr/gh-dash%2312&diff=kcosr/gh-dash%2312&file=web/src/App.tsx',
    });
    expect(canon('/activity', '?diff=sedes@6df2155')).toEqual({ pathname: '/activity', search: '?diff=kcosr/sedes@6df2155' });
    expect(canon('/prs', '?diff=SEDES@6DF2155')).toEqual({ pathname: '/prs', search: '?diff=kcosr/sedes@6DF2155' });
    // A branch's: the repo part ends at the '~', whatever the name holds.
    expect(canon('/repos/kcosr/sedes', '?diff=sedes~fix/a%2312&thread=3')).toEqual({ pathname: '/repos/kcosr/sedes', search: '?diff=kcosr/sedes~fix/a%2312&thread=3' });
    expect(canon('/prs', '?diff=kcosr/sedes~fix/a@b')).toBeNull();
  });

  it('rewrites a /repos/<name> path and keeps the search as it was', () => {
    expect(canon('/repos/gh-dash')).toEqual({ pathname: '/repos/kcosr/gh-dash', search: '' });
    expect(canon('/repos/gh-dash/', '?x=%2B&range=90d')).toEqual({ pathname: '/repos/kcosr/gh-dash', search: '?x=%2B&range=90d' });
    expect(canon('/repos/SEDES')).toEqual({ pathname: '/repos/kcosr/sedes', search: '' });
    expect(canon('/repos/DLVHDR/gh-dash')).toEqual({ pathname: '/repos/dlvhdr/gh-dash', search: '' });
  });

  it('rewrites path and search together, keeping unrelated params in order', () => {
    expect(canon('/repos/sedes', '?q=a%20b&repos=gh-dash&range=custom&from=2026-01-01&to=2026-02-01&pr=sedes%2316')).toEqual({
      pathname: '/repos/kcosr/sedes',
      search: '?q=a%20b&repos=kcosr/gh-dash&range=custom&from=2026-01-01&to=2026-02-01&pr=kcosr/sedes%2316',
    });
  });

  it('is settled after one rewrite, so replacing the URL cannot loop', () => {
    for (const [path, search] of [
      ['/repos/gh-dash', '?repos=gh-dash,sedes&pr=sedes%2316&diff=gh-dash@6df2155'],
      ['/prs', '?repos=GH-DASH,Sedes'],
      ['/repos/SEDES', ''],
    ] as const) {
      const once = canon(path, search)!;
      expect(once).not.toBeNull();
      expect(canon(once.pathname, once.search)).toBeNull();
    }
  });

  it('writes URLs the app parses back into keys', () => {
    const next = canon('/prs', '?repos=gh-dash,sedes&pr=sedes%2316&diff=gh-dash%232')!;
    const s = parseUrlState(next.search, 'prs');
    expect(s).toMatchObject({ repos: ['kcosr/gh-dash', 'kcosr/sedes'], pr: 'kcosr/sedes#16', diff: 'kcosr/gh-dash#2' });
    // and patching the state afterwards keeps keys readable (slashes unescaped)
    expect(patchSearch(next.search, 'prs', { q: 'x' })).toBe('?repos=kcosr/gh-dash,kcosr/sedes&q=x&pr=kcosr/sedes%2316&diff=kcosr/gh-dash%232');
  });

  it('does nothing while every key is a short name (today)', () => {
    const today = repoResolver([r('gh-dash'), r('sedes')]);
    expect(canonicalRepoUrl('/repos/gh-dash', '?repos=gh-dash,sedes&pr=sedes%2316&diff=gh-dash@6df2155', today)).toBeNull();
    expect(canonicalRepoUrl('/prs', '?repos=', today)).toBeNull();
  });
});

describe('urlState with owner/name keys', () => {
  it('parses repos, pr and diff holding slashes', () => {
    const s = parseUrlState('?repos=kcosr/gh-dash,dlvhdr/gh-dash&pr=dlvhdr/gh-dash%2312&diff=org/team/proj@abc1234&file=a.ts', 'prs');
    expect(s.repos).toEqual(['kcosr/gh-dash', 'dlvhdr/gh-dash']);
    expect(s.pr).toBe('dlvhdr/gh-dash#12');
    expect(s.diff).toBe('org/team/proj@abc1234');
    expect(s.file).toBe('a.ts');
  });
});
