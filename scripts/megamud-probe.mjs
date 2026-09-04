/**
 * What does a real MegaMUD answer to each `@` query?
 *
 * `todo-megamud-commands.md` §1 lists eleven commands whose *action* this
 * client already has and whose *answer* has no capture: `{HP=…}` and `{ok}`
 * are the whole reply vocabulary the corpus shows, and answering anything
 * else means inventing a format another player's client then has to parse.
 * The only way to settle it is to ask a MegaMUD. This does: one character of
 * ours telepaths each query at a character running MegaMUD and records, per
 * query, every line that came back and how the classifier typed it.
 *
 * **Read-only queries only.** Everything sent is a question about the other
 * character's state. Nothing here moves them, drops anything, changes a
 * setting, attacks, or hangs up — `@drop-all`, `@goto`, `@stop`, `@auto-*`,
 * `@kill`, `@hangup` are not in the list and must not be added to it: the
 * MegaMUD on the other end obeys, and this is somebody's character.
 *
 * The partner is named on the command line so the probe cannot guess at a
 * stranger. Credentials never leave the test realm: `localProfile` picks the
 * character by target.
 *
 *   npm run probe:megamud -- --to Rand
 *   npm run probe:megamud -- --to Rand --ask "@have manual" --ask "@exp"
 *   npm run probe:megamud -- --to Rand --visit
 *   npm run probe:megamud -- --to Rand --as soul --visit
 *   npm run probe:megamud -- --to Rand --goto 1/297
 *   npm run probe:megamud -- --to Rand --get-all --ask "@have manual"
 *
 * `--as <id>` asks as a particular character of ours (a profile directory
 * name) rather than the first — the room the partner stands in may be behind
 * a level gate the first character cannot pass. Still only a character on
 * the local realm; `localProfileNamed` hands out nothing else.
 *
 * `--get-all` and `--step <direction>` are the **two actions** this probe will
 * take on the partner, each opt-in by name. `@get-all` has the other client
 * pick up what is on its floor, which is the only way to put something in its
 * hands for the `@have` answer nobody had seen. `@do <direction>` has it take
 * one step — the only way to ask `@what` of a different floor when the room
 * it stands in has fixtures nothing will lift — and it is a *direction* and
 * nothing else, so the probe itself sends the opposite one after the
 * questions and asks `@where` to confirm, before it disconnects.
 * Both are here because the partner this was written against is a character
 * of ours, set up to obey every `@` command from this one (`TODO.md`); they
 * stay out of `--ask` and off by default, and the run says out loud that it
 * is about to act on somebody's character.
 *
 * `--goto` walks to a room by id or name and stops there — the way back for
 * a character a visit left somewhere, and nothing else.
 *
 * `--visit` walks this character to the room the partner's `@where` names,
 * asks the questions whose answers change with company present (`@who`,
 * `@what`), and walks back. It moves the character, so it is asked for by
 * name; it routes through the realm data, stops at the first room that is not
 * the one expected or the first fight, and never opens a door or forces one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import {
  configPath,
  HOST,
  PORT,
  localProfile,
  localProfileNamed,
  nothing,
  skip,
  target
} from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const toIndex = process.argv.indexOf('--to');
const partner = toIndex === -1 ? null : process.argv[toIndex + 1];
/*
 * Extra questions, `--ask "@have manual"`, repeatable. Still questions, and
 * checked **whole** before anything is sent: the query word must be one of
 * the read-only list above, and the rest may be one plain argument — letters,
 * digits, spaces, an apostrophe or a hyphen — so nothing that could carry a
 * second line or a second command to the other character's client gets past
 * the guard on the strength of its first word.
 */
const extras = process.argv
  .map((arg, index) => (arg === '--ask' ? (process.argv[index + 1] ?? '') : null))
  .filter((arg) => arg !== null);
