/**
 * What a player attacking a player looks like on the wire.
 *
 * The capture corpus supplied `<Name> moves to attack you!` (87 lines, every
 * one a player) and the two-word-verb surprise blow, and docs/capture-analysis
 * marked both "needs a live check". The only way to produce them is for one of
 * this realm's own test characters to open on another — which is why this
 * exists as a probe rather than a setting: `AutoCombat` will never attack a
 * player, and this attacks one on purpose, once, on the sanctioned realm, and
 * stops after two rounds with `break`.
 *
 * Both sides are reported: what the attacker's client read, what the victim's
 * read, and what the victim's hang-up watch made of it.
 *
 *   npm run probe:pvp -- --pair soul,yang     (first named attacks the second)
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { HOST, PORT, localProfiles, skip, target } from './lib/local-realm.mjs';
import { OPPOSITE } from '../src/shared/world.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pairArg = process.argv[process.argv.indexOf('--pair') + 1];
const wanted = process.argv.includes('--pair') && pairArg ? pairArg.split(',') : null;
const local = localProfiles().filter((p) => wanted === null || wanted.includes(p.id));
if (local.length < 2) skip(`need two characters on ${HOST}:${PORT} with credentials; found ${local.length}.`);
const ordered = wanted ? wanted.map((id) => local.find((p) => p.id === id)).filter(Boolean) : local;
const [attackerProfile, victimProfile] = ordered;

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\npvp-probe -> ${HOST}:${PORT}: ${attackerProfile.id} attacks ${victimProfile.id}\n`);

function open(profile) {
  const seen = [];
  const blocksBySeq = new Map();
  const safety = [];
  let provokedBy = '(connect)';
  const session = new SessionManager(
    {
      data: () => {},
      line: (line) => {
        const text = line.plain.replace(/\s+$/, '');
        if (text.trim().length > 0) seen.push({ seq: line.seq, text, after: provokedBy });
      },
      block: (block) => {
        const types = blocksBySeq.get(block.seq) ?? [];
        types.push(block.type);
        blocksBySeq.set(block.seq, types);
      },
      character: () => {},
      state: () => {},
      telnet: () => {},
      notice: () => {},
      automation: (snapshot) => {
        if (snapshot?.safety) safety.push(snapshot.safety);
      }
    },
    world,
    { ...profile.config.automation, enabled: false },
    profile.config.connection.login
  );
  session.resize({ cols: 80, rows: 24 });
  return {
    profile,
    session,
    seen,
    blocksBySeq,
    safety,
    say: async (command, settle = 1500) => {
      provokedBy = command;
      session.send(`${command}\r`);
      await wait(settle);
    }
  };
}

async function reachRealm(who) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await wait(250);
    if (who.session.character.phase === 'in-game') return true;
  }
  return false;
}

function report(who, title) {
  console.log(`\n  ===== ${title}: ${who.session.character.name ?? who.profile.id} =====`);
  let last = null;
  for (const entry of who.seen) {
    if (entry.after === '(connect)') continue;
    if (entry.after !== last) {
      console.log(`\n  > ${entry.after}`);
      last = entry.after;
    }
    const read = (who.blocksBySeq.get(entry.seq) ?? []).filter((t) => t !== 'unknown');
    console.log(`      ${read.length > 0 ? `[${read.join(',')}]` : '[  ?  ]'} ${entry.text}`);
  }
}

async function main() {
  const attacker = open(attackerProfile);
  const victim = open(victimProfile);
  await attacker.session.connect(target());
  await victim.session.connect(target());
  if (!(await reachRealm(attacker)) || !(await reachRealm(victim))) {
    console.log('  one of them never reached the realm; nothing to measure.\n');
    attacker.session.dispose();
    victim.session.dispose();
    return;
  }
  await wait(3000);
  const roomOf = (who) => who.session.character.room;
  const nameOf = (who) => who.session.character.name ?? who.profile.id;
  console.log(`  ${nameOf(attacker)} in ${roomOf(attacker).name}, ${nameOf(victim)} in ${roomOf(victim).name}`);

  // Walk the victim to the attacker over open steps, and remember the way back.
  const back = [];
  if (roomOf(attacker).map !== null && roomOf(victim).map !== null) {
    const route = world.route(
      `${roomOf(victim).map}/${roomOf(victim).number}`,
      `${roomOf(attacker).map}/${roomOf(attacker).number}`,
      { level: victim.session.character.progress.level ?? null }
    );
    const gated = route.steps.filter((step) => step.requirement !== null);
    if (!route.blocked && gated.length === 0 && route.steps.length <= 30) {
      console.log(`  walking ${nameOf(victim)} ${route.steps.length} steps to ${nameOf(attacker)}`);
      for (const step of route.steps) {
        await victim.say(step.command, 900);
        back.unshift(OPPOSITE[step.command] ?? null);
      }
    } else console.log('  no short open route; asking anyway');
  }
  await wait(2500);

  // The roster on both sides first, so a name is a player and not a guess.
  await attacker.say('who');
  await victim.say('who');
  await victim.say('l');

  /*
   * The realm's own conscience refuses first: with evil warnings on, `a
   * <player>` answers `You are overcome with a feeling of guilt and break off
   * your attack.` — so they are switched off for the attack and back on after,
   * which is what the corpus shows players doing (`set warn`).
   */
  await attacker.say('set warn', 1500);
  // One attack, two rounds, then stop. `break` is `bre`/`break` in the table.
  await attacker.say(`a ${nameOf(victim)}`, 4500);
  await attacker.say('l', 1500);
  await attacker.say('break', 3500);
  await attacker.say('set warn', 1500);
  await victim.say('l', 1500);

  const hang = victim.session.hangUp?.assess?.(victim.session.character, Date.now()) ?? null;

  report(attacker, 'attacker');
  report(victim, 'victim');
  console.log('\n  ----- the victim, as the client understood it -----');
  console.log(`  attackers: ${JSON.stringify(victim.session.character.combat.attackers)}`);
  console.log(`  inCombat: ${victim.session.character.inCombat}`);
  if (hang) console.log(`  hang-up assessment: ${JSON.stringify(hang)}`);
  if (victim.safety.length > 0) console.log(`  last safety snapshot: ${JSON.stringify(victim.safety.at(-1))}`);

  for (const step of back) if (step) await victim.say(step, 900);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(
    'out/pvp-probe.json',
    `${JSON.stringify({ attacker: attacker.seen, victim: victim.seen }, null, 2)}\n`
  );
  console.log('\n  full capture -> out/pvp-probe.json\n');
  attacker.session.disconnect();
  victim.session.disconnect();
  await wait(500);
  attacker.session.dispose();
  victim.session.dispose();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
