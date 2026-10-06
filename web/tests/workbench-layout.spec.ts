import { test, expect } from './fixtures';

async function width(locator: import('@playwright/test').Locator) {
  return (await locator.boundingBox())!.width;
}

test('desktop pane resizing keeps list space, persists preferences, and resets', async ({ page }) => {
  await page.goto('/prs?source=github.com&state=open');
  const sidebar = page.getByRole('complementary', { name: 'Repository scope' });
  const handle = page.getByRole('separator', { name: 'Sidebar width' });
  await expect(sidebar).toBeVisible();
  const start = await width(sidebar);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => width(sidebar)).toBeGreaterThan(start);
  const sideWidth = await width(sidebar);
  await page.reload();
  await expect.poll(() => width(sidebar)).toBe(sideWidth);
  await page.getByRole('article', { name: 'Improve cache refresh', exact: true }).click();
  const drawer = page.getByRole('complementary', { name: 'Pull request details' });
  await expect(drawer).toBeVisible();
  const drawerHandle = page.getByRole('separator', { name: 'Details panel width' });
  const before = await width(drawer);
  const box = (await drawerHandle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x - 75, box.y + 50, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => width(drawer)).toBeGreaterThan(before + 50);
  const preference = await width(drawer);
  await page.reload();
  await expect.poll(() => width(drawer)).toBe(preference);
  await page.setViewportSize({ width: 1050, height: 900 });
  await expect.poll(() => width(page.locator('main'))).toBeGreaterThanOrEqual(359);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => width(drawer)).toBe(preference);
  await drawerHandle.dblclick();
  await expect.poll(() => width(drawer)).toBe(before);
  await handle.dblclick();
  await expect.poll(() => width(sidebar)).toBe(start);
});

test('theme and hidden sidebar preferences survive navigation and reload', async ({ page }, info) => {
  await page.goto('/prs?source=github.com&state=open');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('desktop-dark.png'), fullPage: true });
  const darkBackground = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Repository scope' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('complementary', { name: 'Repository scope' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(darkBackground);
});

test('page filters remain when switching tabs and reopening the application', async ({ page }) => {
  await page.goto('/prs?source=github.com&state=open');
  await page.locator('#q').fill('cache');
  await expect(page).toHaveURL(/q=cache/);
  await expect(page.getByRole('article', { name: 'Improve cache refresh', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Issues', exact: true }).click();
  await expect(page).toHaveURL(/\/issues/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pull requests', exact: true }).click();
  await expect(page.locator('#q')).toHaveValue('cache');
  await expect(page).toHaveURL(/q=cache/);
  await page.goto('/');
  await expect(page.locator('#q')).toHaveValue('cache');
  await expect(page).toHaveURL(/\/prs\?.*q=cache/);
});

for (const viewport of [{ width: 900, height: 900 }, { width: 390, height: 844 }]) {
  test(`mobile composition at ${viewport.width}px keeps navigation, filters, and nested dialogs usable`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/prs?source=github.com&state=open');
    const opener = page.getByRole('button', { name: 'Open sidebar', exact: true });
    await expect(opener).toBeVisible();
    await expect(page.getByRole('separator', { name: 'Sidebar width' })).toHaveCount(0);
    await opener.click();
    const panel = page.getByRole('dialog', { name: 'Repositories', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'New set from selection', exact: true }).click();
    const prompt = page.getByRole('dialog', { name: /New set|Save.*set|Create.*set/i });
    await expect(prompt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'New set from selection', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press('/');
    await expect(page.locator('#q')).toBeFocused();
    await page.locator('#q').fill('cache');
    await expect(page.getByRole('article', { name: 'Improve cache refresh', exact: true })).toBeVisible();
    await page.getByRole('article', { name: 'Improve cache refresh', exact: true }).click();
    const drawer = page.getByRole('complementary', { name: 'Pull request details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await expect.poll(() => width(drawer)).toBe(viewport.width);
    await expect(page.getByRole('separator', { name: 'Details panel width' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`mobile-${viewport.width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('article.pr')).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('nested palette isolates diff shortcuts and Escape closes only the top layer', async ({ page }, info) => {
  await page.goto('/prs?source=github.com&state=open');
  await page.getByRole('article', { name: 'Improve cache refresh', exact: true }).click();
  const drawer = page.getByRole('complementary', { name: 'Pull request details' });
  await drawer.getByRole('button', { name: /Files changed/ }).click();
  const diff = page.getByRole('region', { name: /Changes in/ });
  await expect(diff).toBeVisible();
  const wrap = diff.getByRole('button', { name: 'Wrap', exact: true });
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('w');
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('w');
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(diff).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-diff.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(diff).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('shared segments and export modal keep filters and keyboard focus', async ({ page }) => {
  await page.goto('/prs?source=github.com&state=open&range=30d');
  await page.getByRole('group', { name: 'Group by', exact: true }).getByRole('button', { name: 'Repo', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('group')).toBe('repo');
  await page.getByRole('group', { name: 'Density', exact: true }).getByRole('button', { name: 'Titles', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('density')).toBe('titles');
  const exportButton = page.getByRole('button', { name: 'API', exact: true });
  await exportButton.click();
  const modal = page.getByRole('dialog', { name: 'Export this view', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Improve cache refresh');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(exportButton).toBeFocused();
});
