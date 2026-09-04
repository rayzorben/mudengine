/**
 * What do `who` and `sc` actually return, and does the client read both?
 *
 * The GreaterMUD source says they are one command — `wh`, `who`, `sc`, `sca`
 * and `scan` all map to `CommandType.Who` (docs/greatermud/commands.md). That
 * is a *reading*, and the standing rule is that where the reading and the wire
 * disagree, the wire wins. This asks the wire.
 *
 * Reports, per command: every line the server sent, how the classifier typed
 * it, and what `CharacterState.online` held afterwards. If `sc` is `who` then
 * the two runs are byte-comparable and both populate the roster; if it is not,
 * this is the capture the pattern gets written from rather than a guess.
 *
 * Read-only. It sends `who`, `sc` and `scan` and nothing else, and never moves.
 *
 *   npm run probe:who
 */
import fs from 'node:fs';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfile, skip, target } from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Credentials never leave the test realm; `localProfile` is what enforces it —
 * a character is chosen by *target*, never by filename, so a file renamed or a
 * second character added cannot send a password somewhere else by accident.
 */
const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

console.log(`\nwho-probe -> ${HOST}:${PORT}\n`);

/** Lines and blocks, tagged with the command that provoked them. */
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
      if (current) current.online = [...state.online];
    },
    state: () => {},
    telnet: () => {},
    notice: () => {}
  },
  undefined,
  // Nothing standing: this measures what these commands cause, and an idle
  // routine firing mid-run would put its own lines in the capture.
  {
    ...profile.config.automation,
    idle: { ...profile.config.automation.idle, enabled: false },
    rules: []
  },
  profile.config.connection.login
);

session.resize({ cols: 80, rows: 24 });

async function run(command, settle = 2000) {
  current = { command, lines: [], blocks: [], online: [] };
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
  // The realm-entry probes finish talking before anything here is sent, or
  // their answers land inside the first run.
  await wait(3000);

  await run('who');
  await run('sc');
  await run('scan');

  session.disconnect();
  session.dispose();

  for (const entry of runs) {
    console.log(`\n  > ${entry.command}`);
    for (const line of entry.lines) console.log(`      | ${line}`);
    const types = entry.blocks.map((b) => b.type);
    console.log(`    blocks: ${types.join(', ') || '(none)'}`);
    console.log(
      `    roster after: ` +
        (entry.online
          .map((who) => `${who.name}${who.alignment ? ` (${who.alignment})` : ''}`)
          .join(', ') || '(empty)')
    );
  }

  /*
   * The question, answered rather than argued: are the two the same command?
   *
   * Compared on the *answer* and not on everything the run saw. The echo of the
   * command differs by construction — `who` versus `sc` — and whether it is
   * framed on its own line or glued to the prompt in front of it varies with
   * timing, so including either makes this report a different verdict on
   * consecutive runs. The answer starts at the listing header.
   *
   * Names are masked because two calls a couple of seconds apart can genuinely
   * differ in who is present, and that is not the question.
   */
  const shape = (entry) => {
    const start = entry.lines.findIndex((line) => /Current Adventurers/.test(line));
    return (start === -1 ? entry.lines : entry.lines.slice(start))
      .filter((line) => !/^\s*\[HP=/.test(line))
      .map((line) => line.replace(/[A-Za-z]+/g, 'x').replace(/\d+/g, 'n'))
      .join('\n');
  };
  const [who, sc, scan] = runs;
  console.log('\n  ---');
  console.log(`  sc has the same shape as who:   ${shape(sc) === shape(who)}`);
  console.log(`  scan has the same shape as who: ${shape(scan) === shape(who)}`);
  console.log(`  who filled the roster:          ${who.online.length > 0}`);
  console.log(`  sc filled the roster:           ${sc.online.length > 0}`);
  console.log(
    `  sc produced an unread line:     ` +
      `${sc.blocks.filter((b) => b.type === 'unknown').length} unknown block(s)`
  );
  console.log('');

  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/who-probe.json', `${JSON.stringify(runs, null, 2)}\n`);
  console.log('  full capture -> out/who-probe.json\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
