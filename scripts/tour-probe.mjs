/**
 * What can this client still not read?
 *
 * Connects to `orohost:2427`, asks the realm a long list of harmless
 * questions, walks a few rooms and back, and reports every line the classifier
 * could not type — grouped by shape, commonest first, with the command that
 * provoked each.
 *
 * This is the development loop CLAUDE.md insists on: **patterns come from
 * captures, not from another client's source.** The `who` row's trailing status
 * flag and the three unknown columns on the stat sheet were both found this
 * way, and both would have been written wrong from memory.
 *
 * Read-only apart from movement, and it walks back to where it started. Every
 * command below is a question — nothing here attacks, buys, drops or says
 * anything out loud.
 *
 *   npm run probe:tour
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { HOST, PORT, localProfile, skip, target } from './lib/local-realm.mjs';
import { creditEveryBatch, isBatch } from './lib/batches.mjs';
import { OPPOSITE } from '../src/shared/world.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Credentials never leave the test realm; `localProfile` is what enforces it. */
const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\ntour-probe -> ${HOST}:${PORT}\n`);

/** Every framed line, with what provoked it and what the classifier made of it. */
const seen = [];
/**
 * Blocks by the sequence of the line they were made from.
 *
 * Keyed on `seq` rather than attributed to the most recent line, because a
 * *batch* — a stat sheet, an inventory, a `who` listing — arrives as a second
 * block for the line that completed it. An earlier version of this probe kept
 * only the first block per line and so reported every batch as unread, which is
 * exactly the false alarm a diagnostic must not raise.
 */
const blocksBySeq = new Map();
/** Every batch of the run, so its member lines can be credited at report time. */
const batches = [];
let provokedBy = '(connect)';

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      seen.push({ seq: line.seq, text, after: provokedBy, types: [] });
    },
    block: (block) => {
      if (isBatch(block)) batches.push(block);
      const types = blocksBySeq.get(block.seq) ?? [];
      types.push(block.type);
      blocksBySeq.set(block.seq, types);
    },
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  world,
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false },
    rules: []
  },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

async function ask(command, settle = 1400) {
  provokedBy = command === '' ? '<enter>' : command;
  session.send(`${command}\r`);
  await wait(settle);
}

/**
 * Questions only.
 *
 * Every one of these is something the realm answers without changing anything:
 * no attacking, no buying, no dropping, nothing said out loud. A probe that
 * plays the character is a probe nobody can safely run twice.
 */
/*
 * Every one of these is in the server's own command table
 * (docs/greatermud/commands.md). That matters more than it looks: **an
 * unrecognised command is not refused, it is said out loud**, so a probe that
 * guesses at command names broadcasts them to everybody in the room. An earlier
 * version of this list guessed at five — `spells`, `skills`, `equipment`,
 * `gold`, `quests` — and the realm dutifully repeated all five.
 */
const QUESTIONS = [
  'pro',
  'st',
  'i',
  'exp',
  'health',
  'who',
  'l',
  // `rm` is `Room` in the command table, and worth asking about separately from
  // `l`: auto-combat re-reads the room every few rounds, and `l` prints the
  // name, the whole description, the items and the exits every time. If `rm`
  // answers with less, it is the cheaper command for the same fact.
  'rm',
  'ab',
  'wealth',
  'party'
];

async function main() {
  await session.connect(target());

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await wait(250);
    if (session.character.phase === 'in-game') break;
  }
  if (session.character.phase !== 'in-game') {
    console.log('  never reached the realm; nothing to measure.\n');
    session.dispose();
    return;
  }
  await wait(2500);

  for (const question of QUESTIONS) await ask(question);

  // A short there-and-back walk, for the room and movement shapes.
  const trail = [];
  for (let i = 0; i < 4; i += 1) {
    const here = session.character.room.exits.map((exit) => exit.direction);
    const step = here.find((d) => d !== 'u' && d !== 'd' && d !== trail[trail.length - 1]);
    if (!step) break;
    await ask(step);
    trail.push(OPPOSITE[step]);
  }
  for (const step of trail.reverse()) await ask(step);

  session.disconnect();
  session.dispose();

  /* ------------------------------------------------------------- report */

  for (const entry of seen) entry.types = blocksBySeq.get(entry.seq) ?? [];
  /*
   * Credited *after* the types are attached, because that assignment replaces
   * whatever was there. A member line reads as `unknown` on its own and the
   * batch is the parse; counting it as a gap is the false alarm this probe
   * exists to avoid raising.
   */
  const credited = creditEveryBatch(seen, batches);
  const isUnread = (entry) =>
    entry.types.length === 0 || entry.types.every((type) => type === 'unknown');

  /*
   * Split at the first status line, which is the in-game discriminator.
   *
   * Before it is the banner and the BBS menus: art the server draws broken
   * (documented, expected) and menu bodies the client deliberately does not
   * parse, because the login automator matches *prompts* and reading the menu
   * around them would be a second thing to keep true. Counting those as
   * failures buries the ones that are.
   */
  const entered = seen.findIndex((entry) => entry.types.includes('status-line'));
  const before = entered === -1 ? seen : seen.slice(0, entered);
  const after = entered === -1 ? [] : seen.slice(entered);
  const unknown = after.filter(isUnread);
  const typed = after.length - unknown.length;

  console.log(`  ${seen.length} lines: ${before.length} before the realm, ${after.length} in it`);
  console.log(
    `  in the realm: ${typed} of ${after.length} read ` +
      `(${((typed / Math.max(1, after.length)) * 100).toFixed(1)}%)\n`
  );
  console.log(
    `  ${credited} of those were members of a batch — a stat sheet, an inventory, a\n` +
      '  `who` listing. Each reads as unknown on its own; the batch is the parse, and\n' +
      '  it is attributed to the line that completed it. They are counted as read.\n'
  );

  const histogram = new Map();
  for (const entry of seen) {
    for (const type of entry.types.length > 0 ? entry.types : ['unknown']) {
      histogram.set(type, (histogram.get(type) ?? 0) + 1);
    }
  }
  console.log('  what it read:');
  for (const [type, count] of [...histogram].sort((a, b) => b[1] - a[1])) {
    if (type === 'unknown') continue;
    console.log(`    ${String(count).padStart(4)}  ${type}`);
  }

  /*
   * Grouped by *shape* rather than by text: forty status lines differing only
   * in a number are one thing to look at, not forty.
   */
  const shapes = new Map();
  for (const entry of unknown) {
    const shape = entry.text.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 70);
    if (!shapes.has(shape))
      shapes.set(shape, { count: 0, example: entry.text, after: entry.after });
    shapes.get(shape).count += 1;
  }

  console.log(
    `\n  ${unknown.length} lines in the realm it could not type, ${shapes.size} shapes:\n`
  );
  for (const [, entry] of [...shapes].sort((a, b) => b[1].count - a[1].count).slice(0, 60)) {
    console.log(
      `    ${String(entry.count).padStart(3)}x after \`${entry.after}\`  ${entry.example.slice(0, 90)}`
    );
  }

  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/tour-probe.json', `${JSON.stringify(seen, null, 2)}\n`);
  console.log(`\n  full capture -> out/tour-probe.json\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
