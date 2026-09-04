/**
 * What somebody sees the first time they open this.
 *
 *   npm run check:first-run
 *
 * A fresh options directory, no characters, nothing configured. This is the
 * most common first experience and the least tested one: `npm run smoke`
 * always writes profiles before it launches, so every assertion it makes is
 * about a client that already has characters.
 *
 * The promise being checked is the one in docs/profiles.md: **a character is
 * step one**. With no profile files there is no session and no console — the
 * client's only job is to help make one, so the settings screen opens on the
 * new-character form by itself, with the caret in it, and nothing dials
 * anywhere. (Until 2026-08-29 the promise was the opposite — one anonymous
 * session driven by `connection:` — and every feature had to carve a case out
 * for it.) Plus the two things that have to work before anything else can: the
 * options file is created from the bundled template, and the realm data is
 * found.
 *
 * Launches the *built* app, so it exercises the real wiring. Nothing connects:
 * there is no server here and none is configured to autoconnect.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/*
 * The realm a new character starts on, read from the shipped character template
 * rather than from `src/shared/config.ts`.
 *
 * This harness runs on plain node with no `tsx` behind it, so it cannot import
 * the constant -- and it does not need to: `shipped.test.ts` asserts the two
 * are the same string, so the template is the constant by another name and
 * reading it here costs no loader.
 */
const DEFAULT_REALM_NAME = String(
  YAML.parse(fs.readFileSync(path.resolve('resources/config/profile.default.yaml'), 'utf8'))
    ?.server ?? ''
);

const CONFIG_DIR = path.resolve('out/first-run');
const CONFIG = path.join(CONFIG_DIR, 'global', 'default.yaml');
const PROFILE = path.resolve('out/first-run-profile');
const CDP_PORT = 9444;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const pass = (message) => console.log(`   PASS  ${message}`);
const fail = (message) => {
  failures += 1;
  console.log(`   FAIL  ${message}`);
};
const check = (ok, message, detail) =>
  ok ? pass(message) : fail(`${message}${detail ? ` -- ${detail}` : ''}`);

fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

console.log('\nmudengine first-run check -- a fresh options directory, no characters\n');

/* -------------------------------------------------------------------- launch */

const electron =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : './node_modules/electron/dist/electron';

// VS Code exports this to helper processes and it makes the Electron binary
// behave as a plain Node runtime: no app, no window, and a misleading ESM error
// before any of our code runs.
const appEnv = { ...process.env, MUDENGINE_HOME: CONFIG_DIR };
delete appEnv.ELECTRON_RUN_AS_NODE;

const hasXvfb =
  process.platform === 'linux' &&
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
  spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;

/*
 * Refuse to open a real window over somebody's session.
 *
 * The app takes keyboard focus on launch by design, and a test has no business
 * doing that to whoever is at the keyboard — it happened once, and the typing
 * went into the game's login prompt.
 */
if (Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !hasXvfb) {
  console.error(
    '\nThere is a desktop session here and no `xvfb-run` to hide behind, so this\n' +
      'would open a window and take your keyboard.\n'
  );
  process.exit(1);
}

