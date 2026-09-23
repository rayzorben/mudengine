/**
 * What does `stat all` actually print on this realm, byte for byte — and does
 * the client's own arithmetic agree with it?
 *
 * No recorded session has ever sent the command: `grep -r 'HP Regen' captures/`
 * and the session logs find nothing across 218 recordings
 * (docs/mudplay/04-the-missing-half-of-the-arithmetic.md). Everything the
 * client knows about the sheet is therefore a *reading* of the server's source
 * (`Player.ShowStatAll`, docs/greatermud/player-and-world.md), and a reading is
 * not a capture. This asks, and it is the one probe that settles three roadmap
 * items at once — 04, 05 and 06 — because the sheet prints the figures all
 * three compute: accuracy, swings per round, damage range, dodge and both
 * regeneration rates, as the server itself computes them.
 *
 * And it grades the client. `src/shared/prowess.ts` transcribes the same
 * routines, so the probe computes each figure from the character's sheet, the
 * realm's class row and the wielded weapon, and prints it beside the server's.
 * Agreement is what lets a figure claim `stated` provenance later; a
 * disagreement is a transcription error found by the game rather than by a
 * player, which is the whole argument of 04 §8.
 *
 *   npm run probe:statall                    # the configured character
 *   npm run probe:statall -- --as soul
 *   npm run probe:statall -- --mob "giant rat"   # the monster for the second sheet
 *
 * Every word sent is in the server's own command table: `st` is `Stat`, and
 * `stat all`, `stat al` and `stat a` are `StatCommand`'s three spellings of the
 * same branch (`PlayerCommands/StatCommand.cs:27`). With a second word that is
 * a monster's realm number the server prints the table *after that monster's
 * defences* (`Player.cs:7000-7030`) — any monster, in the room or not, because
 * it is looked up by id. The id comes from the character's own realm data, so
 * nothing here is guessed at and nothing is said out loud in the room.
 *
 * Reads and nothing else: automation is off for the run, so no monster in the
 * room is attacked while the sheet is being read.
 */
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import { accuracy, dodge, regeneration, swingsPerRound } from '../src/shared/prowess.ts';
import { prowessSheetOf, wieldedWeapon } from '../src/shared/verdict.ts';
import {
  HOST,
  PORT,
  configPath,
  localProfile,
  localProfileNamed,
  skip,
  target
} from './lib/local-realm.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const asName = valueOf('--as');
const profile = asName ? localProfileNamed(asName) : localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);
const mobName = valueOf('--mob') ?? 'giant rat';

/*
 * The character's own realm, for two things: the class row the arithmetic
 * needs (`CombatLVL`, `MageryLVL` — the sheet prints neither) and the realm
 * number of the monster to ask about.
 */
const library = new RealmLibrary({
  shippedDir: path.resolve('resources/world'),
  cacheDir: path.join(path.dirname(configPath()), 'realms'),
  notify: (message) => console.log(`   [realm] ${message}`)
});
const loaded = library.load(profile.database);
const world = loaded.graph;

/*
 * The sanctioned local realm is GreaterMUD — the credential rule's own table
 * says so — and GreaterMUD is the one family whose formulas `prowess` has. A
 * probe that read the family off the wire would be measuring the detector as
 * well as the arithmetic; this measures the arithmetic.
 */
const FAMILY = 'greatermud';

console.log(`\nstatall-probe -> ${HOST}:${PORT} as ${profile.id}`);
console.log(`  realm: ${loaded.source} — ${world.mobCount} monsters\n`);

const runs = [];
let current = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      current?.lines.push({ text: line.plain, tag: line.tag ?? null });
    },
    block: (block) => {
      current?.blocks.push({ type: block.type });
    },
    character: () => {},
    state: () => {},
    // A socket the server closed is reported, not dialled back: a probe has
    // one run in it, and `Reconnect` is the app's, not the harness's.
    dropped: (why) =>
      console.log(`   [client] the server closed the connection${why ? ` (${why})` : ''}.`),
    telnet: () => {},
    notice: (message) => console.log(`   [client] ${message}`)
  },
  world,
  /*
   * Nothing automated: a reading probe must not open a fight on whatever is
   * standing in the room, and an idle routine firing mid-run would put its
   * own lines inside the capture. The login automator is `connection.login`,
   * not automation, so the character still logs itself in.
   */
  { ...profile.config.automation, enabled: false, rules: [] },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

async function run(command, settle = 2500) {
  current = { command, lines: [], blocks: [] };
  runs.push(current);
  session.send(`${command}\r`);
  await wait(settle);
  current = null;
}

/** The first number after a label on any captured line of a run, or null. */
function figure(entry, pattern) {
  for (const line of entry.lines) {
    const match = pattern.exec(line.text);
    if (match) return match.slice(1).map(Number);
  }
  return null;
}

/** A client figure with its provenance, or the word for none. */
function reckoned(reckoning) {
  return reckoning === null ? 'unknown' : `${reckoning.value} (${reckoning.from})`;
}

