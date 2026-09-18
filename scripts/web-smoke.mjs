/**
 * Web mode, end to end.
 *
 *   npm run smoke:web            against a fake host, like `npm run smoke`
 *   npm run check:live:web       against orohost:2427 with a real character
 *
 * `npm run smoke` proves the desktop client over Electron's IPC. This proves
 * the same client served over HTTP (`MUDENGINE_WEB=1`): main as a Node
 * server, the renderer as static files, the contract on a WebSocket. A mode
 * with no smoke coverage is a mode that breaks silently, and per CLAUDE.md
 * smoke is chosen by path — this one touches every trigger there is.
 *
 * The browser is Electron's own Chromium with **no preload**
 * (`scripts/lib/browser.mjs`), which is exactly what a browser tab is: the
 * page gets `window.mudengine` from nowhere and installs the web bridge. So
 * everything below is proved in a real browser — the sign-in form, the
 * cookie, the socket opening under the served CSP, the console typing to the
 * host — rather than reasoned about. Two tabs, because a second one is what
 * proves every tab draws the one rail.
 *
 * The four rules every harness here keeps (`mudengine-verify`): nothing is
 * done for the client that the client should do (it signs itself in through
 * its own form, connects itself, quits on the signal it handles); the server
 * is asked to end and its teardown line is read, never killed; every check is
 * on an effect and never on a token; and the fake host answers like a server.
 *
 * `--live` swaps the fake host for the sanctioned realm, with a character
 * chosen by *target* through `scripts/lib/local-realm.mjs` — the one place
 * that says where credentials may go. It skips, with the exit code that
 * means skipped, when no such character is configured.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { localProfile, skip } from './lib/local-realm.mjs';
import { homePaths } from './lib/home.mjs';
import { judgeFailures } from './lib/smoke-baseline.mjs';

const IAC = 255,
  WILL = 251,
  WONT = 252,
  DO = 253,
  DONT = 254,
  SB = 250,
  SE = 240,
  GA = 249;
const OPT_ECHO = 1,
  OPT_SGA = 3,
  OPT_TTYPE = 24,
  OPT_NAWS = 31;

const CDP_PORT = 9555;
const HOME = path.resolve('out/web-smoke-home');
const BROWSER_PROFILE = path.resolve('out/web-smoke-browser');
const LOG_DIR = path.resolve('out/web-smoke-logs');
const live = process.argv.includes('--live');
const keepOpen = process.argv.includes('--keep-open');

/** The character this run drives: the fixture's, or the sanctioned realm's. */
let SESSION = 'web';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
/** Each failed check by name, which is what the baseline compares. */
const failedNames = [];
const pass = (message) => console.log(`   PASS  ${message}`);
const fail = (message, detail) => {
  failures += 1;
  failedNames.push(message);
  console.log(`   FAIL  ${message}${detail ? ` -- ${detail}` : ''}`);
};
const check = (ok, message, detail) => (ok ? pass(message) : fail(message, detail));

/**
 * A socket's bytes with the Telnet negotiation taken out.
 *
 * The fake host asks for NAWS, so the client reports its size whenever the
 * console is re-measured — and the cards drawing beside it re-measure it. A
 * report landing between two keystrokes is ordinary traffic, and a check
 * that read the raw bytes saw `l`, then IAC SB NAWS … IAC SE, then `ook` and
 * called the keystrokes lost (2026-09-07). The effect under test is the
 * command reaching the host, which is what the host would read once its own
 * negotiation is parsed off.
 */
function withoutTelnet(buffer) {
  const out = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (byte !== IAC) {
      out.push(byte);
      continue;
    }
    const next = buffer[i + 1];
    if (next === IAC) {
      out.push(IAC);
      i += 1;
    } else if (next === SB) {
      // To IAC SE, whole; an unterminated one runs to the end.
      let j = i + 2;
      while (j < buffer.length && !(buffer[j] === IAC && buffer[j + 1] === SE)) j += 1;
      i = j + 1;
    } else if (next === WILL || next === WONT || next === DO || next === DONT) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return Buffer.from(out);
}

/** Poll until `probe` answers truthily, or give up. */
async function waitFor(probe, tries = 60, every = 250) {
  for (let i = 0; i < tries; i += 1) {
    let value = null;
    try {
      value = await probe();
    } catch {
      value = null;
    }
    if (value) return value;
    await sleep(every);
  }
  return null;
}

