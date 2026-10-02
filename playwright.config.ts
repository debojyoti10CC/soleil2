import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  timeout: 45_000, expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:3101', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node --use-env-proxy --import tsx scripts/e2e-server.ts', url: 'http://127.0.0.1:3101/api/health', reuseExistingServer: false, timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
});
