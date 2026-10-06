import type { Locator } from '@playwright/test';
import type { StreamMessage } from '../../shared/api';
import { test, expect } from './fixtures';

async function receivesPointer(locator: Locator) {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === el || !!target && el.contains(target);
  });
}

test('mobile agent offers remain actionable above the sidebar and below modal dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseShow!: () => void;
  const showReady = new Promise<void>((resolve) => { releaseShow = resolve; });
  let sent = false;
  await page.route('**/api/v1/stream', async (route) => {
    if (sent) {
      await route.fulfill({ status: 404, json: { error: 'Synthetic stream completed' } });
      return;
    }
    await showReady;
    sent = true;
    const message: StreamMessage = {
      type: 'show', id: 'mobile-offer', agent: { id: 42, kind: 'agent', name: 'Review agent' },
      target: { repo: 'owner/alpha', pr: 12 }, message: 'Please review the cache update.',
      at: '2026-10-05T10:00:00Z',
    };
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(message)}\n\n` });
  });

  await page.goto('/prs?source=github.com&state=open');
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Repositories', exact: true });
  await expect(panel).toBeVisible();
  releaseShow();

  const offers = page.getByRole('region', { name: 'Agents', exact: true });
  await expect(offers).toContainText('Review agent');
  await expect(offers).toContainText('wants to show you');
  await expect(offers.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  const dismiss = offers.getByRole('button', { name: 'Dismiss', exact: true });
  await expect.poll(() => receivesPointer(dismiss)).toBe(true);
  await expect(page.locator('.show-chip')).toHaveCSS('animation-name', 'wb-toast');

  await panel.getByRole('button', { name: 'New set from selection', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: /New set|Save.*set|Create.*set/i });
  await expect(prompt).toBeVisible();
  await expect.poll(() => receivesPointer(dismiss)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => receivesPointer(dismiss)).toBe(true);
  await dismiss.click();
  await expect(offers).toHaveCount(0);
  await expect(panel).toBeVisible();
});
