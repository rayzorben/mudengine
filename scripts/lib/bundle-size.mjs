/**
 * The size check for one build (main, preload or the window), run here
 * because Vite skips it for an SSR build.
 *
 * Vite's own chunk warning only runs when `build.ssr` is off, and electron-vite
 * builds main and preload as SSR bundles, so their limits never printed (todo
 * 150: main grew 887 kB to 2,400 kB unseen). This plugin checks every target
 * the same way and turns Vite's check off so nothing is said twice. Over the
 * limit it names the largest modules, which is the first thing to read. A
 * plain build warns; the gate sets `SIZE_LIMIT_FAILS` and the build fails.
 * Reasoning: `mudengine-verify` › *Each build has a size limit*.
 */

/** The variable `scripts/gate.mjs` sets so a build over its limit fails. */
export const SIZE_LIMIT_FAILS = 'MUDENGINE_SIZE_LIMIT_FAILS';

/** How many modules an over-limit report names. */
const NAMED = 10;

const kB = (bytes) => `${(bytes / 1000).toFixed(0)} kB`;

/** The plugin for one target, `limitKb` measured as Vite prints sizes. */
export function bundleSizePlugin(target, limitKb) {
  return {
    name: 'mudengine-bundle-size',
    config: () => ({ build: { chunkSizeWarningLimit: Number.POSITIVE_INFINITY } }),
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
      const total = chunks.reduce((sum, c) => sum + Buffer.byteLength(c.code), 0);
      if (total <= limitKb * 1000) return;
      const largest = chunks
        .flatMap((c) => Object.entries(c.modules).map(([id, m]) => [id, m.renderedLength]))
        .sort((a, b) => b[1] - a[1])
        .slice(0, NAMED)
        .map(([id, n]) => `  ${kB(n).padStart(7)}  ${id.replace(process.cwd() + '/', '')}`);
      const message =
        `${target} is ${kB(total)} of JavaScript, over its ${limitKb} kB limit ` +
        `(CHUNK_LIMIT_KB, electron.vite.config.ts). Largest modules, before minifying:\n` +
        largest.join('\n');
      if (process.env[SIZE_LIMIT_FAILS] === '1') this.error(message);
      else this.warn(message);
    }
  };
}
