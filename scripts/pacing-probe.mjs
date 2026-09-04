/**
 * Is the server's command window per connection, or per host?
 *
 * The open question in docs/roadmap.md §4 and docs/profiles.md §9.2. The server
 * accepts about twenty commands in flight and then **silently discards** the
 * rest — no complaint, no disconnect, nothing observable. That was measured with
 * one connection. If the limit turns out to be per *host*, several automated
 * characters starve each other in a way that is by construction undetectable,
 * which is why it gates automating more than one at a time.
 *
 * Read-only against the character: it sends `l` and nothing else. No movement,
 * no combat, nothing that can lose anybody.
 *
 *   node --import tsx scripts/pacing-probe.mjs
 */
import { SessionManager } from '../src/main/session/SessionManager.ts';
import { HOST, PORT, localProfiles, skip, target } from './lib/local-realm.mjs';

/**
 * Commands per burst, and how many bursts to walk up.
 *
 * The recorded cliff is around twenty (legacy-assessment §6.2: 25 sent, 2
 * answered). Walking a ladder rather than testing one size is the difference
 * between confirming a number and finding out where it actually is.
 */
const LADDER = (process.env.PACING_LADDER ?? '10,25,50,100,200')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- options

const characters = localProfiles().filter(
  (profile) => String(profile.target.port) === String(PORT)
);
if (characters.length === 0) skip(`no character on ${HOST}:${PORT} with credentials.`);

// ------------------------------------------------------------------- driving

function open(profile) {
  const raw = [];
  const state = { text: () => raw.join('') };
  const session = new SessionManager(
    {
      data: (chunk) => raw.push(chunk.text),
      line: () => {},
      block: () => {},
      character: () => {},
      state: () => {},
      telnet: () => {},
      notice: () => {}
    },
    undefined,
    // Nothing standing may send commands of its own into a measurement.
    {
      ...profile.config.automation,
      idle: { ...profile.config.automation.idle, enabled: false },
      onEnterRealm: [],
      rules: []
    },
    profile.config.connection.login
  );
  session.resize({ cols: 80, rows: 24 });
  return { session, state };
}

/** Waits for the status line, which is the only in-realm discriminator. */
async function reachRealm(probe, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(250);
    if (probe.state.text().includes('[HP=')) return true;
  }
  return false;
}

/** Status lines are the server's per-command acknowledgement, so they count. */
const prompts = (text) => (text.match(/\[HP=/g) ?? []).length;

async function burst(probe, label, size) {
  // Let anything still arriving land, so a slow reply is not counted as a loss.
  await wait(2500);
  const before = probe.state.text().length;
  for (let i = 0; i < size; i += 1) probe.session.send('l\r');
  // Generous: the question is whether a command was *discarded*, and a reply
  // that is merely slow must not be mistaken for one that never came.
  await wait(Math.max(8000, size * 120));
  const answered = prompts(probe.state.text().slice(before));
  console.log(
    `   ${label}: sent ${String(size).padStart(4)}, answered ${String(answered).padStart(4)}` +
      (answered < size ? `  <- ${size - answered} lost` : '')
  );
  return answered;
}

async function main() {
  console.log(`\npacing-probe -> ${HOST}:${PORT}\n`);

  const first = characters[0];
  console.log(`phase A: one connection, bursts of ${LADDER.join(', ')}`);
  const a = open(first);
  await a.session.connect(target());
  if (!(await reachRealm(a))) {
    console.log('   could not reach the realm; nothing to measure.');
    a.session.disconnect();
    a.session.dispose();
    process.exit(0);
  }
  await wait(2000);
  let alone = 0;
  let aloneSize = 0;
  for (const size of LADDER) {
    const answered = await burst(a, 'alone', size);
    alone = answered;
    aloneSize = size;
    if (answered < size) {
      console.log(
        `\n   the cliff is between ${LADDER[LADDER.indexOf(size) - 1] ?? 0} and ${size}.`
      );
      break;
    }
  }
  if (alone === aloneSize) {
    console.log(`\n   no cliff up to ${aloneSize}: every command was answered.`);
  }

  /*
   * Two connections at once is the whole question, and it needs two characters.
   * The same character logged in twice is not a second connection: the server
   * drops one of them, which is a different measurement entirely.
   */
  if (characters.length < 2) {
    console.log(
      `\nphase B needs a SECOND character on ${HOST}:${PORT} — a different account, since` +
        '\nthe same one logged in twice is dropped rather than doubled. Only ' +
        `${characters.length} configured, so the per-host question stays open.\n`
    );
    a.session.disconnect();
    a.session.dispose();
    process.exit(0);
  }

  console.log('\nphase B: two connections bursting together');
  const b = open(characters[1]);
  await b.session.connect(target());
  if (!(await reachRealm(b))) {
    console.log('   the second character could not reach the realm; nothing to compare.');
  } else {
    await wait(2000);
    const [together] = await Promise.all([
      burst(a, 'a, together', aloneSize),
      burst(b, 'b, together', aloneSize)
    ]);
    console.log(
      `\nalone ${alone}, together ${together}. ` +
        (together < alone * 0.7
          ? 'The window looks PER HOST: one connection starves the other.'
          : 'The window looks PER CONNECTION: neither starves the other.')
    );
  }
  b.session.disconnect();
  b.session.dispose();
  a.session.disconnect();
  a.session.dispose();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
