import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['server/**/*.test.ts', 'tests/**/*.unit.test.ts', 'contracts/**/*.test.ts'], testTimeout: 30000 } });
