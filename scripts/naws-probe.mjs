/**
 * Does the server honour NAWS, or does it assume 80 columns?
 *
 * The open question in docs/profiles.md §9. It decides what a split pane
 * narrower than 80 columns actually costs: if the server reflows to the width
 * we report, a narrow pane gets narrow prose and only fixed-width art and the
 * status-line repaint break. If it ignores NAWS, every line arrives 80 wide and
 * is wrapped client-side, the `CSI 79 D` repaint lands mid-wrapped-line, and
 * `LineTokenizer` mis-frames the prompt.
 *
 * This drives the real `SessionManager` rather than a hand-rolled socket, so
 * what it measures is what the client actually does: real option negotiation,
 * real NAWS reporting, real framing with its terminator tags.
 *
 * Read-only against the character. The only command it sends is `l`.
 *
 *   node --import tsx scripts/naws-probe.mjs [local|bearfather]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { normalizeConfig } from '../src/shared/config.ts';
import { HOST as LOCAL_HOST, PORT as LOCAL_PORT, localProfile } from './lib/local-realm.mjs';

/**
 * The servers this probe may dial, and what it may do to each.
 *
 * Not a free parameter: an arbitrary host would make this a general-purpose
 * dialler, and the standing rule is that this project connects to known targets
 * only. `bearfather` is the sanctioned second reference realm, added so the
 * NAWS finding could be checked against a MajorMUD server rather than assumed
 * to be family-wide from one GreaterMUD instance.
 *
 * `mayLogIn` is the load-bearing field, and it is a structural guard rather
 * than an intention. The probe reads `resources/config/user.yaml` for its login
 * answers, so pointing it at a third-party realm without this would send the
 * player's local-server credentials to somebody else's machine. Phase C is
 * therefore skipped anywhere but the test realm, in code, where forgetting is
 * not possible. The realm's address comes from `scripts/lib/local-realm.mjs`,
 * which is the one place that says where it is: this file used to name it
 * itself, and the name it held was two renames out of date.
 */
const TARGETS = {
  local: { host: LOCAL_HOST, port: LOCAL_PORT, encoding: 'cp437', mayLogIn: true },
  bearfather: { host: 'bbs.bearfather.net', port: 23, encoding: 'cp437', mayLogIn: false }
};

