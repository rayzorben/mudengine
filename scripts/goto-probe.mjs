/**
 * What does the realm answer to a `sys go` / `sys goto`, and how fast?
 *
 * Todo 813's last-ditch escape sends a realm's own teleport, written out
 * literally per realm (`server.yaml` `fleeGoto:`). GreaterMUD's is
 * `sys go <map> <room>`, a sysop's tool (`SysCommand.cs:196`); MajorMUD's is
 * `sys goto <place>`. This asks both forms, a room that does not exist, and
 * times each answer, so the escape reads what the wire says rather than what
 * a fork assumed (8515f4f: "prints no room, send an Enter").
 *
 *   npm run probe:goto -- --as probe
 *
 * `--as` is required: the character must be one that is not already online.
 * Nothing here attacks; the mid-fight answer is read from the player's own
 * logs (see `mudengine-verify` › probes).
 */
import { setTimeout as wait } from 'node:timers/promises';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfileNamed, skip, target } from './lib/local-realm.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--as');
const asName = at >= 0 ? args[at + 1] : undefined;
if (!asName) skip('say which character with --as <name>; it must not already be online.');
const profile = localProfileNamed(asName);
if (!profile) skip(`no character "${asName}" on ${HOST}:${PORT} with credentials.`);

console.log(`\ngoto-probe -> ${HOST}:${PORT} as ${profile.id}\n`);

const runs = [];
let current = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0 || current === null) return;
      current.lines.push({ ms: Date.now() - current.at, text: line.plain });
    },
    block: (block) => {
      if (current === null) return;
      current.blocks.push({ ms: Date.now() - current.at, type: block.type });
    },
    players: () => {},
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  {
    // Nothing automated: only the probe's own commands go out.
    automation: {
      ...profile.config.automation,
      enabled: false,
      idle: { ...profile.config.automation.idle, enabled: false },
      rules: []
    },
    login: profile.config.connection.login
  }
);

session.resize({ cols: 80, rows: 24 });

async function run(command, settle = 4000) {
  current = { command, at: Date.now(), lines: [], blocks: [] };
  runs.push(current);
  session.send(`${command}\r`);
  await wait(settle);
  current = null;
}

/** Asks, and returns whether the realm was reached; the caller always disposes. */
async function ask() {
  await session.connect(target());
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await wait(250);
    if (session.character.phase === 'in-game') break;
  }
  if (session.character.phase !== 'in-game') {
    console.log('  never reached the realm; nothing to measure.\n');
    return false;
  }
  await wait(3000);

  await run('rm');
  await run('sys go 1 297');
  await run('rm');
  await run('sys goto silvermere');
  await run('sys go 1 999999');
  await run('sys');
  session.disconnect();
  return true;
}

let reached = false;
try {
  reached = await ask();
} finally {
  session.dispose();
}

if (reached) {
  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines)
      console.log(`      +${line.ms}ms | ${JSON.stringify(line.text)}`);
    console.log(
      `    blocks: ${entry.blocks.map((b) => `${b.type}@${b.ms}`).join(', ') || '(none)'}`
    );
  }
  console.log('');
}