// -------------------------------------------------------------- fake host

const received = [];
let hostPort = 0;
let fakeHost = null;

if (!live) {
  /*
   * The opening volley and one full room, the stat sheet that carries the
   * maxima, and the in-place status repaint — the decode paths the wire has
   * to get right, in the shape `scripts/smoke.mjs` proved them in. `rm` is
   * answered as the realm answers it so the entry probe's quiet window has a
   * real acknowledgement to close on.
   */
  fakeHost = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.write(
      Buffer.from([IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO, IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS])
    );
    setTimeout(() => socket.write(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE])), 30);
    setTimeout(() => {
      socket.write(
        Buffer.concat([
          Buffer.from('\x1b[1;36mNewhaven, Village Entrance\x1b[0m\r\n', 'latin1'),
          Buffer.from('    A dusty path leads away from the gates.\r\n', 'latin1'),
          Buffer.from('Name:   Rayzor              Lives/CP: 3/12\r\n', 'latin1'),
          Buffer.from('Race:   Human      Exp:      1500   Perception:  20\r\n', 'latin1'),
          Buffer.from('Class:  Warrior    Level:    4      Stealth:     10\r\n', 'latin1'),
          Buffer.from('Hits:   98/400     Armour Class: 12/3   Thievery:    5\r\n', 'latin1'),
          Buffer.from('Mana:   50/120     Spellcasting: 12     Traps:       3\r\n', 'latin1'),
          Buffer.from(
            '\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0;32m, \x1b[1;33msouth\x1b[0m\r\n',
            'latin1'
          ),
          Buffer.from('\x1b[1;32m[HP=98/MA=50]:\x1b[0m\x1b[79D\x1b[K', 'latin1'),
          Buffer.from([IAC, GA])
        ])
      );
    }, 120);
    socket.on('data', (chunk) => {
      received.push(chunk);
      if (/(^|\n)rm\r?\n/.test(chunk.toString('latin1'))) {
        socket.write(
          Buffer.from(
            'rm\r\nLocation: 1,2140\r\n\r\n\x1b[1;32m[HP=98/MA=50]:\x1b[0m\x1b[79D\x1b[K',
            'latin1'
          )
        );
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => fakeHost.listen(0, '127.0.0.1', resolve));
  hostPort = fakeHost.address().port;
}

// ------------------------------------------------------------------- home

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(BROWSER_PROFILE, { recursive: true, force: true });
fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'global'), { recursive: true });

if (live) {
  /*
   * A real character, chosen by target and never by name, copied into a home
   * of this run's own along with the realms it names. The copy carries the
   * password and is deleted on the way out, whatever happened.
   */
  const profile = localProfile();
  if (profile === null) skip('no character on the sanctioned realm has credentials configured');
  SESSION = profile.id;
  const theirs = homePaths();
  fs.copyFileSync(theirs.options, path.join(HOME, 'global', 'default.yaml'));
  fs.cpSync(theirs.serversDir, path.join(HOME, 'servers'), { recursive: true });
  fs.cpSync(theirs.profile(profile.id).dir, path.join(HOME, 'profiles', profile.id), {
    recursive: true
  });
  console.log(`\nmudengine web check -- ${SESSION} on the sanctioned realm\n`);
} else {
  fs.writeFileSync(
    path.join(HOME, 'global', 'default.yaml'),
    [
      'connection:',
      '  host: 127.0.0.1',
      '  port: 1',
      '  encoding: cp437',
      'ui:',
      '  tabs: top',
      '  theme: dark',
      'logging:',
      '  enabled: true',
      `  directory: '${LOG_DIR}'`,
      ''
    ].join('\n'),
    'utf8'
  );
  fs.mkdirSync(path.join(HOME, 'servers', 'web-realm'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, 'servers', 'web-realm', 'server.yaml'),
    ['name: Web Realm', 'host: 127.0.0.1', `port: ${hostPort}`, 'encoding: cp437', ''].join('\n'),
    'utf8'
  );
  fs.mkdirSync(path.join(HOME, 'profiles', SESSION), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, 'profiles', SESSION, 'profile.yaml'),
    ['name: Web Character', 'server: Web Realm', 'autoConnect: false', 'accent: amber', ''].join(
      '\n'
    ),
    'utf8'
  );
  console.log(`\nmudengine web smoke -- fake host on 127.0.0.1:${hostPort}\n`);
}

