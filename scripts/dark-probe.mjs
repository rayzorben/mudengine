/**
 * Does the client keep its place where it cannot see?
 *
 * Three things measured on one short walk, all of them added on 2026-08-28 and
 * none of them provable from a unit test:
 *
 * 1. **A `Text:` exit the *player* types.** `go manhole` is not in the command
 *    table, so nothing supplies a direction; the current room's own realm exits
 *    are what derive it. The destination is one of 293 rooms called `Sewer
 *    Tunnel`, so if the direction is not derived the room cannot resolve at
 *    all — which makes this a test with only one way to pass.
 * 2. **The room's light.** `1/607` records light −175 and the server prints
 *    `The room is barely visible` *after* `Obvious exits:`, so it annotates a
 *    room already read rather than replacing it.
 * 3. **A carried charge.** `glowing pearl (Readied/0)` is a spent light and the
 *    server treats it as absent; the `/0` used to be stripped as slot noise.
 *
 * Read-only apart from movement, and it walks back up.
 *
 *   node --import tsx scripts/dark-probe.mjs
 */
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { HOST, PORT, localProfile, skip, target } from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The street with the manhole, and the sewer under it. */
const STREET = '1/17';
const SEWER = '1/607';

const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\ndark-probe -> ${HOST}:${PORT}\n`);

const notices = [];
const session = new SessionManager(
  {
    data: () => {},
    line: () => {},
    block: () => {},
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: (message) => notices.push(message)
  },
  world,
  { ...profile.config.automation, idle: { ...profile.config.automation.idle, enabled: false }, rules: [] },
  profile.config.connection.login
);
session.resize({ cols: 80, rows: 24 });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n         ${detail}` : ''}`);
};

const here = () => {
  const { map, number } = session.character.room;
  return map === null || number === null ? null : `${map}/${number}`;
};

async function send(command, settle = 1800) {
  session.send(`${command}\r`);
  await wait(settle);
}

/** Walks a planned route by hand, so the walker's own hint is not in play. */
async function walkTo(destination) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const from = here();
    if (from === null) return 'no idea where the character is';
    if (from === destination) return null;
    const route = world.route(from, destination, { level: session.character.progress.level ?? 1 });
    if (!route || route.blocked || route.steps.length === 0) return 'no route';
    for (const step of route.steps) await send(step.command);
  }
  return here() === destination ? null : `ended at ${here() ?? 'nowhere'}`;
}

async function main() {
  await session.connect(target());
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && session.character.phase !== 'in-game') await wait(250);
  if (session.character.phase !== 'in-game') {
    console.log('   could not reach the realm.\n');
    process.exit(1);
  }
  await wait(3000);
  await send('rm');
  await send('i');

  const started = here();
  console.log(`   starting at ${started ?? 'nowhere'} (${session.character.room.name ?? '—'})\n`);

  /*
   * Only a *readied* light counts down: the pack listing writes a bare
   * `glowing pearl` for one that is merely carried and `glowing pearl
   * (Readied/0)` for one in the hand. So the check is conditional on the
   * annotation being there at all — asserting a charge on an item the listing
   * annotated with nothing would be asserting an invented number, which is the
   * thing `charges: null` exists to avoid.
   */
  const lights = session.character.inventory.items.filter((item) =>
    /glowing pearl|torch|lantern|moon-lamp/i.test(item.name)
  );
  const readied = lights.filter((item) => item.slot !== null);
  console.log(
    `   lights carried: ${lights.length === 0 ? 'none' : lights.map((i) => `${i.name} (${i.slot ?? 'in the pack'}${i.charges === null ? '' : `/${i.charges}`})`).join(', ')}\n`
  );
  if (readied.length > 0) {
    check(
      'a readied light states its charges',
      readied.every((item) => item.charges !== null),
      readied.map((item) => `${item.name} -> ${item.charges}`).join(', ')
    );
  } else {
    console.log('   SKIP  no light is readied, so no listing states a charge this run\n');
  }

  const toStreet = await walkTo(STREET);
  if (toStreet !== null) {
    check('reaches the street with the manhole', false, toStreet);
    await finish(started);
    return;
  }
  check('reaches the street with the manhole', true, session.character.room.name ?? '');

  // The whole point: typed by hand, not hinted by the walker.
  await send('go manhole', 2500);

  check(
    'a hand-typed `Text:` exit still places the character',
    here() === SEWER,
    `at ${here() ?? 'nowhere'} (${session.character.room.name ?? '—'}), ` +
      `by ${session.character.room.resolvedBy ?? 'nothing'}, ` +
      `${session.character.room.ambiguous} candidate(s)`
  );
  check(
    'and the room says how dark it is',
    session.character.room.light !== null,
    `light: ${session.character.room.light ?? 'nothing said'}`
  );

  await finish(started);
}

async function finish(started) {
  if (here() !== started && started !== null) {
    const back = await walkTo(started);
    if (back !== null) console.log(`\n   could not walk back: ${back}`);
  }
  console.log(`\n   ended at ${here() ?? 'nowhere'} (${session.character.room.name ?? '—'})`);
  if (notices.length > 0) {
    console.log('\n   what it said:');
    for (const message of notices.slice(-12)) console.log(`     ${message}`);
  }
  session.disconnect();
  await wait(600);
  session.dispose();
  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? '\nAll dark checks passed.\n'
      : `\n${failed.length} check(s) failed.\n`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
