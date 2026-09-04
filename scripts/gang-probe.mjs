/**
 * What does this server say when somebody joins or leaves a gang?
 *
 * The gang is now a **permission**: `automation.remotes.gang` says what anybody
 * in this character's gang may ask for, and `evidenceAbout` decides who is in
 * it by comparing two rows of the `who` listing. That comparison is the only
 * evidence this client has, and it rests on two things nobody has checked
 * against the wire:
 *
 * 1. **Does a `who` row's gang column actually change** when somebody joins or
 *    leaves one? The column is read (`patterns.ts`, two spacings, 13 corpus
 *    files across 15 gangs) but every one of those captures is a *steady*
 *    roster. Nothing has watched one change.
 * 2. **What does the server volunteer** at the moment it happens — a gangpath,
 *    a broadcast, a line in the room, nothing at all? `docs/game-behaviour.md`
 *    has gangpath as *not observed; needs a gang*, and the receive pattern came
 *    from `CommManager.cs` rather than from bytes.
 *
 * Only a live realm can answer either, and only with a second character that
 * will actually join a gang. So: one character of ours watches, and a partner
 * running MegaMUD is asked — by telepath, through the `@do` this client already
 * speaks — to join and then to leave. Every line either of them sees is
 * recorded verbatim with the classifier's reading of it.
 *
 *   npm run probe:gang -- --to Rand                     # watch only
 *   npm run probe:gang -- --to Rand --join valor        # ask them to join
 *   npm run probe:gang -- --to Rand --join valor --leave
 *   npm run probe:gang -- --to Rand --leave             # ask them to leave
 *   npm run probe:gang -- --to Rand --join valor --as probe
 *
 * ## The two actions are opt-in, by name, and said out loud
 *
 * `@do join gang <name>` and `@do leave gang` **change somebody's character**,
 * which is a different thing from every question `probe:megamud` asks. They
 * follow that probe's `--get-all` precedent exactly: off unless asked for by
 * name, announced before they are sent, and allowed only because the partner on
 * the other end is a character of ours set up to obey this client.
 *
 * The gang name is checked whole before anything is sent — one plain word, so
 * nothing that could carry a second command to the other character's client
 * gets past on the strength of its first word. An unknown command is *said out
 * loud in the room* on this server, which is why `AutoLoot` will not risk `get
 * all`; the same caution applies to a string sent through somebody else's `@do`.
 *
 * ## What it does not do
 *
 * It never joins a gang **itself**. Membership of this character is a decision
 * with consequences on a live realm, and a probe is the last thing that should
 * make one. What it needs is the *other* row moving, which is what it asks for.
 *
 * ## What it found, 2026-08-29, and what it did not
 *
 * Run against `orohost:2427` with Vaelor watching and Rand running MegaMUD 2.1
 * (`out/gang-probe.json`):
 *
 * **Settled.** Both halves of the comparison the permission rests on are read
 * off one live `who`: `Vaelor  -  Kai Warrior of Valor S` gives *Valor*, and
 * `Rand  -  Apprentice` gives *none* — a row a listing wrote in full with no
 * gang, which is a real `false` rather than an unknown. So `gangOnRoster`
 * answers for both rows on this realm, and `evidenceAbout` correctly refuses
 * Rand the gang's grants.
 *
 * **Not settled, and the reason is worth keeping.** `@do join gang valor` and
 * `@do leave gang` were both acknowledged `{ok}` by MegaMUD — it ran them — and
 * the server produced *nothing*: no gangpath, no broadcast, no line in the
 * room, and no change to either `who` row. The explanation is in the server's
 * own command table: `Join` (`jo` `joi` `join`) and `Leave` (`le` `lea` `leav`
 * `leave`) are the **party** verbs, and `Broadgang` is the only gang verb
 * GreaterMUD has. So `join gang valor` was read as `Join` with an argument, and
 * the syntax MegaMUD's manual documents is not this realm's.
 *
 * Which means **how a gang is joined on this server is still unknown**, and the
 * two questions above are still open. What would settle them is a gang whose
 * membership actually changes — an operator, or whatever mechanism this realm
 * uses — not another guessed command: an unknown command is said out loud in
 * the room here, and guessing at verbs through somebody else's `@do` broadcasts
 * the guess from their character rather than from this one.
 *
 * A side effect worth knowing about: because `leave` is the party verb, a
 * `--leave` run asks the partner to leave whatever **party** they are in.
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfile, localProfileNamed, nothing, skip, target } from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const partner = arg('--to');
if (!partner || !/^[A-Za-z][\w'-]*$/.test(partner)) {
  console.error('\nusage: npm run probe:gang -- --to <character running MegaMUD> [--join <gang>] [--leave]\n');
  process.exit(2);
}

/*
 * One plain word. A gang name with a space, a slash or a semicolon in it is
 * refused rather than quoted: this string is handed to another player's client
 * to run as a command, and the only safe shape is one nothing can be smuggled
 * into.
 */
