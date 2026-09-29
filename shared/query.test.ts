import { describe, expect, it } from 'vitest';
import { encodeQueryValue, rewriteRepoParams, rewriteRepoPath } from './query';

const KEYS: Record<string, string> = { a: 'alice/a', b: 'alice/b', proj: 'grp/sub/proj' };
/** Bare names only, like the v5 saved-view rewrite. */
const resolve = (repo: string) => (repo.includes('/') ? null : KEYS[repo.toLowerCase()] ?? null);

describe('encodeQueryValue', () => {
  it("keeps ',', '/' and '@' readable and escapes everything else", () => {
    expect(encodeQueryValue('alice/a,alice/b')).toBe('alice/a,alice/b');
    expect(encodeQueryValue('alice/a@abc1234')).toBe('alice/a@abc1234');
    expect(encodeQueryValue('alice/a#12')).toBe('alice/a%2312');
    expect(encodeQueryValue('a b&c=d+e%f?')).toBe('a%20b%26c%3Dd%2Be%25f%3F');
  });
});

describe('rewriteRepoParams', () => {
  it('maps each resolvable entry of `repos` and leaves unknown ones as they are', () => {
    expect(rewriteRepoParams('repos=a,b', resolve)).toBe('repos=alice/a,alice/b');
    expect(rewriteRepoParams('repos=a,nope', resolve)).toBe('repos=alice/a,nope');
    expect(rewriteRepoParams('repos=A', resolve)).toBe('repos=alice/a');
    expect(rewriteRepoParams('repos=proj', resolve)).toBe('repos=grp/sub/proj');
  });

  it('maps the repo part of `pr` and `diff`', () => {
    expect(rewriteRepoParams('pr=a%231', resolve)).toBe('pr=alice/a%231');
    expect(rewriteRepoParams('diff=a%2312', resolve)).toBe('diff=alice/a%2312');
    expect(rewriteRepoParams('diff=a@abc1234', resolve)).toBe('diff=alice/a@abc1234');
    expect(rewriteRepoParams('diff=a%40abc1234', resolve)).toBe('diff=alice/a@abc1234');
    expect(rewriteRepoParams('pr=nope%231&diff=nope@abc1234', resolve)).toBe('pr=nope%231&diff=nope@abc1234');
    expect(rewriteRepoParams('pr=12', resolve)).toBe('pr=12');
  });

  it('keeps every other byte, including params it does not rewrite', () => {
    const rest = 'who=me&range=custom&from=2026-09-01&to=2026-09-27&q=a%20b+c&types=pr,commit&file=src/x.ts&rel=0&flag&x=%7E&=v';
    expect(rewriteRepoParams(`${rest}&repos=a`, resolve)).toBe(`${rest}&repos=alice/a`);
    expect(rewriteRepoParams(`repos=a&${rest}`, resolve)).toBe(`repos=alice/a&${rest}`);
    expect(rewriteRepoParams('xrepos=a&repos2=a&REPOS=a', resolve)).toBe('xrepos=a&repos2=a&REPOS=a');
  });

  it('is byte-identical when nothing resolves', () => {
    for (const q of ['', 'repos=', 'repos=nope', 'repos=alice%2Fa', 'repos=alice/a,nope', 'repos=a%E0%A4%A', 'pr=a%E0%A4%A%231']) {
      expect(rewriteRepoParams(q, resolve), q).toBe(q);
    }
  });

  it('decodes percent-encoded input first, so encoded commas and slashes are understood', () => {
    expect(rewriteRepoParams('repos=alice%2Fa,b', resolve)).toBe('repos=alice/a,alice/b');
    expect(rewriteRepoParams('repos=a%2Cb', resolve)).toBe('repos=alice/a,alice/b');
    expect(rewriteRepoParams('repos=a,+b', resolve)).toBe('repos=alice/a,alice/b');
  });
});

describe('rewriteRepoPath', () => {
  it('maps a one-segment /repos/<name> to /repos/<owner>/<name>', () => {
    expect(rewriteRepoPath('/repos/a', resolve)).toBe('/repos/alice/a');
    expect(rewriteRepoPath('/repos/a/', resolve)).toBe('/repos/alice/a');
    expect(rewriteRepoPath('/repos/proj', resolve)).toBe('/repos/grp/sub/proj');
  });

  it('leaves every other path alone', () => {
    for (const p of ['/repos/nope', '/repos', '/repos/', '/repos/alice/a', '/prs', '/insights', '/', '/repos/%E0%A4%A']) {
      expect(rewriteRepoPath(p, resolve), p).toBe(p);
    }
  });
});
