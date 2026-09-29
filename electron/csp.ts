import { createHash } from 'node:crypto';

/** The only remote origin the window may load from (images only; main's request filter enforces it too). */
export const AVATARS_ORIGIN = 'https://avatars.githubusercontent.com';

/** CSP source expressions for each inline <script> (no src) in the page, e.g. index.html's theme script. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attrs!)) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body!, 'utf8').digest('base64')}'`);
  }
  return [...new Set(hashes)];
}

/**
 * The app window's policy (measured in the spike: every view, diffs, dark theme). Sent on every app:// response,
 * so module workers get it too.
 */
export function appCsp(scriptHashes: string[]): string {
  return [
    "default-src 'none'",
    // Bundles and lazy chunks; the hashes allow index.html's inline theme script.
    ['script-src', "'self'", ...scriptHashes].join(' '),
    // The diff highlighter's module workers (they import grammar chunks under their own script-src).
    "worker-src 'self'",
    "connect-src 'self'",
    "style-src 'self'",
    // @pierre/diffs injects <style> elements into its shadow roots ...
    "style-src-elem 'self' 'unsafe-inline'",
    // ... and Shiki's token spans carry style="--diffs-token-*" attributes.
    "style-src-attr 'unsafe-inline'",
    // Vite inlines small font subsets as data: URLs.
    "font-src 'self' data:",
    // The GitHub account's avatar in Settings (Markdown images are rendered as links, other avatars are letters).
    `img-src 'self' ${AVATARS_ORIGIN} data:`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** The error page main serves itself when the server can't start: static HTML, inline styles, no scripts. */
export const ERROR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
