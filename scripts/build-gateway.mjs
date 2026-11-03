/**
 * Bundles the peer gateway (`src/gateway/main.ts`) into one file,
 * `out/gateway/main.mjs`, for `deploy/gateway/Dockerfile`. The gateway takes
 * nothing from npm, so the image carries Node and this file only. esbuild is
 * the one the build already has through Vite; it does not typecheck, so
 * `npm run typecheck:gateway` runs first.
 *
 *   npm run build:gateway
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'out', 'gateway', 'main.mjs');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const typecheck = spawnSync(npm, ['run', 'typecheck:gateway'], { cwd: ROOT, stdio: 'inherit' });
if (typecheck.status !== 0) {
  console.error('build-gateway: the typecheck failed; nothing was built');
  process.exit(typecheck.status ?? 1);
}

/** Node's own modules stay imports; anything from npm fails the build, as the structure test refuses it. */
const nodeOnly = {
  name: 'node-only',
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith('node:')
        ? { path: args.path, external: true }
        : { errors: [{ text: `${args.path} is from npm, and the gateway takes nothing from npm` }] }
    );
  }
};

await build({
  entryPoints: [path.join(ROOT, 'src', 'gateway', 'main.ts')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  plugins: [nodeOnly],
  // Whitespace only, for the reason `electron.vite.config.ts` gives: the comments are the documentation and do not ship.
  minifyWhitespace: true,
  logLevel: 'info'
});
console.log(`build-gateway: wrote ${path.relative(ROOT, OUT)}`);
