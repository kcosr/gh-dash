import { describe, expect, it } from 'vitest';
import type { Repo, TrackedBy } from './api';
import {
  defaultRepoScope,
  matchRepoRef,
  parseRepoInput,
  repoLabel,
  repoPath,
  repoRefKeys,
  repoResolver,
  resolveRepoKey,
  selectRepos,
  splitKey,
} from './repos';

function repo(key: string, over: Partial<Repo> = {}, trackedBy: TrackedBy = 'owned'): Repo {
  const i = key.lastIndexOf('/');
  const name = i < 0 ? key : key.slice(i + 1);
  return {
    key, name, nameWithOwner: i < 0 ? `alice/${key}` : key, owner: i < 0 ? 'alice' : key.slice(0, i), description: null,
    url: `https://github.com/${key}`, visibility: 'public', isArchived: false, isFork: false, language: null, topics: [],
    defaultBranch: 'main', stars: 0, forks: 0, createdAt: '2026-01-01T00:00:00Z', pushedAt: null, lastActivityAt: null,
    pinned: false, hidden: false, setIds: [], syncedAt: null, trackedBy,
    stats: { openPrs: 0, openIssues: 0, mergedPrs30d: 0, commits30d: 0, newStars30d: 0, weeklyCommits: [] },
    ...over,
  };
}

// Owner/name keys, as they will be once repositories from other owners can be tracked: a collision on the short
// name (kcosr/gh-dash owned, dlvhdr/gh-dash added by hand), a manual repo alone under its name, and a nested path.
const owned = repo('kcosr/gh-dash');
const collide = repo('dlvhdr/gh-dash', {}, 'manual');
const sedes = repo('kcosr/sedes');
const lonely = repo('acme/only-manual', {}, 'manual');
const nested = repo('org/team/proj', {}, 'manual');
const twinA = repo('a/twin', {}, 'manual');
const twinB = repo('b/twin', {}, 'manual');
const many = [owned, collide, sedes, lonely, nested, twinA, twinB];

describe('splitKey', () => {
  it('splits at the last slash and leaves a bare key without an owner', () => {
    expect(splitKey('kcosr/gh-dash')).toEqual({ owner: 'kcosr', name: 'gh-dash' });
    expect(splitKey('org/team/proj')).toEqual({ owner: 'org/team', name: 'proj' });
    expect(splitKey('gh-dash')).toEqual({ owner: null, name: 'gh-dash' });
  });
});

describe('repoPath', () => {
  it('encodes each segment and keeps the slashes', () => {
    expect(repoPath('gh-dash')).toBe('/repos/gh-dash');
    expect(repoPath('kcosr/gh-dash')).toBe('/repos/kcosr/gh-dash');
    expect(repoPath('org/team/my.proj_x')).toBe('/repos/org/team/my.proj_x');
    expect(repoPath('a b/c#d')).toBe('/repos/a%20b/c%23d');
  });
});

describe('resolveRepoKey', () => {
  const cases: [string, string | null][] = [
    ['kcosr/gh-dash', 'kcosr/gh-dash'],
    ['KCOSR/Gh-Dash', 'kcosr/gh-dash'], // exact key, case-insensitive
    ['dlvhdr/gh-dash', 'dlvhdr/gh-dash'],
    ['DLVHDR/GH-DASH', 'dlvhdr/gh-dash'],
    ['gh-dash', 'kcosr/gh-dash'], // a bare name is the owned repo of that name, never the manual one
    ['GH-DASH', 'kcosr/gh-dash'],
    ['sedes', 'kcosr/sedes'],
    ['only-manual', null], // a bare name that matches only a manual repo resolves to nothing
    ['acme/only-manual', 'acme/only-manual'],
    ['twin', null],
    ['org/team/proj', 'org/team/proj'],
    ['ORG/Team/PROJ', 'org/team/proj'],
    ['team/proj', null], // no suffix matching
    ['proj', null],
    ['nope', null],
    ['kcosr/nope', null],
    ['', null],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(resolveRepoKey(input, many)).toBe(expected);
    expect(repoResolver(many)(input)).toBe(expected);
  });

  it('accepts a map keyed by key, like the web app has', () => {
    const map = new Map(many.map((r) => [r.key, r]));
    expect(resolveRepoKey('GH-DASH', map)).toBe('kcosr/gh-dash');
    expect(resolveRepoKey('only-manual', map)).toBeNull();
  });

  it('is the identity on names today, when every key is a short name of an owned repo', () => {
    const today = [repo('sedes'), repo('gh-dash')];
    expect(resolveRepoKey('sedes', today)).toBe('sedes');
    expect(resolveRepoKey('SEDES', today)).toBe('sedes');
    expect(resolveRepoKey('alice/sedes', today)).toBeNull();
  });
});

