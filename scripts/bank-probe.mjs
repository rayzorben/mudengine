/**
 * What does a bank actually say, byte for byte?
 *
 * `bank` is read: the header and the figure were both captured live at the
 * Bank of Godfrey, and both spellings — GreaterMUD's `Bank of Godfrey` and
 * MajorMUD's `The Bank of Godfrey (#8)` — now parse into `CharacterState.banks`.
 *
 * **`withdraw` is not read, and this is the probe that fixes that.** The
 * command exists in the server's own table (docs/greatermud/commands.md:116)
 * and its response sentence appears in **no capture in the 218-file corpus**
 * and on no wire this client has seen. Writing `You withdraw N copper
 * farthings.` from the symmetry with the deposit line would be a pattern from
 * memory, and the buy/sell pair is the counterexample sitting in the same
 * file: `You just bought … for …` against `You sold … for …`, two spellings
 * for one round trip. So it is asked rather than assumed.
 *
 * Four questions, in the order the run answers them:
 *
 *   1. What sentence does `withdraw` print?
 *   2. Does the balance line change shape at zero, or when the vault is empty?
 *   3. Do `bal` and `bankbook` produce the same record as `bank`?
 *   4. What does the server say when the sum is more than the vault holds?
 *
 *   npm run probe:bank
 *   npm run probe:bank -- --as probe
 *
 * ## It borrows its own money and puts it back
 *
 * Every command sent is in the server's command table — an unrecognised
 * command is *said out loud in the room* on this server, which is why nothing
 * here is guessed at. The only state it changes is this character's own purse,
 * and it changes it **by a round trip**: one small withdrawal, then a deposit
 * of the same figure, so the vault ends where it started. The amount is
 * deliberately tiny and the run reports the balance before and after so a
 * mismatch is visible rather than silent.
 *
 * It must be run **standing in a bank**. It checks, and refuses rather than
 * sending banking commands into an ordinary room.
 */
import { setTimeout as wait } from 'node:timers/promises';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfile, localProfileNamed, skip, target } from './lib/local-realm.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/*
 * Small on purpose. The point is the *sentence*, not the sum, and a probe that
 * moves a character's savings around is one nobody will run twice.
 */
const AMOUNT = 10;

const asName = valueOf('--as');
const profile = asName ? localProfileNamed(asName) : localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

console.log(`\nbank-probe -> ${HOST}:${PORT}\n`);

const runs = [];
let current = null;
let character = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      current?.lines.push(text);
    },
    block: (block) => {
      current?.blocks.push({ type: block.type, groups: block.groups ?? {} });
    },
    character: (state) => {
      character = state;
      if (current) {
        current.banks = state.banks.map((bank) => ({ ...bank }));
        current.wealth = state.inventory.wealth;
      }
    },
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  undefined,
  // Nothing standing: an idle routine firing mid-run would put its own lines
  // and its own answers inside the capture.
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false },
    rules: []
  },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

async function run(command, settle = 2500) {
  current = { command, lines: [], blocks: [], banks: [], wealth: null };
  runs.push(current);
  session.send(`${command}\r`);
  await wait(settle);
  current = null;
  return runs.at(-1);
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
  await wait(3000);

  /*
   * Refuse rather than guess. `deposit` and `withdraw` outside a bank are
   * commands the server will answer with a refusal at best — and the run would
   * measure that refusal instead of the thing it came for. The room's own name
   * is the check, because it is what the character can actually see.
   */
  const room = session.character.room.name ?? '(unread)';
  if (!/\bbank\b/i.test(room)) {
    console.log(`  standing in ${JSON.stringify(room)}, which is not a bank.`);
    console.log('  walk the character into one and run this again.\n');
    session.disconnect();
    session.dispose();
    return;
  }
  console.log(`  standing in ${JSON.stringify(room)}\n`);

  // 1. The record, and the two other spellings of the same question.
  const opening = await run('bank');
  await run('bal');
  await run('bankbook');

  const before = opening.banks[0]?.copper ?? null;

  // 2. The sentence nothing has ever captured, and the balance either side of it.
  await run(`withdraw ${AMOUNT}`);
  const afterWithdraw = await run('bank');

  // 3. Put it back, so the vault ends where it started.
  await run(`deposit ${AMOUNT}`);
  const afterDeposit = await run('bank');

  /*
   * 4. The refusal. Asked last, because it is the one command here that is
   * meant to fail, and a failure mid-run would leave the money out.
   */
  await run(`withdraw ${Number.MAX_SAFE_INTEGER}`);

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines) console.log(`      | ${JSON.stringify(line)}`);
    const types = entry.blocks.map((b) => b.type);
    console.log(`    blocks: ${types.join(', ') || '(none)'}`);
  }

  console.log('\n  what the client recorded');
  const banks = character?.banks ?? [];
  if (banks.length === 0) {
    console.log('      no bank answered — the balance was not filed.');
  } else {
    for (const bank of banks) {
      console.log(
        `      ${bank.name}${bank.shop === null ? '' : ` (#${bank.shop})`}: ${bank.copper} copper`
      );
    }
  }

  console.log('\n  the round trip');
  const after = afterDeposit.banks[0]?.copper ?? null;
  console.log(`      before:          ${before ?? '(none read)'}`);
  console.log(`      after withdraw:  ${afterWithdraw.banks[0]?.copper ?? '(none read)'}`);
  console.log(`      after deposit:   ${after ?? '(none read)'}`);
  if (before !== null && after !== null) {
    console.log(
      before === after
        ? '      balanced — the vault ends where it started.'
        : `      ** OUT BY ${after - before} ** — check the character's purse by hand.`
    );
  }

  /*
   * The verdict this probe exists for, stated rather than left in the dump:
   * did the withdraw sentence reach the classifier as anything at all?
   */
  const withdrew = runs.find((entry) => entry.command.startsWith('withdraw '));
  console.log('\n  the withdraw sentence');
  for (const line of withdrew?.lines ?? []) console.log(`      ${JSON.stringify(line)}`);
  const named = (withdrew?.blocks ?? []).filter((b) => b.type !== 'unknown');
  console.log(
    named.length === 0
      ? '      classified as nothing — this is the pattern still to write.'
      : `      classified as: ${named.map((b) => b.type).join(', ')}`
  );
  console.log('');
}

await main();
