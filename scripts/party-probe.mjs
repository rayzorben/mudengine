/**
 * What does a party look like on the wire?
 *
 * `npm run probe:tour` found the party roster as the one genuinely unmodelled
 * thing the client cannot read, and it is the interesting one: it carries each
 * member's class, their **health as a percentage** and their rank in the
 * formation — most of what a multiboxing client wants about the characters it
 * is not looking at, from one command and without a second connection.
 *
 * Modelling it needs the shapes for forming a party, a member joining, one
 * leaving, and the roster with more than one name in it. Guessing those from
 * another client's source is the mistake CLAUDE.md exists to prevent, so this
 * asks the server.
 *
 * Two characters on `gmud-tgs:2427`, chosen from the profiles directory by
 * *target* so credentials cannot leave the local server. One invites, the other
 * joins, both look, one leaves. Everything either of them sees is reported with
 * the command that provoked it and what the classifier made of it.
 *
 * The characters are walked to the same room first — a party needs them
 * together — and left where they were found.
 *
 *   npm run probe:party
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { HOST, PORT, localProfiles, skip, target } from './lib/local-realm.mjs';
import { OPPOSITE } from '../src/shared/world.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Credentials never leave the test realm; chosen by target, never by filename.
 * `--pair soul,yang` picks two of the local characters by profile id — still
 * only from the set that points at the test realm, so the rule holds.
 */
const pairArg = process.argv[process.argv.indexOf('--pair') + 1];
const wanted = process.argv.includes('--pair') && pairArg ? pairArg.split(',') : null;
const local = localProfiles().filter((p) => wanted === null || wanted.includes(p.id));