/** One row of the grading table. */
function grade(label, client, server) {
  const clientValue = client === null ? null : client.value;
  const verdict =
    clientValue === null || server === null
      ? 'not comparable'
      : clientValue === server
        ? 'agree'
        : client.from === 'bound' && clientValue <= server
          ? 'bound holds'
          : 'DISAGREE';
  console.log(
    `    ${label.padEnd(18)} client ${reckoned(client).padEnd(16)} server ${String(server ?? '?').padEnd(6)} ${verdict}`
  );
}

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
  // The realm-entry probes finish talking before anything here is sent.
  await wait(3000);

  // The pack and the ordinary sheet first, so the client's inputs are the
  // ones this session read rather than whatever an earlier one left on disk —
  // and the pack matters: encumbrance under a third grants accuracy and dodge,
  // and an unread pack is taken as *not* under it (`ProwessSheet`), so without
  // the `i` every client figure below would be the encumbered floor.
  await run('i');
  await run('st');
  await run('stat all', 3000);
  await run('stat a');

  /*
   * The second sheet is against a monster: whatever is standing in the room
   * first, because that is the fight the figure is for; else the name asked
   * for; else the first of a few every realm in this family carries. Looked
   * up in the realm data, never typed as a number — the server takes an id
   * and an id nobody can read is a guess about which monster was asked about.
   */
  const standing = session.character.room.occupants.find(
    (who) => who.kind === 'mob' && who.mob?.id !== undefined
  );
  const named = [standing?.name, mobName, 'giant rat', 'rat', 'kobold thief', 'thug']
    .filter((name) => typeof name === 'string')
    .map((name) => world.mob(name))
    .find((mob) => mob?.id !== undefined);
  if (named) {
    console.log(`   [probe] second sheet against ${named.name} (realm #${named.id}).`);
    await run(`stat all ${named.id}`, 3000);
  } else {
    console.log(`   [probe] no monster to ask about; skipping the second sheet.`);
  }

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines) {
      console.log(`      | ${JSON.stringify(line.text)}${line.tag ? `  [${line.tag}]` : ''}`);
    }
    const types = entry.blocks.map((b) => b.type);
    console.log(`    blocks: ${types.join(', ') || '(none)'}`);
  }

  /*
   * The grading. The server's figures are read off the `stat all` run by the
   * row formats in `Player.ShowStatAll`; the client's come from `prowess` over
   * the sheet this session read. `bound holds` is a client floor at or under
   * the server's figure — what a bound promises; `DISAGREE` is a transcription
   * to look at.
   */
  const sheet = runs.find((entry) => entry.command === 'stat all');
  if (sheet) {
    const state = session.character;
    const row = world.classNamed(state.className ?? '') ?? null;
    const cls = { combat: row?.combat ?? null, magery: row?.magery ?? null };
    // The arithmetic is what is graded, so the sheet this run just read is
    // withheld: handed in, every figure would be the server's own, twice.
    const inputs = { ...prowessSheetOf(state, cls), stated: null };
    const weapon = wieldedWeapon(state.inventory.items);
    console.log(
      `\n  grading the arithmetic (class ${state.className ?? '?'}: combat ${cls.combat ?? '?'}, magery ${cls.magery ?? '?'}; weapon ${weapon ? `${weapon.min}-${weapon.max} speed ${weapon.speed ?? '?'}` : 'none'})`
    );
    const regen = figure(sheet, /HP Regen:\s*(-?\d+)\/(-?\d+)/);
    const manaRegen = figure(sheet, /MA Regen:\s*(-?\d+)\/(-?\d+)/);
    const dodged = figure(sheet, /Dodge:\s*(-?\d+)/);
    // `Swings` is a double on the wire — `1.842` on the first capture — so the
    // row is read with a decimal, and the client's figure is compared to it.
    const attack = figure(sheet, /^Attack\s+(\d+(?:\.\d+)?)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
    const ours = regeneration(inputs, null, FAMILY);
    grade('HP regen / tick', ours?.health ?? null, regen?.[0] ?? null);
    grade('dodge', dodge(inputs, FAMILY), dodged?.[0] ?? null);
    grade('swings / round', swingsPerRound(inputs, weapon, FAMILY), attack?.[0] ?? null);
    grade('accuracy', accuracy(inputs, weapon, FAMILY), attack?.[1] ?? null);
    if (weapon) {
      grade('damage min', { value: weapon.min, from: 'source' }, attack?.[2] ?? null);
      grade('damage max', { value: weapon.max, from: 'source' }, attack?.[3] ?? null);
    }
    if (manaRegen)
      console.log(
        `    mana regen         server ${manaRegen[0]}/${manaRegen[1]} (client needs the class's magery stat; see prowess.regeneration)`
      );
    if (regen)
      console.log(
        `    resting rate       server ${regen[1]} = ${regen[0]} × 3 ${regen[1] === regen[0] * 3 ? '(as the source says)' : '(NOT triple — the source is wrong about this build)'}`
      );
  }
  console.log('');
}

await main();
