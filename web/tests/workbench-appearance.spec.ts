import type { Page } from '@playwright/test';
import { appCsp, inlineScriptHashes } from '../../electron/csp';
import { test, expect } from './fixtures';

const LIST = '/prs?source=github.com&state=open';

/** Serve the app page with the desktop window's policy (main.ts: its inline scripts' hashes, from the built page). */
async function withDesktopCsp(page: Page) {
  await page.route((url) => url.pathname === '/prs', async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({ response, body: html, headers: { ...response.headers(), 'content-security-policy': appCsp(inlineScriptHashes(html)) } });
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

const applied = (page: Page) => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  colorScheme: document.documentElement.style.colorScheme,
  rendered: !!document.querySelector('#root > *'),
}));

for (const [what, stored, system] of [['a saved dark theme', 'dark', 'light'], ['the system dark theme', null, 'dark']] as const) {
  test(`${what} applies before the app's scripts run, under the desktop window's policy`, async ({ page }, info) => {
    await withDesktopCsp(page);
    await page.emulateMedia({ colorScheme: system });
    if (stored) await page.addInitScript((value) => localStorage.setItem('gh-dash:theme', value), stored);
    // Hold the app back: only the page's own inline script runs, as at first paint.
    await page.route(/\/assets\/index-[^/]+\.js$/, (route) => route.abort());
    const response = await page.goto(LIST, { waitUntil: 'load' });
    expect(response?.headers()['content-security-policy']).toMatch(/script-src 'self' 'sha256-[^']+';/);
    expect(await applied(page)).toEqual({ theme: 'dark', colorScheme: 'dark', rendered: false });
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
    await page.screenshot({ path: info.outputPath(`first-paint-${stored ? 'saved' : 'system'}-dark.png`) });
  });
}

test('a saved light theme wins over the system dark one, and the app runs under the desktop policy', async ({ page }) => {
  await withDesktopCsp(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('gh-dash:theme', 'light'));
  await page.goto(LIST, { waitUntil: 'load' });
  await expect(page.getByRole('article', { name: 'Improve cache refresh', exact: true })).toBeVisible();
  expect(await applied(page)).toEqual({ theme: 'light', colorScheme: 'light', rendered: true });
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
});

test("gh-dash's own spinners and fades hold still under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(LIST);
  await expect(page.getByRole('article', { name: 'Improve cache refresh', exact: true })).toBeVisible();
  const motion = () => page.evaluate(() => {
    // The product's moving parts, as its views render them.
    const host = document.createElement('div');
    host.innerHTML = '<span class="sync"><span class="spin"><svg></svg></span></span>'
      + '<div class="setup-card"><span class="ic spin"><svg></svg></span><div class="meter"><i></i></div></div>'
      + '<button class="wb-btn"><span class="spin"><svg></svg></span></button><div class="list stale"></div>';
    document.body.append(host);
    const style = (selector: string) => getComputedStyle(host.querySelector(selector)!);
    const out = {
      spinners: ['.sync .spin svg', '.setup-card .spin svg', '.wb-btn .spin svg'].map((s) => style(s).animationName),
      meter: style('.meter i').transitionDuration,
      stale: [style('.list.stale').transitionDuration, style('.list.stale').transitionDelay],
    };
    host.remove();
    return out;
  });
  expect(await motion()).toEqual({ spinners: ['none', 'none', 'none'], meter: '0s', stale: ['0s', '0.2s'] });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await motion()).toEqual({ spinners: ['spin', 'spin', 'spin'], meter: '0.4s', stale: ['0.2s', '0.2s'] });
  // The charts' fade (charts.css, loaded with Insights).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Insights', exact: true }).click();
  const body = page.locator('.gd-card-body').first();
  await expect(body).toBeVisible();
  expect(await body.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
});
