import type { Page } from '@playwright/test';
import { test, expect, branches, repos } from './fixtures';

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toBeFocused();
  return palette;
}

test('branch review preserves repository steps, keyboard back and branch navigation', async ({ page }) => {
  await page.goto('/prs?source=github.com');
  const palette = await openPalette(page);
  const query = palette.getByRole('combobox');
  await expect(palette.getByRole('option', { name: 'alpha', exact: true })).toBeVisible();
  await query.fill('Review a branch');
  await query.press('Enter');
  await expect(query).toHaveAttribute('placeholder', 'Pick a repository…');
  await expect(query).toHaveValue('');
  await palette.getByRole('option', { name: 'alpha', exact: true }).click();
  await expect(query).toHaveAttribute('placeholder', 'Filter branches…');
  await expect(palette.getByRole('option', { name: /^feature\/a/ })).toBeVisible();
  await expect(query).toBeFocused();

  await query.press('Backspace');
  await expect(query).toHaveAttribute('placeholder', 'Pick a repository…');
  await palette.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(query).toHaveAttribute('placeholder', /Search repos/);
  await expect(query).toBeFocused();
  await query.fill('Review a branch');
  await query.press('Enter');
  await palette.getByRole('option', { name: 'alpha', exact: true }).click();
  await query.fill('feature/b');
  await expect(palette.getByRole('option', { name: /^feature\/a/ })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: /^feature\/b/ })).toBeVisible();
  await query.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('diff')).toBe('owner/alpha~feature/b');
});

for (const ref of [
  { text: 'alpha#12', repo: 'owner/alpha', number: 12, title: 'Improve cache refresh' },
  { text: 'beta!34', repo: 'gitlab.example.com/team/beta', number: 34, title: 'Update deployment documentation' },
]) {
  test(`direct ${ref.text} lookup preserves provider references and opens the result`, async ({ page }) => {
    await page.goto('/prs?source=github.com');
    const palette = await openPalette(page);
    await expect(palette.getByRole('option', { name: 'alpha', exact: true })).toBeVisible();
    const requested = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/v1/prs' && url.searchParams.get('limit') === '200'
        && url.searchParams.get('repos') === ref.repo;
    });
    await palette.getByRole('combobox').fill(ref.text);
    const url = new URL((await requested).url());
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('source')).toBe(false);
    // A provider reference does not occur in the title: the shared palette must
    // preserve the application's already-filtered result instead of hiding it.
    const result = palette.getByRole('option', { name: new RegExp(`^${ref.title}`) });
    await expect(result).toBeVisible();
    await result.click();
    await expect(palette).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('pr')).toBe(`${ref.repo}#${ref.number}`);
  });
}

test('palette context switching and cross-source repository selection retain routing', async ({ page }) => {
  await page.goto('/prs?source=github.com');
  let palette = await openPalette(page);
  await expect(palette.getByRole('option', { name: 'alpha', exact: true })).toBeVisible();
  await palette.getByRole('combobox').fill('Switch to GitLab');
  await palette.getByRole('option', { name: 'Switch to GitLab', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('source')).toBe('gitlab.example.com');
  palette = await openPalette(page);
  await palette.getByRole('combobox').fill('alpha');
  const alpha = palette.getByRole('option', { name: 'alpha', exact: true });
  await expect(alpha).toContainText('Switch to GitHub');
  await alpha.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('source')).toBe('github.com');
  await expect.poll(() => new URL(page.url()).searchParams.get('repos')).toBe('owner/alpha');
});

test('a failed branch lookup can retry without closing its step', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/branches/owner%2Falpha*', async (route) => {
    await route.fulfill(fail
      ? { status: 503, json: { error: 'Test branch service unavailable' } }
      : { json: branches });
  });
  await page.goto('/prs?source=github.com&repos=owner%2Falpha');
  const palette = await openPalette(page);
  await expect(palette.getByRole('option', { name: 'alpha', exact: true })).toBeVisible();
  await palette.getByRole('combobox').fill('Review a branch');
  await palette.getByRole('combobox').press('Enter');
  const retry = palette.getByRole('option', { name: /Retry Branches of/ });
  await expect(retry).toBeVisible();
  fail = false;
  await retry.click();
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toHaveAttribute('placeholder', 'Filter branches…');
  await expect(palette.getByRole('option', { name: /^feature\/a/ })).toBeVisible();
  await expect(retry).toHaveCount(0);
});


