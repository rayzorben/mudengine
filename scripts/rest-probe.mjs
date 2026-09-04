/**
 * Which commands break a rest, and which do not?
 *
 * ## Why this was rewritten
 *
 * The first version of this probe printed a table and left a person to read a
 * verdict into it. What got read was *anything breaks a rest* — and the client
 * was built on it: a `restUntil` threshold that sent `l` to stand a character
 * up, because standing up costs a command anyway so it may as well re-read the
 * room. A look does not break a rest. On 2026-08-27 a character at full health
 * in a room it could not be stood up from answered the same status line with
 * the same look **431 times in fourteen seconds**
 * (`logs/2026-08-27_21-24-03_main.mudcap.jsonl`).
 *
 * Two faults produced that, and this version fixes both:
 *
 * - **It reported observations, not verdicts.** `flagsIn` asked whether
 *   `(Resting)` appeared *anywhere* in the window after a command — which it
 *   does either way, because the prompt that carried the command's own echo was
 *   printed while the character was still resting. The question is what the
 *   **last** status line says once the command has been answered, and that is
 *   what this decides now.
 * - **It had no positive control.** Nothing in the run was known to break a
 *   rest, so "it did not break" and "this probe cannot see a break" were the
 *   same output. A move is the control here: if the move does not clear the
 *   flag, every other negative in the run is worthless, and this says so
 *   instead of printing them.
 *
 * ## What it does
 *
 * For each candidate: sit the character down, confirm `(Resting)` is up, send
 * the candidate, and read the last status line it produced.
 *
 * Nothing here attacks, buys, drops or says anything out loud. The one command
 * that changes anything is the control, which steps through an exit the room
 * itself listed and steps straight back.
 *
 * `--cast <short name>` adds the one candidate that needs a spell — see `CAST`.
 * Casting was never in the list, and the client's belief that a character could
 * cast sitting down turned out to be wrong on Paradigm (2026-09-02).
 *
 *   npm run probe:rest
 *   npm run probe:rest -- --cast swan
 */
import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfile, skip, target } from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opposites, so the control can put the character back where it found it. */
const BACK = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
  northeast: 'southwest',
  southwest: 'northeast',
  northwest: 'southeast',
  southeast: 'northwest'
};

/**
 * The commands worth asking about, and why each one is in the list.
 *
 * Every one of these is something the client either sends on its own or wants
 * to: if any of them breaks a rest, a character resting to heal is being stood
 * up by its own client.
 */
const CANDIDATES = [
  ['', 'a bare Enter'],
  ['l', 'a look — what the stand-up threshold used to send'],
  ['i', 'reading the pack'],
  ['st', 'the stat sheet — sent on entering the realm'],
  ['exp', 'experience — sent on entering the realm'],
  ['rm', 'the room command — sent to re-anchor a lost loop'],
  ['get nothinghere', 'a refused get — see the note under the table']
];

/**
 * And casting, which is the one this list was missing.
 *
 * The client believed a character could cast sitting down and had never asked:
 * there was no `c` in the list above, so `AutoHeal` broke every rest it mended
 * and `Recovery` never sat the character back down. The wire settled it on
 * Paradigm (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`, 2026-09-02) —
 * `[HP=48/KAI=5]: (Resting)` answered with `c swan`, and the flag gone from
 * every prompt after it — and this asks the sanctioned realm the same question.
 *
 * It is separate from `CANDIDATES` because it is the only one that needs a
 * spell: the character has to know one, and which one is a fact about the
 * character rather than about the client. Named on the command line, and
 * skipped with a reason rather than guessed at:
 *
 *   npm run probe:rest -- --cast <short name>
 */
const CAST = (() => {
  const at = process.argv.indexOf('--cast');
  const spell = at === -1 ? null : process.argv[at + 1];
  return spell && !spell.startsWith('--') ? spell.trim() : null;
})();

const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

console.log(`\nrest-probe -> ${HOST}:${PORT}\n`);

const lines = [];
const session = new SessionManager(
  {
    data: () => {},
    line: (line) => lines.push(line.plain.replace(/\s+$/, '')),
    block: () => {},
    character: () => {},
    command: () => {},
    state: () => {},
    telnet: () => {},
    notice: (message) => console.log(`   [client] ${message}`),
    automation: () => {}
  },
  undefined,
  {
    ...profile.config.automation,
    // Nothing else may send while this is measuring which command did what.
    enabled: false
  },
  profile.config.connection.login
);
session.resize({ cols: 80, rows: 24 });

