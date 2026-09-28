/** Plain-text previews of GitHub-flavored markdown (for 2-line clamps). */

export function plainPreview(src: string | null | undefined, max = 420): string {
  if (!src) return '';
  let s = src.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, ' '); // HTML comments (PR templates)
  // Fenced code, up to the closing fence or the end of the text. (Not `$`: with the m flag it
  // matches at the first line end, which dropped only a block's first line.)
  s = s.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|(?![\s\S]))/gm, ' ');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' '); // raw HTML tags
  // Link/image destinations may contain one level of parentheses, e.g. (https://x/a_(b)).
  s = s.replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ''); // images
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1'); // links -> text
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1'); // reference links
  s = s.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ''); // link definitions

  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}(\s|$)/.test(l) && !/^([-*_]\s*){3,}$/.test(l) && !/^\|?[\s:|-]+\|?$/.test(l))
    .map((l) =>
      l
        .replace(/^>\s?/, '')
        .replace(/^([-*+]|\d+[.)])\s+/, '')
        .replace(/^\[( |x|X)\]\s+/, '')
        .replace(/^\||\|$/g, '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`+([^`]*)`+/g, '$1')
        .trim(),
    )
    .filter(Boolean)
    .map((l) => (/[.!?:;,…)]$/.test(l) ? l : `${l}.`));

  let out = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (out.length > max) {
    const cut = out.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    out = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, '')}…`;
  }
  return out;
}

/** First paragraph as plain text (used in "Copy as Markdown" of lists). */
export function firstParagraph(src: string): string {
  const para = (src ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim().split(/\n\s*\n/)[0] ?? '';
  return plainPreview(para, 280);
}
