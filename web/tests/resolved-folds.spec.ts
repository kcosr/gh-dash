import type { Page } from '@playwright/test';
import type { CommentThread, Diff } from '../../shared/api';
import { expect, prs, test } from './fixtures';

const pr = prs[1]!;
const path = 'src/cache.ts';
const headOid = 'b'.repeat(40);
const baseOid = 'a'.repeat(40);
const at = '2026-10-05T10:00:00Z';
const author = { id: 1, kind: 'self' as const, name: 'You' };
const thread = (id: number, startLine: number, endLine: number, options: Partial<CommentThread> = {}): CommentThread => ({
  id, kind: 'pr', repo: pr.repo, number: pr.number, branch: pr.headRef,
  commitOid: headOid, baseOid, path, side: 'new', startLine, endLine, snippet: '', status: 'open',
  resolvedAt: null, resolvedBy: null, createdAt: at, updatedAt: at,
  comments: [{ id, author, body: `Review thread ${id}`, createdAt: at, editedAt: null }],
  ...options,
});

async function openReview(page: Page, patch: string, threads: CommentThread[]) {
  await page.route('**/api/v1/prs/**/diff', (route) => route.fulfill({ json: {
    kind: 'pr', repo: pr.repo, repoId: 2, number: pr.number, title: pr.title, baseOid, headOid, fetchedAt: at,
    files: [
      { path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch },
      { path: 'src/other.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old other\n+new other' },
    ],
    totalFiles: 2, additions: 2, deletions: 2, url: pr.url,
  } satisfies Diff }));
  await page.route('**/api/v1/prs/**/threads', (route) => route.fulfill({ json: { items: threads } }));
  await page.route('**/api/v1/threads/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    const t = threads.find((t) => t.id === id)!;
    const { status } = route.request().postDataJSON() as Pick<CommentThread, 'status'>;
    t.status = status;
    t.resolvedAt = status === 'resolved' ? at : null;
    t.resolvedBy = status === 'resolved' ? author : null;
    return route.fulfill({ json: t });
  });
  await page.goto(`/prs?source=gitlab.example.com&state=open&pr=${encodeURIComponent(pr.id)}&diff=${encodeURIComponent(pr.id)}`);
  const diff = page.getByRole('region', { name: /Changes in/ });
  await expect(diff).toBeVisible();
  return diff;
}