// ----------------------------------------------------------------- server

/**
 * The client, as the container runs it: a Node process with `MUDENGINE_WEB`
 * and a home of its own. No password in the environment, so this start is
 * the one that generates and prints it — which the checks below need.
 */
const serverEnv = {
  ...process.env,
  MUDENGINE_WEB: '1',
  MUDENGINE_HOME: HOME,
  MUDENGINE_PORT: '0',
  MUDENGINE_BIND: '127.0.0.1'
};
delete serverEnv.MUDENGINE_PASSWORD;
delete serverEnv.MUDENGINE_CONFIG;

let serverOut = '';
function startServer() {
  const child = spawn(process.execPath, ['out/main/index.js'], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => {
    serverOut += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) process.stderr.write(`   [server] ${text}\n`);
    serverOut += chunk.toString();
  });
  return child;
}

let server = startServer();
const serverExit = () =>
  new Promise((resolve) => {
    server.once('exit', (code, signal) => resolve({ code, signal }));
  });

const address = await waitFor(() => {
  const match = /Open:\s+http:\/\/localhost:(\d+)\//.exec(serverOut);
  return match ? Number(match[1]) : null;
}, 120);
if (address === null) {
  console.error('\nThe web host never said where it was listening:\n');
  console.error(serverOut);
  process.exit(1);
}
const PORT = address;
const BASE = `http://127.0.0.1:${PORT}`;
const password = /Sign in with the password\n\s+(\S+)\n/.exec(serverOut)?.[1] ?? '';

// --------------------------------------------------------------- cleanup

let browser = null;
const stopBrowser = () => {
  if (browser === null) return;
  try {
    process.kill(-browser.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  browser = null;
};
const stopServer = () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
const cleanup = () => {
  if (!keepOpen) {
    stopBrowser();
    stopServer();
  }
  fakeHost?.close();
  // The live copy carries a real password and exists only for the length of
  // this run. The fixture home is nobody's, but a check that leaks nothing is
  // one that removes both.
  if (live) fs.rmSync(HOME, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

// ------------------------------------------------------ assert: the gate

check(password.length >= 24, 'the first start prints a generated password', password);
const passwordFile = path.join(HOME, '.access-password');
check(
  fs.existsSync(passwordFile) && fs.readFileSync(passwordFile, 'utf8') === password,
  'and saves it beside the options file'
);
if (process.platform !== 'win32') {
  check((fs.statSync(passwordFile).mode & 0o777) === 0o600, 'readable by nobody else');
}
check(/NOT encrypted/.test(serverOut), 'the banner says the link is cleartext');

{
  const page = await fetch(`${BASE}/`, { redirect: 'manual' });
  const body = await page.text();
  check(
    page.status === 401 && /name="password"/.test(body) && !/<script/.test(body),
    'without a session the page is the sign-in form and nothing of the client',
    `${page.status}`
  );
  const wrong = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=not-it',
    redirect: 'manual'
  });
  check(wrong.status === 401, 'a wrong password is refused', `${wrong.status}`);
  check(/refused a sign-in/.test(serverOut), 'and said out loud');

  const socket = net.connect(PORT, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      'GET /ws HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n')
  );
  const status = await new Promise((resolve) =>
    socket.once('data', (chunk) => resolve(chunk.toString('latin1').split('\r\n')[0]))
  );
  socket.destroy();
  check(
    status === 'HTTP/1.1 401 Unauthorized',
    'the socket is refused on the upgrade without a session',
    status
  );
}

// ---------------------------------------------------------------- browser

const electron =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : './node_modules/electron/dist/electron';

const browserEnv = {
  ...process.env,
  MUDENGINE_BROWSE_URL: `${BASE}/`,
  MUDENGINE_BROWSE_TABS: '2'
};
// VS Code exports this to helper processes and it makes the Electron binary
// behave as a plain Node runtime: no app, no window. See CLAUDE.md.
delete browserEnv.ELECTRON_RUN_AS_NODE;

const hasSession = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const hasXvfb =
  process.platform === 'linux' &&
  hasSession &&
  spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
const wantsWindow = process.argv.includes('--windowed');
if (hasSession && !hasXvfb && !wantsWindow) {
  console.error(
    '\nThere is a desktop session here and no `xvfb-run` to hide behind, so this\n' +
      'would open a window and take your keyboard. Install xvfb, or pass --windowed\n' +
      'if you meant to watch it.\n'
  );
  process.exit(1);
}
if (hasXvfb) delete browserEnv.WAYLAND_DISPLAY;

const browserArgs = [
  'scripts/lib/browser.mjs',
  '--no-sandbox',
  `--user-data-dir=${BROWSER_PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`
];
browser = hasXvfb
  ? spawn('xvfb-run', ['-a', electron, '--ozone-platform=x11', ...browserArgs], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: browserEnv,
      detached: true
    })
  : spawn(electron, browserArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: browserEnv,
      detached: true
    });
