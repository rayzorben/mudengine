/**
 * Where the window's time goes while somebody types, and how long a keystroke
 * takes to come back.
 *
 *   npx electron-vite build --sourcemap && node scripts/profile-ui.mjs [--windowed] [--no-hud] [--keep-open]
 *   npm run profile:ui
 *
 * Stands up a fake host that answers like the realm — server echo, the
 * `ESC[79D ESC[K` prompt repaint, a status line after every event — launches
 * the built app, and drives it through four situations a player is in every
 * evening: sitting at the prompt, typing a command, typing *while a fight
 * prints*, and a listing arriving all at once. For each it records, from
 * inside the window:
 *
 * - **every React commit and which components rendered in it**, through the
 *   DevTools hook React looks for at load (which is why the page is reloaded
 *   once with the hook pre-installed);
 * - the browser's own **event timing, long tasks and long animation frames**,
 *   which is what "drawing blocked input" looks like from the inside;
 * - **each keystroke's journey**: the keydown in the window, the byte reaching
 *   the host, the echo arriving back in the window, and the next frame after
 *   it — three clocks, all epoch milliseconds on one machine;
 * - a **V8 CPU profile**, attributed through the sourcemap to React, xterm or
 *   the client's own component (`scripts/lib/cpuprofile.mjs`).
 *
 * Nothing here asserts. It measures and prints, and writes the profiles to
 * `out/profile-ui/` for DevTools. A number is the deliverable: the claims this
 * was written to test — that the rail re-renders per keystroke, that the
 * chrome's blur repaints with the console — are exactly the kind that are
 * argued about and never settled without one.
 *
 * `--no-hud` runs the same script with the card rail off, which is the
 * control: whatever cost stays is the console's own.
 *
 * On a desktop it runs under `xvfb-run` for the reason `scripts/smoke.mjs`
 * records — the app takes the keyboard on launch, by design — and then the GPU
 * is SwiftShader, so **compositor and GPU figures from a virtual display are
 * not this machine's**; the main-thread figures are. Pass `--windowed` to
 * measure on the real display, having first put the keyboard down.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';

import { analyse, loadMapper, spread } from './lib/cpuprofile.mjs';

const IAC = 255,
  WILL = 251,
  WONT = 252,
  DO = 253,
  DONT = 254,
  SB = 250,
  SE = 240;
const OPT_ECHO = 1,
  OPT_SGA = 3,
  OPT_TTYPE = 24,
  OPT_NAWS = 31;

const CDP_PORT = 9334;
const SESSION = 'alpha';
const keepOpen = process.argv.includes('--keep-open');
const wantsWindow = process.argv.includes('--windowed');
const hudOff = process.argv.includes('--no-hud');

// Its own directory per mode, so the control run does not wipe the run it controls for.
const OUT = path.resolve(hudOff ? 'out/profile-ui-no-hud' : 'out/profile-ui');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/*
 * A home of its own, exactly as the smoke run has, and for the same reason: a
 * harness that writes into somebody's real characters is not a harness.
 * The settings mirror the options the report is about — the shipped face, a
 * long backscroll, a blinking cursor, the tab rail on the left, the HUD on —
 * so the window measured is the window somebody plays in.
 */
const HOME = path.join(OUT, 'home');
const PROFILE = path.join(OUT, 'chromium');
const LOGS = path.join(OUT, 'logs');
const FONT = 'LucidaProgrammer Nerd Font Mono';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

// ------------------------------------------------------------------ fake host

/**
 * The prompt, byte for byte as the live realm prints it (captured 2026-09-04,
 * `logs/…_festus.mudcap.jsonl`): the colours, the erase-and-repaint before
 * it, and a `\r\n`-terminated line before that. Every unsolicited event
 * reprints it — the capture shows a prompt after every single `*Combat
 * Engaged*` — so a fight is one status line per line of combat text, which
 * is what drives the tracker, the character push and the cards for real.
 */
const ERASE = '\x1b[79D\x1b[K';
const prompt = (hp, ma) =>
  `\x1b[0;36m[HP=\x1b[1;36m${hp}\x1b[0;36m/MA=\x1b[1;36m${ma}\x1b[0;36m]:\x1b[0m`;

const ROOM = [
  '\x1b[1;36mNewhaven, Village Entrance\x1b[0m',
  '    A dusty path leads away from the gates.',
  '\x1b[0;36mYou notice newbie manual, grey robes here.\x1b[0m',
  '\x1b[0;35mAlso here: Nathaniel.\x1b[0m',
  '\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0;32m, \x1b[1;33msouth\x1b[0m'
];
const SHEET = [
  'Name:   Rayzor              Lives/CP: 3/12',
  'Race:   Human      Exp:      1500   Perception:  20',
  'Class:  Warrior    Level:    4      Stealth:     10',
  'Hits:   98/400     Armour Class: 12/3   Thievery:    5',
  'Mana:   50/120     Spellcasting: 12     Traps:       3'
];
const PACK = [
  'You are carrying 2 runic coins, 16 platinum pieces, 353 gold crowns, 450 silver',
  'nobles, 7 copper farthings, padded helm (Head), padded vest (Torso), padded gloves',
  '(Hands), padded pants (Legs), padded boots (Feet), quarterstaff',
  'You have no keys.',
  'Wealth: 2199807 copper farthings',
  'Encumbrance: 500/3360 - None [14%]'
];
const WHO = [
  '\x1b[0;36m         Current Adventurers\x1b[0m',
  '\x1b[0;36m         ===================\x1b[0m',
  '\x1b[0;37m         Rayzor                -  Apprentice S\x1b[0m',
  '\x1b[0;31m         Outlaw   Grimjaw     -  Cutpurse\x1b[0m'
];

