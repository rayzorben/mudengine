/**
 * Does the client dig its own way into Musty Grottos (todo 20261102-2305-01)?
 *
 * The graveyard's `dig grave` lands on some tries only (5% at level 15 on
 * orohost's gmud.zip), wants a shovel carried, and breaks it on 2%. This asks
 * the client for a route to Musty Grottos, walks it as the route panel's
 * Walk does (`walkRoute`), then only watches: every `dig grave`, the pack
 * listed between tries, every notice and engagement, and what the walk does
 * when the shovel breaks (`Suddenly your shovel breaks in two`).
 *
 *   npm run probe:dig -- --as main [--minutes 30] [--attack-spell lbol]
 *
 * `--as` is required and names a character that is not already online, at or
 * near the graveyard with a shovel. Nothing is done to the realm: orohost's
 * `sys removeitem` answers `Item(s) removed` and keeps the item (2026-11-02),
 * so a break is waited for. Every line goes to `out/dig-probe.jsonl`. See
 * `mudengine-verify` › probes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { neverReachedRealm, probeSession } from './lib/probe-session.mjs';
import { wayOf } from '../src/main/automation/walk/ports.ts';
import { worldLeg } from '../src/main/session/navigation.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import { roomAddress } from '../src/shared/world.ts';
import {
  EXIT,
  HOST,
  PORT,
  configPath,
  localProfileNamed,
  nothing,
  skip,
  target
} from './lib/local-realm.mjs';

const GROTTOS = 'Musty Grottos, Portal';
// Both of the command's phrases, as gmud.zip's room script states them (`RoomCommand.say`).
const DIG = /^dig (up )?grave$/i;
// The realm's lines for the two outcomes the walk must read (gmud.zip block 9121, wire 2026-11-02).
const BROKE = /^Suddenly your shovel breaks in two/;
const NO_SHOVEL = /^Nothing happens\.$/;
const OUT = path.resolve('out/dig-probe.jsonl');

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const asName = option('--as');
const minutes = Number(option('--minutes') ?? 30);
const attackSpell = option('--attack-spell');
if (!asName) skip('say which character with --as <name>; it must not already be online.');
const profile = localProfileNamed(asName);
if (!profile) skip(`no character "${asName}" on ${HOST}:${PORT} with credentials.`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT, { flags: 'w' });
const started = Date.now();
function log(kind, text, extra = {}) {
  out.write(`${JSON.stringify({ t: Date.now(), kind, text, ...extra })}\n`);
  if (kind !== 'line')
    console.log(`  +${((Date.now() - started) / 1000).toFixed(1)}s [${kind}] ${text}`);
}

const library = new RealmLibrary({
  shippedDir: path.resolve('resources/world'),
  cacheDir: path.join(path.dirname(configPath()), 'realms'),
  notify: (message) => log('realm', message)
});
const world = library.load(profile.database).graph;
const grottos = world.findByName(GROTTOS)[0];
if (grottos === undefined) skip(`${GROTTOS} is not in ${profile.database || 'the shipped world'}.`);
const goal = `${grottos.map}/${grottos.room}`;
const gravedigger = world.mob('gravedigger');
/** Where a shovel is fetched from: the gravedigger's lairs. */
const digger = new Set(gravedigger === undefined ? [] : world.lairRoomsOf(gravedigger));

console.log(`\ndig-probe -> ${HOST}:${PORT} as ${profile.id}, to ${GROTTOS} (${goal})\n`);

const seen = {
  digs: 0,
  /** A dig sent with no pack listing since the one before it. */
  unlisted: 0,
  listedSinceDig: true,
  /** Shovels broken, digs said with none (`Nothing happens.`), and the time of the first break. */
  broke: 0,
  emptyHanded: 0,
  brokeAt: null,
  /** A gravedigger lair walked into after a break: the fetch going after a new shovel. */
  gravedigger: false,
  safetyAt: null,
  engagedAt: null
};