const NOISE =
  /Fontconfig|wayland|GPU|dbus|Vulkan|MESA|gbm|EGL|invalid |DevTools|Failed to shutdown|swiftshader|WebGL/i;
browser.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text && !NOISE.test(text)) process.stderr.write(`   [browser] ${text}\n`);
});

// -------------------------------------------------------------------- CDP

async function pages(count) {
  return waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const found = list.filter((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
    return found.length >= count ? found : null;
  }, 80);
}

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const inflight = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      fail(`renderer exception: ${message.params.exceptionDetails?.text ?? 'unknown'}`);
    }
    if (message.id && inflight.has(message.id)) {
      inflight.get(message.id)(message);
      inflight.delete(message.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      inflight.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
    return result.result?.result?.value;
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const key = async (type, key, code, vk, extra = {}) =>
    cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...extra });
  const press = async (key_, code, vk, modifiers = 0) => {
    await key('rawKeyDown', key_, code, vk, { modifiers });
    await key('keyUp', key_, code, vk, { modifiers });
  };
  return { ws, cdp, evaluate, key, press };
}

const targets = await pages(2);
if (targets === null) {
  fail('the browser never exposed two page targets');
  process.exit(1);
}
const first = await attach(targets[0]);
const second = await attach(targets[1]);

// ------------------------------------------------------ assert: sign in

check(
  (await waitFor(() => first.evaluate(`!!document.querySelector('input[name="password"]')`))) ===
    true,
  'the browser is shown the sign-in form'
);
await first.evaluate(`(document.querySelector('input[name="password"]').focus(), true)`);
await first.cdp('Input.insertText', { text: password });
await first.key('keyDown', 'Enter', 'Enter', 13, { text: '\r' });
await first.key('keyUp', 'Enter', 'Enter', 13);

check(
  (await waitFor(() => first.evaluate(`!!document.querySelector('.status-rail')`), 80)) === true,
  'signing in through the form draws the client'
);
check(
  (await first.evaluate(`window.mudengine && window.mudengine.host`)) === 'web',
  'the window installed the web bridge'
);

/*
 * The socket, under the served CSP. `listSessions` is an invoke, so an
 * answer means the WebSocket opened in this Chromium under the policy the
 * server wrote — the thing the todo said to verify in a browser rather than
 * assume about `'self'`.
 */
