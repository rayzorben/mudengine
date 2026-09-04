/**
 * Drives the built client against the live GreaterMUD server and asserts the
 * things only a real server can settle.
 *
 *   npm run check:live
 *
 * `npm run smoke` proves the client works against a fixture the client's own
 * authors wrote, which is exactly the shape of check that hid automatic login
 * for three phases. This proves it against a server nobody here controls: that
 * it logs itself in, that it learns a maximum from a real stat sheet, that a
 * route planned from the shipped realm data actually walks, and that the
 * account password is not written into the capture.
 *
 * Uses the developer's own options file, and the client's own automatic login:
 * per CLAUDE.md a harness must not do something the client should be doing.
 * Skips rather than fails when no credentials are configured, because that is
 * a machine that cannot run this check, not a broken client.
 *
 * `orohost:2427` is the only server this project connects to. That is
 * enforced below rather than trusted, since this script reads a config file it
 * did not write.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { HOST, PORT, isLocalRealm } from './lib/local-realm.mjs';
import { homePaths } from './lib/home.mjs';

/** Fixed before launch, so only files this run produced are examined later. */
const startedAt = Date.now();

const CDP_PORT = 9777;
/**
 * The character this harness drives. Resolved from the profiles directory below.
 *
 * Every session-scoped call over the bridge names its character, for the same
 * reason the client does: a call that does not say which character it means is
 * the bug the addressed contract exists to prevent, and a harness quietly
 * exercising a different shape from the app is how automatic login stayed
 * broken for three phases.
 */
let SESSION = 'default';

const PROFILE = path.resolve('out/live-profile');
const SHOT = path.resolve('out/live-check.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const pass = (m) => console.log(`   PASS  ${m}`);
const fail = (m, d) => {
  failures += 1;
  console.log(`   FAIL  ${m}${d ? ` -- ${d}` : ''}`);
};
const check = (ok, m, d) => (ok ? pass(m) : fail(m, d));

// ------------------------------------------------------------------ options

const home = homePaths();
const configPath = fs.existsSync(home.options) ? home.options : null;

if (!configPath) {
  console.log('\nno options file — nothing to check against. Skipping.\n');
  process.exit(0);
}

/*
 * Both forms, deliberately. The parsed tree is what resolves the character
 * below; the raw text is what the temporary copy is built from, because that
 * copy has to keep the user's comments and their exact formatting -- it is
 * their file, borrowed.
 */
const optionsText = fs.readFileSync(configPath, 'utf8');
const options = YAML.parse(optionsText) ?? {};

/*
 * Where the character comes from.
 *
 * The client reads characters from `profiles/` beside the options file, so this
 * does too. Reading `connection:` instead would be the harness exercising a
 * path the app no longer takes, which is precisely the shape of check that hid
 * automatic login for three phases.
 */
const profilesDir = home.profilesDir;
/** Character *directories*: `profiles/<id>/profile.yaml`. See `app/home.ts`. */
const profileIds = fs.existsSync(profilesDir)
  ? fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  : [];

/*
 * Realms are files, and only files: the options file no longer states them at
 * all. Without reading the directories no character resolves and this check
 * skips -- silently, which is the failure mode CLAUDE.md records the realm
 * rename causing across eight probes.
 */
const servers = [];
for (const id of fs.existsSync(home.serversDir)
  ? fs
      .readdirSync(home.serversDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  : []) {
  try {
    const found = YAML.parse(fs.readFileSync(home.server(id).file, 'utf8'));
    if (found?.host) servers.push({ name: found.name ?? id, ...found });
  } catch {
    // A server that will not parse is one the client would skip too.
  }
}
const byName = (list, name) =>
  list.find((e) => String(e?.name ?? '').toLowerCase() === String(name).trim().toLowerCase());

let who = null;
for (const id of profileIds) {
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(home.profile(id).file, 'utf8'));
  } catch {
    continue;
  }
  if (!raw || typeof raw !== 'object') continue;
  const server = typeof raw.server === 'string' ? byName(servers, raw.server) : raw.server;
  if (!server?.host) continue;
  // No named account store any more: every character's account is inline.
  const account = raw.account && typeof raw.account === 'object' ? raw.account : null;
  who = {
    id,
    host: String(server.host),
    port: String(server.port ?? ''),
    username: String(account?.username ?? ''),
    password: String(account?.password ?? '')
  };
  break;
}

