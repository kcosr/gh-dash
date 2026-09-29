import { describe, expect, it } from 'vitest';
import { fitRepoLabel, highlightParts, truncateToWidth } from './repo-display';

// One unit per character; "…" is one character wide too.
const w = (s: string) => Array.from(s).length;

describe('truncateToWidth', () => {
  it('keeps text that fits and cuts the end of text that does not', () => {
    expect(truncateToWidth('gh-dash', 7, w)).toBe('gh-dash');
    expect(truncateToWidth('gh-dash', 5, w)).toBe('gh-d…');
    expect(truncateToWidth('gh-dash', 1, w)).toBe('…');
    expect(truncateToWidth('gh-dash', 0, w)).toBe('…');
  });
  it('does not leave a space before the ellipsis', () => {
    expect(truncateToWidth('ab cd', 4, w)).toBe('ab…');
  });
});

describe('fitRepoLabel', () => {
  it('leaves a label that fits, prefix and name together', () => {
    expect(fitRepoLabel('dlvhdr/', 'gh-dash', 14, w)).toEqual({ prefix: 'dlvhdr/', label: 'gh-dash' });
    expect(fitRepoLabel('', 'gh-dash', 7, w)).toEqual({ prefix: '', label: 'gh-dash' });
  });
  it('shortens the owner first and keeps the name whole and the slash', () => {
    expect(fitRepoLabel('dlvhdr/', 'gh-dash', 12, w)).toEqual({ prefix: 'dlv…/', label: 'gh-dash' });
    expect(fitRepoLabel('dlvhdr/', 'gh-dash', 9, w)).toEqual({ prefix: '…/', label: 'gh-dash' });
    const long = fitRepoLabel('acme-platform-infrastructure/', 'internal-tools', 26, w);
    expect(long).toEqual({ prefix: 'acme-platf…/', label: 'internal-tools' });
    expect(w(long.prefix + long.label)).toBeLessThanOrEqual(26);
  });
  it('drops the owner and cuts the name only when "…/" plus the name does not fit', () => {
    expect(fitRepoLabel('dlvhdr/', 'gh-dash', 8, w)).toEqual({ prefix: '', label: 'gh-dash' });
    expect(fitRepoLabel('dlvhdr/', 'gh-dash', 5, w)).toEqual({ prefix: '', label: 'gh-d…' });
  });
  it('cuts the end of a name that has no owner', () => {
    expect(fitRepoLabel('', 'internal-tools', 8, w)).toEqual({ prefix: '', label: 'interna…' });
  });
  it('treats a prefix without a slash as plain text to shorten', () => {
    expect(fitRepoLabel('owner: ', 'x', 5, w)).toEqual({ prefix: 'own…', label: 'x' });
  });
});

describe('highlightParts', () => {
  const flat = (segs: { text: string; hit: boolean }[][]) => segs.map((p) => p.map((s) => (s.hit ? `[${s.text}]` : s.text)).join(''));
  it('marks a match inside either part', () => {
    expect(flat(highlightParts(['dlvhdr/', 'gh-dash'], 'dlv'))).toEqual(['[dlv]hdr/', 'gh-dash']);
    expect(flat(highlightParts(['dlvhdr/', 'gh-dash'], 'dash'))).toEqual(['dlvhdr/', 'gh-[dash]']);
  });
  it('marks a match across the boundary in both parts', () => {
    expect(flat(highlightParts(['dlvhdr/', 'gh-dash'], 'hdr/gh'))).toEqual(['dlv[hdr/]', '[gh]-dash']);
  });
  it('ignores case, and the match keeps the text as written', () => {
    expect(flat(highlightParts(['', 'Gh-Dash'], 'GH-'))).toEqual(['', '[Gh-]Dash']);
  });
  it('marks nothing without a query or a match', () => {
    expect(flat(highlightParts(['a/', 'b'], ''))).toEqual(['a/', 'b']);
    expect(flat(highlightParts(['a/', 'b'], 'zz'))).toEqual(['a/', 'b']);
  });
});