test('a resolved thread folds its own lines and keeps overlapping and opposite-side code', async ({ page }) => {
  const patch = '@@ -1,6 +1,7 @@\n alpha\n context 2\n-old\n+new\n overlap\n another\n+added\n end';
  const diff = await openReview(page, patch, [thread(1, 2, 4), thread(2, 4, 4, { side: 'old' }), thread(3, 4, 4, { status: 'resolved' })]);
  const card = (id: number) => diff.locator(`.dth[data-thread="${id}"]`);
  const title = (id: number) => card(id).locator('.dth-sum');
  const line = (n: number) => diff.locator(`[data-line="${n}"]`);
  const added = diff.locator('[data-line="3"][data-line-type="change-addition"]');
  const removed = diff.locator('[data-line="3"][data-line-type="change-deletion"]');
  const fold = diff.getByRole('button', { name: 'Fold resolved code' });
  await expect(fold).toHaveAttribute('aria-pressed', 'false');
  await fold.click();
  await title(2).click();
  await expect(title(2)).toHaveAttribute('aria-expanded', 'false');
  await card(1).getByRole('button', { name: 'Resolve' }).click();
  await expect(title(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(added).toBeHidden();
  await expect(removed).toBeVisible();
  await expect(line(2)).toBeHidden();
  await expect(line(4)).toBeVisible();
  await expect(card(1).getByRole('img', { name: 'Resolved by you' })).toBeVisible();
  await expect(card(3).getByRole('img', { name: 'Code folded' })).toHaveCount(0);

  await title(1).click();
  await expect(added).toBeVisible();
  await expect(card(1).getByRole('button', { name: 'Reopen' })).toBeVisible();
  await title(1).click();
  await diff.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(added).toBeHidden();
  await expect(removed).toBeVisible();
  await expect(removed).toHaveText('old');
  await expect(line(2)).toHaveCount(2);
  for (const cell of await line(2).all()) await expect(cell).toBeHidden();
  await card(1).getByRole('button', { name: 'Reopen' }).click();
  await expect(added).toBeVisible();
  await expect(title(1)).toHaveAttribute('aria-expanded', 'true');
});

test('folding a long range compacts the virtualized viewport and lets the comments jump reveal it', async ({ page }) => {
  const rows = Array.from({ length: 550 }, (_, n) => n === 500 ? '-old\n+new' : ` line ${n + 1}`);
  const diff = await openReview(page, `@@ -1,550 +1,550 @@\n${rows.join('\n')}`, [thread(1, 1, 500, { status: 'resolved' }), thread(2, 528, 528)]);
  const fold = diff.getByRole('button', { name: 'Fold resolved code' });
  const row = diff.locator('[data-line="502"]');
  await fold.click();
  await expect(row).toBeInViewport();
  await diff.locator('button[data-id="src/other.ts"]').click();
  await expect(diff.getByText('new other', { exact: true })).toBeInViewport();
  await diff.getByRole('button', { name: 'Comments', exact: true }).click();
  await diff.locator('.dcc button[data-link="1"]').click();
  const card = diff.locator('.dth[data-thread="1"]');
  await expect(card.locator('.dth-sum')).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('button', { name: 'Reopen' })).toBeInViewport();

  const link = new URL(page.url());
  link.searchParams.set('thread', '2');
  link.searchParams.delete('file');
  await page.goto(link.href);
  const linked = diff.locator('.dth[data-thread="2"]');
  await expect(linked.getByRole('button', { name: 'Resolve' })).toBeInViewport();
  await expect(fold).toHaveAttribute('aria-pressed', 'true');
});

test('find reveals a line inside a long resolved fold and restores the fold on close', async ({ page }) => {
  const rows = Array.from({ length: 550 }, (_, i) => {
    if (i === 500) return '-old\n+new';
    return i === 334 ? ' findme-here' : ` line ${i + 1}`;
  });
  const diff = await openReview(page, `@@ -1,550 +1,550 @@\n${rows.join('\n')}`, [thread(1, 1, 500, { status: 'resolved' })]);
  await diff.getByRole('button', { name: 'Fold resolved code' }).click();
  await expect(diff.locator('[data-line="502"]')).toBeInViewport();
  await diff.getByRole('button', { name: 'Find in files', exact: true }).click();
  const find = diff.getByRole('searchbox', { name: 'Find in files' });
  await find.fill('findme-here');
  const line = diff.locator('[data-line="335"]');
  await expect(line).toBeInViewport();
  await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get('ghd-find-current') ?? [], (range) => range.toString()))).toEqual(['findme-here']);
  await expect(diff.locator('.dth[data-thread="1"] .dth-sum')).toHaveAttribute('aria-expanded', 'false');
  await find.press('Escape');
  await expect(line).toBeHidden();
});

test('a resolved range ending outside the patch folds only when its thread can be shown inline', async ({ page }) => {
  await page.route('**/api/v1/blob/**', (route) => {
    const ref = new URL(route.request().url()).searchParams.get('ref');
    return route.fulfill({ contentType: 'text/plain', body: `one\ntwo\nthree\n${ref === headOid ? 'new' : 'old'}\nfive\n` });
  });
  const diff = await openReview(page, '@@ -4 +4 @@\n-old\n+new', [
    thread(1, 4, 5, { status: 'resolved', snippet: 'new\nfive' }),
    thread(2, 2, 2, { status: 'resolved', snippet: 'two' }),
    thread(3, 3, 3, { status: 'resolved', snippet: 'prior version', commitOid: 'c'.repeat(40) }),
  ]);
  const file = diff.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/cache.ts"]') });
  const line = (n: number) => file.locator(`[data-line="${n}"]`);
  const added = file.locator('[data-line="4"][data-line-type="change-addition"]');
  const card = file.locator('.dth[data-thread="1"]');
  await diff.getByRole('button', { name: 'Fold resolved code' }).click();
  await expect(card.getByRole('img', { name: 'Code folded' })).toHaveCount(0);
  await expect(added).toBeVisible();
  await file.getByRole('button', { name: 'Expand toward end of file', exact: true }).click();
  await expect(line(5)).toBeVisible();
  await expect(card.getByRole('img', { name: 'Code folded' })).toHaveCount(0);

  await file.getByRole('button', { name: 'Show full file', exact: true }).click();
  await expect(card.getByRole('img', { name: 'Code folded' })).toBeVisible();
  await expect(line(2)).toBeHidden();
  await expect(line(3)).toBeVisible();
  await expect(added).toBeHidden();
  await expect(line(5)).toBeHidden();
  await card.locator('.dth-sum').click();
  await expect(added).toBeVisible();
  await expect(line(5)).toBeVisible();
});
