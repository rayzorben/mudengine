/**
 * What does `read <scroll>` print for each of the server's outcomes?
 *
 * `ReadCommand.cs` has four answers to a scroll that teaches a spell: the
 * spell added, already known, `Unable to learn` (the class's magery, a level
 * or alignment gate in `Spell.CanPlayerUseSpell`), and a scroll with no
 * spell. The corpus holds only the first. This walks to the nearest counter
 * selling both `scroll of magic missile` (a Mage's) and `scroll of minor
 * healing` (a Priest's), both free in Newhaven, buys and reads each twice,
 * so any class meets at least two of the outcomes, then drops what is left.
 *
 *   npm run probe:scroll -- --as probe
 *
 * `--as` is required: the character must be one that is not already online.
 * Every word sent is in `src/shared/commands.ts`, so nothing is said aloud.
 */
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { worldLeg } from '../src/main/session/navigation.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import { HOST, PORT, configPath, localProfileNamed, skip, target } from './lib/local-realm.mjs';

const SCROLLS = ['scroll of magic missile', 'scroll of minor healing'];

const args = process.argv.slice(2);
const at = args.indexOf('--as');
const asName = at >= 0 ? args[at + 1] : undefined;
if (!asName) skip('say which character with --as <name>; it must not already be online.');
const profile = localProfileNamed(asName);
if (!profile) skip(`no character "${asName}" on ${HOST}:${PORT} with credentials.`);

console.log(`\nscroll-probe -> ${HOST}:${PORT} as ${profile.id}\n`);

const library = new RealmLibrary({
  shippedDir: path.resolve('resources/world'),
  cacheDir: path.join(path.dirname(configPath()), 'realms'),
  notify: (message) => console.log(`   [realm] ${message}`)
});
const world = library.load(profile.database).graph;

const runs = [];
let current = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0 || current === null) return;
      current.lines.push({ seq: line.seq, text: line.plain });
    },
    block: (block) => {
      if (current === null) return;
      current.blocks.push({ seq: block.seq, type: block.type });
    },
    players: () => {},
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  {
    world,
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

async function run(command, settle = 1800) {
  current = { command, lines: [], blocks: [] };
  runs.push(current);
  session.send(`${command}\r`);
  await wait(settle);
  current = null;
}

const me = () => session.character;
const hereId = () => {
  const { map, number } = me().room;
  return map === null || number === null ? null : `${map}/${number}`;
};

/** The nearest room whose counter sells every scroll, by steps from here. */
function counter(from) {
  let best = null;
  for (const room of world.searchByName('shop', 400)) {
    if (room.shop === undefined) continue;
    const stock = new Set(
      (world.shop(room.shop)?.items ?? []).map((item) => item.name.toLowerCase())
    );
    if (!SCROLLS.every((scroll) => stock.has(scroll))) continue;
    const route = worldLeg(world, from, `${room.map}/${room.room}`);
    if (route.blocked) continue;
    if (best === null || route.steps.length < best.route.steps.length) best = { room, route };
  }
  return best;
}

async function main() {
  await session.connect(target());
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && me().phase !== 'in-game') await wait(250);
  if (me().phase !== 'in-game') {
    console.log('  never reached the realm; nothing to measure.\n');
    session.dispose();
    return;
  }
  await wait(3000);
  await run('st', 2500);
  if (hereId() === null) await run('rm', 2500);
  const from = hereId();
  const found = from === null ? null : counter(from);
  if (found === null) {
    console.log(
      `  no counter selling ${SCROLLS.join(' and ')} is reached from ${from ?? 'nowhere known'}.\n`
    );
  } else {
    console.log(
      `  ${me().className ?? '?'} level ${me().progress.level ?? '?'}: walking ${found.route.steps.length} steps to ${found.room.name}`
    );
    for (const step of found.route.steps) {
      if (step.requirement?.kind === 'door') await run(`open ${step.direction}`, 1200);
      await run(step.command, 1600);
    }
    if (me().room.name?.toLowerCase() !== found.room.name.toLowerCase()) {
      console.log(`  arrived in ${me().room.name ?? 'nowhere known'}, not ${found.room.name}.\n`);
    } else {
      for (const scroll of SCROLLS) {
        for (let pass = 0; pass < 2; pass += 1) {
          await run(`buy ${scroll}`);
          await run(`read ${scroll}`);
        }
      }
      await run('i');
      for (const scroll of SCROLLS) {
        const left = me().inventory.items.filter((item) => item.name.toLowerCase() === scroll);
        for (const _ of left) await run(`drop ${scroll}`, 1200);
      }
      await run('sp', 2500);
    }
  }

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines) {
      const types = entry.blocks.filter((b) => b.seq === line.seq).map((b) => b.type);
      console.log(`      | ${JSON.stringify(line.text)}  [${types.join(', ') || '-'}]`);
    }
  }
  console.log('');
}

await main();