if (!who) {
  console.log(
    `\nno character in ${profilesDir} names a server, so the client has nothing to connect. ` +
      `Copy resources/config/profile.default.yaml into one. Skipping.\n`
  );
  process.exit(0);
}

SESSION = who.id;
const host = who.host;
const port = who.port;
/*
 * The credential rule, enforced rather than intended: this check logs in with
 * the player's real password, so it refuses to run against anything but the
 * test realm. `isLocalRealm` is the one place that says which names mean it —
 * this file used to spell the list out for itself, and a rename left it and
 * seven probes disagreeing about where the server was.
 */
if (!isLocalRealm(host)) {
  console.error(
    `\nRefusing to run: character "${SESSION}" points at ${host}, and ${HOST} is the only server this project logs in to.\n`
  );
  process.exit(1);
}
if (String(port) !== String(PORT)) {
  console.error(
    `\nRefusing to run: character "${SESSION}" points at port ${port}, not the test realm's ${PORT}.\n`
  );
  process.exit(1);
}

const password = who.password;
if (who.username === '' || password === '') {
  console.log(
    `\ncharacter "${SESSION}" has no credentials, so the client cannot reach the realm on its own. Skipping.\n`
  );
  process.exit(0);
}

console.log(
  `\nmudengine live check -- ${SESSION} on ${host}:${port}, options from ${configPath}\n`
);

/*
 * The rule engine is the one part of Phase 5 a fixture cannot settle: it fires
 * on parsed state, and parsed state comes from a real server. So this check
 * runs with one rule loaded — through the *configuration*, which is how rules
 * are meant to arrive. A renderer-facing "load these rules now" call would be a
 * backdoor around the only path that matters.
 *
 * `pro` is the safe command to prove it with: read-only, understood by this
 * server (an unrecognised one would be *said out loud* to the room), and it
 * happens to be the command that answers where the character is.
 */
const PROBE_RULE = {
  name: 'live check: confirm position while idle',
  when: 'every 3s',
  if: ['inCombat == false'],
  then: [{ command: 'pro', priority: 'idle', coalesce: 'live-check' }],
  cooldownMs: 3000
};

/*
 * The copy gets its own directory, and the characters come with it.
 *
 * Characters live in `profiles/` *beside the resolved options file*, so a copy
 * dropped loose into `out/` would inherit whatever happened to be in
 * `out/profiles/` -- which is where the smoke test writes its fixtures. The
 * check would then quietly drive a fake character at a dead port and report on
 * it. An isolated directory is the only version of this that cannot borrow
 * somebody else's characters.
 */
const RUN_DIR = path.resolve('out/live-check-run');
const RUN_CONFIG = path.join(RUN_DIR, 'global', 'default.yaml');
let runHome = home.root;
try {
  const parsed = YAML.parse(optionsText) ?? {};
  parsed.automation = { ...(parsed.automation ?? {}), rules: [PROBE_RULE] };
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(RUN_CONFIG), { recursive: true });
  fs.writeFileSync(RUN_CONFIG, YAML.stringify(parsed), 'utf8');
  // The whole tree, not just the characters: a server is a directory now, and
  // a copy without them is a copy in which no character can name where it
  // plays.
  for (const name of ['profiles', 'servers']) {
    const from = path.join(home.root, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(RUN_DIR, name), { recursive: true });
  }
  if (fs.existsSync(home.globalLoops)) {
    fs.cpSync(home.globalLoops, path.join(RUN_DIR, 'global', 'loops'), { recursive: true });
  }
  runHome = RUN_DIR;
} catch (error) {
  console.log(`   SKIP  could not prepare a rule to check: ${error.message}`);
}

// ------------------------------------------------------------------- launch

fs.rmSync(PROFILE, { recursive: true, force: true });

const appEnv = { ...process.env, MUDENGINE_HOME: runHome };
// VS Code exports this to helper processes and it makes Electron behave as a
// plain Node runtime: no app, no window. See CLAUDE.md.
delete appEnv.ELECTRON_RUN_AS_NODE;

