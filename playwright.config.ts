import { defineConfig } from '@playwright/test';

// Browser contract tests use the production web build and synthetic API responses.
// They do not access a running dashboard, provider account, or local runtime database.
export default defineConfig({
  testDir: './web/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4187',
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
  },
});