describe('repoLabel', () => {
  it('is the short name for a repo you own and the whole key for anything else', () => {
    const map = new Map(many.map((r) => [r.key, r]));
    for (const source of [many, map]) {
      expect(repoLabel('kcosr/gh-dash', source)).toBe('gh-dash');
      expect(repoLabel('dlvhdr/gh-dash', source)).toBe('dlvhdr/gh-dash');
      expect(repoLabel('org/team/proj', source)).toBe('org/team/proj');
    }
  });
  it('shows a key that is no longer in the list as it is', () => {
    expect(repoLabel('gone/repo', many)).toBe('gone/repo');
    expect(repoLabel('gone', new Map())).toBe('gone');
  });
  it('is the key itself today, when key and short name are the same', () => {
    expect(repoLabel('sedes', [repo('sedes')])).toBe('sedes');
  });
});

describe('parseRepoInput', () => {
  const ok = { owner: 'kcosr', name: 'gh-dash' };
  it.each([
    'kcosr/gh-dash',
    '  kcosr/gh-dash  ',
    'kcosr/gh-dash/',
    'kcosr/gh-dash.git',
    'https://github.com/kcosr/gh-dash',
    'https://github.com/kcosr/gh-dash/',
    'https://github.com/kcosr/gh-dash.git',
    'https://github.com/kcosr/gh-dash/pull/12',
    'https://github.com/kcosr/gh-dash/tree/main/web/src',
    'https://github.com/kcosr/gh-dash?tab=readme-ov-file',
    'https://github.com/kcosr/gh-dash#readme',
    'http://github.com/kcosr/gh-dash',
    'https://www.github.com/kcosr/gh-dash',
    'HTTPS://GitHub.com/kcosr/gh-dash',
    'github.com/kcosr/gh-dash',
    'www.github.com/kcosr/gh-dash.git',
    'git@github.com:kcosr/gh-dash.git',
    'git@github.com:kcosr/gh-dash',
    'git@GitHub.com:kcosr/gh-dash.git',
  ])('parses %s', (text) => {
    expect(parseRepoInput(text)).toEqual(ok);
  });

  it('keeps dots, underscores and leading dots in names, and digits and hyphens in owners', () => {
    expect(parseRepoInput('my-org-2/my.repo_x')).toEqual({ owner: 'my-org-2', name: 'my.repo_x' });
    expect(parseRepoInput('kcosr/.github')).toEqual({ owner: 'kcosr', name: '.github' });
    expect(parseRepoInput('https://github.com/dlvhdr/gh-dash.git')).toEqual({ owner: 'dlvhdr', name: 'gh-dash' });
  });

  it.each([
    '',
    '   ',
    'gh-dash', // a bare name isn't an address
    'kcosr/',
    '/gh-dash',
    'a/b/c', // more than owner/name
    'kcosr/gh-dash/pull/12', // only with a URL
    'https://gitlab.com/kcosr/gh-dash', // other hosts are refused until sources exist
    'gitlab.com/kcosr/gh-dash',
    'git@gitlab.com:kcosr/gh-dash.git',
    'https://github.com.evil.example/kcosr/gh-dash',
    'https://evilgithub.com/kcosr/gh-dash',
    'https://github.com/kcosr',
    'https://github.com/',
    'ssh://git@github.com/kcosr/gh-dash.git',
    'kcosr/gh-dash#3', // '#', '@', ',', '%', '?' and whitespace can't be in a key
    'kcosr/gh-dash@abc1234',
    'kcosr/gh-dash,kcosr/sedes',
    'kcosr/gh%2Ddash',
    'kcosr/gh-dash?x=1',
    'kco sr/gh-dash',
    'kcosr/gh dash',
    'kcosr/..',
    'kcosr/.',
    'kcosr/.git',
    'k.cosr/gh-dash', // owners have no dots
    'kcosr_/gh-dash',
    'ünï/gh-dash',
  ])('rejects %j', (text) => {
    expect(parseRepoInput(text)).toBeNull();
  });

  it('trims surrounding whitespace, newlines included', () => {
    expect(parseRepoInput('\n kcosr/gh-dash\n')).toEqual(ok);
  });
});

