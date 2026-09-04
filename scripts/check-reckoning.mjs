/**
 * Grades the client's sense of where it is against the server's own answer.
 *
 *   npm run check:reckoning [-- <logs directory>] [--anchor]
 *
 * Replays every recorded session through the **real** `Classifier` and
 * `CharacterTracker` with the shipped realm, and compares what the client
 * worked out for itself against every `Location: map,room` the server ever
 * stated — the one thing this server says about position that is not
 * inference.
 *
 * The answer key is withheld from the tracker. `user-profile` blocks are
 * scored and then **not applied**, so what is graded is what the client would
 * have believed with no `rm` at all. That is the question the harness exists
 * for, and it is not a question `check:live` can answer: `rm` is a GreaterMUD
 * word, MajorMUD has neither it nor `pro`, and a client that can only stay
 * placed by asking cannot play there.
 *
 * Three outcomes, and the middle one is the only real failure:
 *
 * - **agreed** — the client and the server named the same room.
 * - **wrong room** — the client named a different one. A route planned from
 *   here goes somewhere the character may not get back from, so this is the
 *   number that must stay at nought.
 * - **lost** — the client declined to name one. Honest, recoverable, and much
 *   cheaper than being wrong; a loop asks once and carries on.
 *
 * With `--anchor` the server's answer is applied after scoring, so each fix
 * grades only the stretch since the last one. Without it — the default — the
 * whole session is graded from one opening fix, which is the harder question
 * and the one worth asking.
 *
 * Recorded 2026-08-30 over 113 sessions, 2,159 rooms and 5,843 commands: 85
 * of 85 agreed, none wrong, none lost. Before the same run found the bug it
 * was written to look for — a command the server refused leaving a move
 * queued that no room was coming for — it was 76 of 85 with nine losses, all
 * of them one dark corridor in the sewer.
 */
import fs from 'node:fs';
import path from 'node:path';

import { homePaths } from './lib/home.mjs';

// Through `tsx` (see the npm script) so the real parser is the one graded.
// Replaying against a copy of it would grade the copy.
const { Classifier } = await import('../src/main/parse/Classifier.ts');
const { CharacterTracker } = await import('../src/main/parse/CharacterTracker.ts');
const { WorldGraph } = await import('../src/main/world/WorldGraph.ts');

const args = process.argv.slice(2);
const anchor = args.includes('--anchor');
const dir = args.find((value) => !value.startsWith('--')) ?? homePaths().logs;

const realmFile = path.resolve('resources/world/rooms.jsonl.gz');
const world = WorldGraph.load(realmFile);
if (world.size === 0) {
  console.error(`no realm data at ${realmFile} — run \`npm run build:world\``);
  process.exit(1);
}

if (!fs.existsSync(dir)) {
  // Not a failure: a checkout with no recorded play has nothing to grade. Said
  // out loud rather than exiting zero in silence, which is how a probe goes
  // quiet without going red.
  console.log(`no session logs at ${dir} — set \`logging.capture: true\` and play.`);
  process.exit(0);
}

const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.mudcap.jsonl'))
  .sort();

const score = { asked: 0, agreed: 0, wrong: 0, ambiguous: 0, lost: 0 };
const failures = [];
let rooms = 0;
let commands = 0;

