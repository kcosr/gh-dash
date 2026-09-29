import { defaultUrlTransform } from 'react-markdown';
import { describe, expect, it } from 'vitest';
import type { Repo } from './api';
import {
  PROVIDERS, capitalize, linkBase, mixedPrWords, refText, repoKind, repoProvider, resolveItemUrl, sourceRootUrl, wordsFor,
  type ProviderRepo,
} from './provider';

const GH = 'https://github.com/kcosr/gh-dash';
const GL = 'https://gitlab.example.com/alice/app';
// A GitLab under a relative root, with a nested project.
const GL_ROOTED = 'https://gitlab.example.com/gitlab/platform/team/svc';

const ghRepo: ProviderRepo = { url: GH, nameWithOwner: 'kcosr/gh-dash', provider: 'github' };
const glRepo: ProviderRepo = { url: GL, nameWithOwner: 'alice/app', provider: 'gitlab' };
const glRooted: ProviderRepo = { url: GL_ROOTED, nameWithOwner: 'platform/team/svc', provider: 'gitlab' };

describe('PROVIDERS', () => {
  it('builds GitHub URLs exactly as the web did before the descriptor', () => {
    const { link } = PROVIDERS.github;
    const pr = `${GH}/pull/3`;
    expect(link.pr(GH, 3)).toBe(pr);
    expect(link.prFiles(pr)).toBe(`${GH}/pull/3/files`);
    expect(link.prCommits(pr)).toBe(`${GH}/pull/3/commits`);
    expect(link.commit(GH, '6df21550c42ff69731e827d728f33f1577aba87f')).toBe(`${GH}/commit/6df21550c42ff69731e827d728f33f1577aba87f`);
    expect(link.prs(GH)).toBe(`${GH}/pulls`);
    expect(link.issues(GH)).toBe(`${GH}/issues`);
    expect(link.releases(GH)).toBe(`${GH}/releases`);
  });

  it('builds GitLab URLs under /-/, relative root and nested groups included', () => {
    const { link } = PROVIDERS.gitlab;
    const mr = `${GL}/-/merge_requests/12`;
    expect(link.pr(GL, 12)).toBe(mr);
    expect(link.prFiles(mr)).toBe(`${GL}/-/merge_requests/12/diffs`);
    expect(link.prCommits(mr)).toBe(`${GL}/-/merge_requests/12/commits`);
    expect(link.commit(GL, 'abc1234')).toBe(`${GL}/-/commit/abc1234`);
    expect(link.prs(GL)).toBe(`${GL}/-/merge_requests`);
    expect(link.issues(GL)).toBe(`${GL}/-/issues`);
    expect(link.releases(GL)).toBe(`${GL}/-/releases`);
    expect(link.pr(GL_ROOTED, 7)).toBe('https://gitlab.example.com/gitlab/platform/team/svc/-/merge_requests/7');
  });

  it('anchors a file in a diff page: sha256 with a diff- prefix on GitHub, sha1 on GitLab', async () => {
    expect(await PROVIDERS.github.link.fileAnchor('README.md')).toBe('#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5');
    expect(await PROVIDERS.gitlab.link.fileAnchor('README.md')).toBe('#8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d');
    expect(await PROVIDERS.gitlab.link.fileAnchor('web/src/App.tsx')).toBe('#32c2b18b2edc5c4977610ff88b719fb33d188fb6');
  });

  it('has each host\'s words and reference prefix', () => {
    expect(PROVIDERS.github).toMatchObject({ kind: 'github', name: 'GitHub', cli: 'gh', prRef: '#' });
    expect(PROVIDERS.github.pr).toEqual({ one: 'pull request', many: 'pull requests', short: 'PR', shortMany: 'PRs', nav: 'Pull requests' });
    expect(PROVIDERS.gitlab).toMatchObject({ kind: 'gitlab', name: 'GitLab', cli: 'glab', prRef: '!' });
    expect(PROVIDERS.gitlab.pr).toEqual({ one: 'merge request', many: 'merge requests', short: 'MR', shortMany: 'MRs', nav: 'Merge requests' });
  });
});

describe('repoProvider', () => {
  it('reads the repo\'s provider, GitHub when it has none or is unknown', () => {
    expect(repoProvider(glRepo)).toBe(PROVIDERS.gitlab);
    expect(repoProvider(ghRepo)).toBe(PROVIDERS.github);
    expect(repoProvider(undefined)).toBe(PROVIDERS.github);
    expect(repoKind(null)).toBe('github');
  });

  it('takes an API Repo as it is today (every repo on github.com until Repo.provider exists)', () => {
    const repo = { key: 'kcosr/gh-dash', url: GH, nameWithOwner: 'kcosr/gh-dash' } as Repo;
    expect(repoProvider(repo).name).toBe('GitHub');
  });
});

