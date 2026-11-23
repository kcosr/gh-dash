import type { Page } from '@playwright/test';
import type { CommentThread, Diff, DiffFile } from '../../shared/api';
import { expect, prs, test } from './fixtures';

const pr = prs[1];
const baseOid = 'a'.repeat(40);
const headOid = 'b'.repeat(40);
const path = 'src/cache.ts';
const previousPath = 'lib/cache.ts';
const fetchedAt = '2026-10-05T10:00:00Z';
const files: DiffFile[] = [
  { path, previousPath, status: 'renamed', additions: 1, deletions: 1, patch: '@@ -4 +4 @@\n-old value\n+new value' },
  { path: 'src/other.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old other\n+new other' },
];
const thread: CommentThread = {
  id: 9, kind: 'pr', repo: pr.repo, number: pr.number, branch: pr.headRef, commitOid: headOid, baseOid,
  path, side: 'new', startLine: 2, endLine: 2, snippet: 'unchanged comment line',
  status: 'open', resolvedAt: null, resolvedBy: null, createdAt: fetchedAt, updatedAt: fetchedAt,
  comments: [{
    id: 27, author: { id: 1, kind: 'self', name: 'You' }, body: 'This comment belongs on line 2.',
    createdAt: fetchedAt, editedAt: null,
  }],
};

async function openDiff(page: Page, changedFiles = files, deepLink = false) {
  await page.route('**/api/v1/prs/**/diff', (route) => route.fulfill({ json: {
    kind: 'pr', repo: pr.repo, repoId: 2, number: pr.number, title: pr.title, baseOid, headOid, fetchedAt,
    files: changedFiles, totalFiles: changedFiles.length,
    additions: changedFiles.reduce((n, f) => n + f.additions, 0), deletions: changedFiles.reduce((n, f) => n + f.deletions, 0),
    url: pr.url,
  } satisfies Diff }));
  await page.route('**/api/v1/prs/**/threads', (route) => route.fulfill({ json: { items: [thread] } }));
  const url = '/prs?source=gitlab.example.com&state=open';
  await page.goto(deepLink ? `${url}&diff=${encodeURIComponent(pr.id)}` : url);
  if (!deepLink) {
    await page.getByRole('article', { name: pr.title, exact: true }).click();
    await page.getByRole('button', { name: /Files changed/ }).click();
  }
  return page.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/cache.ts"]') });
}

test('the merge request number opens its details even from a directly linked diff', async ({ page }) => {
  await openDiff(page, files, true);
  const requestNumber = page.getByRole('link', { name: `Open merge request !${pr.number} details` });
  await requestNumber.press('Enter');
  await expect(page.getByRole('region', { name: /Changes in/ })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('pr')).toBe(pr.id);
  await page.getByRole('button', { name: /Files changed/ }).click();
  await expect(requestNumber).toBeVisible();
});

