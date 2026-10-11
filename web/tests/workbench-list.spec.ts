import type { Page } from '@playwright/test';
import type { PullRequestDetail } from '../../shared/api';
import { test, expect, prs, sync } from './fixtures';

const LIST = '/prs?source=github.com&state=open';

/** A PR of owner/alpha, active at `hour` (the list sorts newest first). */
function pr(number: number, title: string, hour: number, body = prs[0]!.body): PullRequestDetail {
  const at = `2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`;
  return { ...prs[0]!, id: `owner/alpha#${number}`, number, title, body, activityAt: at, updatedAt: at, createdAt: at, url: `https://github.com/owner/alpha/pull/${number}` };
}

/** The URL with `owner/alpha#<number>`'s details open. */
const detailsOf = (number: number) => new RegExp(`[?&]pr=owner(/|%2F)alpha%23${number}(&|$)`);

const titles = (page: Page) => page.locator('article.pr').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')));

/**
 * The list answers `items` (changeable), and a sync runs until `refetch`: ending it refetches the synced lists, as a
 * real sync's end does (App's sync watcher).
 */
async function liveList(page: Page, items: PullRequestDetail[]) {
  let answer = items;
  let running = true;
  const known = new Map(items.map((p) => [p.number, p]));
  await page.route('**/api/v1/prs?*', (route) => route.fulfill({
    json: { items: answer, nextCursor: null, total: answer.length, facets: { byRepo: { 'owner/alpha': answer.length } } },
  }));
  await page.route((url) => /^\/api\/v1\/prs\/owner%2Falpha\/\d+$/.test(url.pathname), (route) =>
    route.fulfill({ json: known.get(Number(new URL(route.request().url()).pathname.split('/').pop())) }));
  await page.route('**/api/v1/sync/status', (route) => route.fulfill({ json: { ...sync, running } }));
  // Opening a row on its host (`o`) must not leave the machine.
  await page.context().route(/^https:\/\/(github\.com|example\.com)\//, (route) => route.fulfill({ contentType: 'text/html', body: '<title>host</title>' }));
  return async (next: PullRequestDetail[]) => {
    for (const p of next) known.set(p.number, p);
    answer = next;
    running = false;
    await expect.poll(() => titles(page), { timeout: 10_000 }).toEqual([...next].sort((a, b) => b.activityAt.localeCompare(a.activityAt)).map((p) => p.title));
  };
}

test('the PR cursor stays on its row when a refetch reorders the list', async ({ page }) => {
  const [first, second, third] = [pr(1, 'First change', 9), pr(2, 'Second change', 8), pr(3, 'Third change', 7)];
  const refetch = await liveList(page, [first!, second!, third!]);
  await page.goto(LIST);
  await expect.poll(() => titles(page)).toEqual(['First change', 'Second change', 'Third change']);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  const cursor = page.locator('article.pr.cursor');
  await expect(cursor).toHaveAttribute('aria-label', 'Second change');
  // The third PR gets newer: the cursor's row moves down a place, and another takes its place.
  await refetch([first!, second!, pr(3, 'Third change', 10)]);
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toHaveAttribute('aria-label', 'Second change');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(detailsOf(2));
  await expect(page.getByRole('complementary', { name: 'Pull request details' })).toContainText('Second change');
  // With details open the cursor moves them along, from where the row is now.
  await page.keyboard.press('k');
  await expect(cursor).toHaveAttribute('aria-label', 'First change');
  await expect(page).toHaveURL(detailsOf(1));
});

test('the PR cursor lets go of a row a refetch removes, and its keys do nothing', async ({ page }) => {
  const [first, second, third] = [pr(1, 'First change', 9), pr(2, 'Second change', 8), pr(3, 'Third change', 7)];
  const refetch = await liveList(page, [first!, second!, third!]);
  await page.goto(LIST);
  await expect.poll(() => titles(page)).toEqual(['First change', 'Second change', 'Third change']);
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  const cursor = page.locator('article.pr.cursor');
  await expect(cursor).toHaveAttribute('aria-label', 'Third change');
  await refetch([first!]);
  await expect(cursor).toHaveCount(0);
  const url = page.url();
  let popups = 0;
  page.on('popup', () => popups++);
  // Index-based, these read past the shortened list (an uncaught TypeError, which the fixture fails on).
  for (const key of ['Enter', 'o', 'd']) await page.keyboard.press(key);
  expect(page.url()).toBe(url);
  expect(popups).toBe(0);
  await page.keyboard.press('j');
  await expect(cursor).toHaveAttribute('aria-label', 'First change');
});

test('outset PR rows paint whole inside the sections that skip off-screen work', async ({ page }, info) => {
  await liveList(page, [pr(1, 'First change', 9), pr(2, 'Second change', 8)]);
  await page.goto(`${LIST}&pr=owner/alpha%231`);
  const active = page.locator('article.pr.active');
  await expect(active).toHaveAttribute('aria-label', 'First change');
  const hovered = page.getByRole('article', { name: 'Second change', exact: true });
  await hovered.hover();
  for (const row of [active, hovered]) {
    const box = await row.evaluate((el) => {
      // content-visibility: auto clips paint to the section's padding box.
      const section = el.closest('section')!;
      const style = getComputedStyle(section);
      const r = el.getBoundingClientRect();
      const s = section.getBoundingClientRect();
      // The sticky header covers the rows scrolling under it edge to edge.
      const h = section.querySelector('.group-h')!.getBoundingClientRect();
      return {
        contentVisibility: style.contentVisibility,
        outset: parseFloat(getComputedStyle(el).marginLeft),
        left: r.left - (s.left + parseFloat(style.borderLeftWidth)),
        right: s.right - parseFloat(style.borderRightWidth) - r.right,
        header: [h.left <= r.left, h.right >= r.right],
      };
    });
    expect(box.contentVisibility).toBe('auto');
    expect(box.outset).toBeLessThan(0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeGreaterThanOrEqual(0);
    expect(box.header).toEqual([true, true]);
  }
  await page.screenshot({ path: info.outputPath('pr-row-edges.png'), clip: { x: 0, y: 0, width: 900, height: 360 } });
});

test('a PR row opens on a plain click only: not a selection, a link inside it, or a modified click', async ({ page }) => {
  const body = 'See [the release notes](https://example.com/notes) before **merging**.';
  await liveList(page, [pr(1, 'First change', 9, body), pr(2, 'Second change', 8, body)]);
  await page.goto(`${LIST}&density=full`);
  const row = page.getByRole('article', { name: 'First change', exact: true });
  const drawer = page.getByRole('complementary', { name: 'Pull request details' });
  await expect(row).toBeVisible();

  // Selecting the title's text.
  const title = row.locator('.pr-title');
  const box = (await title.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 2, 90), box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await expect(drawer).toHaveCount(0);

  // A link in the description opens on its own.
  const popup = page.waitForEvent('popup');
  await row.getByRole('link', { name: 'the release notes' }).click();
  await (await popup).close();
  await expect(drawer).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]pr=/);

  // A modified click is the browser's.
  const icon = row.locator('.pr-ic');
  await icon.click({ modifiers: ['Alt'] });
  await expect(drawer).toHaveCount(0);

  // A plain click toggles the details.
  await icon.click();
  await expect(drawer).toContainText('First change');
  await icon.click();
  await expect(drawer).toHaveCount(0);
});