const roster = await waitFor(
  () =>
    first
      .evaluate(`window.mudengine.listSessions()`)
      .then((list) => (list.length > 0 ? list : null)),
  40
);
check(
  Array.isArray(roster) && roster.some((entry) => entry.id === SESSION),
  'the socket opened under the served CSP and answered with the roster',
  JSON.stringify(roster?.map((entry) => entry.id))
);
check(
  (
    await first.evaluate(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`
    )
  ).includes(`connect-src 'self' ws://127.0.0.1:${PORT}`),
  'and the policy names this host'
);

// ------------------------------------------------- assert: what is withheld

const popOut = await first.evaluate(`window.mudengine.popOut(${JSON.stringify(SESSION)})`);
check(
  typeof popOut === 'string' && popOut.length > 0,
  'popping out is refused with a reason',
  popOut
);
await first.press('k', 'KeyK', 75, 2);
// The palette takes the keyboard when it mounts; type once it has, never a
// timer later, and read the rows once the search has drawn one.
await waitFor(() => first.evaluate(`!!document.activeElement?.closest('.palette')`));
await first.evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'character');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
/*
 * By command id, never by the words on the row — a reworded label must not
 * turn this into a vacuous pass. And with a positive control: the rows the
 * search *should* find are asserted present first, so a palette that failed
 * to render at all cannot satisfy "nothing offered".
 */
const offered = await waitFor(() =>
  first
    .evaluate(
      `[...document.querySelectorAll('.palette li[data-command]')].map((li) => li.dataset.command)`
    )
    .then((ids) => (Array.isArray(ids) && ids.includes('settings') ? ids : null))
);
check(
  Array.isArray(offered) && offered.includes('close') && offered.includes('settings'),
  'the palette lists the character commands',
  JSON.stringify(offered)
);
check(
  Array.isArray(offered) && !offered.some((id) => ['popout', 'popin', 'gather'].includes(id)),
  'and does not offer a second window',
  JSON.stringify(offered)
);
await first.press('Escape', 'Escape', 27);
await waitFor(() => first.evaluate(`!document.querySelector('.palette')`));

// ----------------------------------------------------- assert: the reveal

await first.press('k', 'KeyK', 75, 2);
await waitFor(() => first.evaluate(`!!document.activeElement?.closest('.palette')`));
await first.evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'options file');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
// Enter takes the highlighted row, so the search has to have drawn it first.
await waitFor(() =>
  first.evaluate(`!!document.querySelector('.palette li[data-command][data-active="true"]')`)
);
await first.press('Enter', 'Enter', 13);
check(
  (await waitFor(() => first.evaluate(`!!document.querySelector('.home-browser')`))) === true,
  'showing the options file lists it in the window, since there is no file manager here'
);
const shownPath = await first.evaluate(
  `document.querySelector('.home-browser-path')?.innerText ?? ''`
);
check(
  shownPath.includes(fs.realpathSync(path.join(HOME, 'global'))),
  'at its own directory',
  shownPath
);
check(
  (await waitFor(() =>
    first.evaluate(
      `document.querySelector('.home-browser li[data-selected="true"] .home-browser-name')?.innerText ?? ''`
    )
  )) === 'default.yaml',
  'with the file marked'
);
/*
 * The dialog takes the keyboard in an effect after it mounts — the picker's
 * race below, in the same dialog opened another way. An Escape sent before
 * that lands on the body, the browser stays, and every check about the
 * picker after it finds *this* dialog instead (2026-09-07: two runs in three).
 * Wait for the keyboard, then for the effect, never for a timer.
 */
check(
  (await waitFor(() => first.evaluate(`!!document.activeElement?.closest('.home-browser')`))) ===
    true,
  'which holds the keyboard'
);
await first.press('Escape', 'Escape', 27);
check(
  (await waitFor(() => first.evaluate(`!document.querySelector('.home-browser')`))) === true,
  'and Escape puts it away'
);
const outside = await first.evaluate(`window.mudengine.browseHome('/')`);
check(
  outside.error !== null && outside.entries.length === 0,
  'a path outside the home is refused with a reason',
  outside.error
);

/*
 * The picker, asked for from inside the settings screen — which is where the
 * realm form's Browse button asks for it — draws in front of that screen.
 * Measured by hit-testing the dialog's centre rather than by reading a
 * z-index: what matters is which surface a click there lands on. It shipped
 * behind the screen that asked for it once (2026-09-07).
 */
await first.press(',', 'Comma', 188, 2);
check(
  (await waitFor(() => first.evaluate(`!!document.querySelector('.settings')`))) === true,
  'the settings screen opens'
);
// The state a person is in when they click Browse: the screen has loaded and
// put the caret in its first field. Asking for the picker before that races
// the field's own focus, which a hand on a mouse never does.
check(
  (await waitFor(() => first.evaluate(`!!document.activeElement?.closest('.settings')`))) === true,
  'and takes the keyboard'
);
await first.evaluate(
  `(window.__picked = undefined, window.mudengine.chooseRealm().then((file) => { window.__picked = { file }; }), true)`
);
check(
  (await waitFor(() => first.evaluate(`!!document.querySelector('.home-browser')`))) === true,
  'and asking it for a realm database opens the picker'
);
const frontmost = await first.evaluate(`
  (() => {
    const box = document.querySelector('.home-browser').getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit ? (hit.closest('.home-browser') ? 'picker' : hit.closest('.settings') ? 'settings' : hit.className) : 'nothing';
  })()
`);
check(frontmost === 'picker', 'in front of the settings screen', String(frontmost));
/*
 * The dialog takes the keyboard in an effect after it mounts, so a key sent
 * the instant it is in the DOM lands on the screen behind it and the answer
 * never comes (2026-09-07: this passed, hung or failed by the clock). Wait
 * for the focus, then for the effect of the key, never for a timer.
 */
