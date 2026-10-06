import { test, expect } from './fixtures';
import type { Source } from '../../shared/api';
import type { DesktopState } from '../../shared/desktop';

test('shared menus keep keyboard selection and restore trigger focus', async ({ page }) => {
  await page.goto('/prs?source=github.com&state=open');
  const trigger = page.getByRole('button', { name: 'Visibility: Any' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Visibility' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitemradio', { name: /Private/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/vis=private/);
  await expect(page.getByRole('button', { name: 'Visibility: Private' })).toBeFocused();
});

test('date range presets and custom inputs use the shared popover without leaking Escape', async ({ page }) => {
  await page.goto('/prs?source=github.com&state=open&range=30d');
  const trigger = page.getByRole('button', { name: 'Last 30 days', exact: true });
  await trigger.click();
  const popover = page.getByRole('dialog', { name: 'Date range' });
  await expect(popover.getByRole('button', { name: /Last 30 days/ })).toBeFocused();
  await popover.getByRole('button', { name: 'Custom range…' }).click();
  await expect(popover.getByLabel('From')).toBeFocused();
  await popover.getByLabel('From').fill('2026-09-01');
  await popover.getByLabel('To').fill('2026-09-30');
  await popover.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/range=custom/);
  await expect(page).toHaveURL(/from=2026-09-01/);
  await expect(page).toHaveURL(/to=2026-09-30/);
  const current = page.getByRole('button', { name: /Sep 1.*Sep 30/ });
  await current.click();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(current).toBeFocused();
});

test('name prompt preserves async pending, failure recovery, and success toast', async ({ page }) => {
  let attempts = 0;
  let finish: (() => void) | undefined;
  await page.route('**/api/v1/sets', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    attempts += 1;
    if (attempts === 1) {
      await new Promise<void>((resolve) => { finish = resolve; });
      await route.fulfill({ status: 409, json: { error: 'That set name already exists' } });
    } else {
      await route.fulfill({ json: { id: 42, name: 'My review', repos: ['owner/alpha'], createdAt: '2026-10-05T12:00:00Z' } });
    }
  });
  await page.goto('/prs?source=github.com&state=open');
  const trigger = page.getByRole('button', { name: 'New set from selection' });
  await trigger.click();
  const prompt = page.getByRole('dialog', { name: 'New set' });
  await expect(prompt.getByLabel('Name')).toBeFocused();
  await prompt.getByLabel('Name').fill('My review');
  const submit = prompt.getByRole('button', { name: 'Create set' });
  await prompt.getByLabel('Name').press('Enter');
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(prompt.getByLabel('Name')).toBeFocused();
  await expect(prompt.getByLabel('Name')).toHaveAttribute('readonly', '');
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect.poll(() => !!finish).toBe(true);
  finish!();
  await expect(prompt.getByRole('alert')).toHaveText('That set name already exists');
  await expect(prompt.getByLabel('Name')).toHaveValue('My review');
  await expect(prompt.getByLabel('Name')).toBeFocused();
  await expect(prompt.getByLabel('Name')).toBeEditable();
  await prompt.getByLabel('Name').press('Enter');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Set “My review” created' })).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('email tokens retain delimiter, paste, blur, removal, and saved payload semantics', async ({ page }) => {
  // Additional Settings-only endpoints; this browser test never reaches the real API.
  await page.route('**/api/v1/diff-cache', (route) => route.fulfill({ json: { bytes: 0, entries: 0, maxBytes: 200 * 1024 * 1024 } }));
  let saved: unknown;
  await page.route('**/api/v1/settings', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { syncIntervalMinutes: 30, backfillDays: 365, myEmails: [], includeForks: false, diffCacheMb: 200, ...saved as object } });
  });
  await page.goto('/settings?source=github.com');
  const input = page.getByRole('textbox', { name: 'Add commit email' });
  const interval = page.getByRole('spinbutton', { name: /Sync interval/ });
  const normalBorder = await interval.evaluate((el) => getComputedStyle(el).borderColor);
  await interval.fill('1');
  await input.focus();
  await expect(interval).toHaveAttribute('aria-invalid', 'true');
  await expect.poll(() => interval.evaluate((el) => getComputedStyle(el).borderColor)).not.toBe(normalBorder);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await interval.fill('30');
  await input.focus();
  await expect(interval).not.toHaveAttribute('aria-invalid', 'true');
  await expect.poll(() => interval.evaluate((el) => getComputedStyle(el).borderColor)).toBe(normalBorder);
  await input.fill('first@example.com');
  await input.press(',');
  await expect(page.getByRole('button', { name: 'Remove first@example.com' })).toBeVisible();
  await input.fill('second@example.com; third@example.com');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove second@example.com' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove third@example.com' })).toBeVisible();
  await input.press('Backspace');
  await expect(page.getByRole('button', { name: 'Remove third@example.com' })).toHaveCount(0);
  await input.fill('first@example.com fourth@example.com');
  await input.press('Tab');
  await expect(page.getByRole('button', { name: 'Remove first@example.com' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove fourth@example.com' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove second@example.com' }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ myEmails: ['first@example.com', 'fourth@example.com'] });
});


