import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      VITE_INFERHARNESS_API_BASE_URL: 'http://localhost:8080'
    },
    include: ['tests/unit/**/*.{test,spec}.ts'],
    exclude: ['tests/e2e/**']
  }
});
