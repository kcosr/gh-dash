import type { Locator, Page } from '@playwright/test';
import type { CommentThread, Diff, DiffFile } from '../../shared/api';
import { expect, prs, test } from './fixtures';

const pr = prs[0];
const baseOid = 'a'.repeat(40);
const headOid = 'b'.repeat(40);
const path = 'src/cache.ts';
const otherPath = 'src/other.ts';
const first = 515;
const second = 1351;
const third = 1815;
const farMatch = 2231;
const context = 15;

const original = Array.from({ length: 2400 }, (_, i) => `// source line ${i + 1}`);
original[first - 2] = '// needle shared by both revisions';
original[first + context + 2] = '// revealed context marker';
original[farMatch - 1] = 'const hidden = "needle";';
const changes = [
  { line: first, old: 'const stale = "needle";', next: 'const fresh = "needle";' },
  { line: second, old: 'const prior = "needle";', next: 'const active = "other";' },
  { line: third, old: 'const cleanup = false;', next: 'const cleanup = true;' },
];
const patch = changes.map(({ line, old, next }) => {
  const start = line - context;
  const count = 2 * context + 1;
  const before = original.slice(start - 1, line - 1).map((text) => ' ' + text);
  const after = original.slice(line, line + context).map((text) => ' ' + text);
  return [`@@ -${start},${count} +${start},${count} @@`, ...before, '-' + old, '+' + next, ...after].join('\n');
}).join('\n');
const otherLines = Array.from({ length: 100 }, (_, i) => i ? `// other line ${i + 1}` : '// needle in the other file');
const files: DiffFile[] = [
  { path, previousPath: null, status: 'modified', additions: changes.length, deletions: changes.length, patch },
  { path: otherPath, previousPath: null, status: 'added', additions: otherLines.length, deletions: 0,
    patch: ['@@ -0,0 +1,100 @@', ...otherLines.map((line) => '+' + line)].join('\n') },
];

async function openDiff(page: Page, holdBlobs?: Promise<void>) {
  await page.route('**/api/v1/prs/**/diff', (route) => route.fulfill({ json: {
    kind: 'pr', repo: pr.repo, repoId: 1, number: pr.number, title: pr.title, baseOid, headOid,
    files, totalFiles: files.length, additions: changes.length + otherLines.length, deletions: changes.length,
    fetchedAt: '2026-10-05T10:00:00Z', url: pr.url,
  } satisfies Diff }));
  await page.route('**/api/v1/blob/**', async (route) => {
    await holdBlobs;
    const ref = new URL(route.request().url()).searchParams.get('ref');
    const lines = [...original];
    for (const change of changes) lines[change.line - 1] = ref === headOid ? change.next : change.old;
    await route.fulfill({ contentType: 'text/plain', body: lines.join('\n') + '\n' });
  });
  await page.goto('/prs?state=open&diff=' + encodeURIComponent(pr.id));
  const diff = page.getByRole('region', { name: /Changes in/ });
  const file = (name: string) => diff.locator('diffs-container').filter({ has: page.locator(`.dvh[data-path="${name}"]`) });
  const pick = (name: string) => diff.getByRole('navigation', { name: 'Changed files' }).locator(`[data-id="${name}"]`);
  return { diff, file: file(path), other: file(otherPath), pick, scroll: diff.locator('.dvr-scroll') };
}

function line(file: Locator, number: number, type = '') {
  return file.locator(`[data-line="${number}"]${type ? `[data-line-type="${type}"]` : ''}`);
}

/** CodeView can keep rows mounted above and below the pane. The file header can also obscure a row. */
async function expectInReadingView(rows: Locator) {
  await expect.poll(() => rows.evaluateAll((elements) => elements.some((row) => {
    const host = (row.getRootNode() as ShadowRoot).host;
    const viewport = host?.closest('.dvr-scroll')?.getBoundingClientRect();
    const header = host?.querySelector('.dvh')?.getBoundingClientRect();
    if (!viewport || !header) return false;
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > Math.max(viewport.top, header.bottom) + 1 && rect.top < viewport.bottom - 1;
  }))).toBe(true);
}

function button(region: Locator, name: string) {
  return region.getByRole('button', { name, exact: true });
}

