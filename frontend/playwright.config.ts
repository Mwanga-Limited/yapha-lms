import { defineConfig } from '@playwright/test';

// End-to-end tests run against a real backend + database (see .github/workflows/ci.yml and TESTING.md).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:4000', trace: 'retain-on-failure' },
  reporter: [['list']],
});
