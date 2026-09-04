/**
 * Does the client actually know what fight it is in?
 *
 * The one question `npm test` cannot answer. A unit test asserts that the code
 * does what somebody believed the server sends; this walks the character around
 * Newhaven with auto-combat switched on and reports what the *server* sent —
 * every attack line, whether the monster in it could be named, what each
 * occupant was classified as, and every command the arbiter put on the wire.
 *
 * It exists because four failures shipped together and every one of them was a
 * thing a fixture could not have caught:
 *
 *   The thin carrion beast snaps at you with its teeth!   <- not an attack, apparently
 *   The large lashworm lunges at you!                     <- nor this, eleven times
 *   [HP=34]: pu thin carrion beast                        <- already dead, four rounds running
 *   Your command had no effect.
 *
 * ## What it will and will not do
 *
 * It **fights**, which no other probe here does, and that is the point — so it
 * is bounded in the three ways that matter:
 *
 * - **It stays in Newhaven.** A step is refused if the room it would arrive in
 *   is not one the realm data calls Newhaven, and it walks back the way it came.
 * - **It stops on damage.** Below `FLOOR` of maximum health it breaks off,
 *   reports, and disconnects — a probe that can lose the character is a probe
 *   nobody can run twice.
 * - **It never picks a target itself.** Every attack comes from `AutoCombat`
 *   reading the character's own configuration, because the thing being measured
 *   is what the client does unattended, not what a script can be made to do.
 *
 * Read-only about *people*: nothing here attacks a player, by construction —
 * `AutoCombat` refuses, and this proposes nothing of its own.
 *
 *   npm run probe:combat
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { FightLog } from '../src/main/session/FightLog.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import { HOST, PORT, configPath, localProfile, skip, target } from './lib/local-realm.mjs';
import { creditEveryBatch, isBatch } from './lib/batches.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the character is allowed to be.
 *
 * Newhaven and the room directly under it. The village itself has fourteen
 * rooms and **no monsters at all** — it is shops, a guild and a healer — so a
 * probe confined to it measures nothing about combat, which was the first thing
 * this run proved: ninety seconds of walking, zero attack lines. `Dungeon,
 * Entrance` is one step down from Newhaven, Narrow Road and carries the lair
 * the realm data numbers 1, 2, 3, 4, 5, 7 and 109 — a giant rat, a lashworm and
 * a carrion beast among them, which is exactly the fight this was written
 * about.
 */
const ALLOWED = [/newhaven/i, /^dungeon, entrance$/i];
/*
 * The Arena is where the fights are, and it is in Newhaven — which is the
 * answer to "stay in Newhaven" rather than an exception to it. The village
 * proper has fourteen rooms and **no monsters at all**: shops, a guild and a
 * healer. Ninety seconds of walking it produced zero attack lines, which is how
 * this was found.
 */
/** Where to go and stand, by the name the realm data gives it. */
const HUNT = 'Newhaven, Arena';
/** And where to leave the character afterwards: a room with no lair in it. */
const SAFE = "Newhaven, Adventurer's Guild";
/** Break off below this fraction of maximum health. */
const FLOOR = 0.5;
/** How long to play for, in milliseconds. */
const RUN_MS = Number(process.env.PROBE_MS ?? 180_000);

const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

/*
 * The character's *own* realm, not the shipped one.
 *
 * Which matters more here than anywhere else: naming the monster inside an
 * attack line is done from the realm's monster table, so a probe that measured
 * against the shipped realm while the character plays on another would report a
 * client that cannot name anything — and be wrong about why.
 */
const library = new RealmLibrary({
  shippedFile: path.resolve('resources/world/rooms.jsonl.gz'),
  cacheDir: path.join(path.dirname(configPath()), 'realms'),
  notify: (message) => console.log(`   [realm] ${message}`)
});
const loaded = library.load(profile.database);
const world = loaded.graph;
const realmSource = loaded.problem ? `${loaded.source} (${loaded.problem})` : loaded.source;