const which = process.argv[2] ?? 'local';
const TARGET = TARGETS[which];
if (!TARGET) {
  console.error(`unknown target "${which}" — one of: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}
const { host: HOST, port: PORT, encoding: ENCODING } = TARGET;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env['NAWS_PROBE_OUT'] ?? path.join(dirname, '..', 'out');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ measuring

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Every `CSI <n> D` (cursor back) in the stream, counted by n. */
function cursorBack(text) {
  const counts = new Map();
  for (const m of text.matchAll(/\x1b\[(\d*)D/g)) {
    const n = m[1] === '' ? 1 : Number(m[1]);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Visible width of each CRLF-delimited line, ANSI removed. */
function lineWidths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, '').replace(/\r/g, '').length)
    .filter((n) => n > 0);
}

function widthSummary(text) {
  const widths = lineWidths(text);
  if (widths.length === 0) return { lines: 0, max: 0, p95: 0, over80: 0 };
  const sorted = [...widths].sort((a, b) => a - b);
  return {
    lines: widths.length,
    max: sorted[sorted.length - 1],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    over80: widths.filter((w) => w > 80).length
  };
}

// -------------------------------------------------------------------- driving

function openSession({ cols, rows }, login, automation) {
  const raw = [];
  const lines = [];
  const telnet = [];
  const notices = [];

  const session = new SessionManager(
    {
      data: (chunk) => raw.push(chunk.text),
      line: (line) => lines.push(line),
      block: () => {},
      character: () => {},
      state: () => {},
      telnet: (event) => telnet.push(event),
      notice: (message) => notices.push(message)
    },
    undefined,
    automation,
    login
  );

  session.resize({ cols, rows });
  return { session, raw, lines, telnet, notices, text: () => raw.join('') };
}

async function connectAndSettle(probe, ms) {
  await probe.session.connect({ host: HOST, port: PORT, encoding: ENCODING });
  await wait(ms);
}

function close(probe) {
  probe.session.disconnect();
  probe.session.dispose();
}

// --------------------------------------------------------------------- phases

/**
 * Phase A — the negotiation census.
 *
 * The client performs NAWS only when the peer sends DO NAWS; `windowSizeReport`
 * returns an empty buffer otherwise. So the first question is not "does the
 * server reflow" but "does it ever ask", and if it does not, nothing downstream
 * of that matters.
 */
async function phaseA(config) {
  const noLogin = { ...config.connection.login, enabled: false };
  const probe = openSession({ cols: 80, rows: 24 }, noLogin, config.automation);
  await connectAndSettle(probe, 6000);
  close(probe);

  const summaries = probe.telnet.map((e) => `${e.direction.toUpperCase()} ${e.summary}`);
  return {
    negotiation: summaries,
    serverAskedForNaws: summaries.some((s) => /^IN DO NAWS/.test(s)),
    weReportedNaws: summaries.some((s) => /^OUT SB NAWS/.test(s)),
    bytes: probe.text().length,
    cursorBack: cursorBack(probe.text()),
    widths: widthSummary(probe.text())
  };
}

/**
 * Phase B — is anything before login width-dependent?
 *
 * Three connections, not two. The obvious experiment — wide, narrow, compare —
 * cannot tell "the server reflowed" from "the banner carries a node number or a
 * clock". So the third connection repeats the *first* geometry as a control: if
 * the same-width pair also differs, the difference is session noise and the
 * cross-width comparison says nothing. A public BBS front-end made this
 * necessary rather than pedantic; it compared identical on one run and not on
 * the next, at the same two widths.
 *
 * Needs no credentials on any server: everything here happens before login.
 */
async function phaseB(config) {
  const noLogin = { ...config.connection.login, enabled: false };
  const plan = [
    { label: 'wide', size: { cols: 200, rows: 50 } },
    { label: 'narrow', size: { cols: 40, rows: 12 } },
    { label: 'control', size: { cols: 200, rows: 50 } }
  ];

  const results = [];
  for (const { label, size } of plan) {
    const probe = openSession(size, noLogin, config.automation);
    await connectAndSettle(probe, 6000);
    close(probe);
    results.push({ label, size, text: probe.text() });
    await wait(500);
  }

  const [wide, narrow, control] = results;
  const differs = (a, b) => {
    if (a === b) return null;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return {
      atByte: i,
      a: JSON.stringify(a.slice(i, i + 48)),
      b: JSON.stringify(b.slice(i, i + 48))
    };
  };

  return {
    wide: { size: wide.size, bytes: wide.text.length, widths: widthSummary(wide.text) },
    narrow: { size: narrow.size, bytes: narrow.text.length, widths: widthSummary(narrow.text) },
    control: { size: control.size, bytes: control.text.length, widths: widthSummary(control.text) },
    /** Different geometry. */
    crossWidthIdentical: wide.text === narrow.text,
    crossWidthDiff: differs(wide.text, narrow.text),
    /** Same geometry — the control. If this also differs, the above means nothing. */
    sameWidthIdentical: wide.text === control.text,
    sameWidthDiff: differs(wide.text, control.text)
  };
}

/**
 * Phase C — in the realm, where the status line is.
 *
 * The repaint marker only exists once there is a status line to repaint, which
 * means logging in. Sends `l` at each width and nothing else: no movement, so
 * there is no character to walk back.
 */
async function phaseC(config) {
  // Never against anything but the local server. See TARGETS.
  if (!TARGET.mayLogIn) {
    return { skipped: `credentials are never sent to ${HOST}; phase C is ${LOCAL_HOST}-only` };
  }
  /*
   * The account is a character's, never the options file's: the options file
   * has held none since the anonymous session was retired (2026-08-29), and
   * `localProfile` hands out only a character that plays on the local realm.
   */
  const who = localProfile();
  if (who === null) return { skipped: 'no character configured for the local realm' };
  const login = who.config.connection.login;
  if (!login.enabled || !login.username || !login.password) {
    return { skipped: `no credentials configured for ${who.id}` };
  }

  // The standing routines would send commands of their own into the middle of a
  // measurement. Login stays real; the idle poke does not.
  const automation = {
    ...config.automation,
    idle: { ...config.automation.idle, enabled: false }
  };

  const probe = openSession({ cols: 80, rows: 24 }, login, automation);
  await probe.session.connect({ host: HOST, port: PORT, encoding: ENCODING });

  // In the realm is "the status line has appeared" — the same discriminator the
  // parser uses. Nothing before that point is recorded: the login exchange can
  // carry an echoed password.
  const deadline = Date.now() + 45000;
  let realmAt = -1;
  while (Date.now() < deadline) {
    await wait(250);
    const found = probe.text().indexOf('[HP=');
    if (found !== -1) {
      realmAt = found;
      break;
    }
  }
  if (realmAt === -1) {
    close(probe);
    return { skipped: 'never reached the realm within 45s', notices: probe.notices };
  }

  await wait(3000);

  const samples = [];
  const mark = () => probe.text().length;

  for (const cols of [80, 40, 132, 80]) {
    probe.session.resize({ cols, rows: 24 });
    // NAWS_COALESCE_MS is 150; give the report time to land and the server time
    // to act on it before asking for anything.
    await wait(1500);
    const from = mark();
    probe.session.send('l\r');
    await wait(2500);
    const slice = probe.text().slice(from);
    samples.push({
      cols,
      bytes: slice.length,
      widths: widthSummary(slice),
      cursorBack: cursorBack(slice),
      repaintLines: probe.lines.filter((l) => l.terminator === 'repaint').length
    });
  }

  close(probe);

  return {
    reachedRealm: true,
    samples,
    // Only from the realm onward — see above.
    realmText: probe.text().slice(realmAt)
  };
}

// ------------------------------------------------------------------------ run

async function main() {
  const configFile = path.join(dirname, '..', 'resources', 'config', 'user.yaml');
  const source = fs.existsSync(configFile) ? parse(fs.readFileSync(configFile, 'utf8')) : {};
  const config = normalizeConfig(source);

  console.log(`naws-probe -> ${which} (${HOST}:${PORT}, ${ENCODING})\n`);

  console.log('phase A: negotiation census');
  const a = await phaseA(config);
  for (const line of a.negotiation) console.log(`  ${line}`);
  console.log(`  server asked for NAWS: ${a.serverAskedForNaws}`);
  console.log(`  we reported NAWS:      ${a.weReportedNaws}`);
  console.log(`  banner: ${a.bytes} bytes, ${JSON.stringify(a.widths)}`);
  console.log(`  cursor-back markers: ${JSON.stringify(a.cursorBack)}\n`);

  console.log('phase B: 200x50 vs 40x12, with a 200x50 control');
  const b = await phaseB(config);
  console.log(`  wide:    ${b.wide.bytes} bytes ${JSON.stringify(b.wide.widths)}`);
  console.log(`  narrow:  ${b.narrow.bytes} bytes ${JSON.stringify(b.narrow.widths)}`);
  console.log(`  control: ${b.control.bytes} bytes ${JSON.stringify(b.control.widths)}`);
  console.log(`  cross-width identical: ${b.crossWidthIdentical}`);
  if (b.crossWidthDiff) console.log(`    first difference at byte ${b.crossWidthDiff.atByte}`);
  console.log(`  same-width identical:  ${b.sameWidthIdentical}   <- the control`);
  if (b.sameWidthDiff) {
    console.log(`    first difference at byte ${b.sameWidthDiff.atByte}`);
    console.log(`      a: ${b.sameWidthDiff.a}`);
    console.log(`      b: ${b.sameWidthDiff.b}`);
  }
  console.log();

  console.log('phase C: in the realm');
  const c = await phaseC(config);
  if (c.skipped) {
    console.log(`  skipped — ${c.skipped}`);
    if (c.notices) for (const n of c.notices) console.log(`    notice: ${n}`);
  } else {
    for (const s of c.samples) {
      console.log(
        `  NAWS ${String(s.cols).padStart(3)}x24 -> ${String(s.bytes).padStart(5)} bytes  ` +
          `max=${String(s.widths.max).padStart(3)} p95=${String(s.widths.p95).padStart(3)} ` +
          `over80=${s.widths.over80}  cursorBack=${JSON.stringify(s.cursorBack)}`
      );
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const report = path.join(OUT, `naws-probe.${which}.json`);
  fs.writeFileSync(report, JSON.stringify({ phaseA: a, phaseB: b, phaseC: c }, null, 2));
  console.log(`\nreport: ${report}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
