import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine is deliberately headless: no DOM, no canvas, no browser APIs.
    // If a test here ever needs jsdom, that is a signal the engine boundary leaked.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