check(
  (await waitFor(() => first.evaluate(`!!document.activeElement?.closest('.home-browser')`))) ===
    true,
  'and holds the keyboard'
);
await first.press('Escape', 'Escape', 27);
const answer = await waitFor(() =>
  first.evaluate(`window.__picked ? JSON.stringify(window.__picked) : null`)
);
check(
  answer === '{"file":null}' &&
    (await waitFor(() => first.evaluate(`!document.querySelector('.home-browser')`))) === true,
  'Escape dismisses the picker and answers nothing',
  String(answer)
);
check(
  (await first.evaluate(`!!document.querySelector('.settings')`)) === true,
  'and leaves the settings screen it was opened from'
);
// The hand-back lands a frame after the picker is gone; a key sent before it
// lands on the body and does nothing, which is a race a hand never wins.
check(
  (await waitFor(() => first.evaluate(`!!document.activeElement?.closest('.settings')`))) === true,
  'with the caret handed back to it'
);
await first.press('Escape', 'Escape', 27);
check(
  (await waitFor(() => first.evaluate(`!document.querySelector('.settings')`))) === true,
  'which its own Escape then closes'
);

// --------------------------------------------------- assert: the second tab

await second.cdp('Page.reload');
check(
  (await waitFor(() => second.evaluate(`!!document.querySelector('.status-rail')`), 80)) === true,
  'a second tab, reloaded, is signed in by the same cookie'
);
const secondRoster = await second.evaluate(`window.mudengine.listSessions()`);
check(
  JSON.stringify(secondRoster.map((entry) => entry.id)) ===
    JSON.stringify(roster.map((entry) => entry.id)),
  'and draws the one rail every tab draws'
);

// ------------------------------------------------------- assert: the game

/*
 * Connect through the chord the desktop uses, so the hotkey table is proved
 * in a tab too. In the fixture the stat sheet arrives with the banner; on the
 * live realm the client has to log itself in first, which is what the longer
 * wait is for.
 */
await first.evaluate(`(document.querySelector('.xterm-helper-textarea')?.focus(), true)`);
/*
 * Only when nothing is dialling already. A real character may say
 * `autoConnect: true` in its own file, and the chord *toggles* — pressing it
 * on a character the client is already logging in would hang up on it.
 */
const phaseBefore = (await first.evaluate(`window.mudengine.getState(${JSON.stringify(SESSION)})`))
  ?.phase;
if (phaseBefore === 'idle' || phaseBefore === 'closed' || phaseBefore === 'error') {
  await first.press('Enter', 'Enter', 13, 2);
}
const vitals = await waitFor(
  () =>
    first
      .evaluate(`window.mudengine.getCharacter(${JSON.stringify(SESSION)})`)
      .then((character) =>
        character?.vitals?.hp !== null && character?.vitals?.hpMax !== null
          ? character.vitals
          : null
      ),
  live ? 240 : 80,
  500
);
check(
  vitals !== null && (live || (vitals.hp === 98 && vitals.hpMax === 400)),
  live
    ? 'the client logged itself in and a real stat sheet reached the tab'
    : 'the status line and the stat sheet reached the tab',
  JSON.stringify(vitals)
);
const state = await first.evaluate(`window.mudengine.getState(${JSON.stringify(SESSION)})`);
check(state?.phase === 'connected', 'the session is connected', state?.phase);
check(
  (await waitFor(() =>
    first.evaluate(`/\\d+\\s*\\/\\s*\\d+/.test(document.querySelector('.rail')?.innerText ?? '')`)
  )) === true,
  'and the cards draw the figures'
);

