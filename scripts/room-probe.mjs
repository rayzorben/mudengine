/**
 * Where does room tracking hold, and where does it let go?
 *
 * Walks a short there-and-back route on `gmud-tgs:2427` and reports, per room
 * block, what the client believed and why: the parsed name, the exits, the
 * direction it thought it had walked, and which rung of the disambiguation
 * ladder answered.
 *
 * The interesting rows are the ones where a *known* location becomes unknown
 * without the character having moved.
 *
 * Read-only apart from movement, and it walks back to where it started.
 *
 *   node --import tsx scripts/room-probe.mjs
 */
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { HOST, PORT, localProfile, skip, target } from './lib/local-realm.mjs';
import { OPPOSITE } from '../src/shared/world.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Credentials never leave the test realm; `localProfile` is what enforces it —
 * a character is chosen by *target*, never by filename, so a file renamed or a
 * second character added cannot send a password somewhere else by accident.
 */
const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\nroom-probe -> ${HOST}:${PORT}, ${world.size} rooms of realm data\n`);

const rows = [];
const corpus = [];
let last = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.trim();
      if (text.length === 0) return;
      rows.push({ kind: 'line', text: text.slice(0, 68), term: line.terminator });
      // Everything the server said, for pattern work. The room-name rule is the
      // loosest in the table, so widening it has to be measured against real
      // prose and not only against real names.
      corpus.push(text);
    },
    block: (block) => {
      rows.push({
        kind: 'block',
        type: block.type,
        text: (block.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        groups: JSON.stringify(block.groups ?? {}).slice(0, 70)
      });
    },
    character: (state) => {
      const room = state.room;
      const key = `${room.map}/${room.number}/${room.name}/${room.resolvedBy}/${room.ambiguous}`;
      if (key === last) return;
      last = key;
      rows.push({
        kind: 'room',
        name: room.name,
        at: room.map === null ? '—' : `${room.map},${room.number}`,
        by: room.resolvedBy ?? '—',
        conf: room.confidence?.toFixed?.(2) ?? '—',
        amb: room.ambiguous,
        exits: room.exits.map((e) => e.direction).join(' ')
      });
    },
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  world,
  // No standing routines: this measures what commands *here* cause.
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false },
    rules: []
  },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

/** Marks the trace, so a row can be read next to what provoked it. */
function say(what) {
  rows.push({ kind: 'sent', what });
}

async function send(command, settle = 1600) {
  say(command === '' ? '<enter>' : command);
  session.send(`${command}\r`);
  await wait(settle);
}

async function main() {
  await session.connect(target());

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await wait(250);
    if (session.character.phase === 'in-game') break;
  }
  await wait(2500);

  // The script. Each line is chosen to isolate one thing.
  await send('pro'); //          coordinates: the only statement of position
  await send('l n'); //          a look *in a direction*: describes somewhere else
  await send('l'); //            a look, no movement -- must not lose it
  await send(''); //             a bare Enter, not a direction -- must not lose it
  const exits = session.character.room.exits.map((e) => e.direction);
  const out = exits[0] ?? 'n';
  const back = OPPOSITE[out];
  await send(out); //            a real move
  await send(''); //             Enter again, in the new room
  await send('l'); //            and a look
  // A direction the room does not have: the wall case, which is what makes a
  // queued run of directions desynchronise.
  const wall = ['n', 's', 'e', 'w'].find((d) => !exits.includes(d) && d !== back) ?? 'u';
  await send(wall);
  await send(''); //             and does the failure leave the belief intact?
  await send(back); //           walk home

  // A longer wander, purely to collect prose for the pattern work. Every step
  // is retraced, so the character ends where it began.
  const trail = [];
  for (let i = 0; i < 6; i += 1) {
    const here = session.character.room.exits.map((e) => e.direction);
    const step = here.find((d) => d !== 'u' && d !== 'd' && d !== trail[trail.length - 1]);
    if (!step) break;
    await send(step);
    trail.push(OPPOSITE[step]);
  }
  for (const step of trail.reverse()) await send(step);

  await send('pro'); //          and confirm where home actually is

  session.disconnect();
  session.dispose();

  for (const row of rows) {
    if (row.kind === 'sent') console.log(`\n  > ${row.what}`);
    else if (row.kind === 'line') console.log(`      | ${row.text}`);
    else if (row.kind === 'block') console.log(`    [${row.type}] ${row.groups}`);
    else
      console.log(
        `    ==> ${(row.name ?? 'NO NAME').padEnd(30)}${row.at.padEnd(10)}` +
          `${row.by.padEnd(16)}conf ${row.conf}  amb ${row.amb}  exits[${row.exits}]`
      );
  }
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/room-lines.txt', corpus.join('\n') + '\n');
  console.log(`  ${corpus.length} lines -> out/room-lines.txt\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
