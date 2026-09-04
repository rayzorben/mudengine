/**
 * Do the `@` commands actually round-trip between two of our own characters?
 *
 * Only two characters can answer this, and only a live realm: `@health` is a
 * telepath one client sends and another client answers, and every part of the
 * exchange — the channel, the reply format, the parse back into party state —
 * is invisible to a unit test.
 *
 * What it measures, in order:
 *
 * 1. One character telepaths `@health` at the other.
 * 2. The other answers `{HP=…}` in the format the captures show
 *    (captures/055, captures/123), on the channel the captures show.
 * 3. The asker reads the reply and — when the two are in a party — folds the
 *    numbers onto that member.
 * 4. `@kill` is **refused**, out loud, and nothing is attacked.
 *
 * `automation.remotes` is off in the options file by design, so it is turned on
 * *here* rather than in the user's configuration.
 *
 *   node --import tsx scripts/remotes-probe.mjs -- --pair soul,yang
 */
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { HOST, PORT, localProfiles, skip, target } from './lib/local-realm.mjs';
import { ACTIONABLE_REMOTES } from '../src/shared/remotes.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const pairArg = process.argv[process.argv.indexOf('--pair') + 1];
const wanted = process.argv.includes('--pair') && pairArg ? pairArg.split(',') : null;
const local = localProfiles().filter((p) => wanted === null || wanted.includes(p.id));
if (local.length < 2) {
  skip(`need two characters on ${HOST}:${PORT} with credentials; found ${local.length}.`);
}

const world = WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
console.log(`\nremotes-probe -> ${HOST}:${PORT}\n`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n         ${detail}` : ''}`);
};

function open(profile) {
  const automation = {
    ...profile.config.automation,
    /*
     * The point of the run, and it is switched on here rather than in the
     * options file, where it is off by design.
     *
     * Nobody is granted anything **yet**: permission is per command and per
     * *name*, and the name that matters is the one the realm gives the other
     * character, which nothing knows until both have logged in. `grantEach`
     * below reconfigures both sessions once it does. Granting a guess here --
     * the profile's display name, the login username -- would measure silence
     * whenever the guess was wrong, and silence is exactly what this probe is
     * trying to distinguish a failure from.
     */
    remotes: { enabled: true, gangpath: true, gang: [], players: {} },
    idle: { ...profile.config.automation.idle, enabled: false },
    rules: []
  };
  const state = { profile, automation, lines: [], sent: [], notices: [], session: null };
  state.session = new SessionManager(
    {
      data: () => {},
      line: (line) => {
        const text = line.plain.replace(/\s+$/, '');
        if (text.trim().length > 0) state.lines.push(text);
      },
      block: () => {},
      character: () => {},
      state: () => {},
      telnet: () => {},
      notice: (message) => state.notices.push(message),
      command: (command) => state.sent.push(command)
    },
    world,
    automation,
    profile.config.connection.login
  );
  state.session.resize({ cols: 80, rows: 24 });
  return state;
}

async function say(who, command, settle = 1800) {
  who.session.send(`${command}\r`);
  await wait(settle);
}

async function reachRealm(who) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await wait(250);
    if (who.session.character.phase === 'in-game') return true;
  }
  return false;
}

const nameOf = (who) => who.session.character.name ?? '(unknown)';

/**
 * Each character grants the other every remote this client can answer, by the
 * name the realm actually gave them.
 *
 * After login, because that is when the names exist. `@kill` and the rest of
 * the standing refusals are deliberately *not* granted -- they cannot be, and
 * they are refused by the table rather than by a permission, which is the
 * behaviour check 4 measures.
 */
function grantEach(one, two) {
  for (const [self, other] of [
    [one, two],
    [two, one]
  ]) {
    self.session.configure(
      {
        ...self.automation,
        remotes: {
          ...self.automation.remotes,
          players: {
            [nameOf(other).toLowerCase()]: { allow: [...ACTIONABLE_REMOTES], deny: [] }
          }
        }
      },
      self.profile.config.connection.login
    );
  }
}
const roomIdOf = (who) => {
  const { map, number } = who.session.character.room;
  return map === null || number === null ? null : `${map}/${number}`;
};

/** Retraces to a remembered room, replanning rather than reversing the steps. */
async function walkBack(who, destination) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const from = roomIdOf(who);
    if (from === null || from === destination) return;
    const route = world.route(from, destination, {
      level: who.session.character.progress.level ?? 1
    });
    if (!route || route.blocked || route.steps.length === 0) return;
    for (const step of route.steps) {
      if (step.requirement?.kind === 'door') await say(who, `open ${step.direction}`, 1200);
      await say(who, step.command, 1300);
    }
  }
}

