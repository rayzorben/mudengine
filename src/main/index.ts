/**
 * Main process entry point: choose the host, then start the client on it.
 *
 * `MUDENGINE_WEB=1` serves the window over HTTP to a browser tab
 * (`host/WebHost.ts`); anything else is the desktop application
 * (`host/ElectronHost.ts`). The client itself — `client.ts` — is the same
 * either way and never learns which it got beyond what the `Host` answers.
 *
 * **The hosts are imported dynamically, and that is the whole reason this
 * file exists.** A static `import { app } from 'electron'` is resolved when
 * the module graph is linked, before a line runs: under plain Node the
 * `electron` package exports the path of a binary and has no `app`, so the
 * process dies during ESM preparse with an error about a missing export
 * (the failure `ELECTRON_RUN_AS_NODE` produces, recorded in CLAUDE.md). The
 * desktop host is therefore its own chunk, loaded only when it is wanted,
 * and a plain Node process asked for the desktop is told so in words rather
 * than in a linker's.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startClient } from './client';

/*
 * Where the built halves are, stated from the entry and handed to the host.
 *
 * Rollup puts the hosts in `out/main/chunks/`, so their own `import.meta.url`
 * is one directory deeper than `out/main/index.js` and `../renderer` from
 * there is nowhere. The entry is the one file whose place is fixed — it is
 * what `package.json` names and what `electron-vite dev` runs — so it is the
 * one that says where the preload, the renderer and the resources are.
 */
const outMain = path.dirname(fileURLToPath(import.meta.url));
const layout = {
  preload: path.join(outMain, '../preload/index.mjs'),
  rendererDir: path.join(outMain, '../renderer'),
  // `out/main` is two levels below the project root.
  resources: path.join(outMain, '../../resources')
};

const web = (process.env['MUDENGINE_WEB'] ?? '').trim() === '1';

if (!web && typeof process.versions['electron'] !== 'string') {
  console.error(
    'This is not running under Electron. Start it with the desktop client, or set MUDENGINE_WEB=1 to serve it over HTTP.'
  );
  process.exit(1);
}

const { host } = web
  ? await import('./host/WebHost').then((module) => ({ host: module.createWebHost(layout) }))
  : await import('./host/ElectronHost').then((module) => ({
      host: module.createElectronHost(layout)
    }));

startClient(host);