const joinGang = arg('--join');
if (joinGang !== null && !/^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(joinGang)) {
  console.error(`\nrefusing --join ${JSON.stringify(joinGang)}: one plain word.\n`);
  process.exit(2);
}
const leaving = process.argv.includes('--leave');

const asWho = arg('--as');
const profile = asWho === null ? localProfile() : localProfileNamed(asWho);
if (!profile) {
  skip(
    asWho === null
      ? `no character on ${HOST}:${PORT} with credentials.`
      : `no character '${asWho}' on ${HOST}:${PORT} with credentials.`
  );
}

console.log(`\ngang-probe -> ${HOST}:${PORT}, ${profile.id} watching ${partner}\n`);
if (joinGang !== null || leaving) {
  // Said before it happens, like `--get-all`: this moves somebody's character.
  console.log(
    `  this run will ask ${partner} to ${[
      joinGang === null ? null : `join gang ${joinGang}`,
      leaving ? 'leave their gang' : null
    ]
      .filter(Boolean)
      .join(', then ')}.\n`
  );
}

/** Every phase's lines and blocks, in order, so the report reads as a story. */
const phases = [];
let current = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length > 0) current?.lines.push(text);
    },
    block: (block) => {
      current?.blocks.push({ type: block.type, groups: block.groups ?? {} });
    },
    character: () => {},
    state: () => {},
    telnet: () => {},
    notice: (message) => current?.notices.push(message)
  },
  undefined,
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false },
    /*
     * This character must not answer anything itself: the measurement is what
     * the *server* says about a gang changing, and a reply of ours in the
     * middle of it would be a line in the record that this run put there.
     */
    remotes: { enabled: false, gangpath: false, gang: [], players: {} },
    rules: []
  },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

async function phase(name, settle = 4000) {
  current = { phase: name, lines: [], blocks: [], notices: [] };
  phases.push(current);
  await wait(settle);
  current = null;
  return phases.at(-1);
}

/** Sends one command and records everything that follows it under `name`. */
async function step(name, command, settle = 4000) {
  current = { phase: name, command, lines: [], blocks: [], notices: [] };
  phases.push(current);
  session.send(`${command}\r`);
  await wait(settle);
  current = null;
  return phases.at(-1);
}

/**
 * What the roster says about one name's gang right now.
 *
 * `undefined` for a row nothing has listed, `null` for one a listing wrote in
 * full with no gang on it, and the name otherwise — the same three answers
 * `gangOnRoster` gives, because that is the function the permission gate reads
 * and this probe is measuring whether it can ever see a change.
 */
function gangOf(name) {
  if (name === null) return undefined;
  const row = session.character.online.find(
    (entry) => entry.name.toLowerCase() === name.toLowerCase()
  );
  if (row === undefined) return undefined;
  if (row.gang !== null) return row.gang;
  return row.provisional ? undefined : null;
}

const partnerGang = () => gangOf(partner);
/** And this character's own, which is the other half of the comparison. */
const ownGang = () => gangOf(session.character.name);

