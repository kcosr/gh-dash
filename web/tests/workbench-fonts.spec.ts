import { test, expect } from './fixtures';

test('bundled UI and code fonts load every language subset under the application CSP', async ({ page }) => {
  await page.goto('/prs?source=github.com&state=open');
  await expect(page.getByRole('article', { name: 'Improve cache refresh', exact: true })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    // Exercise Cyrillic ext, Cyrillic, Greek ext, Greek, Vietnamese, Latin ext, Latin.
    const text = 'ѠЖἀαắŁA';
    const faces = await Promise.all([
      document.fonts.load('400 16px "Inter Variable"', text),
      document.fonts.load('400 16px "JetBrains Mono"', text),
      document.fonts.load('500 16px "JetBrains Mono"', text),
    ]);
    return {
      subsets: faces.map((group) => group.map((face) => face.status)),
      resources: performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => url.includes('.woff2')),
      origin: location.origin,
    };
  });
  expect(loaded.subsets).toEqual([
    Array(7).fill('loaded'),
    Array(6).fill('loaded'),
    Array(6).fill('loaded'),
  ]);
  expect(new Set(loaded.resources).size).toBe(19);
  for (const resource of loaded.resources) {
    expect(new URL(resource).origin).toBe(loaded.origin);
    expect(new URL(resource).pathname).toMatch(/^\/assets\/.+\.woff2$/);
  }
});
