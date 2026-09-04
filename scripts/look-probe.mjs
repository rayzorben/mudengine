/**
 * What does `look <player>` actually print on this realm, byte for byte?
 *
 * The `[ Name ] (Gang)` line and the equipment block under it were both read
 * from the capture corpus, which is entirely MajorMUD — and all 25 of its
 * occurrences put a space before the parenthesis. GreaterMUD does not: the
 * screenshot that started this reads `[ Soul Guardian ](Valor)`, and with the
 * space required the pattern matched neither the name nor the gang. Because
 * the equipment block below is filed against *that* name, a look at somebody
 * recorded nothing at all — the Worn tab said "nobody has looked at Soul yet"
 * about a player who had just been looked at.
 *
 * The corpus cannot settle this and neither can the server's source; only the
 * wire can, which is what this asks. It also captures the empty-slot spelling:
 * GreaterMUD prints all eighteen slots and marks the bare ones `<empty>`, a
 * word that appears nowhere in the 218-capture corpus, where MajorMUD says the
 * same thing by omitting the row.
 *
 *   npm run probe:look -- --at Soul
 *   npm run probe:look -- --at Soul --as probe
 *
 * ## It looks and nothing else
 *
 * `look` is the most harmless command in the table — it changes nothing, costs
 * nothing but a round, and is what the client sends anyway when somebody clicks
 * a name. No `@do`, no second character required, and the target is checked to
 * be one plain word before it is sent: an unrecognised command is *said out
 * loud in the room* on this server, so nothing that could carry a second word
 * gets past.
 */
import { setTimeout as wait } from 'node:timers/promises';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfile, localProfileNamed, skip, target } from './lib/local-realm.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const who = valueOf('--at');
if (!who) skip('nothing to look at: pass --at <name>.');
// One plain word, checked whole. The same caution `probe:gang` states for a
// gang name, and for the same reason: what goes out reaches a live room.
if (!/^[A-Za-z][A-Za-z'-]*$/.test(who)) skip(`--at ${who}: a name is one plain word.`);

const asName = valueOf('--as');
const profile = asName ? localProfileNamed(asName) : localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

console.log(`\nlook-probe -> ${HOST}:${PORT}, looking at ${who}\n`);

const runs = [];
let current = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      current?.lines.push(text);
    },
    block: (block) => {
      current?.blocks.push({
        type: block.type,
        groups: block.groups ?? {},
        rows: block.rows?.length
      });
    },
    character: (state) => {
      if (current) current.players = { ...state.players };
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
  current = { command, lines: [], blocks: [], players: {} };
  runs.push(current);
  session.send(`${command}\r`);
  await wait(settle);
  current = null;
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
  // The realm-entry probes finish talking before anything here is sent.
  await wait(3000);

  await run('who');
  await run(`look ${who}`);

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines) console.log(`      | ${JSON.stringify(line)}`);
    const types = entry.blocks.map((b) => b.type);
    console.log(`    blocks: ${types.join(', ') || '(none)'}`);
  }

  /*
   * The verdict, stated rather than left for a reader to infer from the dump:
   * did the look reach the registry, and with what?
   */
  const last = runs.at(-1);
  const record = last?.players?.[who.toLowerCase()];
  console.log('\n  what the client recorded');
  if (!record) {
    console.log(`      nothing at all — the look at ${who} was not filed.`);
  } else {
    console.log(`      name:      ${record.name}`);
    console.log(`      gang:      ${record.gang ?? '(none said)'}`);
    console.log(
      `      equipment: ${
        record.equipment === null
          ? '(nobody has looked)'
          : record.equipment.length === 0
            ? '(looked, wearing nothing)'
            : record.equipment.map((worn) => `${worn.name} (${worn.slot})`).join(', ')
      }`
    );
  }
  console.log('');
}

await main();