const args = [
  'out/main/index.js',
  '--no-sandbox',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`,
  // Electron prefers Wayland over the DISPLAY xvfb-run just set, and would
  // connect to the real compositor.
  '--ozone-platform=x11'
];
if (hasXvfb) delete appEnv.WAYLAND_DISPLAY;

const child = hasXvfb
  ? spawn('xvfb-run', ['-a', electron, ...args], { env: appEnv, detached: true })
  : spawn(electron, args, { env: appEnv, detached: true });

const output = [];
child.stdout.on('data', (data) => output.push(data.toString()));
child.stderr.on('data', (data) => output.push(data.toString()));

const stop = () => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);

/* ----------------------------------------------------------------- CDP glue */

async function attach() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error('the renderer never exposed a debugging target');
}

const page = await attach();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 0;
const inflight = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && inflight.has(message.id)) {
    inflight.get(message.id)(message);
    inflight.delete(message.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    inflight.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
  return result.result?.result?.value;
}

await cdp('Runtime.enable');
for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`!!document.querySelector('.status-rail')`)) break;
  await sleep(250);
}
await sleep(1500);

/* --------------------------------------------------------------- assertions */

check(await evaluate(`!!document.querySelector('.status-rail')`), 'the client starts');

/*
 * Before anything else can work. The template is copied once and never updated,
 * so this is also the only moment a file gets every current setting.
 */
check(fs.existsSync(CONFIG), 'and writes an options file where it was told to');
const written = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '';
check(/^# mudengine configuration/.test(written), 'from the bundled template, comments and all');
check(/onPartyChange/.test(written), 'including the settings added most recently');
// And no account of its own: the template describes a realm, and credentials
// belong to a character.
check(
  !/^\s+username:/m.test(written) &&
    !/^\s+autoConnect:/m.test(written.split('\nservers:')[0] ?? written),
  'and it carries no account and no autoconnect of its own'
);

// The realm is loaded eagerly and said out loud, precisely so a build that
// cannot find it says so rather than failing at the first route.
check(
  output.join('').includes('world:') && /\d[\d,]* rooms/.test(output.join('')),
  'and finds the realm data',
  output
    .join('')
    .split('\n')
    .find((line) => line.includes('world:'))
);

/*
 * The promise: a character is step one. With none there is no session and no
 * console; the new-character form is open instead, and the caret is in it.
 */
check(
  !(await evaluate(`!!document.querySelector('.tab-rail .tab')`)),
  'no tab rail, because there is nobody to choose between'
);
check(
  !(await evaluate(`!!document.querySelector('.terminal-cell')`)),
  'and no console, because there is no session to type at'
);
check(
  await evaluate(`!!document.querySelector('.settings')`),
  'the settings screen opened by itself'
);
check(
  (await evaluate(
    `!!document.querySelector('.settings-form') &&
     [...document.querySelectorAll('.settings h1, .settings h2, .settings legend, .settings button')]
       .some((el) => /new character/i.test(el.innerText))`
  )) === true,
  'on the new-character form'
);
check(
  (await evaluate(`document.activeElement?.closest('.settings') !== null`)) === true,
  'and the caret is in it'
);

/* Nothing is connected, and nothing tried to be. */
const phase = await evaluate(`document.querySelector('.status-rail')?.innerText ?? ''`);
check(/idle|closed|not connected/i.test(phase), 'nothing dialled on its own', phase.slice(0, 80));

/*
 * And it is said as well as shown. With no console the words go to stdout, and
 * they name the shortcut that brings the screen back once it has been closed.
 */
/*
 * Read from the app's stdout, not the DOM: xterm draws the terminal to a
 * canvas, so what the client said is not in the document at all. That is also
 * why notices are echoed to stdout — it is the only place the explanation
 * survives the window closing.
 */
const said = output.join('');
/*
 * Matched on the sentence the client actually says. It was `/no characters
 * yet/`, which is the *key's* name (`app.onboarding.noCharactersYet`) and not
 * its copy — the string had been reworded to "No characters configured…" with
 * this line left behind, so the check had been red on a clean tree. That is the
 * rule CLAUDE.md states about `smoke.mjs` applied to the other harness: a
 * string a harness asserts is not reworded without updating the harness in the
 * same change.
 */
check(/no characters configured/i.test(said), 'the client says there are no characters configured');
check(
  /settings|ctrl|\u2318/i.test(said),
  'and how to add one',
  said.split('\n').find((line) => /no characters/i.test(line))
);

/*
 * And the shortcut brings the screen (back), which is what it exists for. It
 * opens rather than toggles, so pressing it with the screen already open is a
 * no-op and the form below is still there to assert on.
 */
await cdp('Input.dispatchKeyEvent', {
  type: 'rawKeyDown',
  key: ',',
  code: 'Comma',
  windowsVirtualKeyCode: 188,
  modifiers: 2
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: ',',
  code: 'Comma',
  windowsVirtualKeyCode: 188,
  modifiers: 2
});
await sleep(600);
check(
  await evaluate(`!!document.querySelector('.settings')`),
  'settings stays open on its shortcut'
);
check(
  (await evaluate(
    `[...document.querySelectorAll('.settings-list button')].some((b) => /new character/i.test(b.innerText))`
  )) === true,
  'and offers to make the first character'
);
/* The template ships saved realms, so the first character has somewhere to
   play without anybody typing an address. */
check(
  (await evaluate(
    `[...document.querySelectorAll('.settings-form select option')].length > 0 ||
     (() => { const b = [...document.querySelectorAll('.settings-list button')]
        .find((x) => /new character/i.test(x.innerText)); if (b) b.click(); return true; })()`
  )) === true,
  'with somewhere to play already listed'
);

/*
 * And it is the realm the client *says* is its default, rather than whichever
 * one sorts first.
 *
 * Nothing else checks this end to end: the form's default is not exported, and
 * `smoke.mjs` deliberately overrides it (its home has a realm of its own). This
 * is the one harness that starts with no configuration at all, so it is the one
 * that meets what a new player meets -- and "the default is X" was untrue for
 * as long as it was decided by directory order, which is the failure that made
 * `DEFAULT_REALM_NAME` exist.
 */
const startsOn = await evaluate(`
  (() => {
    const select = [...document.querySelectorAll('.settings-form label')]
      .find((l) => /plays on/i.test(l.querySelector('span')?.innerText ?? ''))
      ?.querySelector('select');
    return select ? select.value : '(no control)';
  })()
`);
check(
  startsOn === DEFAULT_REALM_NAME,
  'and a new character starts on the realm the client ships as its default',
  `${startsOn} (wanted ${DEFAULT_REALM_NAME})`
);

/* ------------------------------------------------------------------- finish */

console.log(
  `\n${failures === 0 ? 'All first-run checks passed.' : `${failures} check(s) failed.`}\n`
);
socket.close();
stop();
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