const electron =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : './node_modules/electron/dist/electron';
const args = [
  'out/main/index.js',
  '--no-sandbox',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`
];

// A virtual display when there is a real one to protect: the client takes
// keyboard focus on launch by design, and a check has no business doing that to
// whoever is at the keyboard.
const hasXvfb =
  process.platform === 'linux' &&
  // Either kind of session counts. A Wayland-only desktop has no `DISPLAY` at
  // all, and checking for that alone concluded there was nothing to protect.
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
  spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
/*
 * Refuse to open a real window over someone's session.
 *
 * The app takes keyboard focus on launch by design -- it is the focus policy --
 * and a test has no business doing that to whoever is at the keyboard. When
 * there is a desktop session and no way to hide from it, that is a reason to
 * stop rather than to carry on and hope. Pass --windowed to watch deliberately.
 */
const wantsWindow = process.argv.includes('--windowed');
const hasSession = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
if (hasSession && !hasXvfb && !wantsWindow) {
  console.error(
    '\nThere is a desktop session here and no `xvfb-run` to hide behind, so this\n' +
      'would open a window and take your keyboard. Install xvfb, or pass --windowed\n' +
      'if you meant to watch it.\n'
  );
  process.exit(1);
}

// `detached` so the whole tree can be signalled: under `xvfb-run` -- a shell
// wrapper -- killing the child leaves Electron alive, holding the debugging
// port, and the next run attaches to the previous session's state.
/*
 * Force the X11 backend and hide the real compositor.
 *
 * `xvfb-run` sets `DISPLAY` to a virtual X server, but Electron prefers Wayland
 * when `WAYLAND_DISPLAY` is set and connects to the *real* compositor anyway --
 * so the window opens on the user's actual desktop and takes their keyboard,
 * which is the exact thing running under Xvfb was supposed to prevent. It
 * happened: a run stole focus mid-sentence and the typing went into the game's
 * login prompt, which rejected it.
 */
const xvfbEnv = { ...appEnv };
delete xvfbEnv.WAYLAND_DISPLAY;

const child = hasXvfb
  ? spawn('xvfb-run', ['-a', electron, '--ozone-platform=x11', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: xvfbEnv,
      detached: true
    })
  : spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'], env: appEnv, detached: true });

const NOISE =
  /Fontconfig|wayland|GPU|dbus|Vulkan|MESA|gbm|EGL|invalid |DevTools|Failed to shutdown/i;
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s && !NOISE.test(s)) process.stderr.write(`   [app] ${s}\n`);
});

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  // The copy carries the credentials from the file it was made of. It exists
  // only for the length of this run.
  try {
    if (runHome !== home.root) fs.rmSync(RUN_DIR, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

// ---------------------------------------------------------------------- CDP

async function attach() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* debugger not listening yet */
    }
    await sleep(250);
  }
  throw new Error('renderer never exposed a CDP target');
}

const target = await attach();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const inflight = new Map();
ws.onmessage = (event) => {
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
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');

// A leftover instance from an interrupted run is indistinguishable from a
// working one until its numbers are wrong, so refuse to trust an old renderer.
const firstSeen = await evaluate(`window.__liveCheck ?? (window.__liveCheck = Date.now())`);
if (Date.now() - firstSeen > 60_000) {
  console.error('\nAttached to a renderer from an earlier run. Kill it and try again.\n');
  cleanup();
  process.exit(1);
}

// ------------------------------------------------------- assert: reaching it

let character = null;
for (let i = 0; i < 120; i += 1) {
  character = await evaluate(`window.mudengine.getCharacter('${SESSION}')`);
  if (character?.phase === 'in-game' && character.vitals.hpMax !== null) break;
  await sleep(500);
}

check(character?.phase === 'in-game', 'the client reaches the realm on its own', character?.phase);
check(
  character?.vitals?.hpMax !== null,
  'a maximum is learned from a real stat sheet',
  String(character?.vitals?.hpMax)
);
/*
 * Which realm *this character* plays against.
 *
 * Addressed, because the realm a character plays on names its own world file —
 * and an unaddressed query would answer from whichever realm happened to be the
 * client's, which is a route to a room that does not exist. This is the check
 * that the addressed path reaches a real graph rather than an empty one.
 *
 * It used to be the *character* that named the database. It moved onto the
 * realm on 2026-08-30: two characters on one realm cannot be walking two
 * different maps, so stated per character it was the same answer written out
 * once each with as many places to drift. Nothing here changed — the query was
 * addressed already, which is what made the move a one-line change at the far
 * end of it.
 */
{
  const realm = JSON.parse(
    await evaluate(
      `window.mudengine.worldInfo(${JSON.stringify(SESSION)}).then((w) => JSON.stringify(w))`
    )
  );
  check(realm.rooms > 50_000, 'the character has a realm to play against', JSON.stringify(realm));
  check(
    typeof realm.source === 'string' && realm.source !== 'none',
    'and it says which one',
    JSON.stringify(realm)
  );
}

check(
  character?.room?.map !== null && character?.room?.number !== null,
  'the room resolves against the shipped realm data',
  `${character?.room?.name} -> ${character?.room?.map}/${character?.room?.number}`
);
/*
 * `pro` answers `Location: 1,2147`. Anything else -- a unique name, an exit
 * signature -- is inference, and a route is only as good as its start.
 *
 * Only asserted when the options file actually asks for it. The template is
 * copied once, so a file written before the realm-entry probe learned to ask
 * still has the old list -- and failing the check for that would be blaming the
 * client for the user's configuration. The client says so on connect instead.
 *
 * Either command answers: `rm` and `pro` both carry `Location: 1,2147`, and the
 * probe was changed from the second to the first because `pro` spends thirty
 * lines saying it. A file written before that change still asks for `pro`, and
 * that is a file this check has to keep working for.
 */
const entryProbe = options.automation?.onEnterRealm ?? [];
const asksForProfile = entryProbe.includes('rm') || entryProbe.includes('pro');
if (!asksForProfile) {
  console.log(
    '   SKIP  options file does not ask the realm where it is, so the location is inferred'
  );
} else {
  check(
    character?.room?.resolvedBy === 'coordinates',
    'and does so from coordinates the realm was asked for, not inferred',
    String(character?.room?.resolvedBy)
  );
}
console.log(
  `         ${character?.name} the ${character?.className}, level ${character?.progress?.level}, in ${character?.room?.name}`
);

// ------------------------------------------------------------- assert: vitals

const meters = await evaluate(`
  (() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { level: el.dataset.level, text: el.innerText.trim().replace(/\\s+/g, ' ') };
    };
    return { hp: read('.meter.hp'), mana: read('.meter.mana') };
  })()