describe('words for several repos', () => {
  it('uses one kind\'s own words, neutral words for both, GitHub\'s for none', () => {
    expect(mixedPrWords(['gitlab', 'gitlab'])).toBe(PROVIDERS.gitlab.pr);
    expect(mixedPrWords(['github'])).toBe(PROVIDERS.github.pr);
    expect(mixedPrWords([])).toBe(PROVIDERS.github.pr);
    expect(mixedPrWords(['github', 'gitlab'])).toEqual({
      one: 'pull or merge request', many: 'pull & merge requests', short: 'PR or MR', shortMany: 'PRs & MRs', nav: 'PRs & MRs',
    });
    expect(capitalize(mixedPrWords(['gitlab', 'github']).many)).toBe('Pull & merge requests');
  });

  it('names the host only when there is one', () => {
    expect(wordsFor([])).toEqual({ pr: PROVIDERS.github.pr, host: 'GitHub' });
    expect(wordsFor(['gitlab'])).toEqual({ pr: PROVIDERS.gitlab.pr, host: 'GitLab' });
    expect(wordsFor(['gitlab', 'github']).host).toBeNull();
  });
});

describe('refText', () => {
  it('writes MRs with ! and everything else with #', () => {
    expect(refText('github', 'gh-dash', 12, 'pr')).toBe('gh-dash#12');
    expect(refText('gitlab', 'app', 12, 'pr')).toBe('app!12');
    expect(refText('gitlab', 'gitlab.example.com/alice/app', 3, 'issue')).toBe('gitlab.example.com/alice/app#3');
    expect(refText('github', 'dlvhdr/gh-dash', 3, 'issue')).toBe('dlvhdr/gh-dash#3');
  });
});

describe('sourceRootUrl', () => {
  it('takes the repo path off its URL, keeping a relative root', () => {
    expect(sourceRootUrl(ghRepo)).toBe('https://github.com');
    expect(sourceRootUrl(glRepo)).toBe('https://gitlab.example.com');
    expect(sourceRootUrl(glRooted)).toBe('https://gitlab.example.com/gitlab');
    // Paths are case-insensitive on both hosts; a trailing slash is ignored.
    expect(sourceRootUrl({ url: 'https://gitlab.example.com/Alice/App/', nameWithOwner: 'alice/app' })).toBe('https://gitlab.example.com');
  });

  it('falls back to the origin when the URL does not end with the path', () => {
    expect(sourceRootUrl({ url: 'https://github.com/kcosr/renamed', nameWithOwner: 'kcosr/gh-dash' })).toBe('https://github.com');
  });
});

describe('links in an item\'s Markdown', () => {
  const gh = linkBase(ghRepo);
  const gl = linkBase(glRepo);
  const rooted = linkBase(glRooted);

  it('resolves GitLab uploads against the project and other root-relative links against the instance', () => {
    expect(resolveItemUrl('/uploads/0a1b2c/screen.png', gl)).toBe('https://gitlab.example.com/alice/app/uploads/0a1b2c/screen.png');
    expect(resolveItemUrl('/platform/team/svc/-/issues/3', gl)).toBe('https://gitlab.example.com/platform/team/svc/-/issues/3');
    expect(resolveItemUrl('/uploads/0a1b2c/log.txt', rooted)).toBe('https://gitlab.example.com/gitlab/platform/team/svc/uploads/0a1b2c/log.txt');
    expect(resolveItemUrl('/alice/app/-/merge_requests/2', rooted)).toBe('https://gitlab.example.com/gitlab/alice/app/-/merge_requests/2');
  });

  it('sends GitHub root-relative links to github.com instead of the app', () => {
    expect(resolveItemUrl('/kcosr/gh-dash/pull/3', gh)).toBe('https://github.com/kcosr/gh-dash/pull/3');
    // GitHub has no project-relative uploads.
    expect(resolveItemUrl('/uploads/x.png', gh)).toBe('https://github.com/uploads/x.png');
  });

  it('leaves every other URL alone', () => {
    for (const url of [
      'https://github.com/kcosr/gh-dash', 'http://example.com/a', 'mailto:alice@example.com', '#usage', '?tab=1',
      'docs/usage.md', './a.png', '../-/issues/3', '//cdn.example.com/x.png', '/\\example.com', '',
    ]) {
      expect(resolveItemUrl(url, gl)).toBe(url);
      expect(resolveItemUrl(url, gh)).toBe(url);
    }
  });

  it('runs after react-markdown\'s transform, so unsafe URLs stay blank', () => {
    const transform = (url: string) => resolveItemUrl(defaultUrlTransform(url), gl);
    expect(transform('javascript:alert(1)')).toBe('');
    expect(transform('/uploads/a/b.png')).toBe('https://gitlab.example.com/alice/app/uploads/a/b.png');
    expect(transform('https://example.com/x')).toBe('https://example.com/x');
  });
});