const fights = new FightLog(
  path.join(path.dirname(configPath()), 'fights', `${profile.id}.jsonl.gz`),
  { notice: (message) => console.log(`   [fights] ${message}`) }
);

console.log(`\ncombat-probe -> ${HOST}:${PORT}`);
console.log(`  character: ${profile.id}`);
console.log(
  `  realm:     ${realmSource} — ${world.mobCount} monsters, ${world.info.rooms} rooms\n`
);

/** Every framed line, with the block types it produced. */
const seen = [];
const blocksBySeq = new Map();
/** Every batch of the run, so its member lines can be credited at report time. */
const batches = [];
/** Every attack line the server sent, and what the client made of it. */
const attacks = [];
/** Everything ever seen standing in a room, by name. */
const occupants = new Map();
/** Every command that reached the wire, and who asked for it. */
const sent = [];
let phaseNote = '(connect)';

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      seen.push({ seq: line.seq, text, after: phaseNote, types: [] });
    },
    block: (block) => {
      if (isBatch(block)) batches.push(block);
      const types = blocksBySeq.get(block.seq) ?? [];
      types.push(block.type);
      blocksBySeq.set(block.seq, types);
      if (
        block.type === 'mob-hits' ||
        block.type === 'mob-misses' ||
        block.type === 'mob-arrives-room'
      ) {
        attacks.push({
          type: block.type,
          text: block.text.trim(),
          middle: block.groups['line'] ?? null,
          named: block.groups['attacker'] ?? null
        });
      }
    },
    character: (state) => {
      for (const who of state.room.occupants) {
        occupants.set(who.name.toLowerCase(), {
          name: who.name,
          kind: who.kind,
          disposition: who.disposition,
          uncertain: who.uncertain,
          costly: who.costly,
          room: state.room.name
        });
      }
    },
    command: (command, origin) => sent.push({ command, origin, at: Date.now() }),
    state: () => {},
    telnet: () => {},
    notice: (message) => console.log(`   [client] ${message}`),
    automation: () => {}
  },
  world,
  /*
   * The character's own automation block, verbatim, with one change: the idle
   * keep-alive is off, because a probe that measures which commands the client
   * chooses to send should not have a housekeeping timer in the middle of it.
   */
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false }
  },
  profile.config.connection.login,
  undefined,
  undefined,
  /*
   * And the fights go in the same file the app writes.
   *
   * The probe drives the real `SessionManager`, so these are real fights by a
   * real character — there is no reason for them to be less of a record than
   * the ones a play session produces, and every reason for the two to be
   * comparable.
   */
  fights
);

session.resize({ cols: 80, rows: 24 });

async function say(command, settle = 1200) {
  phaseNote = command === '' ? '<enter>' : command;
  session.send(`${command}\r`);
  await wait(settle);
}

/** Health as a fraction, or null while no maximum has arrived. */
function health() {
  const { hp, hpMax } = session.character.vitals;
  return hp !== null && hpMax ? hp / hpMax : null;
}

/** The room name as the client currently has it, for a message. */
function finalRoomName() {
  return session.character.room.name ?? '';
}

function inHome() {
  const name = session.character.room.name ?? '';
  return ALLOWED.some((pattern) => pattern.test(name));
}

/** Where the client currently believes it is, as a realm id, or null. */
function hereId() {
  const { map, number } = session.character.room;
  return map === null || number === null ? null : `${map}/${number}`;
}

/**
 * Walks a route the realm data planned, one verified step at a time.
 *
 * The same rule `Walker` follows and for the same reason: the steps after the
 * first are unconditional, so one shut door desynchronises the rest while the
 * client keeps sending directions from a room it is not in. A step that does
 * not land where the realm said stops the walk.
 */
