import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The tests that convert a real Access database, kept out of the iteration
 * suite by `vitest.config.ts`'s `exclude` and run by `npm run test:realm`.
 *
 * They are not optional: the conversion path is what a character on a
 * derivative realm depends on, and a fixture would prove the caching and
 * nothing about the thing being cached. They are only too slow — about twenty
 * seconds of real work — to pay for after every edit.
 *
 * Written out rather than merged onto the base config: `mergeConfig`
 * concatenates arrays, so the base `exclude` survived the merge and this ran
 * the ordinary suite instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.realm.test.ts'],
    exclude: ['**/node_modules/**']
  }
});
