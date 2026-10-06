import { test, expect } from './fixtures';

for (const compact of [false, true]) {
  test(`application views and chart tables remain usable on ${compact ? 'mobile' : 'desktop'}`, async ({ page }, info) => {
    await page.setViewportSize(compact ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.goto('/activity?source=github.com&range=custom&from=2026-09-01&to=2026-10-05');
    await expect(page.getByRole('main')).toContainText('Improve cache refresh');
    if (compact) await page.getByRole('button', { name: 'Expand filters' }).click();
    const prs = page.getByRole('main').getByRole('button', { name: /Pull requests/ });
    await expect(prs).toHaveAttribute('aria-pressed', 'true');
    await prs.click();
    await expect(prs).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('main')).not.toContainText('Improve cache refresh');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Insights', exact: true }).click();
    const activity = page.getByRole('region', { name: 'Activity over time', exact: true });
    await expect(activity.getByRole('img', { name: 'Activity over time', exact: true })).toBeVisible();
    const chart = (await activity.boundingBox())!;
    expect(chart.x).toBeGreaterThanOrEqual(0);
    expect(chart.x + chart.width).toBeLessThanOrEqual(compact ? 390 : 1440);
    await activity.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(activity.getByRole('table')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`insights-${compact ? 'mobile' : 'desktop'}.png`), fullPage: true });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Repositories', exact: true }).click();
    await expect(page.getByRole('main')).toContainText('Browser regression fixture');
    await expect(page.locator('.rcard').first()).toBeVisible();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Add commit email' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Diff cache', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('compact diff file and comment overlays preserve focus and Escape order', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/prs?source=github.com&state=open&pr=owner%2Falpha%2312&diff=owner%2Falpha%2312');
  const diff = page.getByRole('region', { name: /Changes in/ });
  await expect(diff).toBeVisible();
  const comments = diff.getByRole('button', { name: 'Comments', exact: true });
  await comments.click();
  const column = diff.locator('.dcc');
  await expect(column).toBeVisible();
  await expect.poll(() => column.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(column).toHaveCount(0);
  await expect(comments).toBeFocused();
  await comments.click();
  await expect(column).toBeVisible();
  const files = diff.getByRole('button', { name: 'File list', exact: true });
  await files.click();
  const list = diff.getByRole('navigation', { name: 'Changed files', exact: true });
  await expect(list).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  // The top keyboard layer must also receive pointer events where the panes overlap.
  await expect.poll(() => list.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + 50));
  })).toBe(true);
  const listBox = (await list.boundingBox())!;
  await page.mouse.click(385, listBox.y + 70);
  await expect(list).toHaveCount(0);
  await expect(column).toBeVisible();
  await files.click();
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(column).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(column).toHaveCount(0);
  await expect(diff).toBeVisible();
  // Closing the file list already restored its trigger, outside the comments
  // panel. Closing comments preserves that deliberate, visible focus position.
  await expect(files).toBeFocused();
  await files.click();
  await expect(list).toBeVisible();
  await comments.click();
  await expect(column).toBeVisible();
  await expect.poll(() => column.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + 50));
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-diff-overlays.png'), fullPage: true });
  const columnBox = (await column.boundingBox())!;
  await page.mouse.click(5, columnBox.y + 70);
  await expect(column).toHaveCount(0);
  await expect(list).toBeVisible();
  await comments.click();
  await expect(column).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(column).toHaveCount(0);
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(diff).toBeVisible();
});