test('author filter communicates its active state with the shared button variant', async ({ page }) => {
  await page.route('**/api/v1/agents', (route) => route.fulfill({ json: { items: [{ id: 1, name: 'Review assistant', createdAt: '2026-10-05T10:00:00Z', lastUsedAt: null, disabledAt: null, tokenPrefix: 'fixture', builtIn: false, sources: null }] } }));
  await page.goto('/comments?source=github.com');
  const trigger = page.getByRole('button', { name: 'Opened by: Anyone' });
  const inactiveBackground = await trigger.evaluate((el) => getComputedStyle(el).backgroundColor);
  await trigger.click();
  await page.getByRole('menu', { name: 'Opened by' }).getByRole('menuitemradio', { name: 'You', exact: true }).click();
  await expect(page).toHaveURL(/author=self/);
  const active = page.getByRole('button', { name: 'Opened by: You' });
  await expect.poll(() => active.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(inactiveBackground);
  await active.click();
  const menu = page.getByRole('menu', { name: 'Opened by' });
  await expect(menu.getByRole('menuitemradio', { name: 'You', exact: true })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Anyone', exact: true }).click();
  await expect(page).not.toHaveURL(/author=self/);
  await expect.poll(() => trigger.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(inactiveBackground);
});


test('source sign-out focuses Cancel so Enter does not forget a remembered token', async ({ page }) => {
  const host = 'gitlab.example.com';
  const at = '2026-10-05T10:00:00Z';
  const source: Source = {
    host, kind: 'gitlab', name: 'GitLab', url: `https://${host}`, configured: true, removable: false,
    viewer: { login: 'owner', name: 'Test Owner', avatarUrl: null },
    account: {
      source: 'app', choice: 'app', locked: false, env: null, login: 'owner', name: 'Test Owner', avatarUrl: null,
      dbLogin: 'owner', mismatch: false, kind: 'classic', expiresAt: null, scopes: ['read_api'], canWrite: false,
      repos: { total: 1, private: null }, cli: null, tokenFile: null, instance: null, error: null, checkedAt: at,
    },
    sync: { source: host, running: false, progress: null, lastSyncAt: at, lastResult: { newItems: 0, errors: [] }, rateLimit: null, tokenSource: 'app', viewer: 'owner', problem: null },
    repos: { owned: 1, added: 0, hidden: 0 },
  };
  const desktop: DesktopState = {
    version: 'browser-fixture', platform: 'linux', configPath: 'synthetic-config', secureStorage: 'available',
    tokenRemembered: false, apiUrl: null, mcpUrl: null, serverError: null, glab: { path: null, chosen: false }, gitlabEnv: 'unset',
    sources: [{ host, url: source.url, tokenRemembered: true }],
    config: { dataDir: 'synthetic-data', listen: false, restApi: true, mcp: true, mcpRequireTokens: true, network: false, port: 4187, allowedHosts: [], apiKeySet: false, passwordSet: false },
  };
  await page.addInitScript((state) => {
    // Only a synthetic bridge; cancellation must never invoke its sign-out operation.
    Object.defineProperty(window, 'ghDashDesktop', { value: {
      getState: async () => state,
      signOutSource: async () => { throw new Error('Sign-out must not be called when Cancel is focused'); },
    } });
  }, desktop);
  await page.route('**/api/v1/sources', (route) => route.fulfill({ json: { items: [source] } }));
  await page.goto('/settings?source=gitlab.example.com');
  const trigger = page.locator('[id="source-gitlab.example.com"]').getByRole('button', { name: 'Sign out', exact: true });
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: `Sign out of ${host}?` });
  await expect(dialog).toContainText('removes it from the OS keychain');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
