import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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

// The page Vite builds from (dist/web/index.html, whose inline scripts main.ts hashes into the window's policy).
const INDEX = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const inline = [...INDEX.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs!)).map(([, , body]) => body!);
const THEME_KEY = /THEME_KEY = '([^']+)'/.exec(readFileSync(new URL('../web/src/lib/storage.ts', import.meta.url), 'utf8'))![1]!;

/** Run the page's theme script against a stored value (an Error: storage throws) and a system preference (null: no matchMedia). */
function applyTheme(stored: string | null | Error, systemDark: boolean | null): [string | undefined, string | undefined] {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const ctx: Record<string, unknown> = {
    localStorage: { getItem: (key: string) => { if (stored instanceof Error) throw stored; return key === THEME_KEY ? stored : null; } },
    document: { documentElement: root },
  };
  ctx.window = ctx;
  if (systemDark !== null) ctx.matchMedia = (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark });
  runInNewContext(inline[0]!, ctx);
  return [root.dataset.theme, root.style.colorScheme];
}

describe("web/index.html's pre-paint theme script", () => {
  it("is the page's only inline script, and the window's policy allows it by its hash", () => {
    expect(inline).toHaveLength(1);
    const hash = `'sha256-${createHash('sha256').update(inline[0]!, 'utf8').digest('base64')}'`;
    expect(inlineScriptHashes(INDEX)).toEqual([hash]);
    expect(appCsp(inlineScriptHashes(INDEX))).toContain(`script-src 'self' ${hash};`);
  });

  it('reads the key the app stores the theme under', () => {
    expect(inline[0]).toContain(`localStorage.getItem('${THEME_KEY}')`);
  });

  // As Workbench's theme API reads it (readThemeMode, resolveTheme): "light" or "dark" when chosen, else (nothing stored,
  // or anything else) the system's.
  it.each([
    ['dark', false, 'dark'],
    ['light', true, 'light'],
    [null, true, 'dark'],
    [null, false, 'light'],
    ['system', true, 'dark'],
    ['blue', false, 'light'],
    [new Error('storage disabled'), true, 'dark'],
    [null, null, 'light'],
  ] as const)('stored %s, system dark %s: %s', (stored, systemDark, theme) => {
    expect(applyTheme(stored, systemDark)).toEqual([theme, theme]);
  });
});
