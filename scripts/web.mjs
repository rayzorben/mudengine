/**
 * Serve the built client over HTTP.
 *
 *   npm run build && npm run web
 *
 * The same thing the container does (`Dockerfile`): main as a Node server
 * with `MUDENGINE_WEB=1`, the renderer served as static files, the contract
 * over a WebSocket. Everything else is environment, and the client prints
 * where it is listening and how to sign in:
 *
 *   MUDENGINE_PORT      8080 unless set; 0 asks the system for a free one
 *   MUDENGINE_BIND      127.0.0.1 unless set; 0.0.0.0 to reach it from elsewhere
 *   MUDENGINE_PASSWORD  choose the password rather than have one generated
 *   MUDENGINE_HOME      where the files live; the platform's own place unless set
 *
 * A script rather than a `package.json` one-liner because `MUDENGINE_WEB=1
 * node …` is a shell idiom that a Windows shell does not have.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'out', 'main', 'index.js');

if (!fs.existsSync(entry) || !fs.existsSync(path.join(root, 'out', 'renderer', 'index.html'))) {
  console.error('The client is not built. Run `npm run build` first.');
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, MUDENGINE_WEB: '1' }
});

// A signal to this wrapper is a signal to the client, which runs its own
// clean teardown on it; the wrapper then leaves with whatever the client said.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