describe('the palette reference', () => {
  it.each([
    ['gh-dash#12', 'gh-dash', '12'],
    ['kcosr/gh-dash#12', 'kcosr/gh-dash', '12'],
    ['org/team/proj#3', 'org/team/proj', '3'],
    ['my.repo_x#1', 'my.repo_x', '1'],
    ['Kcosr/Gh-Dash#007', 'Kcosr/Gh-Dash', '007'],
  ])('matches %s', (text, repoPart, number) => {
    expect(matchRepoRef(text)).toEqual({ repo: repoPart, number });
  });

  it.each(['', 'gh-dash', 'gh-dash#', '#12', 'gh dash#1', 'a//b#1', '/a#1', 'a/#1', 'a/b/#1', 'a#1b', 'a#x', 'a#1#2', 'a@b#1'])('does not match %j', (text) => {
    expect(matchRepoRef(text)).toBeNull();
  });

  it('resolves its repo part like any other reference, then falls back to short names', () => {
    expect(repoRefKeys('kcosr/gh-dash', many)).toEqual(['kcosr/gh-dash']);
    expect(repoRefKeys('DLVHDR/gh-dash', many)).toEqual(['dlvhdr/gh-dash']);
    expect(repoRefKeys('gh-dash', many)).toEqual(['kcosr/gh-dash']); // the owned alias, not the manual namesake
    expect(repoRefKeys('only-manual', many)).toEqual(['acme/only-manual']); // a search, not a key
    expect(repoRefKeys('proj', many)).toEqual(['org/team/proj']);
    expect(repoRefKeys('TWIN', many).sort()).toEqual(['a/twin', 'b/twin']);
    expect(repoRefKeys('nope', many)).toEqual([]);
    expect(repoRefKeys('team/proj', many)).toEqual([]);
  });
});

describe('selectRepos with keys', () => {
  const keys = (list: Repo[]) => list.map((r) => r.key);
  const all = [
    repo('kcosr/gh-dash', { lastActivityAt: '2026-03-01T00:00:00Z', stars: 5 }),
    repo('dlvhdr/gh-dash', { lastActivityAt: '2026-04-01T00:00:00Z', stars: 9, visibility: 'private' }, 'manual'),
    repo('kcosr/sedes', { lastActivityAt: '2026-02-01T00:00:00Z' }),
    repo('kcosr/old', { isArchived: true }),
    repo('kcosr/hid', { hidden: true }),
    repo('kcosr/frk', { isFork: true }),
  ];

  it('selects by key or owned alias, case-insensitively, and ignores entries naming nothing', () => {
    expect(keys(selectRepos(all, { repos: 'gh-dash' }))).toEqual(['kcosr/gh-dash']);
    expect(keys(selectRepos(all, { repos: 'kcosr/gh-dash,DLVHDR/gh-dash' }))).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash']);
    expect(keys(selectRepos(all, { repos: 'kcosr/gh-dash, nope ,,sedes' }))).toEqual(['kcosr/gh-dash', 'kcosr/sedes']);
    expect(selectRepos(all, { repos: '' })).toEqual([]);
    expect(selectRepos(all, { repos: 'dlvhdr' })).toEqual([]);
  });

  it('defaults to keys of repos that are not archived, hidden or forks', () => {
    expect(defaultRepoScope(all)).toEqual(['kcosr/gh-dash', 'dlvhdr/gh-dash', 'kcosr/sedes']);
    expect(defaultRepoScope(all, true)).toEqual(['kcosr/gh-dash', 'dlvhdr/gh-dash', 'kcosr/sedes', 'kcosr/frk']);
    expect(keys(selectRepos(all, { scope: 'default' }))).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash', 'kcosr/sedes']);
    expect(keys(selectRepos(all, { scope: 'default' }, true))).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash', 'kcosr/sedes', 'kcosr/frk']);
    expect(keys(selectRepos(all, {}))).toHaveLength(6);
    // explicit repos= wins over the default scope
    expect(keys(selectRepos(all, { scope: 'default', repos: 'kcosr/old' }))).toEqual(['kcosr/old']);
  });

  it('filters by visibility and searches key text', () => {
    expect(keys(selectRepos(all, { repos: 'kcosr/gh-dash,dlvhdr/gh-dash', visibility: 'private' }))).toEqual(['dlvhdr/gh-dash']);
    expect(keys(selectRepos(all, { q: 'dlvhdr' }))).toEqual(['dlvhdr/gh-dash']);
    expect(keys(selectRepos(all, { q: 'GH-DASH', sort: 'name' }))).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash']);
  });

  it('orders pinned, then visible first, then by the sort, breaking ties on the key', () => {
    // by short name, so the two gh-dash repos are adjacent and ordered by key; the hidden one goes last
    expect(keys(selectRepos(all, { sort: 'name' }))).toEqual(['kcosr/frk', 'dlvhdr/gh-dash', 'kcosr/gh-dash', 'kcosr/old', 'kcosr/sedes', 'kcosr/hid']);
    expect(keys(selectRepos(all, { sort: 'stars', scope: 'default' }))).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash', 'kcosr/sedes']);
    expect(keys(selectRepos(all, { scope: 'default' }))).toEqual(['dlvhdr/gh-dash', 'kcosr/gh-dash', 'kcosr/sedes']); // most recent activity first
    const pinned = all.map((r) => (r.key === 'kcosr/sedes' ? { ...r, pinned: true } : r));
    expect(keys(selectRepos(pinned, { scope: 'default' }))[0]).toBe('kcosr/sedes');
  });
});
