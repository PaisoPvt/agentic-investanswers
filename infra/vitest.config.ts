import { defineConfig } from 'vitest/config';

// Only our own tests: cdk.out holds a copy of the repository as the image asset.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 60_000 } });