if (!live) {
  /*
   * A command typed at the console, key by key, and read off the fake host's
   * socket: the effect, not the token. `web-look` is not a realm word, which
   * is fine for a fixture that answers nothing but `rm`.
   *
   * **The console must hold the keyboard first**, waited for and not
   * assumed: the caret was put there before the dial, and the client's rule
   * is that it settles back there — but the chord, the connect notice and the
   * cards drawing all land between that press and this one, and a key sent a
   * frame before the hand-back lands on the body and does nothing. That is the
   * picker Escape's race (2026-09-07) in another place, and it read as this
   * check failing one run in two.
   */
  check(
    (await waitFor(() =>
      first.evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`)
    )) === true,
    'the console holds the keyboard',
    await first.evaluate(
      `document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'nothing'`
    )
  );
  const before = Buffer.concat(received).length;
  for (const letter of 'look') {
    await first.key(
      'keyDown',
      letter,
      `Key${letter.toUpperCase()}`,
      letter.toUpperCase().charCodeAt(0),
      {
        text: letter
      }
    );
    await first.key(
      'keyUp',
      letter,
      `Key${letter.toUpperCase()}`,
      letter.toUpperCase().charCodeAt(0)
    );
  }
  await first.key('keyDown', 'Enter', 'Enter', 13, { text: '\r' });
  await first.key('keyUp', 'Enter', 'Enter', 13);
  const typed = () => withoutTelnet(Buffer.concat(received).subarray(before)).toString('latin1');
  const arrived = await waitFor(() => (typed().includes('look\r\n') ? true : null));
  check(
    arrived === true,
    'a command typed in the tab reaches the host',
    // What did arrive, so a lost keystroke is told from a lost caret.
    JSON.stringify(typed())
  );
}

await first.evaluate(`window.mudengine.disconnect(${JSON.stringify(SESSION)})`);
const closed = await waitFor(() =>
  first
    .evaluate(`window.mudengine.getState(${JSON.stringify(SESSION)})`)
    .then((next) => (next?.phase !== 'connected' ? next.phase : null))
);
check(closed !== null, 'and disconnects', closed);

// ---------------------------------------------------- assert: the signal

/*
 * `docker stop` is a SIGTERM. The client is asked, not killed, and the
 * teardown line is what says it heard: a harness that kills the app never
 * learns that it cannot quit.
 */
const exited = serverExit();
server.kill('SIGTERM');
const exit = await Promise.race([exited, sleep(8000).then(() => null)]);
check(
  exit !== null && exit.code === 0,
  'SIGTERM ends the client cleanly, as docker stop would',
  JSON.stringify(exit)
);
check(/shutdown: disconnecting and flushing/.test(serverOut), 'and the teardown said so');
check(
  (await waitFor(() => first.evaluate(`!!document.querySelector('.link-lost')`), 40)) === true,
  'the tab says the client is gone'
);

// ---------------------------------------------------- assert: the restart

const firstRun = serverOut;
serverOut = '';
server = startServer();
const again = await waitFor(
  () => (/Open:\s+http:\/\/localhost:(\d+)\//.test(serverOut) ? true : null),
  120
);
check(again === true, 'a second start comes up on the same home');
check(
  /generated on the first start/.test(serverOut) && !serverOut.includes(password),
  'and does not reprint the password'
);
check(firstRun.split(password).length === 2, 'the password appeared exactly once across both runs');
{
  const port2 = Number(/Open:\s+http:\/\/localhost:(\d+)\//.exec(serverOut)?.[1] ?? 0);
  const response = await fetch(`http://127.0.0.1:${port2}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual'
  });
  check(response.status === 303, 'and the saved password still signs in', `${response.status}`);
}
const exited2 = serverExit();
server.kill('SIGTERM');
await Promise.race([exited2, sleep(8000)]);

// ---------------------------------------------------------------- finish

if (failures > 0) console.log(`\n${failures} check(s) failed.`);
// The baseline is the fixture's: the live realm fails what it fails today.
const verdict = live
  ? Number(failures > 0)
  : judgeFailures(failedNames, {
      file: 'scripts/web-smoke-baseline.json',
      accept: process.argv.includes('--accept'),
      command: 'npm run smoke:web -- --accept'
    });
first.ws.close();
second.ws.close();
cleanup();
setTimeout(() => process.exit(verdict), 300);
