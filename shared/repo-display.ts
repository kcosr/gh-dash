/**
 * Pure helpers for showing repo names where CSS can't do the layout: SVG chart labels and the command palette.
 * (In HTML, `<RepoName>` does the same with flex and `text-overflow`.)
 */

/** Width of a string in the caller's font (pixels). */
export type Measure = (text: string) => number;

/** The longest start of `text` plus "…" that fits `maxW`; `text` itself when it already fits. */
export function truncateToWidth(text: string, maxW: number, measure: Measure): string {
  if (measure(text) <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join('').trimEnd() + '…') <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : chars.slice(0, lo).join('').trimEnd() + '…';
}

/**
 * Fit a repo label, drawn as a muted `prefix` ("owner/") followed by `label`, into `maxW`.
 * The prefix and the label are measured together. When they don't fit, the owner gives way first and the name stays
 * whole: "dlvhdr/gh-dash" becomes "dlv…/gh-dash", never "dlvhdr/gh-d…". Only when even "…/" plus the name is too wide
 * does the prefix go, and the name is cut to fit. A trailing '/' of the prefix is kept as a separator.
 */
export function fitRepoLabel(prefix: string, label: string, maxW: number, measure: Measure): { prefix: string; label: string } {
  if (measure(prefix + label) <= maxW) return { prefix, label };
  if (prefix) {
    const sep = prefix.endsWith('/') ? '/' : '';
    const owner = prefix.slice(0, prefix.length - sep.length);
    const room = maxW - measure(label) - measure(sep);
    // At least "…" must fit beside the whole name, or the owner isn't worth showing.
    if (owner && room >= measure('…')) return { prefix: truncateToWidth(owner, room, measure) + sep, label };
  }
  return { prefix: '', label: truncateToWidth(label, maxW, measure) };
}

/**
 * Where `query` (case-insensitive) occurs in the parts joined together, split back per part. A match that runs
 * across the boundary ("dlvhdr/gh" over ["dlvhdr/", "gh-dash"]) is marked in both parts.
 */
export function highlightParts(parts: readonly string[], query: string): { text: string; hit: boolean }[][] {
  const whole = parts.join('');
  const at = query ? whole.toLowerCase().indexOf(query.toLowerCase()) : -1;
  let offset = 0;
  return parts.map((part) => {
    const from = offset;
    offset += part.length;
    if (at < 0) return [{ text: part, hit: false }];
    const a = Math.max(at, from) - from;
    const b = Math.min(at + query.length, from + part.length) - from;
    if (b <= a) return [{ text: part, hit: false }];
    return [
      { text: part.slice(0, a), hit: false },
      { text: part.slice(a, b), hit: true },
      { text: part.slice(b), hit: false },
    ].filter((seg) => seg.text);
  });
}