async function walkTo(name) {
  const from = hereId();
  const destination = world.findByName(name)[0];
  if (from === null || destination === undefined) return `no route to ${name}`;
  const route = world.route(from, `${destination.map}/${destination.room}`);
  if (route.blocked) return route.reason ?? `no route to ${name}`;

  for (const step of route.steps) {
    // `command` rather than `direction`: a `Text:` exit is a phrasing the realm
    // stores, and the direction alone does not traverse it.
    await say(step.command, 1600);
    const arrived = session.character.room.name ?? '';
    if (arrived.toLowerCase() !== step.name.toLowerCase()) {
      return `expected ${step.name}, arrived in ${arrived || 'nowhere the data knows'}`;
    }
    if (session.character.inCombat) return null;
  }
  return null;
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

  // Seed the listings a fight reads: who is in the realm, and what is here.
  await say('who');
  await say('l');

  if (!inHome()) {
    console.log(
      `  the character is in ${session.character.room.name ?? 'nowhere the realm data knows'}, ` +
        `not ${ALLOWED.map(String).join(' or ')}. Not walking it anywhere.\n`
    );
  }

  const until = Date.now() + RUN_MS;
  let stopped = null;

  /*
   * `PROBE_MS=0` walks the character home and stops — the parking mode.
   *
   * Worth having as a mode rather than as a second script: leaving a character
   * in a lair is the way this probe damages the *next* thing anybody runs, and
   * the fix for that has to be one command rather than a note in a file.
   */
  if (RUN_MS > 0) {
    const failed = await walkTo(HUNT);
    if (failed) console.log(`  could not reach ${HUNT}: ${failed}`);
  }

  /*
   * And then stand there.
   *
   * Deliberately, rather than walking a loop: the lair respawns into this
   * one room, so standing in it is what produces fights, and every command
   * spent walking is a command not spent measuring. `l` re-reads the room
   * between fights — the same thing `refreshRounds` does inside one — so a
   * monster that wandered in is noticed by the same path a player's `l` uses.
   */
  while (Date.now() < until) {
    const hurt = health();
    if (hurt !== null && hurt < FLOOR) {
      stopped = `health fell to ${Math.round(hurt * 100)}%`;
      break;
    }
    if (!inHome()) {
      stopped = `left the allowed rooms: now in ${session.character.room.name ?? 'nowhere known'}`;
      break;
    }
    if (session.character.inCombat) {
      await wait(1000);
      continue;
    }
    await say('l', 3000);
  }

  /*
   * And back to a quiet room, unconditionally.
   *
   * It used to walk back only when the character had left Newhaven — which is
   * never, because the room it hunts in is *called* Newhaven, Arena. So the run
   * left the character standing in a lair, and the next thing anybody ran there
   * was `npm run check:live`, whose route walk is stopped by combat within a
   * second. A probe that leaves the character somewhere the next check cannot
   * work from has broken the next check.
   */
  if (session.character.phase === 'in-game' && !new RegExp(SAFE, 'i').test(finalRoomName())) {
    const home = await walkTo(SAFE);
    if (home) console.log(`  could not walk back to ${SAFE}: ${home}`);
  }

  const finalRoom = session.character.room.name;
  const finalHealth = health();
  session.disconnect();
  await wait(400);
  session.dispose();
  // Held on a timer, so the last fight of the run needs asking for.
  fights.dispose();

  /* ------------------------------------------------------------- report */

  for (const entry of seen) entry.types = blocksBySeq.get(entry.seq) ?? [];
  // A batch member reads as `unknown` on its own by design; the batch is the
  // parse. Credited after the types are attached, which replaces them.
  creditEveryBatch(seen, batches);
  const entered = seen.findIndex((entry) => entry.types.includes('status-line'));
  const after = entered === -1 ? [] : seen.slice(entered);
  const unread = after.filter(
    (entry) => entry.types.length === 0 || entry.types.every((type) => type === 'unknown')
  );

  console.log(`\n  stopped: ${stopped ?? 'time was up'}`);
  console.log(
    `  ended in ${finalRoom ?? 'a room the realm data does not have'} at ` +
      `${finalHealth === null ? 'unknown' : `${Math.round(finalHealth * 100)}%`} health\n`
  );

  console.log(`  ${attacks.length} combat and arrival lines:`);
  const unnamed = attacks.filter((entry) => entry.named === null);
  for (const entry of attacks.slice(0, 40)) {
    console.log(
      `    ${entry.named === null ? '  ?' : ' ok'}  ${String(entry.named ?? '—').padEnd(24)} ${entry.text.slice(0, 76)}`
    );
  }
  if (attacks.length > 40) console.log(`    … ${attacks.length - 40} more`);
  console.log(
    `\n  named ${attacks.length - unnamed.length} of ${attacks.length}` +
      `${unnamed.length > 0 ? ` — ${unnamed.length} the room and the realm data could not place` : ''}\n`
  );

  console.log('  everything that stood in a room:');
  for (const who of occupants.values()) {
    console.log(
      `    ${who.kind.padEnd(7)} ${String(who.disposition ?? 'unknown').padEnd(11)} ` +
        `${who.costly === 'never' ? '      ' : who.costly.padEnd(6)} ${who.name}`
    );
  }

  /*
   * The refusals, checked rather than assumed. Every one of these is a thing
   * `AutoCombat` promises never to do unasked, and the only way to know it kept
   * the promise is to compare what it sent against what was standing there.
   */
  const attacked = new Set();
  for (const entry of sent) {
    if (entry.origin !== 'automation') continue;
    const space = entry.command.indexOf(' ');
    if (space > 0)
      attacked.add(
        entry.command
          .slice(space + 1)
          .trim()
          .toLowerCase()
      );
  }
  const wrong = [];
  for (const name of attacked) {
    const who = occupants.get(name);
    if (who === undefined) continue;
    if (who.kind === 'player') wrong.push(`${name}: a player`);
    else if (who.kind === 'unknown') wrong.push(`${name}: nothing placed it`);
    else if (who.costly === 'always') wrong.push(`${name}: the realm calls it good`);
  }
  console.log(`\n  ${attacked.size} thing(s) the client chose to act on:`);
  for (const name of attacked) console.log(`    ${name}`);
  console.log(
    wrong.length === 0
      ? '\n  none of them was a player, an unplaced name, or a monster the realm calls good.\n'
      : `\n  REFUSALS BROKEN:\n    ${wrong.join('\n    ')}\n`
  );

  console.log(`  ${sent.length} command(s) on the wire:`);
  for (const entry of sent.slice(-40))
    console.log(`    ${entry.origin.padEnd(10)} ${entry.command}`);

  const shapes = new Map();
  for (const entry of unread) {
    const shape = entry.text.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 70);
    if (!shapes.has(shape))
      shapes.set(shape, { count: 0, example: entry.text, after: entry.after });
    shapes.get(shape).count += 1;
  }
  console.log(`\n  ${unread.length} lines it could not type, ${shapes.size} shapes:`);
  for (const [, entry] of [...shapes].sort((a, b) => b[1].count - a[1].count).slice(0, 40)) {
    console.log(
      `    ${String(entry.count).padStart(3)}x after \`${entry.after}\`  ${entry.example.slice(0, 90)}`
    );
  }

  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(
    'out/combat-probe.json',
    `${JSON.stringify({ attacks, occupants: [...occupants.values()], sent, seen }, null, 2)}\n`
  );
  console.log('\n  full capture -> out/combat-probe.json\n');
}

/*
 * Exiting on the *drain*, not on the promise.
 *
 * This report is a few hundred lines and `process.exit` does not wait for a
 * pipe to flush — so a run whose output went anywhere but a terminal lost
 * everything after the occupant table, which is the half with the refusals in
 * it. A probe whose findings are cut off is worse than one that fails.
 */
main().then(
  () => (process.exitCode = 0),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
