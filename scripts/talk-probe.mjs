/**
 * Do the conversation channels parse against the real server?
 *
 * The smoke fixture speaks lines this project wrote, which is the shape of
 * check that hides a wrong pattern. This connects two characters to
 * `gmud-tgs:2427`, has one talk, and reports what the other's classifier made
 * of it.
 *
 * Sends only speech. Nothing moves, nothing fights.
 *
 *   node --import tsx scripts/talk-probe.mjs
 */
import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfiles, skip, target } from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Credentials never leave the test realm; chosen by target, never by filename. */
const characters = localProfiles().filter(
  (profile) => String(profile.target.port) === String(PORT)
);

if (characters.length < 2) {
  skip(`needs two characters on ${HOST}:${PORT}; found ${characters.length}.`);
}

function open(profile) {
  const blocks = [];
  const session = new SessionManager(
    {
      data: () => {},
      line: () => {},
      block: (block) => blocks.push(block),
      character: () => {},
      state: () => {},
      telnet: () => {},
      notice: () => {}
    },
    undefined,
    {
      ...profile.config.automation,
      idle: { ...profile.config.automation.idle, enabled: false },
      rules: []
    },
    profile.config.connection.login
  );
  session.resize({ cols: 80, rows: 24 });
  return { session, blocks, name: profile.name };
}

async function reachRealm(probe, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(250);
    if (probe.session.character.phase === 'in-game') return true;
  }
  return false;
}

async function main() {
  console.log(`\ntalk-probe -> ${HOST}:${PORT}\n`);

  const [a, b] = [open(characters[0]), open(characters[1])];
  await a.session.connect(target());
  await b.session.connect(target());

  for (const probe of [a, b]) {
    if (!(await reachRealm(probe))) {
      console.log(`   ${probe.name} could not reach the realm; nothing to listen for.`);
      a.session.disconnect();
      a.session.dispose();
      b.session.disconnect();
      b.session.dispose();
      process.exit(0);
    }
  }
  await wait(2500);

  // One line per channel, so a pattern that only works for gossip is visible.
  const said = [
    ['gossip', 'gos probe: can anyone hear this'],
    ['telepath', '/Vaelor probe: private word'],
    ['broadcast', 'bro probe: shouting'],
    ['auction', 'auction probe: selling nothing'],
    ['yell', 'yell probe: hello']
  ];

  const from = b.blocks.length;
  for (const [, command] of said) {
    b.session.send(`${command}\r`);
    await wait(1200);
  }
  await wait(2500);

  const heard = a.blocks.filter((block) => block.domain === 'conversation');
  console.log(
    `  ${characters[1].name} said ${said.length} things; ${characters[0].name} classified:`
  );
  const byType = new Map();
  for (const block of heard) byType.set(block.type, (byType.get(block.type) ?? 0) + 1);
  for (const [type, count] of byType) console.log(`     ${type} x${count}`);
  if (byType.size === 0) console.log('     nothing — every channel line fell through as unknown');

  // What the speaker's own client made of its own words, and what neither read.
  const missed = a.blocks
    .slice(0)
    .filter((block) => block.type === 'unknown' && /probe:/.test(block.text))
    .map((block) => block.text.trim().slice(0, 70));
  if (missed.length > 0) {
    console.log('\n  lines carrying "probe:" that nothing classified:');
    for (const line of [...new Set(missed)]) console.log('     ', JSON.stringify(line));
  }
  void from;

  a.session.disconnect();
  a.session.dispose();
  b.session.disconnect();
  b.session.dispose();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
