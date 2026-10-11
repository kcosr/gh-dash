import type { Page } from '@playwright/test';
import { test, expect, repos as fixtureRepos } from './fixtures';
import type { Repo, RepoStatus } from '../../shared/api';

/** The fixture's repos, answering PATCH as the server would: both have an open PR, so Automatic keeps them active. */
async function serveRepos(page: Page) {
  const list: Repo[] = fixtureRepos.map((r) => ({ ...r }));
  await page.route('**/api/v1/repos**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace('/api/v1/', ''));
    if (path === 'repos') { await route.fulfill({ json: { items: list } }); return; }
    const repo = list.find((r) => path === `repos/${r.key}`);
    if (!repo) { await route.fallback(); return; }
    if (route.request().method() === 'PATCH') {
      Object.assign(repo, route.request().postDataJSON() as { pinned?: boolean; status?: RepoStatus });
      repo.active = repo.status !== 'inactive';
      repo.activeReason = repo.status !== 'auto' ? 'set' : repo.pinned ? 'pinned' : 'open';
    }
    await route.fulfill({ json: repo });
  });
}

test("a sidebar row's menu opens on right-click, leaves its links the browser's menu, and keyboard focus follows the repo", async ({ page }) => {
  await serveRepos(page);
  await page.goto('/prs?state=open');
  const side = page.locator('#repository-sidebar');
  const more = side.locator('.repo-item[data-key="owner/alpha"] .repo-more');
  const menu = page.getByRole('menu', { name: 'Actions for alpha' });
  await expect(more).toHaveCSS('opacity', '0');
  await side.getByRole('button', { name: 'Filter to alpha', exact: true }).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /^Automatic/ })).toHaveAttribute('aria-checked', 'true');
  // Right-clicking a link in the menu is the link's (to copy its address): the menu stays open.
  await menu.getByRole('menuitem', { name: 'Open on GitHub' }).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  // Pin by keyboard: the row moves to Pinned, and focus goes with it.
  await page.keyboard.press('Enter');
  await menu.getByRole('menuitem', { name: 'Pin', exact: true }).press('Enter');
  await expect(side.locator('.side-h', { hasText: 'Pinned' })).toBeVisible();
  await expect(more).toBeFocused();
  // Unpinned: back in the main list, still focused.
  await page.keyboard.press('Enter');
  await menu.getByRole('menuitem', { name: 'Unpin', exact: true }).press('Enter');
  await expect(side.locator('.side-h', { hasText: 'Pinned' })).toHaveCount(0);
  await expect(more).toBeFocused();
  // Inactive: the row goes into the collapsed section, and focus to its toggle.
  await page.keyboard.press('Enter');
  await menu.getByRole('menuitemradio', { name: /^Inactive/ }).press('Enter');
  await expect(side.getByRole('button', { name: 'Show 1 inactive', exact: true })).toBeFocused();
  await expect(more).toHaveCount(0);
});

test('on a phone the row "…" sits beside the counts, and a change keeps focus in the sidebar', async ({ page }) => {
  await serveRepos(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/prs?state=open');
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Repositories', exact: true });
  const row = panel.locator('.repo-item[data-key="owner/alpha"]');
  await expect(row.locator('.repo-more')).toHaveCSS('opacity', '1');
  await expect(row.locator('.repo-counts')).toHaveCSS('visibility', 'visible');
  await row.locator('.repo-more').click();
  await page.getByRole('menu', { name: 'Actions for alpha' }).getByRole('menuitemradio', { name: /^Inactive/ }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Show 1 inactive', exact: true })).toBeFocused();
});