test('full file context uses the two displayed revisions and preserves changes and comments', async ({ page }) => {
  const requests: Array<{ ref: string | null; path: string | null }> = [];
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/blob/**', async (route) => {
    const { searchParams } = new URL(route.request().url());
    const ref = searchParams.get('ref');
    requests.push({ ref, path: searchParams.get('path') });
    await response;
    const value = ref === headOid ? 'new value' : 'old value';
    await route.fulfill({ contentType: 'text/plain', body: 'start of file\nunchanged comment line\nbefore change\n' + value + '\nafter change\nend of file\n' });
  });
  const file = await openDiff(page);
  const showFull = file.getByRole('button', { name: 'Show full file', exact: true });
  const changesOnly = file.getByRole('button', { name: 'Show changes only', exact: true });
  const line = (n: number) => file.locator('[data-line="' + n + '"]');
  await expect(file.getByText('More unchanged context may be available', { exact: true }).first()).toBeVisible();
  await expect(line(1)).toHaveCount(0);
  await expect(file.locator('[data-line-type="change-addition"][data-line="4"]')).toContainText('new value');
  expect(requests).toEqual([]);

  try {
    await showFull.click();
    await expect(file.getByRole('button', { name: 'Loading file…', exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(changesOnly).toBeFocused();
  await expect(line(1)).toHaveText('start of file');
  await expect(line(6)).toHaveText('end of file');
  await expect(file.locator('[data-line-type="change-addition"][data-line="4"]')).toContainText('new value');
  await expect(file.locator('.dth[data-thread="9"]')).toContainText('This comment belongs on line 2.');
  await expect(file.locator('[data-expand-button]')).toHaveCount(0);
  expect(requests).toEqual(expect.arrayContaining([{ ref: baseOid, path: previousPath }, { ref: headOid, path }]));
  expect(requests).toHaveLength(2);

  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(file.locator('[data-deletions] [data-line="4"]')).toHaveText('old value');
  await expect(file.locator('[data-additions] [data-line="4"]')).toHaveText('new value');

  await changesOnly.click();
  await expect(showFull).toBeFocused();
  await expect(line(1)).toHaveCount(0);
  await expect(line(6)).toHaveCount(0);
  await expect(file.getByText('This comment belongs on line 2.', { exact: true })).toBeVisible();
  await showFull.click();
  await expect(changesOnly).toBeVisible();
  await expect(line(6)).toHaveCount(2);
  expect(requests).toHaveLength(2);
});

test('an unavailable full file keeps the patch and can be retried at the same review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trailing = Array.from({ length: 100 }, (_, n) => 'unchanged line ' + (n + 5));
  let fail = true;
  await page.route('**/api/v1/blob/**', (route) => {
    if (fail) return route.fulfill({ status: 429, json: { error: 'Rate limited' } });
    const ref = new URL(route.request().url()).searchParams.get('ref');
    const value = ref === headOid ? 'new value' : 'old value';
    return route.fulfill({ contentType: 'text/plain', body: ['start of file', 'unchanged comment line', 'before change', value, ...trailing, 'end of file', ''].join('\n') });
  });
  const file = await openDiff(page);
  const showFull = file.getByRole('button', { name: 'Show full file', exact: true });
  await showFull.click();
  await expect(file.getByRole('status').getByText('Context unavailable')).toBeVisible();
  await expect(file.locator('[data-line-type="change-addition"][data-line="4"]')).toContainText('new value');
  fail = false;
  await showFull.click();
  const changesOnly = file.getByRole('button', { name: 'Show changes only', exact: true });
  await expect(changesOnly).toBeVisible();
  await expect(file.getByText('Context unavailable', { exact: true })).toHaveCount(0);
  await changesOnly.click();
  const line = (n: number) => file.locator('[data-line="' + n + '"]');
  const trailingArrow = file.getByRole('button', { name: 'Expand toward end of file', exact: true });
  await trailingArrow.click();
  await expect(line(24)).toHaveText('unchanged line 24');
  await expect(line(25)).toHaveCount(0);
  await showFull.click();
  await changesOnly.click();

  await file.getByText('More unchanged context may be available', { exact: true }).first().click();
  await expect(line(24)).toHaveText('unchanged line 24');
  await expect(line(25)).toHaveCount(0);
  await expect(line(1)).toHaveCount(0);
  await showFull.click();
  await expect(line(1)).toHaveText('start of file');
  await page.locator('.dvr-scroll').evaluate((el) => { el.scrollTop = 460; });
  await changesOnly.press('Enter');
  await expect(showFull).toBeFocused();
  await expect(line(5)).toHaveCount(0);
  await file.getByRole('button', { name: 'Expand up', exact: true }).click();
  await expect(line(1)).toHaveText('start of file');
  await expect(line(5)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('returning to a long patch keeps its already visible header in place', async ({ page }) => {
  const leading = Array.from({ length: 100 }, (_, n) => `unchanged line ${n + 1}`);
  const old = Array.from({ length: 60 }, (_, n) => `old value ${n}`);
  const next = Array.from({ length: 60 }, (_, n) => `new value ${n}`);
  const patch = ['@@ -101,60 +101,60 @@', ...old.map((line) => '-' + line), ...next.map((line) => '+' + line)].join('\n');
  await page.route('**/api/v1/blob/**', (route) => {
    const ref = new URL(route.request().url()).searchParams.get('ref');
    return route.fulfill({ contentType: 'text/plain', body: [...leading, ...(ref === headOid ? next : old), ''].join('\n') });
  });
  const file = await openDiff(page, [{ ...files[0]!, additions: next.length, deletions: old.length, patch }, files[1]!]);
  const scroller = page.locator('.dvr-scroll');
  const showFull = file.getByRole('button', { name: 'Show full file', exact: true });
  const changesOnly = file.getByRole('button', { name: 'Show changes only', exact: true });
  const firstChange = file.locator('[data-line-type="change-deletion"][data-line="101"]');
  await expect(firstChange).toBeInViewport();
  const before = await showFull.boundingBox();
  await showFull.click();
  await expect(changesOnly).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(firstChange).toBeInViewport();
  await expect.poll(() => changesOnly.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const pane = el.closest('.dvr-scroll')!.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    return y >= pane.top && y < pane.bottom && el.contains(document.elementFromPoint(rect.left + rect.width / 2, y));
  })).toBe(true);
  const box = await changesOnly.boundingBox();
  if (!box) throw new Error('Sticky file control has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(showFull).toBeFocused();
  await expect(firstChange).toBeInViewport();
  // Pierre rounds a measured line position to a device pixel.
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs(((await showFull.boundingBox())?.y ?? Infinity) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
});