`);
// Whatever the character's actual health, the level must agree with the numbers
// the client itself reports — that is checkable without knowing them.
const fraction =
  character?.vitals?.hp !== null && character?.vitals?.hpMax
    ? character.vitals.hp / character.vitals.hpMax
    : null;
const expected =
  fraction === null
    ? 'unknown'
    : fraction <= 0.25
      ? 'critical'
      : fraction <= 0.5
        ? 'caution'
        : 'ok';
check(
  meters?.hp?.level === expected,
  'the hp meter agrees with the numbers',
  `${meters?.hp?.level}, expected ${expected}`
);

// ---------------------------------------------------------- assert: the walk

const here = character?.room;
const candidates =
  (await evaluate(
    `window.mudengine.searchRooms(${JSON.stringify(SESSION)}, ${JSON.stringify(here?.name?.split(',')[0] ?? '')})`
  )) ?? [];
let plan = null;
for (const room of candidates.slice(0, 60)) {
  const route = await evaluate(`window.mudengine.routeTo('${SESSION}', ${room.map}, ${room.room})`);
  if (!route || route.blocked || route.steps.length < 2) continue;
  // Nothing gated: this check walks a real character, so it takes no doors, no
  // level-restricted exits and no skiffs to another island.
  if (route.steps.some((step) => step.requirement !== null)) continue;
  /*
   * The *shortest* viable walk, not the longest.
   *
   * This used to take the longest unobstructed route it could find, and
   * unobstructed is not the same as safe: the realm data marks doors and level
   * gates, and marks nothing at all about water. It walked a level 1 character
   * four rooms into the Silver River, which drowned it — the check that exists
   * so running it is not a way to lose a character nearly lost one.
   *
   * Two steps proves route-walking exactly as well as four and halves the
   * exposure, so shortest-that-is-still-a-real-walk is the right choice.
   */
  if (plan === null || route.steps.length < plan.route.steps.length) plan = { room, route };
}

if (plan === null) {
  console.log('   SKIP  no unobstructed route from here to walk');
} else {
  console.log(`         walking ${plan.route.steps.map((s) => s.command).join(' → ')}`);
  const refused = await evaluate(
    `window.mudengine.walkRoute('${SESSION}', ${JSON.stringify(plan.route)})`
  );
  check(refused === null, 'a route planned from realm data starts walking', String(refused));

  let walk = null;
  for (let i = 0; i < 80; i += 1) {
    walk = await evaluate(`window.mudengine.getWalk('${SESSION}')`);
    if (walk?.status === 'arrived' || walk?.status === 'stopped') break;
    await sleep(500);
  }
  check(walk?.status === 'arrived', 'and arrives', `${walk?.status}: ${walk?.reason}`);
  check(
    walk?.done === plan.route.steps.length,
    'with every step confirmed, not merely sent',
    `${walk?.done}/${walk?.total}`
  );

  const after = await evaluate(`window.mudengine.getCharacter('${SESSION}')`);
  check(
    after?.room?.map === plan.room.map && after?.room?.number === plan.room.room,
    'and is really in the destination room',
    `${after?.room?.name}`
  );

  // Put the character back, so running this check is not a way to lose it.
  const back = await evaluate(
    `window.mudengine.routeTo('${SESSION}', ${here.map}, ${here.number})`
  );
  if (back && !back.blocked && back.steps.length > 0) {
    await evaluate(`window.mudengine.walkRoute('${SESSION}', ${JSON.stringify(back)})`);
    for (let i = 0; i < 80; i += 1) {
      walk = await evaluate(`window.mudengine.getWalk('${SESSION}')`);
      if (walk?.status === 'arrived' || walk?.status === 'stopped') break;
      await sleep(500);
    }
    const home = await evaluate(`window.mudengine.getCharacter('${SESSION}')`);
    check(
      home?.room?.map === here.map && home?.room?.number === here.number,
      'and walks back to where it started',
      home?.room?.name
    );
  }
}

// -------------------------------------------------------- assert: the rules

if (runHome === home.root) {
  console.log('   SKIP  no rule was loaded, so nothing to check');
} else {
  let fired = null;
  for (let i = 0; i < 40; i += 1) {
    const trace = await evaluate(`window.mudengine.getAutomation('${SESSION}')`);
    fired = (trace?.firings ?? []).find((entry) => entry.rule === PROBE_RULE.name) ?? null;
    if (fired) break;
    await sleep(500);
  }
  check(fired !== null, 'a rule loaded from configuration fires against live state');
  check(
    fired !== null && fired.commands.includes('pro'),
    'and proposes the command it was written to propose',
    JSON.stringify(fired)
  );

  /*
   * Waited for, not read once.
   *
   * A firing is recorded when the *decision* is made and `sent` when the bytes
   * go out, and between them is the arbiter -- which paces on the status line,
   * because the server accepts about twenty commands in flight and silently
   * discards the rest. Reading `sent` in the same breath as `firings` is
   * therefore a race the queue is designed to lose, and it did: one run failed
   * here and the next passed, with nothing changed.
   */
  let reached = false;
  for (let i = 0; i < 20 && !reached; i += 1) {
    const pending = await evaluate(`window.mudengine.getAutomation('${SESSION}')`);
    reached = (pending?.sent ?? []).some((entry) => entry.command === 'pro');
    if (!reached) await sleep(500);
  }
  check(
    reached,
    'and the arbiter puts it on the wire'
  );
}

// ------------------------------------------------------ assert: the password

const trace = await evaluate(`window.mudengine.getAutomation('${SESSION}')`);
const sent = (trace?.sent ?? []).map((entry) => entry.command);
check(!sent.includes(password), 'the password is not in the decision trace');

const captureDir = path.resolve('out/captures');
// Only a capture *this* run produced. An older file proves nothing about the
// code under test, and passing on a stale one is worse than skipping.
const captures = (fs.existsSync(captureDir) ? fs.readdirSync(captureDir) : [])
  .filter((f) => f.endsWith('.jsonl'))
  .filter((f) => fs.statSync(path.join(captureDir, f)).mtimeMs >= startedAt);
if (captures.length === 0) {
  console.log('   SKIP  no capture from this run (logging.capture is off)');
} else {
  const newest = captures.sort().at(-1);
  const text = fs.readFileSync(path.join(captureDir, newest), 'utf8');
  check(!text.includes(password), 'the password is not in the session capture', newest);
}

// ------------------------------------------------------------------ artifact

const shot = await cdp('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log(`\n   live screenshot -> ${path.relative(process.cwd(), SHOT)}`);
}

ws.close();
console.log(
  `\n${failures === 0 ? 'All live checks passed.' : `${failures} live check(s) failed.`}\n`
);
cleanup();
process.exit(failures === 0 ? 0 : 1);