/** Click the header in place. Bringing a slotted sticky control into view can move the diff itself. */
async function clickSticky(page: Page, control: Locator) {
  await expect(control).toBeEnabled();
  await expect.poll(() => control.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const pane = el.closest('.dvr-scroll')!.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
    return y >= pane.top && y < pane.bottom && el.contains(hit);
  })).toBe(true);
  const box = await control.boundingBox();
  if (!box) throw new Error('Sticky file control has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const draftText = 'Keep the draft attached to this change.';

async function writeInlineDraft(file: Locator) {
  await expectInReadingView(line(file, first, 'change-addition'));
  await file.locator(`[data-column-number="${first}"][data-line-type="change-addition"]`).hover();
  await button(file, `Comment on new line ${first}`).click();
  const draft = file.getByRole('textbox', { name: `Comment on line ${first}` });
  await expect(draft).toBeFocused();
  await draft.fill(draftText);
  return draft;
}

test('full file starts at the patch viewport and returns to the nearest change from unchanged context', async ({ page }) => {
  const { file, scroll } = await openDiff(page);
  await expectInReadingView(line(file, first, 'change-addition'));
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);

  const full = button(file, 'Show full file');
  const patchOnly = button(file, 'Show changes only');
  await full.click();
  await expect(patchOnly).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight)).toBeGreaterThan(40_000);
  await expectInReadingView(line(file, first, 'change-addition'));

  const gapLine = third - 130;
  const lineHeight = await line(file, first, 'change-addition').evaluate((el) => el.getBoundingClientRect().height);
  await scroll.hover();
  await page.mouse.wheel(0, gapLine * lineHeight - await scroll.evaluate((el) => el.scrollTop));
  await expectInReadingView(line(file, gapLine + 15));
  await clickSticky(page, patchOnly);
  await expect(full).toBeFocused();
  await expectInReadingView(line(file, third, 'change-addition'));
});

test('finishing a full-file load preserves the file picked while it was pending', async ({ page }) => {
  let release!: () => void;
  const holdBlobs = new Promise<void>((resolve) => { release = resolve; });
  const { file, other, pick } = await openDiff(page, holdBlobs);
  const otherPick = pick(otherPath);
  try {
    await button(file, 'Show full file').click();
    await expect(button(file, 'Loading file…')).toBeDisabled();
    await otherPick.click();
    await expect(otherPick).toHaveAttribute('aria-current', 'true');
    await expectInReadingView(line(other, 1, 'change-addition'));
  } finally {
    release();
  }
  // The original file may leave the rendered window when its full context is installed.
  await expect(button(file, 'Loading file…')).toHaveCount(0);
  await expect(otherPick).toHaveAttribute('aria-current', 'true');
  await expectInReadingView(line(other, 1, 'change-addition'));
});

test('finishing a full-file load preserves a newer source position in the same file', async ({ page }) => {
  let release!: () => void;
  const holdBlobs = new Promise<void>((resolve) => { release = resolve; });
  const { file, scroll } = await openDiff(page, holdBlobs);
  try {
    await button(file, 'Next change').click();
    await expectInReadingView(line(file, second, 'change-addition'));
    await clickSticky(page, button(file, 'Show full file'));
    await expect(button(file, 'Loading file…')).toBeDisabled();
    await scroll.evaluate((el) => { el.scrollTop = 0; });
    await expectInReadingView(line(file, first, 'change-addition'));
  } finally {
    release();
  }
  await expect(button(file, 'Show changes only')).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight)).toBeGreaterThan(40_000);
  await expectInReadingView(line(file, first, 'change-addition'));
});

test('previous and next change use the same stops in the patch and full file', async ({ page }) => {
  const { file } = await openDiff(page);
  const previous = button(file, 'Previous change');
  const next = button(file, 'Next change');
  await expect(previous).toBeDisabled();
  await next.click();
  await expectInReadingView(line(file, second, 'change-addition'));
  await clickSticky(page, next);
  await expectInReadingView(line(file, third, 'change-addition'));
  await expect(next).toBeDisabled();

  await clickSticky(page, button(file, 'Show full file'));
  await expect(button(file, 'Show changes only')).toBeVisible();
  await expectInReadingView(line(file, third, 'change-addition'));
  await clickSticky(page, previous);
  await expectInReadingView(line(file, second, 'change-addition'));
  await clickSticky(page, previous);
  await expectInReadingView(line(file, first, 'change-addition'));
  await expect(previous).toBeDisabled();
  await next.click();
  await expectInReadingView(line(file, second, 'change-addition'));
});