for (const name of files) {
  const events = fs
    .readFileSync(path.join(dir, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // One malformed line costs one line, not the file.
        return null;
      }
    })
    .filter(Boolean);

  const classifier = new Classifier();
  const tracker = new CharacterTracker(world);
  let seq = 0;
  let placed = false;

  for (const event of events) {
    if (event.k === 'out') {
      // Both, and in this order, because `SessionManager` does both: what a
      // line *is* depends on the command before it.
      classifier.observeCommand(event.s);
      tracker.observeCommand(event.s);
      commands += 1;
      continue;
    }
    if (event.k !== 'line') continue;

    seq += 1;
    let classified;
    try {
      classified = classifier.classify({
        seq,
        at: event.t,
        text: event.raw ?? event.s,
        plain: event.s,
        terminator: event.term ?? 'newline'
      });
    } catch {
      continue;
    }

    const block = classified.block;
    if (block.type === 'room-exits') rooms += 1;

    if (block.type !== 'user-profile') {
      try {
        tracker.apply(block, classified.batch?.rows);
      } catch {
        // A parser fault costs a line, never the replay: the same guarantee
        // `publishLine` gives the terminal.
      }
      continue;
    }

    const map = Number(block.groups['map']);
    const room = Number(block.groups['room']);
    if (!Number.isFinite(map) || !Number.isFinite(room)) continue;

    if (!placed) {
      // The opening fix. Nothing to grade against, and from here on the client
      // has a room — the precondition everything below rests on.
      placed = true;
      tracker.apply(block, classified.batch?.rows);
      continue;
    }

    const belief = tracker.current.room;
    score.asked += 1;
    if (belief.map === null || belief.number === null) {
      if (belief.ambiguous > 1) score.ambiguous += 1;
      else score.lost += 1;
      failures.push(
        `${name} t=${event.t}  no room named (candidates ${belief.ambiguous})` +
          `  — server says ${map},${room} "${world.get(map, room)?.name ?? '?'}"`
      );
    } else if (belief.map === map && belief.number === room) {
      score.agreed += 1;
    } else {
      score.wrong += 1;
      failures.push(
        `${name} t=${event.t}  believed ${belief.map},${belief.number} "${belief.name}"` +
          ` by ${belief.resolvedBy} — server says ${map},${room} "${world.get(map, room)?.name ?? '?'}"`
      );
    }

    if (anchor) tracker.apply(block, classified.batch?.rows);
  }
}

const of = (count) => (score.asked === 0 ? '—' : `${((count / score.asked) * 100).toFixed(1)}%`);

console.log(`\n${dir}`);
console.log(
  `  ${files.length} sessions, ${rooms.toLocaleString()} rooms, ` +
    `${commands.toLocaleString()} commands sent` +
    (anchor ? ', re-anchored at every fix' : ', graded from one opening fix')
);
console.log(`\n  positions the server stated and the client had to have known: ${score.asked}`);
console.log(`    agreed      ${score.agreed}\t${of(score.agreed)}`);
console.log(`    WRONG ROOM  ${score.wrong}\t${of(score.wrong)}`);
console.log(`    ambiguous   ${score.ambiguous}\t${of(score.ambiguous)}`);
console.log(`    lost        ${score.lost}\t${of(score.lost)}`);

if (failures.length > 0) {
  console.log('\n  where it did not agree:');
  for (const line of failures.slice(0, 20)) console.log(`    ${line}`);
  if (failures.length > 20) console.log(`    … and ${failures.length - 20} more`);
}

/*
 * The positive control, and it is the whole reason this prints a count of what
 * it graded rather than only a verdict.
 *
 * A replay that classified nothing, applied nothing, or found no session where
 * the server ever stated a position reports nought wrong just as loudly as a
 * clean one does. `capture:corpus` was dead for a day without anything going
 * red; this is the same shape and gets the same guard.
 */
if (score.asked === 0) {
  console.log(
    '\nNothing was graded: no session here ever asked the realm where it was, so\n' +
      'there is no answer key to grade against. That is not a pass.'
  );
  process.exit(1);
}

/*
 * A wrong room is the only exit code that fails. Being lost is the honest
 * answer to evidence that does not settle it, and a harness that failed on it
 * would be pressing the client to guess — which is the one thing every rule in
 * `resolve.ts` exists to stop it doing. The lost count is a quality number for
 * a person to read, and the run that motivated this harness had nine of them.
 */
if (score.wrong > 0) {
  console.log('\nA wrong room sends the pathfinder somewhere the character may not return from.');
  process.exit(1);
}
console.log('');
