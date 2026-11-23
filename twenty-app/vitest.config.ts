import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Integration tests run against the isolated test instance only. The API key
// comes from the environment; none is committed.
const TWENTY_API_URL = process.env.TWENTY_API_URL ?? 'http://localhost:2021';
const TWENTY_API_KEY = process.env.TWENTY_API_KEY ?? '';

// Make env vars available to globalSetup (test.env only applies to workers)
process.env.TWENTY_API_URL = TWENTY_API_URL;
process.env.TWENTY_API_KEY = TWENTY_API_KEY;

export default defineConfig({
  plugins: [
    tsconfigPaths({
      projects: ['tsconfig.spec.json'],
      ignoreConfigErrors: true,
    }),
  ],
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: ['src/**/*.integration-test.ts'],
    globalSetup: ['src/__tests__/global-setup.ts'],
    env: {
      TWENTY_API_URL,
      TWENTY_API_KEY,
    },
  },
});
