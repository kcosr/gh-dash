import { describe, expect, it } from 'vitest';
import type { Repo, TrackedBy } from './api';
import {
  defaultRepoScope,
  inputHost,
  matchRepoRef,
  paletteRefKeys,
  parseGitHubInput,
  parseGitLabInput,
  parseRepoInput,
  repoLabel,
  repoParts,
  repoPath,
  repoRefKeys,
  repoResolver,
  resolveRepoKey,
  sourceForInput,
  selectRepos,
  splitKey,
} from './repos';

function repo(key: string, over: Partial<Repo> = {}, trackedBy: TrackedBy = 'owned'): Repo {
  const i = key.lastIndexOf('/');
  const name = i < 0 ? key : key.slice(i + 1);
  return {
    key, source: 'github.com', provider: 'github', name, nameWithOwner: i < 0 ? `alice/${key}` : key, owner: i < 0 ? 'alice' : key.slice(0, i), description: null,
    url: `https://github.com/${key}`, visibility: 'public', isArchived: false, isFork: false, language: null, topics: [],
    defaultBranch: 'main', stars: 0, forks: 0, createdAt: '2026-01-01T00:00:00Z', pushedAt: null, lastActivityAt: null,
    pinned: false, hidden: false, setIds: [], syncedAt: null, trackedBy, addedAt: null, unavailable: null,
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

describe('repoParts', () => {
  const map = new Map(many.map((r) => [r.key, r]));
  it('has no owner for a repo you own, so only the name is shown', () => {
    for (const source of [many, map]) expect(repoParts('kcosr/gh-dash', source)).toEqual({ owner: null, name: 'gh-dash' });
  });
  it('has the owner for anything else, split at the last slash', () => {
    for (const source of [many, map]) {
      expect(repoParts('dlvhdr/gh-dash', source)).toEqual({ owner: 'dlvhdr', name: 'gh-dash' });
      expect(repoParts('org/team/proj', source)).toEqual({ owner: 'org/team', name: 'proj' });
    }
  });
  it('keeps the owner of a key that is no longer in the list', () => {
    expect(repoParts('gone/repo', many)).toEqual({ owner: 'gone', name: 'repo' });
    expect(repoParts('gone', new Map())).toEqual({ owner: null, name: 'gone' });
  });
  it('never shows a source\'s host: the namespace path is the owner, and a gone key drops its host', () => {
    const GL = 'gitlab.example.com';
    const gl = repo(`${GL}/platform/team/api`, { source: GL, provider: 'gitlab', nameWithOwner: 'platform/team/api', owner: 'platform/team', name: 'api' }, 'manual');
    const mine = repo(`${GL}/alice/sedes`, { source: GL, provider: 'gitlab', nameWithOwner: 'alice/sedes', owner: 'alice', name: 'sedes' });
    const list = [...many, gl, mine];
    expect(repoParts(gl.key, list)).toEqual({ owner: 'platform/team', name: 'api' });
    expect(repoLabel(gl.key, list)).toBe('platform/team/api');
    expect(repoLabel(mine.key, list)).toBe('sedes');
    expect(repoParts(`${GL}/platform/gone`, list)).toEqual({ owner: 'platform', name: 'gone' });
    expect(repoParts(`${GL}/a/b/c`, new Map())).toEqual({ owner: 'a/b', name: 'c' });
    expect(repoParts('my.org/repo', new Map())).toEqual({ owner: 'my.org', name: 'repo' }); // one '/': a GitHub key
    expect(repoParts('org/team.x/proj', new Map())).toEqual({ owner: 'org/team.x', name: 'proj' }); // no '.' in the first segment
  });

  it('agrees with repoLabel: the owner and the name joined by a slash', () => {
    for (const r of many) {
      const { owner, name } = repoParts(r.key, map);
      expect(owner === null ? name : `${owner}/${name}`).toBe(repoLabel(r.key, map));
    }
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

describe('parseGitLabInput', () => {
  const gitlab = { host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' };
  const ok = { path: 'platform/team/app' };
  it.each([
    'platform/team/app',
    '  platform/team/app/  ',
    'platform/team/app.git',
    'gitlab.example.com/platform/team/app', // its key
    'GITLAB.example.com/platform/team/app',
    'gitlab.example.com/platform/team/app/-/issues/3',
    'https://gitlab.example.com/platform/team/app',
    'https://gitlab.example.com/platform/team/app/',
    'https://gitlab.example.com/platform/team/app.git',
    'https://gitlab.example.com/platform/team/app/-/merge_requests/12',
    'https://gitlab.example.com/platform/team/app/-/merge_requests/12/diffs#note_7',
    'https://gitlab.example.com/platform/team/app/-/tree/main/src?ref_type=heads',
    'https://gitlab.example.com/platform/team/app#readme',
    'http://gitlab.example.com:8080/platform/team/app',
    'HTTPS://GitLab.Example.com/platform/team/app',
    'git@gitlab.example.com:platform/team/app.git',
    'git@gitlab.example.com:platform/team/app',
    'ssh://git@gitlab.example.com/platform/team/app.git',
    'ssh://git@gitlab.example.com:2222/platform/team/app.git',
  ])('parses %s', (text) => {
    expect(parseGitLabInput(text, gitlab)).toEqual(ok);
  });

  it('takes any depth of groups, and keeps dots, underscores and hyphens as typed', () => {
    expect(parseGitLabInput('alice/app', gitlab)).toEqual({ path: 'alice/app' });
    expect(parseGitLabInput('alice/corp.tools', gitlab)).toEqual({ path: 'alice/corp.tools' });
    expect(parseGitLabInput('Platform/Team_2/sub-group/My.App', gitlab)).toEqual({ path: 'Platform/Team_2/sub-group/My.App' });
  });

  it('reads web URLs below the relative root, and keys and ssh addresses without it', () => {
    const rooted = { host: 'code.example.com', baseUrl: 'https://code.example.com/gitlab/' };
    expect(parseGitLabInput('https://code.example.com/gitlab/platform/team/app/-/merge_requests/1', rooted)).toEqual(ok);
    expect(parseGitLabInput('https://code.example.com/gitlab/alice/app', rooted)).toEqual({ path: 'alice/app' });
    expect(parseGitLabInput('code.example.com/alice/app', rooted)).toEqual({ path: 'alice/app' });
    expect(parseGitLabInput('git@code.example.com:alice/app.git', rooted)).toEqual({ path: 'alice/app' });
    // A URL outside the root isn't a page of this instance.
    for (const text of ['https://code.example.com/alice/app', 'https://code.example.com/gitlab', 'https://code.example.com/gitlab/alice', 'https://code.example.com/gitlabx/alice/app']) {
      expect(parseGitLabInput(text, rooted), text).toBeNull();
    }
  });

  it.each([
    '',
    '   ',
    'app', // a project needs its namespace
    'alice/',
    '/alice/app',
    'alice//app',
    'alice/app#3', // '#', '@', ',', '%', '?' and whitespace can't be in a key
    'alice/app@abc1234',
    'alice/app,bob/tool',
    'alice/a%2Fb',
    'alice/app?x=1',
    'ali ce/app',
    'alice/..',
    './app',
    'alice/.',
    'alice/.git',
    '-/profile',
    'alice/-app',
    'ünï/app',
    'https://gitlab.example.com/alice',
    'https://gitlab.example.com/-/profile',
    'https://gitlab.example.com/',
    'https://alice:secret@gitlab.example.com/alice/app', // an address carrying credentials
    // Another host.
    'https://gitlab.other.example/alice/app',
    'https://gitlab.example.com.evil.example/alice/app',
    'git@github.com:alice/app.git',
    'https://github.com/alice/app',
    'github.com/alice/app',
  ])('rejects %j', (text) => {
    expect(parseGitLabInput(text, gitlab)).toBeNull();
  });
});

describe('inputHost and sourceForInput', () => {
  it.each([
    ['https://gitlab.example.com/gitlab/alice/app', 'gitlab.example.com'],
    ['http://GitLab.Example.com:8080/alice/app', 'gitlab.example.com'],
    ['git@GitLab.example.com:alice/app.git', 'gitlab.example.com'],
    ['ssh://git@gitlab.example.com:2222/alice/app.git', 'gitlab.example.com'],
    ['https://www.github.com/alice/app', 'github.com'],
    ['github.com/alice/app', 'github.com'],
    ['www.github.com/alice/app', 'github.com'],
    ['alice/app', null],
    ['platform/team/app', null],
    ['gitlab.example.com/alice/app', null], // a key's host counts when it's a source's
    ['not an address', null],
  ])('%s names %s', (text, host) => {
    expect(inputHost(text)).toBe(host);
  });

  it("reads a key's first segment as a host when it's a source's, or with guess when it reads like one", () => {
    expect(inputHost('GITLAB.example.com/alice/app', ['gitlab.example.com'])).toBe('gitlab.example.com');
    expect(inputHost('gitlab.example.com/alice/app', [], { guess: true })).toBe('gitlab.example.com');
    expect(inputHost('gitlab.example.com/alice/app/-/issues', [], { guess: true })).toBe('gitlab.example.com');
    // Two segments are a path: GitLab groups may have dots.
    expect(inputHost('my.group/app', [], { guess: true })).toBeNull();
    expect(inputHost('alice/team/app', [], { guess: true })).toBeNull();
  });

  it('picks the source an input names among those given', () => {
    const sources = [{ host: 'github.com', id: 1 }, { host: 'gitlab.example.com', id: 2 }];
    expect(sourceForInput('https://gitlab.example.com/gitlab/alice/app/-/merge_requests/3', sources)?.id).toBe(2);
    expect(sourceForInput('GITLAB.EXAMPLE.COM/alice/app', sources)?.id).toBe(2);
    expect(sourceForInput('git@github.com:alice/app.git', sources)?.id).toBe(1);
    expect(sourceForInput('https://github.com/alice/app', sources)?.id).toBe(1);
    expect(sourceForInput('alice/app', sources)).toBeNull();
    expect(sourceForInput('https://gitlab.other.example/alice/app', sources)).toBeNull();
  });

  it("keeps GitHub's parser as parseGitHubInput", () => {
    expect(parseGitHubInput).toBe(parseRepoInput);
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
    expect(matchRepoRef(text)).toEqual({ repo: repoPart, sep: '#', number });
  });

  it.each([
    ['app!12', 'app', '12'],
    ['gitlab.example.com/platform/team/app!3', 'gitlab.example.com/platform/team/app', '3'],
  ])('matches the MR reference %s', (text, repoPart, number) => {
    expect(matchRepoRef(text)).toEqual({ repo: repoPart, sep: '!', number });
  });

  it.each(['', 'gh-dash', 'gh-dash#', 'gh-dash!', '#12', '!12', 'gh dash#1', 'a//b#1', '/a#1', 'a/#1', 'a/b/#1', 'a#1b', 'a#x', 'a#1#2', 'a!1#2', 'a#1!2', 'a@b#1'])('does not match %j', (text) => {
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

  describe('by kind and context', () => {
    const GL = 'gitlab.example.com';
    const gl = (path: string, trackedBy: TrackedBy = 'owned') =>
      repo(`${GL}/${path}`, { source: GL, provider: 'gitlab', nameWithOwner: path, owner: path.slice(0, path.lastIndexOf('/')) }, trackedBy);
    const both = [repo('alice/app'), repo('alice/tool'), gl('alice/app'), gl('platform/team/svc', 'manual')];
    const keys = (text: string, context: string | null = null) => paletteRefKeys(matchRepoRef(text)!, both, context);

    it('reads ! as a GitLab MR, and anything else as text', () => {
      expect(keys('app!3')).toEqual([`${GL}/alice/app`]);
      expect(keys('svc!3', 'github.com')).toEqual([`${GL}/platform/team/svc`]);
      expect(keys('tool!3')).toBeNull(); // only on GitHub: a text search, as before
      expect(keys('nope!3')).toBeNull();
    });

    it('reads # as a GitHub PR, the context first, then leniently any repo', () => {
      expect(keys('app#3')).toEqual(['alice/app']);
      expect(keys('app#3', 'github.com')).toEqual(['alice/app']);
      expect(keys('app#3', GL)).toEqual([`${GL}/alice/app`]); // in GitLab's context, its app
      expect(keys('svc#3')).toEqual([`${GL}/platform/team/svc`]); // no GitHub repo of that name
      expect(keys('tool#3', GL)).toEqual(['alice/tool']); // not in the context: anywhere
      expect(keys('nope#3')).toEqual([]);
    });
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
    // explicit repos= wins over the default selection
    expect(keys(selectRepos(all, { scope: 'default', repos: 'kcosr/old' }))).toEqual(['kcosr/old']);
  });

  it('filters by ownership: mine = owned, others = added by hand', () => {
    expect(keys(selectRepos(all, { scope: 'default', ownership: 'mine' }))).toEqual(['kcosr/gh-dash', 'kcosr/sedes']);
    expect(keys(selectRepos(all, { scope: 'default', ownership: 'others' }))).toEqual(['dlvhdr/gh-dash']);
    expect(keys(selectRepos(all, { ownership: 'all' }))).toHaveLength(6);
    expect(keys(selectRepos(all, { repos: 'gh-dash,dlvhdr/gh-dash', ownership: 'others' }))).toEqual(['dlvhdr/gh-dash']);
    expect(keys(selectRepos(all, { q: 'DLVHDR' }))).toEqual(['dlvhdr/gh-dash']);
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

describe('selectRepos by source', () => {
  const keys = (list: Repo[]) => list.map((r) => r.key).sort();
  const gl = (key: string, over: Partial<Repo> = {}) =>
    repo(`gitlab.example.com/${key}`, { source: 'gitlab.example.com', provider: 'gitlab', nameWithOwner: key, ...over });
  const all = [repo('kcosr/gh-dash'), repo('kcosr/old', { isArchived: true }), gl('alice/gh-dash'), gl('platform/team/svc', { hidden: true })];

  it('keeps the repos of the sources named, case-insensitively; none named is every source', () => {
    expect(keys(selectRepos(all, { source: 'gitlab.example.com' }))).toEqual(['gitlab.example.com/alice/gh-dash', 'gitlab.example.com/platform/team/svc']);
    expect(keys(selectRepos(all, { source: 'GitHub.com' }))).toEqual(['kcosr/gh-dash', 'kcosr/old']);
    expect(keys(selectRepos(all, { source: 'github.com, gitlab.example.com' }))).toHaveLength(4);
    expect(keys(selectRepos(all, { source: '' }))).toHaveLength(4);
    expect(selectRepos(all, { source: 'nowhere.example.com' })).toEqual([]);
  });

  it('intersects the explicit selection and the default one', () => {
    expect(keys(selectRepos(all, { scope: 'default', source: 'gitlab.example.com' }))).toEqual(['gitlab.example.com/alice/gh-dash']);
    expect(keys(selectRepos(all, { repos: 'gh-dash,gitlab.example.com/platform/team/svc', source: 'gitlab.example.com' }))).toEqual(['gitlab.example.com/platform/team/svc']);
    expect(selectRepos(all, { repos: 'kcosr/gh-dash', source: 'gitlab.example.com' })).toEqual([]);
  });
});
