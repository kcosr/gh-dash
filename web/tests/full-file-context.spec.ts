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

async function openDiff(page: Page) {
  await page.route('**/api/v1/prs/**/diff', (route) => route.fulfill({ json: {
    kind: 'pr', repo: pr.repo, number: pr.number, title: pr.title, baseOid, headOid, fetchedAt,
    files, totalFiles: files.length, additions: 2, deletions: 2, url: pr.url,
  } satisfies Diff }));
  await page.route('**/api/v1/prs/**/threads', (route) => route.fulfill({ json: { items: [thread] } }));
  await page.goto('/prs?source=gitlab.example.com&state=open');
  await page.getByRole('article', { name: pr.title, exact: true }).click();
  await page.getByRole('button', { name: /Files changed/ }).click();
  return page.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/cache.ts"]') });
}

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
  let fail = true;
  await page.route('**/api/v1/blob/**', (route) => {
    if (fail) return route.fulfill({ status: 429, json: { error: 'Rate limited' } });
    const ref = new URL(route.request().url()).searchParams.get('ref');
    const value = ref === headOid ? 'new value' : 'old value';
    return route.fulfill({ contentType: 'text/plain', body: 'start of file\nunchanged comment line\nbefore change\n' + value + '\nend of file\n' });
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
  await file.getByText('More unchanged context may be available', { exact: true }).first().click();
  await expect(file.getByText('end of file', { exact: true })).toBeVisible();
  await expect(file.getByText('start of file', { exact: true })).toHaveCount(0);
  await showFull.click();
  await expect(file.getByText('start of file', { exact: true })).toBeVisible();
  await changesOnly.click();
  await expect(file.getByText('end of file', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