if (!partner || !/^[A-Za-z][\w'-]*$/.test(partner)) {
  console.error('\nusage: npm run probe:megamud -- --to <character running MegaMUD>\n');
  process.exit(2);
}

/** Questions only. See the header before adding one. */
const QUERIES = [
  '@health',
  '@exp',
  '@level',
  '@lives',
  '@wealth',
  '@enc',
  '@where',
  '@who',
  '@what',
  '@have torch',
  '@settings',
  '@version',
  '@status',
  '@seen',
  '@path'
];

const READ_ONLY = new Set(QUERIES.map((query) => query.split(' ')[0]));
const ONE_QUESTION = /^(@[a-z-]+)(?: [\w' -]{1,40})?$/;
for (const extra of extras) {
  const shape = ONE_QUESTION.exec(extra);
  if (shape === null || !READ_ONLY.has(shape[1])) {
    console.error(
      `\nrefusing to send ${JSON.stringify(extra)}: one read-only query, one plain argument.\n`
    );
    process.exit(2);
  }
}

const visit = process.argv.includes('--visit');
const getAll = process.argv.includes('--get-all');
/** The way back from each of the ten directions. */
const OPPOSITE = {
  n: 's',
  s: 'n',
  e: 'w',
  w: 'e',
  ne: 'sw',
  sw: 'ne',
  nw: 'se',
  se: 'nw',
  u: 'd',
  d: 'u'
};
const stepIndex = process.argv.indexOf('--step');
const step = stepIndex === -1 ? null : (process.argv[stepIndex + 1] ?? '');
if (step !== null && !/^(n|s|e|w|ne|nw|se|sw|u|d)$/.test(step)) {
  console.error(
    `\nrefusing --step ${JSON.stringify(step)}: one of the ten directions, so it can be walked back.\n`
  );
  process.exit(2);
}
const asIndex = process.argv.indexOf('--as');
const asWho = asIndex === -1 ? null : (process.argv[asIndex + 1] ?? null);
const gotoIndex = process.argv.indexOf('--goto');
const goTo = gotoIndex === -1 ? null : (process.argv[gotoIndex + 1] ?? null);

const profile = asWho === null ? localProfile() : localProfileNamed(asWho);
if (!profile) {
  skip(
    asWho === null
      ? `no character on ${HOST}:${PORT} with credentials.`
      : `no character '${asWho}' on ${HOST}:${PORT} with credentials.`
  );
}

/*
 * The realm data, for the walk: where this character is, where the partner
 * is, and the steps between. Only loaded when asked to walk — the questions
 * alone need no map.
 */
const world =
  visit || goTo !== null
    ? new RealmLibrary({
        shippedFile: path.resolve('resources/world/rooms.jsonl.gz'),
        cacheDir: path.join(path.dirname(configPath()), 'realms'),
        notify: () => {}
      }).load(profile.database).graph
    : undefined;

console.log(`\nmegamud-probe -> ${HOST}:${PORT}, ${profile.id} asking ${partner}\n`);

const runs = [];
let current = null;
let online = [];

let lastTelepath = null;
const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      current?.lines.push(text);
      const reply = /^\w+ telepaths: \{(?<body>.*)\}\s*$/.exec(text);
      if (reply?.groups) lastTelepath = reply.groups.body;
    },
    block: (block) => {
      current?.blocks.push({ type: block.type, groups: block.groups ?? {} });
    },
    character: (state) => {
      online = state.online.map((who) => who.name);
    },
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  world,
  // Nothing standing, and this character must not itself answer `@` commands
  // the partner might send back: the measurement is what *MegaMUD* says.
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false },
    remotes: { ...profile.config.automation.remotes, enabled: false },
    rules: []
  },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

async function ask(query, settle = 4000) {
  current = { query, lines: [], blocks: [] };
  runs.push(current);
  session.send(`/${partner} ${query}\r`);
  await wait(settle);
  current = null;
}

const hereId = () => {
  const { map, number } = session.character.room;
  return map === null || number === null ? null : `${map}/${number}`;
};
const hereName = () => session.character.room.name ?? '';

/**
 * Walks to a named room and says why it stopped, or null. A direction at a
 * time, each confirmed by the room that arrives: a step that lands somewhere
 * else is the end of the walk, not a reason to keep sending. Nothing gated is
 * walked — no door is opened or forced — and a fight ends the walk.
 */
