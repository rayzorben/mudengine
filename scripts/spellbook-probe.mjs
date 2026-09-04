/**
 * What do `sp` and `pow` actually print on this realm, byte for byte?
 *
 * The corpus holds exactly one spellbook listing (captures/056, MajorMUD,
 * the full word `spells`) and its whitespace is demonstrably the poster's,
 * not the wire's — the same file's `st` output lost every inter-column
 * space. It holds no powers listing at all, in any shape. The four columns
 * (`Level Mana Short Spell Name`) are confirmed against the realm data
 * 16/16, but the run-lengths, the terminator, the empty case and the whole
 * of the kai listing only the wire can settle. This asks.
 *
 *   npm run probe:spellbook             # the configured character
 *   npm run probe:spellbook -- --as soul
 *
 * All four command words are in docs/greatermud/commands.md (`Spells` =
 * `sp`, `spells`; `Pow` = `po`, `pow`, `powe`, `power`, `powers`), so
 * nothing here can be said out loud in the room. Each answer is printed
 * JSON-quoted so the column padding survives the terminal, with the
 * classifier's verdict per line — which is itself a finding: the column
 * header is title-cased, so today the loosest rule in the table reads it
 * as a room name and swallows the rows as description.
 */
import { setTimeout as wait } from 'node:timers/promises';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfile, localProfileNamed, skip, target } from './lib/local-realm.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const asName = valueOf('--as');
const profile = asName ? localProfileNamed(asName) : localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

console.log(`\nspellbook-probe -> ${HOST}:${PORT} as ${profile.id}\n`);

const runs = [];
let current = null;

const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      current?.lines.push({ text: line.plain, tag: line.tag ?? null });
    },
    block: (block) => {
      current?.blocks.push({ type: block.type, groups: block.groups ?? {}, rows: block.rows?.length });
    },
    character: () => {},
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
  current = { command, lines: [], blocks: [] };
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

  await run('sp');
  await run('spells');
  await run('pow');
  await run('powers');

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines) {
      console.log(`      | ${JSON.stringify(line.text)}${line.tag ? `  [${line.tag}]` : ''}`);
    }
    const types = entry.blocks.map((b) => b.type);
    console.log(`    blocks: ${types.join(', ') || '(none)'}`);
  }
  console.log('');
}

await main();
