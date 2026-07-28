import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ["tests/helpers/setup.ts"],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/vscode-extension/**',
    ],
    // Integration tests may wait on provider health (~10s); keep a hard ceiling
    // so a hung network call cannot stall CI for 30+ minutes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