test('repository labels keep owner styling and highlights across the owner/name boundary', async ({ page }) => {
  await page.route('**/api/v1/repos', (route) => route.fulfill({
    json: { items: repos.map((repo) => repo.key === 'owner/alpha' ? { ...repo, trackedBy: 'manual' } : repo) },
  }));
  await page.goto('/prs?source=github.com');
  const palette = await openPalette(page);
  await expect(palette.getByRole('option', { name: 'owner/alpha', exact: true })).toBeVisible();
  await palette.getByRole('combobox').fill('owner/al');
  const repo = palette.getByRole('option', { name: 'owner/alpha', exact: true });
  await expect(repo.locator('.pal-o')).toHaveText('owner/');
  await expect.poll(async () => (await repo.locator('mark').allTextContents()).join('')).toBe('owner/al');
});

for (const lookup of ['pull requests', 'branches'] as const) {
  test(`cached ${lookup} keep results and refetch feedback in one palette section`, async ({ page }) => {
    await page.clock.install();
    let failRefetch = false;
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => { release = resolve; });
    const branchLookup = lookup === 'branches';
    await page.route(branchLookup ? '**/api/v1/branches/owner%2Falpha*' : '**/api/v1/prs?*', async (route) => {
      const isPaletteLookup = branchLookup || new URL(route.request().url()).searchParams.get('limit') === '5';
      if (!isPaletteLookup || !failRefetch) { await route.fallback(); return; }
      await responseReady;
      // 400 avoids automatic branch retries; this test exercises the explicit
      // palette retry while a successful earlier response remains cached.
      await route.fulfill({ status: 400, json: { error: 'Synthetic refetch failure' } });
    });
    await page.goto('/prs?source=github.com&repos=owner%2Falpha');
    // Seed the same context-specific query that reopening will refetch. Before
    // repository metadata loads, the palette briefly uses the unscoped query.
    await expect(page.getByRole('group', { name: 'Source', exact: true })
      .getByRole('button', { name: 'GitHub', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const enter = async () => {
      const palette = await openPalette(page);
      if (branchLookup) {
        await expect(palette.getByRole('option', { name: 'alpha', exact: true })).toBeVisible();
        await palette.getByRole('combobox').fill('Review a branch');
        await palette.getByRole('combobox').press('Enter');
      }
      return palette;
    };
    const heading = branchLookup ? 'Branches of alpha' : 'Recent pull requests';
    const resultName = branchLookup ? /^feature\/a/ : /^Improve cache refresh/;
    let palette = await enter();
    await expect(palette.getByRole('option', { name: resultName })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await page.clock.fastForward(61_000);
    failRefetch = true;
    palette = await enter();
    const section = palette.getByRole('group', { name: heading, exact: true });
    try {
      await expect(section).toHaveCount(1);
      await expect(section.getByRole('option', { name: resultName })).toBeVisible();
      await expect(section.getByText(`Loading ${heading}…`, { exact: true })).toBeVisible();
    } finally {
      release();
    }
    const retry = section.getByRole('option', { name: `Retry ${heading}`, exact: true });
    await expect(retry).toBeVisible();
    await expect(section).toHaveCount(1);
    await expect(section.getByRole('option', { name: resultName })).toBeVisible();
    await expect(section.locator('.wb-palette-status-error')).toContainText(branchLookup ? 'Synthetic refetch failure' : 'Could not load pull requests');
    failRefetch = false;
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(section).toHaveCount(1);
    await expect(section.getByRole('option', { name: resultName })).toBeVisible();
  });
}
