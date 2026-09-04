/**
 * Hiding, sneaking, searching, tracking, backstabbing and shopping — on the
 * wire, with a character that cannot do most of them.
 *
 * The capture corpus (docs/capture-analysis.md §7–8) supplied MajorMUD's shapes
 * for all of these; this asks the GreaterMUD test realm for its own, so the
 * patterns written from the corpus are checked against the realm the client
 * actually connects to. Where the character lacks the class or the weapon —
 * a Mystic cannot backstab — the *refusal* is the shape worth having, because
 * auto-combat has to hear it.
 *
 * Every command is checked against the realm's own command table before it is
 * sent: an unrecognised command is said out loud in the room.
 *
 * The third character on the realm is used when there are three, so this can
 * run beside `probe:party` without either one logging the other out.
 *
 *   npm run probe:stealth
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { commandOf } from '../src/shared/commands.ts';
import { HOST, PORT, localProfiles, skip, target } from './lib/local-realm.mjs';
import { OPPOSITE } from '../src/shared/world.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const local = localProfiles();
if (local.length === 0) skip(`no character on ${HOST}:${PORT} with credentials.`);
const profile = local[local.length - 1];
const other = local.find((p) => p !== profile) ?? null;

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\nstealth-probe -> ${HOST}:${PORT} as ${profile.id}\n`);

const seen = [];
const blocksBySeq = new Map();
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
      const types = blocksBySeq.get(block.seq) ?? [];
      types.push(block.type);
      blocksBySeq.set(block.seq, types);
      if ('rows' in block) batches.push({ after: provokedBy, type: block.type, rows: block.rows });
    },
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: (message) => console.log(`   [client] ${message}`),
    automation: () => {}
  },
  world,
  { ...profile.config.automation, enabled: false },
  profile.config.connection.login
);
session.resize({ cols: 80, rows: 24 });

/** Sends only what the realm's table names; refuses to say anything else out loud. */
async function ask(command, settle = 1500) {
  const word = command.split(/\s+/)[0] ?? '';
  if (command !== '' && commandOf(word) === null) {
    console.log(`   refusing to send "${command}": "${word}" is not in the command table`);
    return;
  }
  provokedBy = command === '' ? '<enter>' : command;
  session.send(`${command}\r`);
  await wait(settle);
}

function report(title, filter) {
  console.log(`\n  ----- ${title} -----`);
  let last = null;
  for (const entry of seen) {
    if (!filter(entry.after)) continue;
    if (entry.after !== last) {
      console.log(`\n  > ${entry.after}`);
      last = entry.after;
    }
    const read = (blocksBySeq.get(entry.seq) ?? []).filter((t) => t !== 'unknown');
    console.log(`      ${read.length > 0 ? `[${read.join(',')}]` : '[  ?  ]'} ${entry.text}`);
  }
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
  const me = session.character;
  console.log(`  ${me.name} (${me.className ?? '?'}) in ${me.room.name}\n`);

  // Stealth: the attempt, the outcome, and asking twice.
  await ask('hide');
  await ask('hide');
  await ask('sn');
  await ask('sea');
  await ask('l');

  // Tracking somebody who exists, and the failure shape.
  if (other) await ask(`trac ${other.config.connection.login.username}`);
  await ask(`trac ${me.name}`);

  // Backstab: with no weapon and the wrong class, the refusal is the shape.
  const mob = me.room.occupants.find((who) => who.kind === 'mob');
  await ask(`bs ${mob ? mob.name.split(' ').pop() : 'rat'}`);
  await ask('bs');

  // A door, if this room has one; otherwise the refusal for a wall.
  const door = me.room.exits.find((exit) => exit.door !== null && exit.door !== undefined);
  if (door) await ask(`open ${door.direction}`);
  else await ask('open n');

  // Shopping: what the realm says when there is a shop here, and when there is not.
  await ask('i');
  await ask('list', 2500);

  /*
   * Then the nearest shop the realm data knows, over open exits only, to buy
   * and wield whatever this character can afford — which for a new character
   * is what the starter shop gives away — and back again.
   */
  const walkBack = [];
  const visited = new Set();
  let wielded = false;
  for (let attempt = 0; attempt < 2 && !wielded; attempt += 1) {
    const here = session.character.room;
    if (here.map === null || here.number === null) break;
    const route = world.nearest(
      `${here.map}/${here.number}`,
      (room) =>
        room.shop !== undefined &&
        !visited.has(`${room.map}/${room.room}`) &&
        (world.shop(room.shop)?.items.length ?? 0) > 0,
      20
    );
    if (!route || route.steps.length === 0) {
      console.log('  no stocked shop within 20 open steps');
      break;
    }
    const last = route.steps[route.steps.length - 1];
    visited.add(last.to);
    console.log(`  walking ${route.steps.length} steps to ${last.name}`);
    for (const step of route.steps) {
      await ask(step.command, 900);
      walkBack.unshift(OPPOSITE[step.command] ?? null);
    }
    await wait(1500);
    await ask('list', 2500);
    const shop = batches.filter((b) => b.type === 'shop-list').at(-1);
    const wealth = session.character.inventory.wealth ?? 0;
    const affordable = (shop?.rows ?? [])
      .filter((row) => !row.note)
      .map((row) => ({
        ...row,
        cost: row.price === 'Free' ? 0 : Number(String(row.price).replace(/,/g, ''))
      }))
      .filter((row) => Number.isFinite(row.cost) && row.cost <= wealth)
      .sort((a, b) => a.cost - b.cost);
    // Something to hold before something to read: a scroll answers `arm` with
    // the wear refusal, which the first pass captured.
    const cheap =
      affordable.find((row) => !/^(?:scroll|songsheet|sash) /i.test(row.item)) ?? affordable[0];
    if (cheap) {
      console.log(`  buying "${cheap.item}" for ${cheap.price} (wealth ${wealth})`);
      await ask(`buy ${cheap.item}`, 2000);
      await ask(`arm ${cheap.item}`, 2000);
      await ask('i');
      wielded = session.character.inventory.items.some((item) => item.slot !== null);
      if (wielded) console.log(`  wielded ${cheap.item}`);
    } else console.log(`  nothing affordable to buy (wealth ${wealth})`);
  }
  for (const step of walkBack) if (step) await ask(step, 900);
  await wait(1000);

  /*
   * Backstab with something to backstab. The arena is one step down from the
   * road this character starts on; a Gypsy may backstab, and with nothing
   * wielded the refusal is the shape — either way the answer is captured with
   * a target in the room, which `bs` alone never reaches.
   */
  if (session.character.room.exits.some((exit) => exit.direction === 'd')) {
    await ask('d', 2500);
    const prey = session.character.room.occupants.find((who) => who.kind === 'mob');
    if (prey) {
      await ask(`bs ${prey.name.split(' ').pop()}`, 2500);
      await ask('l', 1500);
    } else console.log('  nothing to backstab down there');
    await ask('u', 2500);
  }

  report('what the classifier made of it', (after) => after !== '(connect)');
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/stealth-probe.json', `${JSON.stringify({ seen, batches }, null, 2)}\n`);
  console.log('\n  full capture -> out/stealth-probe.json\n');

  session.disconnect();
  await wait(400);
  session.dispose();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
