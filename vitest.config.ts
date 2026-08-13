import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // The addon entry is TSX; tests import it to check route registration.
    jsx: 'automatic',
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    environment: 'node',
  },
});
