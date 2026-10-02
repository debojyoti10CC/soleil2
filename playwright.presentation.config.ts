import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/presentation', outputDir: '.runtime/presentation-results', workers: 1, fullyParallel: false, timeout: 180_000,
  expect: { timeout: 30_000 }, use: { baseURL: 'http://localhost:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }], reporter: [['list']],
});
