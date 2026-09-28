import { describe, expect, it } from 'vitest';
import { appCsp, inlineScriptHashes } from './csp';

// web/index.html's theme script as Vite emits it. Hashes computed independently (openssl dgst -sha256 -binary | base64);
// THEME_HASH is also what the spike's window accepted.
const THEME =
  "\n      // Apply the saved theme before first paint to avoid a flash.\n      try { const t = localStorage.getItem('gh-dash:theme'); if (t) document.documentElement.dataset.theme = t; } catch {}\n    ";
const THEME_HASH = "'sha256-gHrVHuGBtMtnuxPR5kbbmp3ZbfSOu+vjsvcE5jaS8pM='";

describe('inlineScriptHashes', () => {
  it('hashes inline scripts only, exactly as written', () => {
    const html = `<!doctype html><html><head>
    <script>${THEME}</script>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <SCRIPT>alert(1)</SCRIPT >
    <script>${THEME}</script>
    </head><body></body></html>`;
    expect(inlineScriptHashes(html)).toEqual([THEME_HASH, "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"]);
  });

  it('finds nothing in a page without inline scripts', () => {
    expect(inlineScriptHashes('<script src="/a.js"></script><p>hi</p>')).toEqual([]);
  });
});

describe('appCsp', () => {
  it('allows only same-origin scripts plus the hashed inline ones', () => {
    const csp = appCsp([THEME_HASH]);
    const directives = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
    expect(directives['script-src']).toEqual(["'self'", THEME_HASH]);
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['img-src']).toEqual(["'self'", 'https://avatars.githubusercontent.com', 'data:']);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    // No other remote origin anywhere.
    expect(csp.replaceAll('https://avatars.githubusercontent.com', '')).not.toContain('http');
  });
});