async function walkTo(name, limit = 40) {
  if (!world) return 'no realm data';
  const from = hereId();
  const byId = /^\d+\/\d+$/.test(name) ? world.byId(name) : undefined;
  const destination = byId ?? world.findByName(name)[0];
  if (from === null) return 'this character is not placed';
  if (destination === undefined) return `the realm data has no room called ${name}`;
  const to = `${destination.map}/${destination.room}`;
  if (from === to) return null;
  // As the client routes: what this character can pass, so a level-gated room
  // is priced out rather than walked up to and refused.
  const route = world.route(from, to, {
    level: session.character.progress.level,
    wealth: session.character.inventory.wealth
  });
  if (route.blocked) return route.reason ?? `no route to ${name}`;
  if (route.steps.length > limit) return `${name} is ${route.steps.length} steps away`;
  /*
   * The whole route is checked before one step is sent. A gate found on step
   * four after three were walked leaves the character three rooms from where
   * it was, which is what the first run of this did; a walk that cannot be
   * finished is not started.
   */
  const gated = route.steps.find((step) => step.requirement);
  if (gated) return `${gated.name} is gated (${gated.requirement.raw}); not walking`;
  for (const step of route.steps) {
    session.send(`${step.command}\r`);
    await wait(1600);
    if (session.character.inCombat) return `a fight started at ${hereName()}`;
    if (hereName().toLowerCase() !== step.name.toLowerCase()) {
      return `expected ${step.name}, arrived in ${hereName() || 'nowhere the data knows'}`;
    }
  }
  return null;
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
  // Let the entry probes finish, and let the roster say whether the partner
  // is here at all — a telepath at an absent name is a question to nobody.
  await wait(4000);
  session.send('who\r');
  await wait(3000);
  if (!online.some((name) => name.toLowerCase() === partner.toLowerCase())) {
    session.disconnect();
    session.dispose();
    // Ran, and there was nobody to ask: distinguishable from an answer.
    nothing(`${partner} is not in the realm (roster: ${online.join(', ') || 'empty'}).`);
  }

  if (goTo !== null) {
    console.log(`  walking from ${hereName()} (${hereId()}) to ${goTo}.`);
    const stopped = await walkTo(goTo, 80);
    console.log(stopped === null ? `  at ${hereName()} (${hereId()}).` : `  stopped: ${stopped}`);
  } else if (visit) {
    /*
     * Where the partner is, in their own words, then the walk there and the
     * questions whose answers change with somebody present. The way back is
     * the same walk reversed, and a walk that stops early is reported rather
     * than pressed: the character stays where it is, placed, and the report
     * says where.
     */
    const start = hereId();
    const startName = hereName();
    await ask('@where');
    const where = /^(?<room>.+?)(?: \(Exits:.*\))?$/.exec(lastTelepath ?? '');
    const room = where?.groups?.room ?? null;
    if (room === null) {
      console.log(
        `  ${partner}'s @where gave nothing to walk to (${lastTelepath ?? 'no reply'}).\n`
      );
    } else {
      console.log(`  ${partner} is at ${room}; walking from ${startName} (${start}).`);
      const stopped = await walkTo(room);
      if (stopped !== null) console.log(`  stopped: ${stopped}`);
      else {
        console.log(`  arrived; asking with company present.`);
        for (const query of ['@who', '@what', '@have torch']) await ask(query);
        if (startName.length > 0) {
          const back = await walkTo(startName);
          console.log(
            back === null ? `  back at ${startName}.` : `  walking back stopped: ${back}`
          );
        }
      }
    }
  } else {
    if (getAll) {
      console.log(
        `  asking ${partner} to pick up what is on its floor -- an action on their character.`
      );
      await ask('@get-all', 6000);
    }
    if (step !== null) {
      console.log(
        `  asking ${partner} to step ${step} -- an action on their character; walked back below.`
      );
      await ask(`@do ${step}`, 6000);
    }
    for (const query of extras.length > 0 ? extras : QUERIES) await ask(query);
    if (step !== null) {
      // The way back, and the proof it was taken: a partner left one room over
      // would be this probe's doing, and the run says where it stands.
      await ask(`@do ${OPPOSITE[step]}`, 6000);
      await ask('@where');
      console.log(
        `  ${partner} stepped back ${OPPOSITE[step]}; says: ${lastTelepath ?? 'no reply'}`
      );
    }
  }

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > /${partner} ${entry.query}`);
    for (const line of entry.lines) console.log(`      | ${line}`);
    const types = entry.blocks.map((b) => b.type).filter((type) => type !== 'status-line');
    console.log(`    blocks: ${types.join(', ') || '(none)'}`);
  }

  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/megamud-probe.json', `${JSON.stringify(runs, null, 2)}\n`);
  console.log('\n  full capture -> out/megamud-probe.json\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