test('find counts both sides, wraps through virtual rows, and follows the viewed file', async ({ page }) => {
  const { diff, file, other, pick, scroll } = await openDiff(page);
  await button(diff, 'Split').click();
  const findButton = button(diff, 'Find in file');
  const find = diff.getByRole('searchbox', { name: 'Find in file' });
  const count = diff.getByRole('status').filter({ hasText: /\d+\s*(?:of|\/)\s*\d+|No matches/i });
  const isCount = (current: number, total: number) => new RegExp(`^${current}\\s*(?:of|/)\\s*${total}$`);
  await scroll.focus();
  await page.keyboard.press('Control+f');
  await expect(find).toBeFocused();
  await find.fill('needle');
  await expect(count).toHaveText(isCount(1, 4));
  await find.press('Shift+Enter');
  await expect(count).toHaveText(isCount(4, 4));
  await expectInReadingView(line(file, second, 'change-deletion'));
  await find.press('Enter');
  await expect(count).toHaveText(isCount(1, 4));
  await expectInReadingView(line(file, first - 1));

  await find.fill('= "needle"');
  await expect.poll(() => page.evaluate(() =>
    Array.from(CSS.highlights.get('ghd-find-current') ?? [], (range) => range.toString()),
  )).toEqual(['= "needle"']);
  await find.fill('absent phrase');
  await expect(count).toHaveText('No matches');
  await expect(button(diff, 'Next match')).toBeDisabled();
  await find.fill('');
  await expect(count).toHaveCount(0);
  await find.press('c');
  await expect(find).toHaveValue('c');
  await expect(button(diff, 'Comments')).toHaveAttribute('aria-pressed', 'false');
  await find.fill('needle');

  await clickSticky(page, button(file, 'Show full file'));
  await expect(count).toHaveText(isCount(1, 5));
  await expect(line(file, farMatch)).toHaveCount(0);
  await expectInReadingView(line(file, first - 1));
  await page.keyboard.press('Meta+f');
  await expect(find).toBeFocused();
  await find.press('Shift+Enter');
  await expect(count).toHaveText(isCount(5, 5));
  await expectInReadingView(line(file, farMatch));
  await find.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(scroll).toBeFocused();
  await expect(diff).toBeVisible();

  await findButton.click();
  await pick(otherPath).click();
  await expect(count).toHaveText(isCount(1, 1));
  await expectInReadingView(line(other, 1, 'change-addition'));
});

test('find adds context revealed by a gutter expander', async ({ page }) => {
  const { diff, file } = await openDiff(page);
  await button(diff, 'Find in file').click();
  const find = diff.getByRole('searchbox', { name: 'Find in file' });
  await find.fill('revealed context marker');
  await expect(diff.getByRole('status').filter({ hasText: 'No matches' })).toBeVisible();
  await button(file, 'Expand down').first().click();
  await expect(diff.getByRole('status').filter({ hasText: /^1\s*(?:of|\/)\s*1$/ })).toBeVisible();
  await button(diff, 'Next match').click();
  await expectInReadingView(line(file, first + context + 3));
});

test('loading a full file keeps focus in find while preserving an inline draft', async ({ page }) => {
  let release!: () => void;
  const holdBlobs = new Promise<void>((resolve) => { release = resolve; });
  const { diff, file, scroll } = await openDiff(page, holdBlobs);
  const find = diff.getByRole('searchbox', { name: 'Find in file' });
  const draft = await writeInlineDraft(file);
  try {
    await clickSticky(page, button(file, 'Show full file'));
    await expect(button(file, 'Loading file…')).toBeDisabled();
    await button(diff, 'Find in file').click();
    await expect(find).toBeFocused();
  } finally {
    release();
  }
  await expect(button(file, 'Show changes only')).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight)).toBeGreaterThan(40_000);
  await expectInReadingView(line(file, first, 'change-addition'));
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue(draftText);
  await expect(find).toBeFocused();
});