/** Walks the second character to the first, over open steps only. */
async function walkTogether(one, two) {
  const there = roomIdOf(one);
  const from = roomIdOf(two);
  if (there === null || from === null || there === from) return;
  const route = world.route(from, there, {
    level: two.session.character.progress.level ?? 1
  });
  if (!route || route.blocked || route.steps.length === 0 || route.steps.length > 25) {
    console.log(`   (no short route to bring them together; ${route?.steps.length ?? 0} steps)\n`);
    return;
  }
  console.log(`   walking ${nameOf(two)} ${route.steps.length} steps to ${nameOf(one)}\n`);
  for (const step of route.steps) {
    if (step.requirement?.kind === 'door') await say(two, `open ${step.direction}`, 1200);
    await say(two, step.command, 1300);
  }
}

async function main() {
  const [asker, answerer] = [open(local[0]), open(local[1])];
  await asker.session.connect(target());
  await answerer.session.connect(target());

  if (!(await reachRealm(asker)) || !(await reachRealm(answerer))) {
    console.log('   one of them never reached the realm; nothing to measure.\n');
    asker.session.dispose();
    answerer.session.dispose();
    process.exit(1);
  }
  await wait(3000);
  console.log(`   ${nameOf(asker)} asking, ${nameOf(answerer)} answering\n`);
  grantEach(asker, answerer);
  // Remembered before anything moves, so the walk back has somewhere to go.
  const startedAt = roomIdOf(answerer);

  /* ---------------------------------------------------------- @health */
  const before = answerer.sent.length;
  await say(asker, `/${nameOf(answerer)} @health`, 3500);

  const answered = answerer.sent.slice(before).filter((c) => /^\/\S+ \{HP=/.test(c));
  check(
    'the receiver answers @health in the captured format',
    answered.length > 0,
    answered[0] ?? `sent: ${answerer.sent.slice(before).join(' | ') || 'nothing'}`
  );

  const heard = asker.lines.filter((l) => /\{HP=\d+\/\d+/.test(l));
  check(
    'and the answer reaches the asker',
    heard.length > 0,
    heard.at(-1) ?? 'no {HP=…} line arrived'
  );

  /* ------------------------------------- and lands on the party member */
  /*
   * A party needs them in one room, and the realm decides where each character
   * logs in. Walked rather than teleported, and only over a short unobstructed
   * route: this is a measurement of `@health`, not of the router, and a long
   * walk through doors is a different probe's failure mode.
   */
  await walkTogether(asker, answerer);

  await say(asker, `invite ${nameOf(answerer)}`, 2000);
  await say(answerer, `join ${nameOf(asker)}`, 2500);
  await say(asker, 'party', 2500);
  const inParty = asker.session.character.party.members.some(
    (m) => m.name.toLowerCase() === nameOf(answerer).toLowerCase()
  );
  if (inParty) {
    await say(asker, `/${nameOf(answerer)} @health`, 3500);
    const member = asker.session.character.party.members.find(
      (m) => m.name.toLowerCase() === nameOf(answerer).toLowerCase()
    );
    check(
      'the numbers land on the party member, not just on the screen',
      member?.vitals != null,
      member?.vitals
        ? `${member.name}: ${member.vitals.hp}/${member.vitals.hpMax}` +
          (member.vitals.mana === null ? '' : `, ${member.vitals.mana}/${member.vitals.manaMax}`)
        : 'no vitals recorded'
    );
  } else {
    console.log('   SKIP  they are not in one room, so no party formed to fold the numbers into\n');
  }

  /* ------------------------------------------------------------ @kill */
  const beforeKill = answerer.sent.length;
  await say(asker, `/${nameOf(answerer)} @kill ${nameOf(asker)}`, 3000);
  const afterKill = answerer.sent.slice(beforeKill);
  check(
    '@kill is refused rather than obeyed',
    afterKill.some((c) => /\{no: /.test(c)) && !afterKill.some((c) => /^(a|att|attack|k|kill)\b/i.test(c)),
    afterKill.join(' | ') || 'nothing sent'
  );

  /* ------------------------------------------------------------ tidy */
  await say(asker, `uninvite ${nameOf(answerer)}`, 1500);
  await say(answerer, 'disband', 1500);
  // Walked back, like every other probe here: running one must not be a way to
  // leave a character somewhere its player did not put it.
  if (startedAt !== null && roomIdOf(answerer) !== startedAt) {
    await walkBack(answerer, startedAt);
    console.log(
      `\n   ${nameOf(answerer)} back at ${roomIdOf(answerer) ?? 'nowhere'} ` +
        `(started at ${startedAt})`
    );
  }

  if (answerer.notices.length > 0) {
    console.log('\n   what the receiver said to its own player:');
    for (const message of answerer.notices.slice(-8)) console.log(`     ${message}`);
  }

  asker.session.disconnect();
  answerer.session.disconnect();
  await wait(800);
  asker.session.dispose();
  answerer.session.dispose();

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nAll remote checks passed.\n' : `\n${failed.length} check(s) failed.\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