const say = (value) => (value === undefined ? 'unlisted' : (value ?? 'none'));

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
  await phase('settling', 4000);

  await step('who (before)', 'who', 3000);
  if (!session.character.online.some((row) => row.name.toLowerCase() === partner.toLowerCase())) {
    session.disconnect();
    session.dispose();
    // Ran, and there was nobody to ask: distinguishable from an answer.
    nothing(
      `${partner} is not in the realm (roster: ${
        session.character.online.map((row) => row.name).join(', ') || 'empty'
      }).`
    );
  }
  const before = partnerGang();
  /*
   * Both rows, because the permission is a *comparison*: `evidenceAbout` reads
   * this character's own row off the same listing as the asker's, and a run
   * that printed only one of them could not say whether an unresolved verdict
   * was the partner's row or this character's.
   */
  console.log(`  ${session.character.name}'s gang: ${say(ownGang())}`);
  console.log(`  ${partner}'s gang before: ${say(before)}`);

  let afterJoin;
  if (joinGang !== null) {
    /*
     * The telepath, then a full settle before the listing is asked for again.
     * The two are separate phases on purpose: whatever the server volunteers at
     * the moment of the join lands in the first, and the roster's own reading
     * lands in the second. Conflating them would leave a broadcast and a `who`
     * row in one bucket with nothing saying which produced what.
     */
    await step('join: the telepath', `/${partner} @do join gang ${joinGang}`, 6000);
    await step('join: who (after)', 'who', 3000);
    afterJoin = partnerGang();
    console.log(`  after join gang ${joinGang}: ${say(afterJoin)}`);
  }

  let afterLeave;
  if (leaving) {
    await step('leave: the telepath', `/${partner} @do leave gang`, 6000);
    await step('leave: who (after)', 'who', 3000);
    afterLeave = partnerGang();
    console.log(`  after leave gang: ${say(afterLeave)}`);
  }

  session.disconnect();
  await wait(600);
  session.dispose();

  /*
   * The report is the evidence, so every line is kept verbatim beside the
   * classifier's reading of it. A pattern written from a summary is a pattern
   * written from memory, which is the thing this project refuses.
   */
  const out = path.resolve('out/gang-probe.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        host: HOST,
        port: PORT,
        watcher: profile.id,
        partner,
        joinGang,
        leaving,
        roster: {
          watcher: say(ownGang()),
          before: say(before),
          afterJoin: say(afterJoin),
          afterLeave: say(afterLeave)
        },
        phases
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`\n  ${phases.length} phases recorded -> ${out}\n`);

  /*
   * And the reading, printed rather than left in the file: the two questions
   * this probe exists for, each answered or each said to be unanswered. A run
   * whose output a person has to interpret is the shape `probe:rest` got wrong
   * once, and it cost a live session 431 looks.
   */
  const unread = phases.flatMap((entry) =>
    entry.blocks.filter((block) => block.type === 'unknown').map(() => entry.phase)
  );
  const gangLines = phases.flatMap((entry) =>
    entry.lines.filter((line) => /gang/i.test(line)).map((line) => `${entry.phase}: ${line}`)
  );

  console.log('  Did the roster row move?');
  if (joinGang === null && !leaving) {
    console.log('    not asked — no --join or --leave, so nothing was changed.');
  } else {
    const moved =
      (afterJoin !== undefined && afterJoin !== before) ||
      (afterLeave !== undefined && afterLeave !== (afterJoin ?? before));
    console.log(
      moved
        ? `    YES: ${say(before)} -> ${say(afterJoin ?? before)} -> ${say(afterLeave ?? afterJoin ?? before)}`
        : `    NO: it stayed ${say(before)} throughout, so the who column is not how a change is seen.`
    );
  }

  console.log('\n  What did the server volunteer?');
  if (gangLines.length === 0) {
    console.log('    nothing naming a gang arrived on any channel this character can hear.');
  } else {
    for (const line of gangLines.slice(0, 40)) console.log(`    ${line}`);
  }
  if (unread.length > 0) {
    console.log(`\n  ${unread.length} line(s) the classifier could not type; see the file.`);
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  session.dispose();
  process.exit(1);
});
