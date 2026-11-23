import type { Locator, Page } from '@playwright/test';
import type { CommentThread, Diff } from '../../shared/api';
import { currentViewReplySchema } from '../../shared/current-view';
import { expect, prs, test } from './fixtures';

async function prepareViewRequests(page: Page) {
  // A streaming Response stays open while the test selects text and asks for successive live reads.
  await page.addInitScript(() => {
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input !== '/api/v1/stream') return request(input, init);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: Event) => {
            const requestId = (event as CustomEvent<string>).detail;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'current_view_request', requestId })}\n\n`));
          };
          window.addEventListener('test-current-view', send);
          init?.signal?.addEventListener('abort', () => {
            window.removeEventListener('test-current-view', send);
            controller.close();
          }, { once: true });
          window.dispatchEvent(new Event('test-stream-opened'));
        },
      });
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    };
    window.addEventListener('test-stream-opened', () => { document.documentElement.dataset.testStream = 'ready'; });
  });

  let replies = 0;
  await page.route('**/api/v1/current-view/reply', async (route) => {
    replies++;
    await route.fulfill({ status: 204 });
  });
  return {
    replyCount: () => replies,
    ask: async () => {
      const requestId = crypto.randomUUID();
      const reply = page.waitForRequest((request) => request.url().endsWith('/api/v1/current-view/reply') && request.postDataJSON()?.requestId === requestId);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('test-current-view', { detail: id })), requestId);
      return currentViewReplySchema.parse((await reply).postDataJSON());
    },
  };
}

const pr = prs[1];
const baseOid = 'a'.repeat(40);
const headOid = 'b'.repeat(40);
const path = 'src/cache.ts';
const previousPath = 'lib/cache.ts';
const at = '2026-10-05T10:00:00Z';
const author = { id: 1, kind: 'self' as const, name: 'You' };
const resolved: CommentThread = {
  id: 17, kind: 'pr', repo: pr.repo, number: pr.number, branch: pr.headRef,
  commitOid: headOid, baseOid, path, side: 'new', startLine: 40, endLine: 40, snippet: 'new last',
  createdAt: at, updatedAt: at, resolvedAt: at, resolvedBy: author, status: 'resolved',
  comments: [{ id: 19, author, body: 'Check the final value.', createdAt: at, editedAt: null }],
};
const reviewDiff = {
  kind: 'pr', repo: pr.repo, number: pr.number, title: pr.title, baseOid, headOid,
  fetchedAt: at, totalFiles: 2, additions: 3, deletions: 3, url: pr.url,
  files: [
    {
      path, previousPath, status: 'renamed', additions: 2, deletions: 2,
      patch: '@@ -4,3 +4,3 @@\n before\n-const value = 1;\n+const value = 2;\n after\n@@ -40 +40 @@\n-old last\n+new last',
    },
    { path: 'src/next.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -2,2 +2,2 @@\n-old next\n+new next\n next context' },
  ],
} satisfies Diff;

async function mockReview(page: Page, threads: CommentThread[]) {
  await page.route('**/api/v1/prs/**/threads', (route) => route.fulfill({ json: { items: threads } }));
  await page.route('**/api/v1/prs/**/diff', (route) => route.fulfill({ json: reviewDiff }));
}

test('a review view answers live with the displayed revisions, file and active code selection', async ({ page }) => {
  const requests = await prepareViewRequests(page);
  await mockReview(page, [resolved]);

  await page.goto('/prs?source=gitlab.example.com&state=open');
  await expect(page.locator('html')).toHaveAttribute('data-test-stream', 'ready');
  expect((await requests.ask()).view).toBeNull();
  await page.getByRole('article', { name: pr.title, exact: true }).click();
  const openDiff = page.getByRole('button', { name: /Files changed/ });
  await expect(openDiff).toBeVisible();
  const target = { kind: 'pr', repo: pr.repo, number: pr.number };
  expect((await requests.ask()).view).toEqual({
    mode: 'details', target, file: null, baseOid: null, headOid: null, selection: null, viewport: null, threadId: null,
  });

  await openDiff.click();
  const file = page.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/cache.ts"]') });
  const added = file.locator('[data-line="5"][data-line-type="change-addition"]');
  await expect(added).toBeVisible();
  expect((await requests.ask()).view).toMatchObject({
    mode: 'diff', target, baseOid, headOid, file: { path, previousPath }, selection: null,
    viewport: {
      first: { side: 'new', lineNumber: 4 }, hunk: { oldStart: 4, oldCount: 3, newStart: 4, newCount: 3 },
      visible: [
        { side: 'old', startLine: 4, endLine: 6 }, { side: 'old', startLine: 40, endLine: 40 },
        { side: 'new', startLine: 4, endLine: 6 }, { side: 'new', startLine: 40, endLine: 40 },
      ],
    },
  });

  await file.evaluate((host) => {
    const root = host.shadowRoot!;
    const point = (type: string, offset: number): [Node, number] => {
      const row = root.querySelector(`[data-line="5"][data-line-type="${type}"]`)!;
      const tokens = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let token = tokens.nextNode(); token; token = tokens.nextNode()) {
        const length = token.textContent!.length;
        if (offset <= length) return [token, offset];
        offset -= length;
      }
      throw new Error('Selection offset is beyond this code line');
    };
    const range = document.createRange();
    range.setStart(...point('change-deletion', 6));
    range.setEnd(...point('change-addition', 11));
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(requests.replyCount()).toBe(3);
  expect((await requests.ask()).view?.selection).toEqual({ kind: 'text', truncated: false, ranges: [
    { path, side: 'old', startLine: 5, endLine: 5, text: 'value = 1;' },
    { path, side: 'new', startLine: 5, endLine: 5, text: 'const value' },
  ] });
  await expect(file.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);

  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await file.locator('[data-column-number="4"]').click();
  expect((await requests.ask()).view?.selection).toEqual({ kind: 'lines', path, side: 'new', startLine: 4, endLine: 4 });
  await file.locator('[data-column-number="6"]').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  expect(requests.replyCount()).toBe(5);
  expect((await requests.ask()).view?.selection).toEqual({ kind: 'lines', path, side: 'new', startLine: 4, endLine: 6 });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await requests.ask()).view?.selection).toBeNull();

  const fold = page.getByRole('button', { name: 'Fold resolved code' });
  await fold.click();
  const lastAddition = file.locator('[data-line="40"][data-line-type="change-addition"]');
  await expect(lastAddition).toBeHidden();
  expect((await requests.ask()).view?.viewport?.visible).not.toContainEqual({ side: 'new', startLine: 40, endLine: 40 });
  await file.locator('.dth[data-thread="17"] .dth-sum').click();
  await expect(lastAddition).toBeVisible();
  expect((await requests.ask()).view?.viewport?.visible).toContainEqual({ side: 'new', startLine: 40, endLine: 40 });

  const next = page.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/next.ts"]') });
  await next.locator('[data-column-number="2"][data-line-type="change-addition"]').click();
  expect((await requests.ask()).view).toMatchObject({
    file: { path, previousPath }, selection: { kind: 'lines', path: 'src/next.ts', side: 'new', startLine: 2, endLine: 2 },
  });
  await next.locator('[data-column-number="3"]').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  expect((await requests.ask()).view).toMatchObject({
    file: { path, previousPath }, selection: { kind: 'lines', path: 'src/next.ts', side: 'new', startLine: 2, endLine: 3 },
  });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /next\.ts/ }).click();
  expect((await requests.ask()).view?.file).toEqual({ path: 'src/next.ts', previousPath: null });
});

async function textPoint(locator: Locator, character: number) {
  return locator.evaluate((el, offset) => {
    const tokens = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let token = tokens.nextNode(); token; token = tokens.nextNode()) {
      const length = token.textContent!.length;
      if (offset <= length) {
        const caret = document.createRange();
        caret.setStart(token, offset);
        caret.collapse(true);
        const rect = caret.getBoundingClientRect();
        return { x: rect.left + 0.25, y: rect.top + rect.height / 2 };
      }
      offset -= length;
    }
    throw new Error('Selection offset is beyond this text');
  }, character);
}

async function dragSelection(page: Page, from: Locator, fromOffset: number, to: Locator, toOffset: number) {
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  const start = await textPoint(from, fromOffset);
  const end = await textPoint(to, toOffset);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

test('live text selection clips at headers and inline threads in either direction', async ({ page }) => {
  const requests = await prepareViewRequests(page);
  await mockReview(page, [{
    ...resolved, status: 'open', resolvedAt: null, resolvedBy: null, startLine: 5, endLine: 5, snippet: 'const value = 2;',
  }]);
  await page.goto(`/prs?source=gitlab.example.com&state=open&diff=${encodeURIComponent(pr.id)}`);
  const file = page.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/cache.ts"]') });
  const header = file.locator('.dvh-path');
  const added = file.locator('[data-line="5"][data-line-type="change-addition"]');
  const body = file.locator('.dth-md').getByText('Check the final value.', { exact: true });
  await expect(body).toBeVisible();
  // Wait for the highlighter to replace the initial plain text before creating a native DOM selection.
  await expect(added.locator('[style*="dvr-token-keyword"]').first()).toBeVisible();

  for (const [from, fromOffset, to, toOffset] of [[header, 2, added, 8], [added, 8, header, 2]] as const) {
    await dragSelection(page, from, fromOffset, to, toOffset);
    expect((await requests.ask()).view?.selection).toEqual({ kind: 'text', truncated: false, ranges: [
      { path, side: 'new', startLine: 4, endLine: 4, text: 'before' },
      { path, side: 'old', startLine: 5, endLine: 5, text: 'const value = 1;' },
      { path, side: 'new', startLine: 5, endLine: 5, text: 'const va' },
    ] });
  }

  for (const [from, fromOffset, to, toOffset] of [[added, 8, body, 5], [body, 5, added, 8]] as const) {
    await dragSelection(page, from, fromOffset, to, toOffset);
    expect((await requests.ask()).view?.selection).toEqual({ kind: 'text', truncated: false, ranges: [
      { path, side: 'new', startLine: 5, endLine: 5, text: 'lue = 2;' },
    ] });
  }
  await dragSelection(page, body, 2, body, 12);
  expect((await requests.ask()).view?.selection).toBeNull();

  const next = page.locator('diffs-container').filter({ has: page.locator('.dvh[data-path="src/next.ts"]') });
  await dragSelection(page, file.locator('[data-line="40"][data-line-type="change-addition"]'), 4, next.locator('.dvh-path'), 3);
  expect((await requests.ask()).view?.selection).toEqual({ kind: 'text', truncated: false, ranges: [
    { path, side: 'new', startLine: 40, endLine: 40, text: 'last' },
  ] });

  await page.evaluate(() => {
    const original = Selection.prototype.getComposedRanges;
    Selection.prototype.getComposedRanges = function () {
      Selection.prototype.getComposedRanges = original;
      throw new Error('The selection changed during the view read');
    };
  });
  expect((await requests.ask()).view).toBeNull();
  expect((await requests.ask()).view?.file).toEqual({ path, previousPath });
});