/** Every printable byte the host received from the shown character, stamped. */
const wire = [];
let hp = 98;
const ma = 50;

class Host {
  constructor(socket) {
    this.socket = socket;
    this.line = '';
    this.sub = false;
    this.skip = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => {});
    socket.write(
      Buffer.from([IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO, IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS])
    );
    setTimeout(() => socket.write(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE])), 30);
    setTimeout(() => {
      this.write(`\x1b[1;36mWelcome to the Realm\x1b[0m\r\n${ROOM.join('\r\n')}\r\n`);
      this.write(`${SHEET.join('\r\n')}\r\n${ERASE}${prompt(hp, ma)}`);
    }, 120);
  }

  write(text) {
    if (!this.socket.destroyed) this.socket.write(Buffer.from(text, 'latin1'));
  }

  /**
   * Telnet in, characters echoed back. The client negotiates on this socket
   * — `WILL NAWS`, a terminal-type reply, a window size — and none of that is
   * typing, so the IAC grammar is walked and dropped and only what a person
   * typed is echoed, one byte at a time, the way a server that owns the echo
   * does it.
   */
  receive(chunk) {
    for (const byte of chunk) {
      if (this.skip > 0) {
        this.skip -= 1;
        continue;
      }
      if (this.sub) {
        if (byte === SE) this.sub = false;
        continue;
      }
      if (byte === IAC) {
        this.iac = true;
        continue;
      }
      if (this.iac) {
        this.iac = false;
        if (byte === SB) this.sub = true;
        else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) this.skip = 1;
        else if (byte === IAC) this.typed(0xff);
        continue;
      }
      this.typed(byte);
    }
  }

  typed(byte) {
    if (byte === 0x0a || byte === 0x00) return;
    if (byte === 0x0d) {
      this.write('\r\n');
      const command = this.line.trim();
      this.line = '';
      this.answer(command);
      return;
    }
    if (byte === 0x7f || byte === 0x08) {
      this.line = this.line.slice(0, -1);
      this.write('\b \b');
      return;
    }
    const ch = String.fromCharCode(byte);
    this.line += ch;
    wire.push({ at: Date.now(), ch });
    this.write(ch);
  }

  /** The commands the client asks on entering the realm, and a look. */
  answer(command) {
    const lines =
      command === 'rm'
        ? ['Location: 1,2140', '']
        : command === 'l' || command === 'look'
          ? ROOM
          : command === 'st'
            ? SHEET
            : command === 'i'
              ? PACK
              : command === 'sc' || command === 'who'
                ? WHO
                : command === 'exp'
                  ? ['Exp: 1500  Level: 4  Exp needed for next level: 500 (2000)']
                  : command.length > 0
                    ? // The realm's own sentence for a word it does not know.
                      ['Your command had no effect.']
                    : [];
    this.write(`${lines.map((line) => `${line}\r\n`).join('')}${ERASE}${prompt(hp, ma)}`);
  }

  /** Lines the server volunteers, each followed by the prompt as the realm does. */
  say(lines) {
    this.write(lines.map((line) => `${ERASE}${line}\r\n${ERASE}${prompt(hp, ma)}`).join(''));
  }
}

const hosts = [];
const server = net.createServer((socket) => hosts.push(new Host(socket)));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// --------------------------------------------------------------------- files

fs.mkdirSync(path.join(HOME, 'global'), { recursive: true });
fs.writeFileSync(
  path.join(HOME, 'global', 'default.yaml'),
  [
    'terminal:',
    '  font:',
    '    family:',
    `      - ${FONT}`,
    '    size: 14',
    '  scrollback: 100000',
    '  cursorBlink: true',
    '  cursorStyle: block',
    'ui:',
    '  font:',
    '    size: 13',
    '  density: auto',
    '  theme: dark',
    '  tabs: left',
    `  showHud: ${hudOff ? 'false' : 'true'}`,
    'logging:',
    '  enabled: true',
    `  directory: '${LOGS}'`,
    ''
  ].join('\n')
);
const realm = path.join(HOME, 'servers', 'profile-realm');
fs.mkdirSync(realm, { recursive: true });
fs.writeFileSync(
  path.join(realm, 'server.yaml'),
  ['name: Profile Realm', 'host: 127.0.0.1', `port: ${PORT}`, 'encoding: cp437', ''].join('\n')
);
const character = (id, lines) => {
  fs.mkdirSync(path.join(HOME, 'profiles', id), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'profiles', id, 'profile.yaml'), `${lines.join('\n')}\n`);
};
character(SESSION, ['name: Alpha', 'server: Profile Realm', 'autoConnect: true']);
// A second character, loaded and offline: the tab rail and the terminal
// stack are drawn for more than one, which is the shape a player's window has.
character('beta', ['name: Beta', 'server: Profile Realm', 'autoConnect: false']);

