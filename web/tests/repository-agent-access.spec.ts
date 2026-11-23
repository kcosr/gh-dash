import type { RepoAgentAccess, SourceAgentAccess } from '../../shared/agent-access';
import type { DesktopState } from '../../shared/desktop';
import { agentAccessFixture, expect, test } from './fixtures';

test('source defaults and bulk overrides can be managed from the desktop settings', async ({ page }, info) => {
  const host = 'gitlab.example.com';
  const inventory = agentAccessFixture();
  inventory.repos.push(
    { id: 3, key: `${host}/platform/deploy`, source: host, nameWithOwner: 'platform/deploy', access: 'inherit' },
    { id: 4, key: `${host}/platform/telemetry`, source: host, nameWithOwner: 'platform/telemetry', access: 'allow' },
    { id: 5, key: `${host}/research/archive`, source: host, nameWithOwner: 'research/archive', access: 'block' },
  );
  const desktop: DesktopState = {
    version: 'browser-fixture', platform: 'linux', configPath: 'synthetic-config', secureStorage: 'available',
    tokenRemembered: false, apiUrl: null, mcpUrl: null, serverError: null, glab: { path: null, chosen: false }, gitlabEnv: 'unset',
    sources: [{ host, url: `https://${host}`, tokenRemembered: false }],
    config: { dataDir: 'synthetic-data', listen: false, restApi: true, mcp: true, mcpRequireTokens: true, network: false, port: 4187, allowedHosts: [], apiKeySet: false, passwordSet: false },
  };
  await page.exposeFunction('setFixtureSourceAccess', (source: string, access: SourceAgentAccess) => {
    inventory.sources.find((item) => item.host === source)!.defaultAccess = access;
  });
  await page.exposeFunction('setFixtureRepoAccess', (ids: number[], access: RepoAgentAccess) => {
    for (const repo of inventory.repos) if (ids.includes(repo.id)) repo.access = access;
  });
  await page.addInitScript((state) => {
    const fixture = window as Window & {
      setFixtureSourceAccess?: unknown;
      setFixtureRepoAccess?: unknown;
    };
    Object.defineProperty(window, 'ghDashDesktop', { value: {
      getState: async () => state,
      setSourceAgentAccess: fixture.setFixtureSourceAccess,
      setRepoAgentAccess: fixture.setFixtureRepoAccess,
    } });
  }, desktop);
  await page.route('**/api/v1/agent-access', (route) => route.fulfill({ json: inventory }));

  await page.goto('/settings#sources');
  const sourceDefault = page.getByLabel(`Default repository access on ${host}`);
  await expect(sourceDefault).toHaveValue('block');
  await expect(page.getByLabel('Default repository access on github.com')).toHaveValue('allow');
  await page.locator('#sources').screenshot({ path: info.outputPath('source-agent-access.png') });

  await page.getByRole('link', { name: `Manage repository access on ${host}` }).click();
  const access = page.locator('#repository-access');
  await expect(access.getByLabel('Repository access source')).toHaveValue(host);
  await expect(access.getByLabel('Select owner/alpha')).toHaveCount(0);
  const search = access.getByRole('searchbox', { name: 'Search repositories' });
  await search.fill('platform');
  await access.getByRole('button', { name: 'Select all matches' }).click();
  await expect(access.getByLabel(`Select ${host}/platform/deploy`)).toBeChecked();
  await expect(access.getByLabel(`Select ${host}/platform/telemetry`)).toBeChecked();
  await access.getByRole('button', { name: 'Allow selected' }).click();
  await expect.poll(() => inventory.repos.map((repo) => repo.access)).toEqual(['inherit', 'inherit', 'allow', 'allow', 'block']);
  await search.clear();
  await access.getByLabel(`Select ${host}/team/beta`).check();
  await access.screenshot({ path: info.outputPath('bulk-repository-access.png') });

  await sourceDefault.selectOption('allow');
  await expect(sourceDefault).toHaveValue('allow');
  await expect(access.getByLabel(`Agent access through gh-dash for ${host}/research/archive`)).toHaveValue('block');
  await expect.poll(() => inventory.sources.find((item) => item.host === host)!.defaultAccess).toBe('allow');

  await page.getByRole('button', { name: 'Add GitLab', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'GitLab address' });
  const addedDefault = page.getByRole('combobox', { name: /Default agent access/ });
  await address.fill(`https://${host}`);
  await expect(addedDefault).toHaveValue('allow');
  await addedDefault.selectOption('block');
  await address.fill('https://new-gitlab.example.com');
  await expect(addedDefault).toHaveValue('block');

  await page.goto(`/repos/${host}/team/beta`);
  const detail = page.locator('.repo-head');
  await expect(detail.getByLabel(`Agent access through gh-dash for ${host}/team/beta`)).toHaveValue('inherit');
  await detail.screenshot({ path: info.outputPath('repository-agent-access.png') });
});