const session = probeSession(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim() !== '') log('line', text);
      if (BROKE.test(text)) {
        seen.broke += 1;
        seen.brokeAt ??= Date.now();
      }
      if (NO_SHOVEL.test(text)) seen.emptyHanded += 1;
    },
    block: () => {},
    players: () => {},
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: (message) => log('notice', message),
    command: (command, origin) => {
      log('sent', command, { origin });
      if (DIG.test(command.trim())) {
        if (seen.digs > 0 && !seen.listedSinceDig) seen.unlisted += 1;
        seen.digs += 1;
        seen.listedSinceDig = false;
      } else if (command.trim() === 'i') seen.listedSinceDig = true;
    },
    walk: (progress) => log('walk', `${progress.status} ${progress.done}/${progress.total}`),
    automation: (snapshot) => {
      // Newest first, and the snapshot repeats: each decision is logged once, when it is new.
      const safety = snapshot?.safety?.[0];
      if (safety && safety.at !== seen.safetyAt) {
        seen.safetyAt = safety.at;
        log('safety', JSON.stringify(safety));
      }
      const engaged = snapshot?.engagements?.[0];
      if (engaged && engaged.at !== seen.engagedAt) {
        seen.engagedAt = engaged.at;
        log('engage', JSON.stringify(engaged));
      }
    }
  },
  {
    world,
    automation: {
      ...profile.config.automation,
      enabled: true,
      idle: { ...profile.config.automation.idle, enabled: false },
      // As a player would set up a caster: `--attack-spell lbol` for a Mage.
      spells:
        attackSpell === undefined
          ? profile.config.automation.spells
          : { ...profile.config.automation.spells, attack: attackSpell }
    },
    login: profile.config.connection.login
  }
);
session.resize({ cols: 80, rows: 24 });

const here = () => roomAddress(session.character.room);
/** Whether a route's way into the grottos is the dig. */
const digs = (route) =>
  !route.blocked && route.steps.some((step) => DIG.test(step.command ?? '') && step.to === goal);
function describe(label, route) {
  log(
    'route',
    `${label}: ${route.steps.length} steps, ${route.steps
      .map((step) => step.command ?? step.direction)
      .join(' ')}`
  );
  for (const step of route.steps.filter((s) => (s.requirement?.tries ?? 1) > 1))
    log('route', `${step.from} "${step.command}" ~${Math.round(step.requirement.tries)} tries`, {
      requirement: step.requirement
    });
}

async function run() {
  await session.connect(target());
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && session.character.phase !== 'in-game') await wait(250);
  if (session.character.phase !== 'in-game') {
    log('harness', neverReachedRealm());
    return false;
  }
  await wait(3000);
  if (here() === null) {
    // What a player does at a room the client cannot place: look.
    session.send('look\r');
    await wait(2500);
  }
  const from = here();
  if (from === null) {
    log('harness', 'the client never placed the character; the route panel would refuse too.');
    return false;
  }
  const planned = session.leg(from, goal);
  if (typeof planned === 'string' || planned.blocked) {
    log(
      'harness',
      `no route from ${from}: ${typeof planned === 'string' ? planned : planned.reason}`
    );
    return false;
  }
  describe('the client plans', planned);
  /*
   * orohost's gmud.zip also has a way in on foot (a hidden `d` behind a
   * door), and the client rightly walks it rather than dig at 5%. To watch
   * the dig, the way into the grottos is left out, one edge at a time, the
   * way `ChanceWays` asks for a way round (`avoidEdges`), until the plan digs.
   */
  let route = planned;
  const leftOut = [];
  while (!digs(route) && leftOut.length < 4) {
    const last = route.steps.at(-1);
    leftOut.push(wayOf(last));
    route = worldLeg(world, from, goal, {
      ...session.travellerNow(session.character),
      avoidEdges: new Set(leftOut)
    });
    if (route.blocked) break;
  }
  if (!digs(route)) {
    log('harness', `no plan digs with ${leftOut.join(', ')} left out`);
    return false;
  }
  if (leftOut.length > 0) describe(`left out ${leftOut.join(', ')}`, route);
  const startedWalk = session.walkRoute(route);
  log('harness', `walkRoute: ${startedWalk ?? 'started'}`);
  if (startedWalk !== null) return false;

  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    await wait(500);
    if (here() === goal) break;
    if (session.character.phase !== 'in-game') break;
    if (seen.brokeAt !== null && digger.has(here() ?? '')) seen.gravedigger = true;
  }
  return true;
}

let reached = false;
try {
  reached = await run();
} finally {
  // Out the way a player leaves: the realm's own exit, then the socket.
  session.send('x\r');
  await wait(6000);
  session.disconnect();
  session.dispose();
  out.end();
}

const arrived = here() === goal;
console.log(
  `\n  digs ${seen.digs}, digs with no pack listed since the last ${seen.unlisted},` +
    ` shovels broken ${seen.broke}, digs with no shovel ${seen.emptyHanded},` +
    ` at a gravedigger lair after a break ${seen.gravedigger},` +
    ` arrived ${arrived}\n  log: ${OUT}\n`
);
if (!reached) nothing('the walk never started');
process.exit(arrived ? EXIT.found : EXIT.nothing);