// -------------------------------------------------------------------- launch

const electron =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : './node_modules/electron/dist/electron';
if (!fs.existsSync('out/main/index.js')) {
  console.error('\nNothing built. Run: npx electron-vite build --sourcemap\n');
  process.exit(1);
}

const appEnv = { ...process.env, MUDENGINE_HOME: HOME };
delete appEnv.ELECTRON_RUN_AS_NODE;

const hasSession = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const hasXvfb =
  process.platform === 'linux' &&
  hasSession &&
  spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
if (hasSession && !hasXvfb && !wantsWindow) {
  console.error(
    '\nThere is a desktop session here and no `xvfb-run` to hide behind, so this\n' +
      'would open a window and take your keyboard. Install xvfb, or pass --windowed\n' +
      'if you meant to watch it.\n'
  );
  process.exit(1);
}
const virtual = hasXvfb && !wantsWindow;

const electronArgs = [
  'out/main/index.js',
  '--no-sandbox',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`,
  /*
   * On the virtual display there is no GPU, and since Chromium 120 WebGL does
   * not fall back to software on its own. Without this the console's WebGL
   * addon fails to load and the DOM renderer runs instead — a different
   * client from the one on a desktop, and a heavier one on exactly the thread
   * being measured.
   */
  ...(virtual ? ['--enable-unsafe-swiftshader'] : [])
];
const xvfbEnv = { ...appEnv };
delete xvfbEnv.WAYLAND_DISPLAY;

console.log(`\nmudengine UI profile -- fake host on 127.0.0.1:${PORT}${hudOff ? ', HUD off' : ''}\n`);
if (virtual) log('running on a virtual display -- the GPU there is SwiftShader, not yours');

const child = virtual
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', electron, '--ozone-platform=x11', ...electronArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: xvfbEnv,
      detached: true
    })
  : spawn(electron, electronArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: appEnv, detached: true });

const killApp = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
};
process.on('exit', () => {
  if (!keepOpen) killApp('SIGKILL');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killApp('SIGKILL');
    process.exit(1);
  });
}
const NOISE = /Fontconfig|wayland|libwayland|GPU|dbus|Vulkan|MESA|gbm|EGL|invalid |Failed to shutdown/i;
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  // The client's own compositing warning is the one line about the GPU that
  // is never noise here: it is the caveat this harness's figures carry.
  if (s && (/^gpu: /.test(s) || !NOISE.test(s))) process.stderr.write(`   [app] ${s}\n`);
});
let appOut = '';
child.stdout.on('data', (d) => {
  appOut += d.toString();
});

// ---------------------------------------------------------------------- CDP

async function target(kind) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (kind === 'browser') {
        const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
        if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      } else {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(`no CDP ${kind} target`);
}

function client(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const inflight = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && inflight.has(msg.id)) {
      inflight.get(msg.id)(msg);
      inflight.delete(msg.id);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const handler of listeners.get(msg.method)) handler(msg.params);
    }
  };
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
    return () => listeners.get(method)?.delete(handler);
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      inflight.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, call, on, close: () => ws.close() };
}

const page = client(await target('page'));
await page.ready;
const cdp = page.call;
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}
await cdp('Runtime.enable');
await cdp('Page.enable');

async function untilMounted() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if (await evaluate(`!!document.querySelector('.status-rail')`)) return;
    } catch {
      /* mid-navigation */
    }
    await sleep(250);
  }
  throw new Error('window never mounted');
}
await untilMounted();

/*
 * What the GPU is doing, from the browser target. On a virtual display this
 * says "software" and that is the caveat, stated by the machine rather than
 * remembered by the reader.
 */
let gpu = null;
try {
  const browser = client(await target('browser'));
  await browser.ready;
  const info = await browser.call('SystemInfo.getInfo');
  const device = info.gpu?.devices?.[0];
  gpu = {
    device: device ? `${device.vendorString ?? ''} ${device.deviceString ?? ''}`.trim() : '?',
    features: info.gpu?.featureStatus ?? {}
  };
  browser.close();
} catch (error) {
  gpu = { device: `unavailable (${String(error)})`, features: {} };
}

// ------------------------------------------------------- instrument the window

/**
 * Installed before the page's own scripts and the page reloaded, because
 * React looks for the DevTools hook exactly once, at load. `onCommitFiberRoot`
 * counts commits always and, while `detail` is on, walks the fibre tree for
 * the components that did work in that commit — the `PerformedWork` flag,
 * bit 1, which is how DevTools' "highlight updates" knows too.
 *
 * The rest is the browser's own instrumentation: event timing (a keydown's
 * input delay and its distance to the next paint), long tasks, long animation
 * frames with script attribution, a frame clock, and every keydown in the
 * capture phase — before xterm sees it — with its hardware timestamp.
 */
const INSTRUMENT = `(() => {
  const P = (window.__perf = {
    commits: 0, renders: new Map(), props: new Map(), mutations: new Map(),
    detail: false, frameOn: false,
    events: [], longtasks: [], loaf: [], frames: [], chunks: [], keys: []
  });
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  /*
   * Why a component rendered: which of its props changed identity against
   * the previous render, and whether its own state or a context did. This is
   * what "why-did-you-render" reads off the same fibre fields; for a memoised
   * component that rendered at all, at least one of these is the answer.
   */
  const diff = (name, f) => {
    const prev = f.alternate && f.alternate.memoizedProps;
    const next = f.memoizedProps;
    if (!prev || !next) { bump(P.props, name + ' (mount)'); return; }
    if (prev === next) {
      bump(P.props, name + (f.memoizedState !== f.alternate.memoizedState ? ' (state)' : ' (parent)'));
      return;
    }
    let any = false;
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (prev[key] !== next[key]) { any = true; bump(P.props, name + '.' + key); }
    }
    if (!any) bump(P.props, name + ' (props same)');
  };
  const nameOf = (f) => {
    const t = f.type;
    return (t && (t.displayName || t.name || (t.render && t.render.name) || (t.type && t.type.name))) || '?';
  };
  /*
   * Only the part of the tree this commit reconciled, the way React DevTools
   * walks it: a fibre React processed in this render is a *new* object (its
   * alternate is the previous one), so a parent whose child pointer still
   * equals its alternate's child has a subtree React skipped entirely, and
   * everything under it keeps the flags and props pair of whatever render
   * last touched it. Walking those re-counts old renders on every commit,
   * which the first version of this did, and reported nine hundred icon
   * renders in five idle seconds that never happened.
   */
  const walk = (f, prev) => {
    if (!f) return;
    const rendered = (f.flags & 1) !== 0;
    if (rendered && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 15)) {
      const name = nameOf(f);
      bump(P.renders, name);
      diff(name, f);
    }
    if (prev === null || f.child !== prev.child) {
      for (let c = f.child; c; c = c.sibling) walk(c, c.alternate);
    }
  };
  /*
   * What actually changed in the document. A render that produces the same
   * markup mutates nothing, so this is the census of what the window redrew
   * rather than of what React reconsidered: each record keyed by kind, tag,
   * first class and attribute.
   */
  const label = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return node.nodeName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '')
      .split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  // Installed when a scenario starts, not here: this script runs before the
  // document has an element to observe.
  P.watchDom = () => {
    if (P.watching) return;
    P.watching = true;
    new MutationObserver((records) => {
      if (!P.mutOn) return;
      for (const r of records) {
        if (r.type === 'attributes') bump(P.mutations, 'attr ' + label(r.target) + '@' + r.attributeName);
        else if (r.type === 'characterData') bump(P.mutations, 'text ' + label(r.target));
        else {
          for (const n of r.addedNodes) bump(P.mutations, 'add ' + label(n) + ' in ' + label(r.target));
          for (const n of r.removedNodes) bump(P.mutations, 'remove ' + label(n) + ' in ' + label(r.target));
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(),
    inject() { return 1; }, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      P.commits += 1;
      if (P.detail && root && root.current) walk(root.current, root.current.alternate);
    }
  };
  const observe = (type, extra, take) => {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) take(e); })
        .observe({ type, buffered: true, ...extra });
    } catch {}
  };
  observe('event', { durationThreshold: 16 }, (e) => P.events.push({
    name: e.name, t: e.startTime, delay: e.processingStart - e.startTime,
    handler: e.processingEnd - e.processingStart, duration: e.duration
  }));
  observe('longtask', {}, (e) => P.longtasks.push({ t: e.startTime, d: e.duration }));
  observe('long-animation-frame', {}, (e) => P.loaf.push({
    t: e.startTime, d: e.duration, blocking: e.blockingDuration,
    styleLayout: e.styleAndLayoutStart > 0 ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
    scripts: (e.scripts || []).map((s) => ({
      name: s.sourceFunctionName || s.invoker || s.invokerType, d: Math.round(s.duration)
    })).sort((a, b) => b.d - a.d).slice(0, 4)
  }));
  const frame = (t) => {
    if (P.frameOn) { P.frames.push(t); if (P.frames.length > 40000) P.frames.splice(0, 20000); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.addEventListener('keydown', (e) => P.keys.push({ key: e.key, t: e.timeStamp }), true);
})();`;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
await cdp('Page.reload');
await sleep(500);
await untilMounted();
if (!(await evaluate(`!!window.__perf`))) throw new Error('instrumentation did not install');

// The echo's arrival in the window, and the frame after it.
await evaluate(`(window.mudengine.onData(({ session, payload }) => {
  if (session !== ${JSON.stringify(SESSION)}) return;
  const entry = { t: performance.now(), n: payload.text.length, s: payload.text.slice(0, 12), painted: null };
  window.__perf.chunks.push(entry);
  requestAnimationFrame((f) => { entry.painted = f; });
}), true)`);

// In the realm, and the enter-realm probes answered.
for (let i = 0; i < 120; i += 1) {
  const phase = await evaluate(
    `window.mudengine.getCharacter(${JSON.stringify(SESSION)}).then((c) => c.phase)`
  );
  if (phase === 'in-game') break;
  await sleep(250);
}
await sleep(3000);
const host = hosts[0];
if (!host) throw new Error('the character never connected');

const shape = await evaluate(`(() => ({
  renderer: document.querySelector('.terminal-layer[data-shown="true"] .xterm canvas') ? 'webgl'
    : document.querySelector('.terminal-layer[data-shown="true"] .xterm-rows') ? 'dom' : 'unknown',
  canvases: document.querySelectorAll('.xterm canvas').length,
  terminals: document.querySelectorAll('.xterm').length,
  railCards: [...document.querySelectorAll('.rail > .card')].map((c) => c.className.replace(/surface card ?/, '').trim()),
  floats: document.querySelectorAll('.float').length,
  surfaces: document.querySelectorAll('.surface').length,
  blurred: [...document.querySelectorAll('*')].filter((el) => {
    const f = getComputedStyle(el).backdropFilter; return f && f !== 'none';
  }).length,
  cols: (document.querySelector('.terminal-layer[data-shown="true"] .xterm-screen') || {}).clientWidth
}))()`);

// ---------------------------------------------------------------- scenarios

await cdp('Profiler.enable');
await cdp('Profiler.setSamplingInterval', { interval: 500 });

const bundle = await evaluate(
  `[...document.scripts].map((s) => s.src).find((s) => /assets\\/index-.*\\.js$/.test(s)) || ''`
);
const mapper = bundle ? loadMapper(`${new URL(bundle).pathname}.map`) : null;
if (!mapper) log('no sourcemap beside the bundle -- build with `electron-vite build --sourcemap` for attribution');

const vk = (ch) => (ch === ' ' ? 32 : ch === '\r' ? 13 : ch.toUpperCase().charCodeAt(0));
async function press(ch) {
  const enter = ch === '\r';
  const base = enter
    ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    : { key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: vk(ch) };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function type(text, gapMs) {
  for (const ch of text) {
    await press(ch);
    await sleep(gapMs);
  }
}

/*
 * A Chrome trace of the window's main thread, for the half a CPU profile
 * cannot see: V8 files style recalculation, layout and paint under
 * `(program)`, and those are exactly the phases a keystroke queues behind.
 * The trace names them, says how many elements each touched, and — with the
 * stack category — which script scheduled the invalidation.
 */
const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  ...(process.argv.includes('--invalidations')
    ? ['disabled-by-default-devtools.timeline.invalidationTracking']
    : [])
];
async function startTrace() {
  await cdp('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { recordMode: 'recordContinuously', includedCategories: TRACE_CATEGORIES }
  });
}
async function stopTrace() {
  const complete = new Promise((resolve) => {
    const off = page.on('Tracing.tracingComplete', (params) => {
      off();
      resolve(params);
    });
  });
  await cdp('Tracing.end');
  const { stream } = await complete;
  let text = '';
  for (;;) {
    const part = await cdp('IO.read', { handle: stream, size: 4 * 1024 * 1024 });
    text += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data;
    if (part.eof) break;
  }
  await cdp('IO.close', { handle: stream });
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
}

/** The renderer main thread's time by phase, self time with children subtracted. */
function summariseTrace(events) {
  const names = new Map();
  let pid = null;
  let tid = null;
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name' && e.args?.name === 'Renderer') names.set(`p${e.pid}`, true);
  }
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && names.has(`p${e.pid}`)) {
      pid = e.pid;
      tid = e.tid;
    }
  }
  const spans = events
    .filter((e) => e.ph === 'X' && e.pid === pid && e.tid === tid && typeof e.dur === 'number')
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stack = [];
  const self = new Map();
  const count = new Map();
  const extra = { styleElements: 0, layoutDirty: 0, layoutTotal: 0, paints: 0 };
  for (const e of spans) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.deduct = (parent.deduct ?? 0) + e.dur;
    stack.push(e);
    count.set(e.name, (count.get(e.name) ?? 0) + 1);
    if (e.name === 'UpdateLayoutTree') extra.styleElements += e.args?.elementCount ?? 0;
    if (e.name === 'Layout') {
      extra.layoutDirty += e.args?.beginData?.dirtyObjects ?? 0;
      extra.layoutTotal += e.args?.beginData?.totalObjects ?? 0;
    }
    if (e.name === 'Paint') extra.paints += 1;
  }
  for (const e of spans) self.set(e.name, (self.get(e.name) ?? 0) + e.dur - (e.deduct ?? 0));
  const initiators = new Map();
  const invalidations = new Map();
  for (const e of events) {
    if (e.pid !== pid || e.tid !== tid) continue;
    if (e.name === 'ScheduleStyleRecalculation' || e.name === 'InvalidateLayout') {
      const top = e.args?.data?.stackTrace?.[0];
      const key = `${e.name}: ${top ? `${top.functionName || '(anonymous)'}:${top.lineNumber}` : '(no stack)'}`;
      initiators.set(key, (initiators.get(key) ?? 0) + 1);
    }
    if (/InvalidationTracking$/.test(e.name)) {
      const d = e.args?.data ?? {};
      const key = `${e.name.replace('InvalidationTracking', '')} ${d.reason ?? ''} ${d.extraData ?? ''} ${d.selectorPart ?? ''}`.trim();
      invalidations.set(key, (invalidations.get(key) ?? 0) + 1);
    }
  }
  const rows = (map, limit, scale = 1) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, v]) => ({ key, value: Math.round(v / scale) }));
  return {
    found: pid !== null,
    selfMs: rows(self, 14, 1000).map((r) => ({ key: r.key, ms: r.value, n: count.get(r.key) ?? 0 })),
    ...extra,
    initiators: rows(initiators, 10),
    invalidations: rows(invalidations, 10)
  };
}

const results = [];
/** `--only=idle,typing` runs a subset, for iterating on one situation. */
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
async function scenario(name, run) {
  if (only && !only.includes(name)) return null;
  log(`${name} …`);
  await evaluate(`(() => {
    const P = window.__perf;
    P.watchDom();
    P.frameOn = true; P.detail = true; P.mutOn = true;
    P.mark = { commits: P.commits, renders: new Map(P.renders), props: new Map(P.props),
      mutations: new Map(P.mutations), events: P.events.length,
      longtasks: P.longtasks.length, loaf: P.loaf.length, frames: P.frames.length,
      chunks: P.chunks.length, keys: P.keys.length, t0: performance.now() };
    return true;
  })()`);
  const wireFrom = wire.length;
  await startTrace();
  await cdp('Profiler.start');
  const started = Date.now();
  await run();
  const { profile } = await cdp('Profiler.stop');
  const trace = await stopTrace();
  const snap = await evaluate(`(() => {
    const P = window.__perf; const m = P.mark;
    const delta = (now, was) => [...now].map(([k, v]) => [k, v - (was.get(k) || 0)])
      .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const out = {
      epoch: performance.timeOrigin,
      elapsed: performance.now() - m.t0,
      commits: P.commits - m.commits,
      renders: delta(P.renders, m.renders),
      props: delta(P.props, m.props),
      mutations: delta(P.mutations, m.mutations),
      events: P.events.slice(m.events), longtasks: P.longtasks.slice(m.longtasks),
      loaf: P.loaf.slice(m.loaf), frames: P.frames.slice(m.frames),
      chunks: P.chunks.slice(m.chunks), keys: P.keys.slice(m.keys),
      elements: document.querySelectorAll('*').length
    };
    P.frameOn = false; P.detail = false; P.mutOn = false;
    return out;
  })()`);
  fs.writeFileSync(path.join(OUT, `${name}.cpuprofile`), JSON.stringify(profile));
  fs.writeFileSync(path.join(OUT, `${name}.trace.json`), JSON.stringify({ traceEvents: trace }));

  const cpu = analyse(profile, { mapper });
  const phases = summariseTrace(trace);
  const gaps = [];
  for (let i = 1; i < snap.frames.length; i += 1) gaps.push(snap.frames[i] - snap.frames[i - 1]);

  /*
   * Each typed character, three hops. The keydown carries the window's own
   * clock; the host's byte and the window's chunk are both epoch time.
   * A key is matched to the first unclaimed byte carrying its character that
   * reached the host after it was pressed — not by position, because the
   * client's own automation may send a command of its own mid-sentence and a
   * positional pairing would then shift every later figure without a signal.
   * A chunk is matched the same way: the first after the byte's arrival that
   * carries the character — a fight's lines arrive in between and are
   * skipped, which is the point of measuring under one.
   */
  const keys = snap.keys.filter((k) => k.key.length === 1);
  const bytes = wire.slice(wireFrom);
  const hops = [];
  let chunkAt = 0;
  let byteAt = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const down = snap.epoch + keys[i].t;
    let wireIndex = -1;
    for (let j = byteAt; j < bytes.length; j += 1) {
      if (bytes[j].ch === keys[i].key && bytes[j].at >= down - 5) {
        wireIndex = j;
        break;
      }
    }
    if (wireIndex === -1) continue;
    byteAt = wireIndex + 1;
    const onWire = bytes[wireIndex].at;
    let echo = null;
    for (let j = chunkAt; j < snap.chunks.length; j += 1) {
      const c = snap.chunks[j];
      if (snap.epoch + c.t >= onWire && c.s.includes(bytes[wireIndex].ch)) {
        echo = c;
        chunkAt = j + 1;
        break;
      }
    }
    hops.push({
      toWire: onWire - down,
      back: echo ? snap.epoch + echo.t - onWire : null,
      frame: echo && echo.painted !== null ? echo.painted - echo.t : null,
      total: echo && echo.painted !== null ? snap.epoch + echo.painted - down : null
    });
  }

  const result = {
    name,
    wallMs: Date.now() - started,
    elapsedMs: Math.round(snap.elapsed),
    commits: snap.commits,
    commitsPerSecond: Math.round((snap.commits * 1000) / snap.elapsed),
    renders: snap.renders.slice(0, 20),
    props: snap.props.slice(0, 80),
    mutations: snap.mutations.slice(0, 16),
    mutationCount: snap.mutations.reduce((n, [, v]) => n + v, 0),
    elements: snap.elements,
    phases,
    chunks: snap.chunks.length,
    chars: snap.chunks.reduce((n, c) => n + c.n, 0),
    longtasks: {
      n: snap.longtasks.length,
      totalMs: Math.round(snap.longtasks.reduce((n, t) => n + t.d, 0)),
      maxMs: Math.round(Math.max(0, ...snap.longtasks.map((t) => t.d)))
    },
    loaf: {
      n: snap.loaf.length,
      blockingMs: Math.round(snap.loaf.reduce((n, f) => n + f.blocking, 0)),
      styleLayoutMs: Math.round(snap.loaf.reduce((n, f) => n + f.styleLayout, 0)),
      maxMs: Math.round(Math.max(0, ...snap.loaf.map((f) => f.d))),
      scripts: Object.entries(
        snap.loaf.flatMap((f) => f.scripts).reduce((acc, s) => {
          acc[s.name] = (acc[s.name] || 0) + s.d;
          return acc;
        }, {})
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
    },
    events: {
      n: snap.events.length,
      delay: spread(snap.events.map((e) => e.delay)),
      duration: spread(snap.events.map((e) => e.duration))
    },
    frames: {
      n: snap.frames.length,
      gap: spread(gaps),
      over33: gaps.filter((g) => g > 33).length,
      over100: gaps.filter((g) => g > 100).length
    },
    keys: {
      n: hops.length,
      toWire: spread(hops.map((h) => h.toWire)),
      back: spread(hops.map((h) => h.back).filter((v) => v !== null)),
      frame: spread(hops.map((h) => h.frame).filter((v) => v !== null)),
      total: spread(hops.map((h) => h.total).filter((v) => v !== null)),
      unmatched: hops.filter((h) => h.back === null).length
    },
    cpu
  };
  results.push(result);
  return result;
}

const SENTENCE = 'look at the dusty path ahead now';

/** A fight, as the realm prints one: a line every 50ms, the prompt after each, the health moving. */
function fight(seconds) {
  const lines = [
    '\x1b[0;37mYou slash the orc rogue for 12 damage!\x1b[0m',
    '\x1b[0;31mThe orc rogue slashes you for 5 damage!\x1b[0m',
    '\x1b[0;31mThe giant rat bites you for 2 damage!\x1b[0m',
    '\x1b[0;37mYou impale the giant rat for 9 damage!\x1b[0m'
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (i % 4 === 3) hp = hp <= 60 ? 98 : hp - 1;
    host.say([lines[i % lines.length]]);
    i += 1;
  }, 50);
  return new Promise((r) =>
    setTimeout(() => {
      clearInterval(timer);
      r();
    }, seconds * 1000)
  );
}

await scenario('idle', () => sleep(5000));
await scenario('typing', async () => {
  await type(SENTENCE, 50);
  await sleep(300);
  await press('\r');
  await sleep(700);
});
await scenario('typing-in-a-fight', async () => {
  const done = fight(4);
  await sleep(500);
  await type(SENTENCE, 50);
  await sleep(300);
  await press('\r');
  await done;
  await sleep(700);
});
await scenario('burst', async () => {
  const lines = Array.from(
    { length: 2000 },
    (_, i) => `\x1b[0;37mThe torchlight flickers on the wall. (${i})\x1b[0m`
  );
  host.write(`${ERASE}${lines.map((line) => `${line}\r\n`).join('')}${ERASE}${prompt(hp, ma)}`);
  await sleep(4000);
});

const shot = await cdp('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'screen.png'), Buffer.from(shot.data, 'base64'));

// -------------------------------------------------------------------- report

const ms = (v) => `${Math.round(v * 10) / 10}ms`;
const sp = (s) => (s.n === 0 ? '—' : `p50 ${ms(s.p50)} · p95 ${ms(s.p95)} · max ${ms(s.max)} (n=${s.n})`);

console.log('\nWindow');
log(`GPU: ${gpu.device}`);
for (const [k, v] of Object.entries(gpu.features)) {
  if (/compositing|webgl|rasterization|canvas/.test(k)) log(`  ${k}: ${v}`);
}
log(`console renderer: ${shape.renderer} (${shape.canvases} canvases over ${shape.terminals} terminals)`);
log(`rail: ${shape.railCards.length ? shape.railCards.join(', ') : 'none'}; floats: ${shape.floats}`);
log(`glass surfaces: ${shape.surfaces}, elements with a backdrop filter: ${shape.blurred}`);
log(`sourcemap attribution: ${mapper ? 'yes' : 'no'}`);

for (const r of results) {
  console.log(`\n${r.name}  (${r.elapsedMs}ms; ${r.chunks} chunks, ${r.chars} chars in)`);
  log(`React commits: ${r.commits} (${r.commitsPerSecond}/s); DOM elements: ${r.elements}`);
  if (r.renders.length) log(`  components rendered: ${r.renders.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  if (r.props.length) log(`  why (prop that changed × renders): ${r.props.map(([k, v]) => `${k}×${v}`).join(', ')}`);
  log(`DOM mutations: ${r.mutationCount}`);
  if (r.mutations.length) log(`  ${r.mutations.map(([k, v]) => `${k}×${v}`).join(' | ')}`);
  if (r.phases.found) {
    log(`main thread by phase (trace, self): ${r.phases.selfMs.map((p) => `${p.key} ${ms(p.ms)}/${p.n}`).join(' | ')}`);
    log(`  style recalc touched ${r.phases.styleElements} elements; layout dirtied ${r.phases.layoutDirty} of ${r.phases.layoutTotal} objects; paints ${r.phases.paints}`);
    if (r.phases.initiators.length) log(`  invalidated by: ${r.phases.initiators.map((i) => `${i.key}×${i.value}`).join(' | ')}`);
    if (r.phases.invalidations.length) log(`  invalidation reasons: ${r.phases.invalidations.map((i) => `${i.key}×${i.value}`).join(' | ')}`);
  } else log('trace: renderer main thread not found');
  log(`main thread busy: ${ms(r.cpu.busyMs)} of ${ms(r.cpu.totalMs)} sampled`);
  log(`  self time:      ${r.cpu.selfByCategory.slice(0, 8).map((c) => `${c.key} ${ms(c.ms)}`).join(' | ')}`);
  log(`  inclusive:      ${r.cpu.inclusiveByCategory.filter((c) => !/^(root|idle|program)$/.test(c.key)).slice(0, 8).map((c) => `${c.key} ${ms(c.ms)}`).join(' | ')}`);
  if (r.cpu.byComponent.length)
    log(`  by component:   ${r.cpu.byComponent.slice(0, 10).map((c) => `${c.key} ${ms(c.ms)}`).join(' | ')}`);
  log(`  top self:       ${r.cpu.topSelf.slice(0, 6).map((c) => `${c.key} ${ms(c.ms)}`).join(' | ')}`);
  log(`long tasks: ${r.longtasks.n} (${ms(r.longtasks.totalMs)} total, max ${ms(r.longtasks.maxMs)})`);
  log(`long animation frames: ${r.loaf.n} (blocking ${ms(r.loaf.blockingMs)}, style+layout ${ms(r.loaf.styleLayoutMs)}, max ${ms(r.loaf.maxMs)})`);
  if (r.loaf.scripts.length) log(`  scripts: ${r.loaf.scripts.map(([k, v]) => `${k} ${ms(v)}`).join(' | ')}`);
  log(`frames: ${r.frames.n}; gap ${sp(r.frames.gap)}; >33ms: ${r.frames.over33}, >100ms: ${r.frames.over100}`);
  log(`slow input events (≥16ms to paint): ${r.events.n}; delay ${sp(r.events.delay)}; to paint ${sp(r.events.duration)}`);
  if (r.keys.n > 0) {
    log(`keystrokes: ${r.keys.n} (${r.keys.unmatched} echoes unmatched)`);
    log(`  keydown → host:     ${sp(r.keys.toWire)}`);
    log(`  host → echo chunk:  ${sp(r.keys.back)}`);
    log(`  chunk → next frame: ${sp(r.keys.frame)}`);
    log(`  keydown → frame:    ${sp(r.keys.total)}`);
  }
}

fs.writeFileSync(
  path.join(OUT, 'report.json'),
  JSON.stringify({ at: new Date().toISOString(), virtual, hudOff, gpu, shape, results }, null, 2)
);
console.log(`\nprofiles and report in ${OUT}\n`);

// ---------------------------------------------------------------------- exit

if (!keepOpen) {
  /*
   * Ask the browser process to quit, by pid, the way the smoke run does: a
   * group signal races `xvfb-run` killing its X server against Electron's own
   * teardown, and the abort usually wins.
   */
  let pid = null;
  try {
    for (const row of execSync(`ps -o pid=,args= -g ${child.pid}`).toString().split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(row);
      if (!match) continue;
      if (!/^\S*electron\/dist\/electron\s/.test(match[2]) || /--type=/.test(match[2])) continue;
      pid = Number(match[1]);
      break;
    }
  } catch {
    /* fall back to the group */
  }
  try {
    process.kill(pid ?? -child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const gone = new Promise((r) => child.once('exit', r));
  await Promise.race([gone, sleep(10000)]);
  if (child.exitCode === null) log('the app did not exit within ten seconds of SIGTERM');
  else if (!/shut down|quit/i.test(appOut)) log('the app exited without its shutdown line');
}
page.close();
server.close();
process.exit(0);
