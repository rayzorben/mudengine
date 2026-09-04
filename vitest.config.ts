import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The iteration suite: everything except the tests that convert a real Access
 * database.
 *
 * `RealmLibrary.realm.test.ts` does about twenty seconds of genuine work —
 * seven conversions of a 57,511-room realm — which is more than the other
 * seventy-five files put together, and it set the wall-clock of every run.
 * `vitest.realm.config.ts` runs it; `npm run test:full` runs both, and the
 * pre-commit gate runs that.
 */
export default defineConfig({
  // The same aliases the app builds with, so renderer code can be unit-tested
  // rather than only exercised through the smoke run. `src/shared` is reached
  // as `@shared` everywhere outside the main process.
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.realm.test.ts']
  }
});
