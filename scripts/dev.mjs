/**
 * `npm run dev`, with Chromium's fontconfig complaints kept off the console.
 *
 *   npm run dev
 *
 * Electron statically links its **own** copy of fontconfig — the format
 * strings that produce these lines (`invalid attribute '%s'`, `invalid
 * constant used : %s`) are inside `electron/dist/electron` itself, not in the
 * system `libfontconfig.so.1` it also links. That bundled copy predates
 * fontconfig 2.17, which added the `genericfamily` object and the `xsi:nil`
 * attribute that a current system's `48-guessfamily.conf`, `48-spacing.conf`
 * and `49-sansserif.conf` are written in. So on any machine whose fontconfig
 * is newer than Chromium's, every launch prints ninety-odd warnings about
 * files the system's own `fc-match` parses in silence.
 *
 * Nothing in this project causes them and nothing in it can fix them: they are
 * a version skew between two libraries in the same process, and they will go
 * when Electron's bundled fontconfig catches up. The consequence is confined
 * to generic-family guessing, which this client does not rely on — the
 * terminal names its font explicitly.
 *
 * `scripts/smoke.mjs` and `scripts/live-check.mjs` already drop the same lines
 * from their own output; this puts `npm run dev` on the same footing. It is a
 * **display** filter and a narrow one: only the `Fontconfig warning: "<file>",
 * line <n>:` shape is dropped, so a fontconfig *error*, a font that will not
 * load, and every other word Electron says still reach the console.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/*
 * The CLI is read out of the package's own manifest rather than named here.
 * `electron-vite/bin/electron-vite.js` is not in its `exports` map, so it
 * cannot be resolved directly; `./package.json` is, and `bin` in it is the
 * same string npm used to make the shim in `node_modules/.bin`. Spawning that
 * shim instead would need a shell on Windows.
 */
const manifest = require.resolve('electron-vite/package.json');
const { bin } = require(manifest);
const cli = path.join(path.dirname(manifest), typeof bin === 'string' ? bin : bin['electron-vite']);

/**
 * Exactly the shape the bundled parser emits for a directive it does not know:
 * the file it was reading, the line it was on, and its complaint. A warning
 * fontconfig raises about anything else — a missing cache directory, a font
 * that will not load — does not have a `"<file>", line <n>:` in it and is not
 * matched, which is the point.
 */
const PARSE_WARNING = /^Fontconfig warning: "[^"]*", line \d+: /;

const child = spawn(
  process.execPath,
  [cli, 'dev', ...process.argv.slice(2)],
  // stdout and stdin stay attached to the real terminal so electron-vite keeps
  // its colours and anything it asks for still reaches it. Only stderr is
  // piped, because only stderr is being read.
  { stdio: ['inherit', 'inherit', 'pipe'] }
);

/*
 * Line-buffered, because a filter that tests whole chunks drops a real message
 * that happened to arrive in the same read as a warning.
 */
let pending = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  const lines = (pending + chunk).split('\n');
  // The last element is whatever came after the final newline: a partial line,
  // or '' if the chunk ended on one. Either way it is not ours to judge yet.
  pending = lines.pop() ?? '';
  for (const line of lines) if (!PARSE_WARNING.test(line)) process.stderr.write(`${line}\n`);
});
child.stderr.on('end', () => {
  if (pending && !PARSE_WARNING.test(pending)) process.stderr.write(pending);
  pending = '';
});

/*
 * Ctrl-C reaches the whole foreground process group, so electron-vite already
 * has the signal and tearing it down here would only race its own shutdown.
 * This handler exists to stop *node* exiting first and leaving the child
 * orphaned with the terminal back at a prompt.
 */
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});

child.on('exit', (code, signal) => {
  // Reproduce the child's fate rather than reporting it: a wrapper that turns
  // a signalled death into exit 0 makes `npm run dev` look like it succeeded.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (error) => {
  console.error(`dev: could not start electron-vite: ${error.message}`);
  process.exit(1);
});