if (local.length < 2) {
  skip(`need two characters on ${HOST}:${PORT} with credentials; found ${local.length}.`);
}

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\nparty-probe -> ${HOST}:${PORT}\n`);

/** One connected character, with everything it has seen. */
function open(profile) {
  const seen = [];
  const state = { profile, seen, provokedBy: '(connect)', session: null, character: null };
  state.session = new SessionManager(
    {
      data: () => {},
      line: (line) => {
        const text = line.plain.replace(/\s+$/, '');
        if (text.trim().length === 0) return;
        seen.push({ seq: line.seq, text, after: state.provokedBy, types: [] });
      },
      block: (block) => {
        const entry = seen.find((row) => row.seq === block.seq);
        if (entry) entry.types.push(block.type);
      },
      character: (character) => {
        state.character = character;
      },
      state: () => {},
      telnet: () => {},
      notice: () => {}
    },
    world,
    {
      ...profile.config.automation,
      idle: { ...profile.config.automation.idle, enabled: false },
      rules: []
    },
    profile.config.connection.login
  );
  state.session.resize({ cols: 80, rows: 24 });
  return state;
}

async function say(who, command, settle = 1500) {
  who.provokedBy = command === '' ? '<enter>' : command;
  who.session.send(`${command}\r`);
  await wait(settle);
}

async function reachRealm(who) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await wait(250);
    if (who.session.character.phase === 'in-game') return true;
  }
  return false;
}

async function main() {
  const [one, two] = [open(local[0]), open(local[1])];

  await one.session.connect(target());
  await two.session.connect(target());

  if (!(await reachRealm(one)) || !(await reachRealm(two))) {
    console.log('  one of them never reached the realm; nothing to measure.\n');
    one.session.dispose();
    two.session.dispose();
    return;
  }
  await wait(3000);

  const nameOf = (who) => who.session.character.name ?? '(unknown)';
  const roomOf = (who) => who.session.character.room;
  console.log(`  ${nameOf(one)} in ${roomOf(one).name}, ${nameOf(two)} in ${roomOf(two).name}\n`);

  /*
   * A party needs them in one room. Walked rather than teleported: the second
   * character retraces its steps at the end, so the probe leaves both where it
   * found them.
   */
  /*
   * Either of them may walk. The first run of this only ever walked the
   * second character, and the one time it mattered that route was gated while
   * the reverse was open — so both are planned and whichever is short and
   * unobstructed is taken. `walker` is who moved and is who walks back.
   */
  let walker = two;
  const back = [];
  const plan = (from, to) => {
    if (roomOf(from).map === null || roomOf(to).map === null) return null;
    const route = world.route(
      `${roomOf(from).map}/${roomOf(from).number}`,
      `${roomOf(to).map}/${roomOf(to).number}`,
      { level: from.session.character.progress.level ?? null }
    );
    const gated = route.steps.filter((step) => step.requirement !== null);
    if (route.blocked) return { ok: false, why: `no route: ${route.reason ?? 'blocked'}` };
    if (gated.length > 0) return { ok: false, why: `needs ${gated.length} gated step(s)` };
    if (route.steps.length > 30) return { ok: false, why: `${route.steps.length} steps; too far` };
    if (route.steps.length === 0) return { ok: false, why: 'already together' };
    return { ok: true, route };
  };
  {
    let chosen = plan(two, one);
    if (chosen && !chosen.ok) {
      console.log(`  ${nameOf(two)} -> ${nameOf(one)}: ${chosen.why}`);
      const other = plan(one, two);
      if (other && other.ok) {
        chosen = other;
        walker = one;
      } else if (other) console.log(`  ${nameOf(one)} -> ${nameOf(two)}: ${other.why}`);
    }
    /*
     * Shortest, unobstructed and short. `check:live` once drowned a character
     * by preferring the *longest* unobstructed route: the realm data marks
     * doors and level gates and marks nothing at all about water, so
     * "unobstructed" is not "safe" and the only real mitigation is brevity.
     */
    if (chosen && chosen.ok) {
      const route = chosen.route;
      const there = walker === two ? one : two;
      console.log(`  walking ${nameOf(walker)} ${route.steps.length} steps to ${nameOf(there)}\n`);
      for (const step of route.steps) {
        await say(walker, step.command, 900);
        back.unshift(OPPOSITE[step.command] ?? null);
      }
    } else {
      console.log('  no short safe route between them; asking anyway.\n');
    }
  }

  /*
   * Let the arrival land before inviting.
   *
   * The first run of this invited while the last step of the walk was still in
   * flight and got "You don't see soul here." — the server had not put them in
   * the room yet. A probe that races the thing it is measuring measures the
   * race.
   */
  await wait(2500);

  // The script. Each line isolates one shape.
  await say(one, 'party'); //            alone
  await say(one, `invite ${nameOf(two)}`); // the invitation, from the leader
  await say(two, `join ${nameOf(one)}`); //   and accepting it
  await say(one, 'party'); //            the roster, with two in it
  await say(two, 'party'); //            and from the other side
  /*
   * Following, on the wire: the leader takes one open step and comes back,
   * and what the follower's client is told in between is the whole of what a
   * party's movement looks like to the character not doing the walking.
   */
  {
    const exit = roomOf(one).exits.find(
      (e) => !e.door && e.direction !== 'u' && e.direction !== 'd' && OPPOSITE[e.direction]
    );
    if (exit) {
      await say(one, exit.direction, 3000);
      await say(one, OPPOSITE[exit.direction], 3000);
    } else console.log(`  no open step for the leader to take: ${JSON.stringify(roomOf(one).exits)}`);
  }
  await say(two, 'backrank'); //         a rank change, which the roster shows
  await say(one, 'party');
  /*
   * Snapshotted here, while the party exists.
   *
   * Reporting the *final* state would report an empty party every time, because
   * the last thing the script does is break it up — which is a probe that
   * cannot fail.
   */
  const understood = {
    [nameOf(one)]: one.character?.party,
    [nameOf(two)]: two.character?.party
  };

  await say(two, 'leave'); //            and breaking it up
  await say(one, 'party');

  // Put the second character back where it started.
  for (const step of back) if (step) await say(walker, step, 900);

  one.session.disconnect();
  two.session.disconnect();
  one.session.dispose();
  two.session.dispose();

  /*
   * What the client made of it, not only what the server said. A probe that
   * reports the wire and stops is a probe that can be satisfied by a pattern
   * that matches and a tracker that ignores it.
   */
  console.log('\n  ----- what the client understood, while the party existed -----');
  for (const who of [one, two]) {
    const party = understood[nameOf(who)];
    console.log(`\n  ${nameOf(who)}: following ${party?.following ?? '(nobody)'}`);
    for (const member of party?.members ?? []) {
      console.log(
        `    ${member.name.padEnd(12)} ${(member.className ?? '?').padEnd(10)} ` +
          `hp ${member.health === null ? '?' : `${Math.round(member.health * 100)}%`}  ` +
          `mana ${member.mana === null ? '—' : `${Math.round(member.mana * 100)}%`}  ` +
          `${member.rank ?? '?'}`
      );
    }
    if ((party?.members.length ?? 0) === 0) console.log('    (nobody)');
  }

  for (const who of [one, two]) {
    console.log(`\n  ===== ${nameOf(who)} =====`);
    let last = null;
    for (const entry of who.seen) {
      // Only what a party command provoked: everything else is the connect
      // sequence and the walk, which other probes already cover.
      if (!/party|invite|join|leave|backrank|frontrank|^[nsew]{1,2}$/.test(entry.after)) continue;
      if (entry.after !== last) {
        console.log(`\n  > ${entry.after}`);
        last = entry.after;
      }
      const read = entry.types.filter((type) => type !== 'unknown');
      console.log(`      ${read.length > 0 ? `[${read.join(',')}]` : '[  ?  ]'} ${entry.text}`);
    }
  }

  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(
    'out/party-probe.json',
    `${JSON.stringify({ one: one.seen, two: two.seen }, null, 2)}\n`
  );
  console.log('\n  full capture -> out/party-probe.json\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
