import { defineConfig } from 'vitest/config';

// Frontend tests: npm test (runs once) or npm run test:watch.
export default defineConfig({

  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