/**
 * Sends one command and reports what the **last** status line it produced says.
 *
 * `null` when the command produced no status line at all, which is not the same
 * answer as either of the other two and must never be folded into one: a
 * command nothing acknowledged has told us nothing about the flag.
 */
async function send(command) {
  const at = lines.length;
  session.send(`${command}\r`);
  await wait(1800);
  const prompts = lines.slice(at).filter((text) => text.startsWith('[HP='));
  const last = prompts.at(-1);
  if (last === undefined) return null;
  return { resting: last.includes('(Resting)'), prompt: last };
}

/** Sits the character down, and says whether it is actually down. */
async function sitDown() {
  const answer = await send('rest');
  return answer?.resting === true;
}

async function measure(command, note) {
  if (!(await sitDown())) return { command, note, verdict: 'could not sit down' };
  const answer = await send(command);
  if (answer === null) return { command, note, verdict: 'no status line' };
  return { command, note, verdict: answer.resting ? 'does NOT break' : 'BREAKS' };
}

function row({ command, note, verdict }) {
  const shown = command === '' ? '<enter>' : command;
  console.log(`  ${shown.padEnd(16)} ${verdict.padEnd(18)} ${note}`);
}

async function main() {
  await session.connect(target());
  const deadline = Date.now() + 45_000;
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

  console.log('  command          verdict            what it is\n');

  /* Does it start at all, and is asking twice a toggle? */
  const started = await send('rest');
  console.log(
    `  ${'rest'.padEnd(16)} ${(started?.resting ? 'sits down' : 'did NOT sit down').padEnd(18)} the command under test`
  );
  const twice = await send('rest');
  console.log(
    `  ${'rest (again)'.padEnd(16)} ${(twice?.resting ? 'idempotent' : 'TOGGLES OFF').padEnd(18)} asking twice`
  );

  const results = [];
  for (const [command, note] of CANDIDATES) results.push(await measure(command, note));
  /*
   * Casting, when a spell was named. The wire on Paradigm says it breaks a rest
   * (2026-09-02) and the client now assumes so — `Recovery.restTo` exists to
   * sit the character back down after it — so this is the sanctioned realm
   * being asked the same question, not a discovery.
   *
   * `c` alone is never sent: an unrecognised command here is said out loud in
   * the room, and a spell this character does not know is answered out loud
   * too. Unnamed, it says so rather than guessing at one.
   */
  if (CAST) results.push(await measure(`c ${CAST}`, 'casting — see the note under the table'));
  for (const result of results) row(result);

  /*
   * The control, last because it is the only one that moves the character.
   *
   * An exit the room itself listed, and straight back through its opposite. A
   * room with no plain exit leaves the control unrun — which is reported as
   * loudly as a failure, because an unrun control invalidates every negative
   * above it just as thoroughly as a failed one.
   */
  let control = 'not run — no plain exit in this room';
  const exit = session.character.room.exits.find(
    (candidate) => candidate.note === null && BACK[candidate.direction] !== undefined
  );
  if (exit && (await sitDown())) {
    const moved = await send(exit.direction);
    control =
      moved === null
        ? 'not run — the move produced no status line'
        : moved.resting
          ? `FAILED — ${exit.direction} did not break the rest`
          : `passed — ${exit.direction} broke the rest`;
    await send(BACK[exit.direction]);
  }
  console.log(`\n  control: ${control}`);

  if (!control.startsWith('passed')) {
    console.log(
      '\n  Nothing in this run is known to break a rest, so every "does NOT break"\n' +
        '  above is unproven rather than measured. Do not build on them.'
    );
  }

  console.log(
    '\n  `get nothinghere` is a get the server refuses. Whether a get that\n' +
      '  succeeds breaks a rest needs something on the floor to pick up, which\n' +
      '  this cannot arrange — so `AutoLoot` goes on waiting for a rest to end.'
  );

  console.log(
    CAST
      ? `\n  \`c ${CAST}\` is the cast. On Paradigm it breaks a rest (2026-09-02),\n` +
          '  which is why `automation.health.restTo` exists — without it one heal\n' +
          '  ended the resting for the whole of the recovery, at a sixth of the\n' +
          '  regeneration.'
      : '\n  No spell was named, so casting went unasked: pass `--cast <short name>`\n' +
          '  with one this character knows. On Paradigm it breaks a rest\n' +
          '  (2026-09-02); on this realm nothing has asked.'
  );

  session.disconnect();
  await wait(400);
  session.dispose();
  console.log('');
}

main().then(
  () => (process.exitCode = 0),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