test('find can seek into full-file context while syntax highlighting is still queued', async ({ page }) => {
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: { diff?: { cacheKey?: string } }, options?: Transferable[] | StructuredSerializeOptions) {
      const dispatch = () => Array.isArray(options) ? send.call(this, message, { transfer: options }) : send.call(this, message, options);
      if (!message.diff?.cacheKey?.endsWith(':full-context')) return dispatch();
      document.documentElement.dataset.fullHighlightQueued = 'true';
      window.addEventListener('release-full-highlight', dispatch, { once: true });
    };
  });
  const { diff, file } = await openDiff(page);
  await expect.poll(() => line(file, first, 'change-addition').locator('span').count()).toBeGreaterThan(1);
  await clickSticky(page, button(file, 'Show full file'));
  await expect(page.locator('html')).toHaveAttribute('data-full-highlight-queued', 'true');
  await expect(button(file, 'Show changes only')).toBeVisible();
  await expectInReadingView(line(file, first, 'change-addition'));
  await button(diff, 'Find in file').click();
  const find = diff.getByRole('searchbox', { name: 'Find in file' });
  await find.fill('const hidden');
  await expectInReadingView(line(file, farMatch));
  await page.evaluate(() => window.dispatchEvent(new Event('release-full-highlight')));
  await expect.poll(() => line(file, farMatch).locator('span').count()).toBeGreaterThan(1);
  await expectInReadingView(line(file, farMatch));
});

test('Escape from find closes it before the open inline draft', async ({ page }) => {
  const { diff, file } = await openDiff(page);
  const draft = await writeInlineDraft(file);
  const find = diff.getByRole('searchbox', { name: 'Find in file' });
  const trigger = button(diff, 'Find in file');
  await trigger.click();
  await expect(find).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue(draftText);
});

test('stay in a tall inline annotation across context modes and navigate nearby hunks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  const fetchedAt = '2026-10-05T10:00:00Z';
  await page.route('**/api/v1/prs/**/threads', (route) => route.fulfill({ json: { items: [{
    id: 9, kind: 'pr', repo: pr.repo, number: pr.number, branch: pr.headRef, commitOid: headOid, baseOid,
    path, side: 'new', startLine: second, endLine: second, snippet: changes[1]!.next,
    status: 'open', resolvedAt: null, resolvedBy: null, createdAt: fetchedAt, updatedAt: fetchedAt,
    comments: [{
      id: 27, author: { id: 1, kind: 'self', name: 'You' },
      body: Array.from({ length: 48 }, (_, i) => 'Thread paragraph ' + (i + 1)).join('\n\n'),
      createdAt: fetchedAt, editedAt: null,
    }],
  } satisfies CommentThread] } }));
  const { file, scroll } = await openDiff(page);
  const note = file.locator('.dth[data-thread="9"]');
  const noteTop = () => note.evaluate((note) => Math.round(note.getBoundingClientRect().top - note.closest('.dvr-scroll')!.getBoundingClientRect().top));
  await expect(button(file, 'Next change')).toBeEnabled();
  await clickSticky(page, button(file, 'Next change'));
  await expectInReadingView(line(file, second, 'change-addition'));
  const visibleRows = () => file.evaluate((host) => {
    const viewport = host.closest('.dvr-scroll')!.getBoundingClientRect();
    const top = Math.max(viewport.top, host.querySelector('.dvh')!.getBoundingClientRect().bottom);
    return [...host.shadowRoot!.querySelectorAll('[data-line][data-line-type]')].filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > top && rect.top < viewport.bottom;
    }).length;
  });
  const goInsideNote = async () => {
    await expect(note.locator('p')).toHaveCount(48);
    await expect.poll(() => note.evaluate((note) => note.getBoundingClientRect().height)).toBeLessThan(1450);
    await scroll.hover();
    await page.mouse.wheel(0, await noteTop() + 350);
    await expect.poll(noteTop).toBeLessThan(-250);
    await expect.poll(visibleRows).toBe(0);
  };
  await goInsideNote();
  await expect(button(file, 'Previous change')).toBeEnabled();
  await expect(button(file, 'Next change')).toBeEnabled();
  await clickSticky(page, button(file, 'Show full file'));
  await expect(button(file, 'Show changes only')).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight)).toBeGreaterThan(40_000);
  await expectInReadingView(line(file, second, 'change-addition'));
  await goInsideNote();
  await clickSticky(page, button(file, 'Show changes only'));
  await expect(button(file, 'Show full file')).toBeVisible();
  await expectInReadingView(line(file, second, 'change-addition'));
  await goInsideNote();
  await clickSticky(page, button(file, 'Next change'));
  await expectInReadingView(line(file, third, 'change-addition'));
});
