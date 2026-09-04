/**
 * End-to-end smoke test for a built distribution.
 *
 *   npm run build && node scripts/smoke.mjs [--keep-open]
 *
 * Stands up a fake MajorMUD-style host, launches the built app, drives the real
 * UI over the Chrome DevTools Protocol, and asserts on both sides of the wire:
 * what the server received (Telnet negotiation, CR LF commands) and what the
 * client reported (connection state, decoded character count). A screenshot of
 * the rendered terminal is written to `out/smoke-screenshot.png` for eyeballing
 * the CP437 and ANSI output, which lives in a canvas and so cannot be asserted
 * on from the DOM.
 *
 * Exits non-zero if any check fails, so it is CI-usable as-is.
 */
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';

const IAC = 255,
  WILL = 251,
  DO = 253,
  SB = 250,
  SE = 240,
  GA = 249;
const OPT_ECHO = 1,
  OPT_SGA = 3,
  OPT_TTYPE = 24,
  OPT_NAWS = 31;

const CDP_PORT = 9333;
/**
 * The session this harness drives.
 *
 * Every session-scoped call over the bridge names its character. There is one
 * until profiles supply real ids, but the harness passes it explicitly for the
 * same reason the client does: a call that does not say which character it
 * means is the bug the addressed contract exists to prevent, and a test harness
 * quietly exercising a different shape from the app is how automatic login
 * stayed broken for three phases.
 */
const SESSION = 'smoke';

/** What the client asks the realm on entering it, per the shipped defaults. */
const DEFAULT_PROBE = ['rm', 'st', 'i', 'exp', 'sc', 'l'];
const SHOT = path.resolve('out/smoke-screenshot.png');
const keepOpen = process.argv.includes('--keep-open');

/**
 * The run gets its own home directory rather than touching the developer's.
 *
 * One variable for the whole tree — the options, the characters, the servers,
 * the loops and every record the client keeps — which is the property worth
 * exercising: `MUDENGINE_HOME` has to relocate all of it together, or a test
 * run writes into somebody's real characters. It also pins values the checks
 * below assert on, so this doubles as coverage of the YAML reaching the
 * renderer.
 */
const HOME = path.resolve('out/smoke-home');
fs.rmSync(HOME, { recursive: true, force: true });
const CONFIG = path.join(HOME, 'global', 'default.yaml');
const SMOKE_FONT = 'LucidaProgrammer Nerd Font Mono';
const SMOKE_FONT_SIZE = 15;
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });

const writeConfig = (theme) =>
  fs.writeFileSync(
    CONFIG,
    [
      'connection:',
      '  host: 127.0.0.1',
      '  port: 1',
      '  encoding: cp437',
      'terminal:',
      '  font:',
      '    family:',
      `      - ${SMOKE_FONT}`,
      `    size: ${SMOKE_FONT_SIZE}`,
      '  scrollback: 12345',
      'ui:',
      '  density: auto',
      // Stated, not inherited: the shipped default is `left`, so this also
      // proves the options file still wins.
      '  tabs: top',
      `  theme: ${theme}`,
      // Pinned rather than defaulted: the band assertions below are about these
      // numbers, and a change to the shipped default should not quietly move
      // what this run is checking.
      '  vitals:',
      '    hp:',
      '      caution: 0.5',
      '      critical: 0.25',
      '    mana:',
      '      caution: 0.5',
      '      critical: 0.25',
      'logging:',
      '  enabled: true',
      `  directory: '${LOG_DIR}'`,
      ''
    ].join('\n'),
    'utf8'
  );

/**
 * A wiped Electron profile per run.
 *
 * Without this the app reuses the developer's real profile, so `localStorage`
 * -- which holds the theme and density overrides -- carries over between runs
 * and silently changes what the assertions below see. A stale override there
 * masked a genuine precedence bug once already.
 */
/**
 * The realm the character plays on, as a directory of its own.
 *
 * It used to be a `profiles:` list inside the options file, which is the shape
 * a realm had before it acquired a login script and loops of its own. There is
 * no such key any more -- a realm is a file -- so writing one here is what
 * makes the character below resolvable at all.
 */
const REALMS_DIR = path.join(HOME, 'servers');
const writeRealm = () => {
  const dir = path.join(REALMS_DIR, 'smoke-realm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.yaml'),
    ['name: Smoke Realm', 'host: 127.0.0.1', `port: ${PORT}`, 'encoding: cp437', ''].join('\n'),
    'utf8'
  );
};

const PROFILE = path.resolve('out/smoke-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

/** Session logs land here, wiped per run so the assertion below is about this run. */
const LOG_DIR = path.resolve('out/smoke-logs');

/**
 * Characters live under the home directory, one directory each, with their own
 * loops beside them.
 *
 * Wiping HOME above takes the world memory with it, which matters for the same
 * reason the Electron profile is wiped: that record is *permanent* by design,
 * and a second run starting out already knowing what the first one found would
 * assert nothing.
 */
const PROFILES_DIR = path.join(HOME, 'profiles');

/**
 * One character, plus one file that cannot be one.
 *
 * The whole run is driven through `smoke.yaml`: the session id every
 * session-scoped call uses is the *filename*, so if profiles did not load,
 * nothing below this point would address a session that exists. `broken.yaml`
 * is there to prove the other half of the rule -- one unparseable profile is
 * reported and skipped, and must not cost you the characters that are fine.
 */
const writeProfiles = () => {
  fs.rmSync(PROFILES_DIR, { recursive: true, force: true });
  const character = (id) => {
    fs.mkdirSync(path.join(PROFILES_DIR, id), { recursive: true });
    return path.join(PROFILES_DIR, id, 'profile.yaml');
  };
  fs.writeFileSync(
    character('smoke'),
    [
      'name: Smoke Character',
      // By name, from the realm directory beside the options file.
      'server: Smoke Realm',
      'autoConnect: false',
      'accent: amber',
      // A sparse overlay: everything not mentioned is inherited.
      'automation:',
      '  idle:',
      '    afterSeconds: 111',
      /*
       * Running away, switched on for this character only.
       *
       * Worth driving through the real client rather than only in a unit test:
       * it is a safety feature that sends a command on its own, and the failure
       * nobody would notice is it quietly not firing.
       *
       * **The threshold is under the fixture's own health on purpose.** The
       * character sits at 98/400 -- under a quarter -- for the whole run, so a
       * threshold of 0.3 fires the escape continuously, and the escape is a
       * *move* now. A move nothing answers stands the whole client down:
       * `Walker.start` refuses across one, `LoopRunner.advance` waits on one,
       * auto-combat will not open a fight through one. Measured here, not
       * reasoned about -- with 0.3 it took fourteen checks down with it, about
       * the loop, the route, the Combat card and the room this client learns
       * its way into, and every one of them was the harness rather than the
       * client. The escape section below drops the health itself, asserts, and
       * answers the move.
       */
      '  safety:',
      '    retreat:',
      '      enabled: true',
      '      belowHealth: 0.1',
      ''
    ].join('\n'),
    'utf8'
  );

  /*
   * A loop over the two shops beside the fixture's room (1/2140), so the
   * palette carries a "Loop:" command and starting it sends a real step. The
   * fixture never answers the rooms; the check stops the loop and settles the
   * in-flight move itself, like the route-panel check above.
   *
   * A **file in the character's own loops directory**, which is where a loop
   * lives now -- and driving it from there is what proves the scope reaches
   * the running client rather than only the settings screen.
   */
  fs.mkdirSync(path.join(PROFILES_DIR, 'smoke', 'loops'), { recursive: true });
  fs.writeFileSync(
    path.join(PROFILES_DIR, 'smoke', 'loops', 'smoke-loop.yaml'),
    [
      'name: Smoke loop',
      'stops:',
      "  - 'Newhaven, Weapons Shop 1/2141'",
      "  - 'Newhaven, Armour Shop 1/2142'",
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    character('smoke2'),
    ['name: Second Character', 'server: Smoke Realm', 'accent: violet', ''].join('\n'),
    'utf8'
  );
  fs.writeFileSync(character('broken'), 'server: [unclosed\n', 'utf8');
};
fs.rmSync(LOG_DIR, { recursive: true, force: true });

let failures = 0;
const log = (...a) => console.log('  ', ...a);
const pass = (m) => log('PASS ', m);
const fail = (m) => {
  failures += 1;
  log('FAIL ', m);
};
const check = (ok, m, detail) => (ok ? pass(m) : fail(`${m}${detail ? ` -- ${detail}` : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rough sRGB luminance of a #rrggbb string, for light/dark assertions. */
const luminanceOf = (hex) => {
  const v = hex.replace('#', '');
  if (v.length !== 6) return NaN;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// --------------------------------------------------------------- fake MUD host

const received = [];
let clientSocket = null;

/**
 * What each accepted connection received, and in what order they arrived.
 *
 * Two characters connect in this run, so "what the server got" is no longer one
 * question. `received` stays the flat view the single-session assertions use;
 * `perSocket` is what proves a keystroke reached one character and not the
 * other.
 */
const perSocket = [];

/**
 * Every socket still open, in accept order.
 *
 * `perSocket` holds what each connection *received*; this holds the connections
 * themselves, so a check can say something to a character whose terminal is not
 * on screen — which is the only way to test what the tab rail is for.
 */
const liveSockets = [];

const server = net.createServer((socket) => {
  const index = perSocket.length;
  perSocket.push([]);
  liveSockets.push(socket);
  socket.on('close', () => {
    const at = liveSockets.indexOf(socket);
    if (at !== -1) liveSockets.splice(at, 1);
  });
  clientSocket = socket;
  socket.setNoDelay(true);

  // The opening volley a BBS front end typically sends.
  socket.write(
    Buffer.from([IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO, IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS])
  );

  setTimeout(() => socket.write(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE])), 30);

  setTimeout(() => {
    // CP437 double-line box art, ANSI colour, a status line, and a GA prompt
    // mark -- every decode path the terminal has to get right.
    const top = Buffer.from([0xc9, ...Array(30).fill(0xcd), 0xbb, 0x0d, 0x0a]);
    const mid = Buffer.from([
      0xba,
      ...Buffer.from('   Welcome to the Realm       ', 'latin1'),
      0xba,
      0x0d,
      0x0a
    ]);
    const bottom = Buffer.from([0xc8, ...Array(30).fill(0xcd), 0xbc, 0x0d, 0x0a]);

    socket.write(
      Buffer.concat([
        Buffer.from('\x1b[1;36m', 'latin1'),
        top,
        mid,
        bottom,
        // A full room, in the order the game sends one: name, description,
        // items, occupants, then exits -- which is what completes it.
        Buffer.from('\x1b[1;36mNewhaven, Village Entrance\x1b[0m\r\n', 'latin1'),
        Buffer.from('    A dusty path leads away from the gates.\r\n', 'latin1'),
        Buffer.from('\x1b[0;36mYou notice newbie manual, grey robes here.\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[0;35mAlso here: Nathaniel.\x1b[0m\r\n', 'latin1'),
        // The stat sheet, which is the only source of maxima.
        Buffer.from('Name:   Rayzor              Lives/CP: 3/12\r\n', 'latin1'),
        Buffer.from('Race:   Human      Exp:      1500   Perception:  20\r\n', 'latin1'),
        Buffer.from('Class:  Warrior    Level:    4      Stealth:     10\r\n', 'latin1'),
        // 98/400 and 50/120: the stat sheet agrees with the status line below, and
        // the two land in different threshold bands so the HUD's red and yellow
        // are both driven for real rather than only unit-tested.
        Buffer.from('Hits:   98/400     Armour Class: 12/3   Thievery:    5\r\n', 'latin1'),
        Buffer.from('Mana:   50/120     Spellcasting: 12     Traps:       3\r\n', 'latin1'),
        Buffer.from(
          '\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0;32m, \x1b[1;33msouth\x1b[0m\r\n',
          'latin1'
        ),
        // A literal 0xFF in the payload, escaped as IAC IAC: must survive as one
        // byte and must not be mistaken for the start of a command.
        Buffer.from([0x9f, IAC, IAC, 0x0d, 0x0a]),
        // The in-place status-line repaint: this family rewrites the prompt with
        // ESC[79D ESC[K rather than sending a newline, which is what the line
        // tokenizer has to frame on.
        Buffer.from('\x1b[1;32m[HP=100/MA=50]:\x1b[0m\x1b[79D\x1b[K', 'latin1')
      ])
    );
  }, 120);

  // Enough lines to push the viewport off the live edge, so the jump-to-latest
  // affordance -- and the focus rule attached to it -- can actually be driven.
  setTimeout(() => {
    const filler = Array.from(
      { length: 200 },
      (_, i) => `\x1b[0;37mThe torchlight flickers. (${i})\x1b[0m\r\n`
    ).join('');
    socket.write(Buffer.from(filler, 'latin1'));
  }, 200);

  // Last of all, and deliberately unterminated: a prompt is a line that ends
  // because the server stopped talking. Nothing follows it, so the only thing
  // that can release it is the idle flush.
  setTimeout(() => {
    socket.write(
      Buffer.concat([
        // Somebody talking, so the conversation feed has something to hold.
        Buffer.from('\x1b[0;36mNathaniel gossips: anyone selling a rope?\x1b[0m\r\n', 'latin1'),
        // A link, because people paste them and a link that has to be retyped
        // is a link nobody follows. And a scheme that is not the web, which
        // must stay text: this is somebody else's typing.
        Buffer.from(
          '\x1b[0;36mSoul gossips: map at https://example.test/newhaven (file:///etc/passwd)\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from('\x1b[0;35mRayth telepaths: meet me at the docks\x1b[0m\r\n', 'latin1'),
        // Two things the Alerts card ranks differently: a command that did not
        // run, and somebody arriving. Real server phrasings, so the card is
        // proven against the actual classifier rather than against a fixture
        // written to match it.
        Buffer.from('\x1b[0;31mThere is no exit in that direction!\x1b[0m\r\n', 'latin1'),
        // A fight: the server's own marker, this character swinging, and two
        // things swinging back. What it is *hitting* and what is *hitting it*
        // are different questions, and the second is what decides a retreat.
        Buffer.from('\x1b[1;31m*Combat Engaged*\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[0;37mYou slash the orc rogue for 12 damage!\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[0;31mThe orc rogue slashes you for 5 damage!\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[0;31mThe giant rat bites you for 2 damage!\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[0;33mSoul just entered the Realm.\x1b[0m\r\n', 'latin1'),
        /*
         * An inventory long enough to wrap, exactly as the live realm sends
         * one: the server formats to a width of its own and puts a real CRLF at
         * the fold, so only the first line says `You are carrying`. The tail
         * used to be dropped in silence and the card listed half a kit.
         */
        /*
         * Coins first, which is where the server prints them, and all five so
         * the row has something to shorten. They are *not* items: the pack
         * listing states them separately and the card counts them separately.
         */
        Buffer.from(
          'You are carrying 2 runic coins, 16 platinum pieces, 353 gold crowns, 450 silver\r\n',
          'latin1'
        ),
        Buffer.from(
          'nobles, 7 copper farthings, padded helm (Head), padded vest (Torso), padded gloves\r\n',
          'latin1'
        ),
        /*
         * The tail, folded by the server at a width of its own choosing — and
         * the *quarterstaff carries no slot*, deliberately. Two later checks
         * turn on this line and they want opposite things from it: the boots
         * are worn and listed, so taking them off and putting them back on has
         * a slot to remember; the quarterstaff is merely carried, so wielding
         * it later is the case where the client knows something is in use and
         * honestly does not know where. Annotating both left the second with
         * nothing to test.
         */
        Buffer.from(
          '(Hands), padded pants (Legs), padded boots (Feet), quarterstaff\r\n',
          'latin1'
        ),
        Buffer.from('You have no keys.\r\n', 'latin1'),
        // The server's own total for those coins, at the measured ladder:
        // 2 000 000 + 160 000 + 35 300 + 4 500 + 7.
        Buffer.from('Wealth: 2199807 copper farthings\r\n', 'latin1'),
        Buffer.from('Encumbrance: 500/3360 - None [14%]\r\n', 'latin1'),
        // Picked up *after* the listing, which is the shape that matters: a
        // listing is authoritative and replaces what is there, and the
        // broadcasts the server volunteers keep it true until the next one.
        Buffer.from('\x1b[0;33mYou took a healing potion.\x1b[0m\r\n', 'latin1'),
        /*
         * A status line, for the same reason one sits between the `who` listing
         * and the party listing below: **a batch ends on a status line or not
         * at all** (`Classifier.feedBatch`, and `maxLines` is 20). Without one
         * here the inventory batch stays open, swallows `Current Adventurers`
         * and everything under it, and the `who` listing is never framed — so
         * the roster arrives empty and the Realm card has nothing to show. The
         * fixture's own note two blocks down warns about exactly this; the
         * inventory listing above needs the same courtesy.
         */
        Buffer.from('\x1b[1;32m[HP=98/MA=50]:\x1b[0m\r\n', 'latin1'),
        // A `who` listing, verbatim in shape from `npm run probe:who`. The
        // alignment column is the PvP-relevant one and is present only for
        // characters that have a standing.
        Buffer.from('\x1b[0;36m         Current Adventurers\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[0;36m         ===================\x1b[0m\r\n', 'latin1'),
        Buffer.from(
          '\x1b[0;37m         Rayzor                -  Apprentice S\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from('\x1b[0;31m         Outlaw   Grimjaw     -  Cutpurse\x1b[0m\r\n', 'latin1'),
        /*
         * A status line closes the `who` batch before the next listing starts.
         * Two batches back to back is not a shape the server sends, and letting
         * one run into the other is how the first gets eaten.
         *
         * Terminated, unlike the prompt at the end of this volley: an
         * unterminated line is framed together with whatever follows it, which
         * would glue the status line to the party header and match neither.
         */
        Buffer.from('\x1b[1;32m[HP=98/MA=50]:\x1b[0m\r\n', 'latin1'),
        // A travel party, verbatim in shape from `npm run probe:party` with two
        // characters on the local server. The mana column is present only for a
        // class that has any -- exactly as in the status line.
        Buffer.from(
          '\x1b[0;36mThe following people are in your travel party:\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from(
          '\x1b[0;37m  Rayzor                        (Warrior)             [H:100%]  - Frontrank\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from(
          '\x1b[0;37m  Soul                          (Paladin)    [M:100%] [H:100%]  - Backrank\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from('\x1b[1;32m[HP=98/MA=50]:\x1b[0m\r\n', 'latin1'),
        /*
         * And again, with somebody hurt -- sitting down, and followed.
         *
         * Two listings, because an alert fires on the *crossing*: "they were
         * already hurt when I looked" is not news, and one listing cannot tell
         * the difference between somebody who just got hit and somebody who has
         * been at 40% all evening.
         *
         * The `R` between the health and the rank is what a resting member
         * looks like, and it used to match nothing: the row qualified as
         * nothing, two members became one, and one member is not a party -- so
         * the whole card *disappeared* the moment somebody sat down. It is here
         * rather than in a unit test because that is where it was seen.
         *
         * `You are following ...` is printed above the roster only for a
         * character that is not at the head of the party, and the card puts
         * whoever that names first however the listing arrived.
         */
        Buffer.from('\x1b[0;36mYou are following Soul.\x1b[0m\r\n', 'latin1'),
        Buffer.from(
          '\x1b[0;36mThe following people are in your travel party:\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from(
          '\x1b[0;37m  Rayzor                        (Warrior)             [H:100%]  - Frontrank\x1b[0m\r\n',
          'latin1'
        ),
        Buffer.from(
          '\x1b[0;37m  Soul                          (Paladin)    [M: 62%] [H:40%] R - Backrank\x1b[0m\r\n',
          'latin1'
        ),
        /*
         * Soul's client answering `@health` -- the one line that gives a party
         * member a *maximum*. The roster is percentage-only, so without this
         * the card can say `40%` and never `40% of 4,434`; 1774/4434 is the
         * same 40% the row above states, so the two never disagree.
         */
        Buffer.from('\x1b[0;35mSoul telepaths: {HP=1774/4434,MA=320/516}\x1b[0m\r\n', 'latin1'),

        // Distinguishable per connection, so cross-talk between two characters
        // is visible rather than inferred. Sent after the filler above, or it
        // would fall out of the renderer's 200-line stream window before
        // anything could read it.
        Buffer.from(`\x1b[0;37mmarker-for-connection-${index}\x1b[0m\r\n`, 'latin1'),
        /*
         * A bank's name, alone, as its own line. Every room the realm calls
         * this is a bank, so the console draws a gold glyph before it. No
         * `Obvious exits:` follows, so the room never completes and the
         * character stays where it is. Last but one, so the row is still in
         * the viewport when the glyph is looked for -- a decoration exists in
         * the DOM only while its row is on screen.
         */
        Buffer.from('\x1b[1;36mBank of Godfrey\x1b[0m\r\n', 'latin1'),
        Buffer.from('\x1b[1;32m[HP=98/MA=50]:\x1b[0m ', 'latin1'),
        Buffer.from([IAC, GA])
      ])
    );
  }, 400);

  socket.on('data', (chunk) => {
    received.push(chunk);
    perSocket[index].push(chunk);
    /*
     * The one command this host answers: `rm`, which the client asks on
     * entering the realm so the map knows where it is. Answered the way the
     * realm answers it — echo, the location, a blank, the status line and its
     * repaint — so that the feed's quiet window has a real answer to withhold
     * and a real acknowledgement to close on.
     */
    if (/(^|\n)rm\r?\n/.test(chunk.toString('latin1'))) {
      socket.write(
        Buffer.from(
          'rm\r\nLocation: 1,2140\r\n\r\n\x1b[1;32m[HP=98/MA=50]:\x1b[0m\x1b[79D\x1b[K',
          'latin1'
        )
      );
    }
  });
  socket.on('error', () => {});
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
// Written here rather than at the top: the saved server names this port.
writeConfig('light');
writeRealm();
writeProfiles();
console.log(`\nmudengine smoke test -- fake host on 127.0.0.1:${PORT}\n`);

// ------------------------------------------------------------------- launch

const electron =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : './node_modules/electron/dist/electron';

/**
 * `ELECTRON_RUN_AS_NODE` makes the Electron binary behave as a plain Node
 * runtime: no app, no window, no `electron` module — `import { app } from
 * 'electron'` resolves to the npm shim and dies during ESM preparse before any
 * of our code runs. VS Code exports it to its own helper processes, so a run
 * launched from an integrated terminal inherits it. Strip it rather than
 * trusting the caller's environment.
 */
const appEnv = { ...process.env, MUDENGINE_HOME: HOME };
delete appEnv.ELECTRON_RUN_AS_NODE;

const electronArgs = [
  'out/main/index.js',
  '--no-sandbox',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`
];

/**
 * Run on a throwaway X display when there is a real one to protect.
 *
 * The app takes keyboard focus on launch — deliberately, it is the focus policy
 * — but a *test* has no business doing that to whoever is at the keyboard. It
 * bit us for real: a smoke run stole focus mid-sentence and the typing went
 * into the game's username prompt, which failed the login and looked exactly
 * like a bug in the client.
 *
 * Only when `DISPLAY` is set, since that is the only case with a session to
 * interrupt; headless CI already has nothing to steal.
 */
const hasXvfb =
  process.platform === 'linux' &&
  // Either kind of session counts. A Wayland-only desktop has no `DISPLAY` at
  // all, and checking for that alone concluded there was nothing to protect.
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
  spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
/*
 * Refuse to open a real window over someone's session.
 *
 * The app takes keyboard focus on launch by design -- it is the focus policy --
 * and a test has no business doing that to whoever is at the keyboard. When
 * there is a desktop session and no way to hide from it, that is a reason to
 * stop rather than to carry on and hope. Pass --windowed to watch deliberately.
 */
const wantsWindow = process.argv.includes('--windowed');
const hasSession = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
if (hasSession && !hasXvfb && !wantsWindow) {
  console.error(
    '\nThere is a desktop session here and no `xvfb-run` to hide behind, so this\n' +
      'would open a window and take your keyboard. Install xvfb, or pass --windowed\n' +
      'if you meant to watch it.\n'
  );
  process.exit(1);
}

if (hasXvfb) console.log('running on a virtual display -- your focus is left alone\n');

/*
 * `detached` puts the app in its own process group so the whole tree can be
 * signalled at the end.
 *
 * `xvfb-run` is a shell wrapper, so `child.kill()` reaps the wrapper and leaves
 * Electron running -- still holding the debugging port and still connected to
 * the fake host. Runs then accumulate: the next one attaches to the *first*
 * leftover instance rather than the app it just launched, and reports that
 * app's state as though it were this run's. It reads as a baffling assertion
 * failure about numbers nothing in the fixture produces.
 */
/*
 * Force the X11 backend and hide the real compositor.
 *
 * `xvfb-run` sets `DISPLAY` to a virtual X server, but Electron prefers Wayland
 * when `WAYLAND_DISPLAY` is set and connects to the *real* compositor anyway --
 * so the window opens on the user's actual desktop and takes their keyboard,
 * which is the exact thing running under Xvfb was supposed to prevent. It
 * happened: a run stole focus mid-sentence and the typing went into the game's
 * login prompt, which rejected it.
 */
const xvfbEnv = { ...appEnv };
delete xvfbEnv.WAYLAND_DISPLAY;

const child = hasXvfb
  ? spawn('xvfb-run', ['-a', electron, '--ozone-platform=x11', ...electronArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: xvfbEnv,
      detached: true
    })
  : spawn(electron, electronArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: appEnv,
      detached: true
    });

/** Signal the app's whole process group, not just the process we spawned. */
const killApp = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
};

/**
 * Ask the *app* to end, rather than signalling everything under `xvfb-run`.
 *
 * Both are in the same process group, and `xvfb-run` is a shell script that
 * traps a signal by killing its Xvfb. So a group SIGTERM is a race: Electron's
 * own handler runs the clean teardown, and Xvfb dying under it takes the X
 * connection away, which aborts the browser process where it stands. With a
 * window and a GPU process actually running — which is every real run, and not
 * the empty one this was first checked against — the abort usually wins, and
 * the client looked like it could not shut down cleanly when it could.
 *
 * So the graceful path signals the Electron process by pid and lets `xvfb-run`
 * clean up afterwards. The group SIGKILL below is unchanged: that one is for
 * runs that end badly, where leaving an Xvfb behind is the failure.
 */
let signalledPid = null;
let signalledArgs = '(no match)';
const askAppToQuit = () => {
  let pid = null;
  try {
    /*
     * The *browser* process, not a renderer and not Xvfb. Electron's helpers
     * all carry `--type=` and only the browser process installs the signal
     * handler, so signalling any of the others ends a child and leaves the app
     * standing — which reads exactly like an app that ignored the signal.
     */
    const rows = execSync(`ps -o pid=,args= -g ${child.pid}`).toString().split('\n');
    for (const row of rows) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(row);
      if (!match) continue;
      const [, id, args] = match;
      /*
       * Anchored at the start, because `xvfb-run` is a shell script whose own
       * command line *contains* the electron path — so an unanchored match
       * killed the wrapper, which traps the signal by killing Xvfb, which takes
       * the X connection away and aborts the browser process before its handler
       * finishes. Which is the exact failure this was written to avoid.
       */
      if (!/^\S*electron\/dist\/electron\s/.test(args) || /--type=/.test(args)) continue;
      pid = Number(id);
      signalledArgs = args.slice(0, 90);
      break;
    }
  } catch {
    /* no group left, or `ps` is not this shape: fall back to the group */
  }
  signalledPid = Number.isInteger(pid) && pid !== null && pid > 0 ? pid : -child.pid;
  try {
    process.kill(signalledPid, 'SIGTERM');
  } catch (error) {
    signalledPid = `${signalledPid} (${String(error)})`;
  }
};

// Runs that end early -- a thrown assertion, Ctrl-C, a failed attach -- must
// not leak either. Without this the leak is worst exactly when a run is going
// badly and is most likely to be repeated.
process.on('exit', () => {
  if (!keepOpen) killApp('SIGKILL');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killApp('SIGKILL');
    process.exit(1);
  });
}

const NOISE =
  /Fontconfig|wayland|libwayland|GPU|dbus|Vulkan|MESA|gbm|EGL|invalid |Failed to shutdown/i;
let appErr = '';
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  // Kept whole, filtered only for *display*: the noise filter exists so a run
  // is readable, and a shutdown that failed is exactly the thing it would hide.
  appErr += `${s}\n`;
  if (s && !NOISE.test(s)) process.stderr.write(`   [app] ${s}\n`);
});

/**
 * Kept, not just drained.
 *
 * The app explains itself on stdout -- notices, and the shutdown line the
 * check at the end reads. Piping it and listening to nothing is also how a
 * chatty run wedges: an unread pipe fills at 64KB and the write blocks the
 * process this harness is driving.
 */
let appOut = '';
child.stdout.on('data', (d) => {
  appOut += d.toString();
});

// ----------------------------------------------------------------- CDP client

async function attach() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* debugger not listening yet */
    }
    await sleep(250);
  }
  throw new Error('renderer never exposed a CDP target');
}

const target = await attach();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 0;
const inflight = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    fail(`renderer exception: ${msg.params.exceptionDetails?.text ?? 'unknown'}`);
  }
  if (msg.id && inflight.has(msg.id)) {
    inflight.get(msg.id)(msg);
    inflight.delete(msg.id);
  }
};

const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    inflight.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

await cdp('Runtime.enable');
await cdp('Page.enable');

for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`!!document.querySelector('.status-rail')`)) break;
  await sleep(250);
}
pass('renderer mounted');

// ----------------------------------------------------------- assert: profiles

const roster = await evaluate(`window.mudengine.listSessions()`);
check(
  roster.length === 2 && roster.map((s) => s.id).join(',') === 'smoke,smoke2',
  'a session per profile file, named after it',
  JSON.stringify(roster.map((s) => s.id))
);
check(
  roster[0]?.name === 'Smoke Character',
  'the character is shown by the name its profile gives it',
  roster[0]?.name
);
check(
  roster[0]?.accent === 'amber',
  'the character keeps the identity colour it chose',
  roster[0]?.accent
);
// broken.yaml sits in the same directory and cannot be a character. One bad
// file must not cost you the good ones.
check(roster.length === 2, 'an unparseable profile is skipped, not fatal');

// ------------------------------------------------------------ assert: layout
//
// The status rail is the height of its own content and nothing more; the
// workspace takes the rest. Removing the command strip without removing its
// grid track once left the workspace sized to its content and the rail filling
// the window, which reads as a strangely tall status bar and is really the
// terminal refusing to grow.
{
  const box = await evaluate(`
    (() => {
      const app = document.querySelector('.app').getBoundingClientRect();
      const rail = document.querySelector('.status-rail').getBoundingClientRect();
      const work = document.querySelector('.workspace').getBoundingClientRect();
      return { app: app.height, rail: rail.height, work: work.height };
    })()
  `);
  check(
    box.rail < 80,
    'the status rail is the height of its content',
    `${Math.round(box.rail)}px of ${Math.round(box.app)}px`
  );
  check(
    box.work > box.app * 0.8,
    'the workspace takes the rest of the window',
    `${Math.round(box.work)}px of ${Math.round(box.app)}px`
  );
}

// ----------------------------------------------------------- assert: tab rail

const tabNames = await evaluate(`
  [...document.querySelectorAll('.tab-rail .tab .name')].map((n) => n.innerText).join('|')
`);
check(
  tabNames === 'Smoke Character|Second Character',
  'a tab per character, named by its profile',
  tabNames
);
check(
  (await evaluate(`document.querySelector('.tab-rail')?.dataset.side`)) === 'top',
  'the rail takes the edge the options file asks for, not the shipped default'
);
check(
  (await evaluate(
    `document.querySelector('.tab-rail .tab[data-active="true"] .name')?.innerText`
  )) === 'Smoke Character',
  'the first character is the one shown'
);

check(
  (await evaluate(`document.querySelector('.tab-rail .tab')?.dataset.accent`)) === 'amber',
  'a tab wears the identity colour its profile chose'
);

// -------------------------------------------------------------- assert: focus

/** Where focus is, as a stable description. */
const focusPath = () =>
  evaluate(`
    (() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      if (el.closest('.terminal-cell')) return 'terminal';
      if (el.closest('.palette')) return 'palette';
      if (el.closest('.conversation-say')) return 'say';
      if (el.closest('.status-rail')) return 'rail:' + (el.className || el.tagName);
      return el.tagName + '.' + el.className;
    })()
  `);

// Rule one: the client opens ready to type at.
let focus = '';
for (let i = 0; i < 40; i += 1) {
  focus = await focusPath();
  if (focus === 'terminal') break;
  await sleep(100);
}
check(focus === 'terminal', 'focus starts in the terminal', focus);

// ------------------------------------------------------------ assert: options

// The address is no longer typed anywhere: it belongs to the character, and the
// character's file names a server from the options file. What proves that
// resolved is the status rail, which reports where this character connects.
let seeded = '';
for (let i = 0; i < 40; i += 1) {
  seeded = await evaluate(`document.querySelector('.status-rail .detail')?.innerText ?? ''`);
  if (seeded.includes(`127.0.0.1:${PORT}`)) break;
  await sleep(100);
}

// The slate carries the console stack rather than inheriting the chrome one.
// xterm renders into a canvas, so this element is the only place the resolved
// terminal stack is observable from the DOM.
const termFont = await evaluate(
  `getComputedStyle(document.querySelector('.terminal-mount')).fontFamily`
);
check(termFont.includes(SMOKE_FONT), 'terminal font comes from the options file', termFont);
check(
  /monospace\s*$/.test(termFont),
  'terminal font stack terminates in the generic monospace keyword',
  termFont
);
check(
  termFont.includes('Web437 IBM VGA 8x16'),
  'terminal stack carries the bundled CP437 fallback face',
  termFont
);

// The chrome follows the same configured family, so the client is monospace
// throughout -- but without the CP437 bitmap face, which chrome never needs.
const chromeFont = await evaluate(
  `getComputedStyle(document.querySelector('.status-rail')).fontFamily`
);
check(chromeFont.includes(SMOKE_FONT), 'chrome font comes from the options file', chromeFont);
check(!chromeFont.includes('Web437'), 'chrome stack omits the CP437 bitmap face', chromeFont);

// ------------------------------------------------------------- assert: theme

// The options file asked for `light`, so the whole instrument -- chrome and
// terminal ground alike -- must have repainted before the first frame.
const themeState = await evaluate(`
  (() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    return [
      root.dataset.theme,
      root.dataset.appearance,
      cs.colorScheme,
      cs.getPropertyValue('--ink-card').trim(),
      cs.getPropertyValue('--ink-slate').trim(),
      cs.getPropertyValue('--text-lo').trim(),
      cs.getPropertyValue('--text-lo-normal').trim(),
      cs.getPropertyValue('--text-lo-quiet').trim()
    ].join(' | ');
  })()
`);
const [themeId, appearance, colorScheme, inkCard, inkSlate, textLo, textLoNormal, textLoQuiet] =
  themeState.split(' | ');
check(themeId === 'light', 'theme comes from the options file', themeState);

// The diagnostics cards are session-only and start hidden on every launch, so
// nothing in the options file can open them. The rail itself is still here --
// it keeps its space for the HUD -- and asserting both halves is the point:
// the container present, the diagnostic cards not.
check(await evaluate(`!!document.querySelector('.rail')`), 'the rail keeps its space');
check(
  await evaluate(`!document.querySelector('.link-card')`),
  'the diagnostics cards start hidden, whatever the options file says'
);
check(appearance === 'light', 'appearance is published for CSS to branch on', appearance);
check(colorScheme === 'light', 'color-scheme is set so native widgets follow', colorScheme);

// A light theme that left the dark neutrals in place would still report
// data-theme=light, so assert the tokens actually moved.
check(luminanceOf(inkCard) > 0.5, 'card fill is actually light', inkCard);

// The frame around the slate is derived from the theme's terminal palette
// rather than restated, so the two can never drift apart. Asserted as a
// property of the value -- it would still be the static `#000000` default if
// the derivation had not run -- rather than as a literal that rots whenever
// the palette is retuned.
check(luminanceOf(inkSlate) > 0.5, 'terminal ground is derived from the theme palette', inkSlate);

// `--text-lo` must resolve *through* the theme's -normal value rather than
// being set directly: the stream-pressure rule overrides it, and an inline
// custom property would beat that rule and silently disable the quiet state.
check(
  textLo === textLoNormal && textLo !== textLoQuiet,
  'muted text resolves through the composed token',
  `--text-lo ${textLo}, normal ${textLoNormal}, quiet ${textLoQuiet}`
);

// Cycling from the palette must outrank the file and survive as a preference.
await evaluate(`(document.querySelector('.status-rail .kbd-hint').click(), true)`);
await sleep(200);
// Typed, not browsed: the palette opens to collapsed groups now, and the
// theme commands are reached the way a person reaches them.
await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'cycle theme');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
await evaluate(`
  (() => {
    const i = [...document.querySelectorAll('.palette li')].find((li) => /Cycle theme/.test(li.innerText));
    if (i) i.click();
    return true;
  })()
`);
await sleep(300);
const cycled = await evaluate(`
  document.documentElement.dataset.theme + ' | ' + localStorage.getItem('mudengine.theme')
`);
// Any registered theme: the cycle order is dark, the seven dark editor
// themes, light, the seven light ones — so the neighbour of `dark` is not `light`.
check(
  /^[a-z-]+ \| \{"value":"[a-z-]+"/.test(cycled),
  'palette cycles the theme and remembers the choice',
  cycled
);
check(cycled.includes('|'), 'theme choice is persisted', cycled);

// ...and an edit to the options file must outrank that remembered choice.
// Without this rule the file's `ui.theme` key goes dead after the first toggle,
// which is the opposite of what a watched config is for.
const remembered = cycled.split(' | ')[0];
const other = remembered === 'dark' ? 'light' : 'dark';
writeConfig(other);
let adopted = '';
for (let i = 0; i < 40; i += 1) {
  adopted = await evaluate(`document.documentElement.dataset.theme`);
  if (adopted === other) break;
  await sleep(150);
}
check(
  adopted === other,
  'editing the options file outranks a remembered palette choice',
  `remembered ${remembered}, file asked for ${other}, got ${adopted}`
);

// Restore, so the rest of the run and the screenshots use the light theme.
writeConfig('light');
for (let i = 0; i < 40; i += 1) {
  if ((await evaluate(`document.documentElement.dataset.theme`)) === 'light') break;
  await sleep(150);
}

// --------------------------------------------------------------- drive the UI

// React ignores a direct `.value` assignment, so go through the prototype
// setter and dispatch the input event it listens for.
// Nothing is typed: the character's file says where it connects. The status
// rail states the connection, so the connection is what it acts on.
await evaluate(`(document.querySelector('.status-rail .phase').click(), true)`);

let connected = false;
for (let i = 0; i < 60; i += 1) {
  if (await evaluate(`!!document.querySelector('.status-rail .dot.connected')`)) {
    connected = true;
    break;
  }
  await sleep(250);
}
check(connected, 'client reaches the connected state');

// Submitting the connection form hands focus back rather than leaving it on
// the button that was just clicked.
for (let i = 0; i < 20; i += 1) {
  focus = await focusPath();
  if (focus === 'terminal') break;
  await sleep(100);
}
check(focus === 'terminal', 'focus returns to the terminal after connecting', focus);

/*
 * The console decorates a place it recognised: the bank's name arrived as a
 * bare line and the glyph before it is an xterm decoration — an element over
 * the row, not a character in it. Gold, and labelled with the bank's name.
 */
{
  // The line goes out with the last of the fixture's output; wait for it.
  let mark = null;
  for (let tries = 0; tries < 20 && mark === null; tries += 1) {
    mark = await evaluate(`
      (() => {
        const el = document.querySelector('.terminal-mark[data-mark="bank"]');
        if (!el) return null;
        return JSON.stringify({ label: el.getAttribute('aria-label'), svg: !!el.querySelector('svg') });
      })()
    `);
    if (mark === null) await sleep(100);
  }
  check(
    typeof mark === 'string' && /Bank of Godfrey/.test(mark) && /"svg":true/.test(mark),
    "a bank's name in the console carries the bank glyph",
    String(mark)
  );
  await capture('smoke-bank.png', 'the bank glyph before a room name');

  /*
   * The buttons after the name, measured rather than eyeballed.
   *
   * Two things can only be caught by geometry, and both shipped broken once.
   * The column was computed from `segment.text`, which carries the colour
   * sequences and the terminator — `Bank of Godfrey` arrives as 28 bytes and
   * paints 15 cells, so the buttons floated thirteen columns right of the name
   * they belong to. And the row grew taller than a cell, so they overlapped the
   * lines above and below, which on a console being written to is every line.
   *
   * Asserted against the *painted* text: the buttons start after the name ends
   * and within a couple of cells of it, and stand no taller than one row.
   */
  const geometry = await evaluate(`
    (() => {
      const row = document.querySelector('.terminal-actions');
      if (!row) return null;
      const button = row.querySelector('.terminal-action');
      if (!button) return null;
      const screen = document.querySelector('.xterm-screen');
      const box = screen.getBoundingClientRect();
      /*
       * The cell is measured from the glyph the console already painted,
       * never a constant: the terminal font is configurable and the pane is
       * resizable. The place glyph's own decoration is exactly MARK_INDENT
       * (two cells) wide, so it is the ruler that is always on screen.
       */
      const glyph = document.querySelector('.terminal-mark');
      const cell = glyph ? glyph.getBoundingClientRect().width / 2 : 0;
      if (!cell) return null;
      const r = row.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      return JSON.stringify({
        label: button.textContent,
        rowHeight: Math.round(r.height),
        buttonHeight: Math.round(b.height),
        cells: (r.left - box.left) / cell
      });
    })()
  `);
  if (typeof geometry === 'string') {
    const box = JSON.parse(geometry);
    /*
     * One cell tall. The line box is the constraint, not a control height —
     * the `button.lookup` trap, where a 32px control around 12px of text made
     * every row of the pack look double-spaced.
     */
    check(
      box.buttonHeight <= box.rowHeight,
      'a terminal action button is no taller than the row it sits on',
      geometry
    );
    /*
     * `Bank of Godfrey` is 15 painted cells behind a 2-cell indent, so the
     * buttons belong at roughly column 18 — nowhere near the column 30 the
     * byte count produced. Measured in cells against the console's own left
     * edge; no pixel constant, per the layout rule.
     */
    check(
      box.cells > 15 && box.cells < 24,
      'and starts just after the painted name, not after its escape codes',
      `${geometry} -> ${box.cells.toFixed(1)} cells`
    );
  } else {
    check(false, 'the bank offers a deposit button beside its name', String(geometry));
  }
}

await sleep(900);

// ------------------------------------------------------- assert: line framing

// Framing is invisible in the terminal, so it is asserted against the framed
// stream the parser will consume rather than against what was painted.
let framed = [];
for (let i = 0; i < 40; i += 1) {
  framed = (await evaluate(`window.mudengine.getLines('${SESSION}')`)) ?? [];
  if (framed.some((line) => line.terminator === 'repaint')) break;
  await sleep(150);
}

check(framed.length > 0, 'server output is framed into lines', `${framed.length} lines`);
check(
  framed.some((line) => line.plain === 'Obvious exits: north, south'),
  'a CRLF-terminated line is framed with its ANSI stripped',
  JSON.stringify(framed.map((l) => l.plain).slice(0, 8))
);

const repaint = framed.find((line) => line.terminator === 'repaint');
check(
  repaint?.plain === '[HP=100/MA=50]:',
  'the in-place status-line repaint is framed as its own line',
  JSON.stringify(repaint)
);
check(
  repaint?.text.includes('\u001b[79D'),
  'the framed line keeps the escape sequences the parser may want',
  JSON.stringify(repaint?.text)
);

// The trailing prompt has no terminator at all; it is released once the server
// goes quiet, which is what makes login automation possible in phase 3.
check(
  framed.some((line) => line.terminator === 'flush' && line.plain.includes('[HP=98/MA=50]:')),
  'the trailing prompt is released after the server goes quiet',
  JSON.stringify(framed.filter((l) => l.terminator === 'flush').map((l) => l.plain))
);

// ---------------------------------------------------------- assert: profiles

await evaluate(`(document.querySelector('.status-rail .kbd-hint').click(), true)`);
await sleep(250);
await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'connect');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
const profileRows = await evaluate(`
  [...document.querySelectorAll('.palette li')]
    .map((li) => li.querySelector('span')?.innerText ?? '')
    .filter((t) => /^Connect:/.test(t))
    .join(' | ')
`);
check(
  /Connect: Smoke Realm/.test(profileRows),
  'a saved realm is offered in the palette',
  profileRows
);
await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'find');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
check(
  /Search the console/.test(await evaluate(`document.querySelector('.palette').innerText`)),
  'search is offered in the palette'
);
await cdp('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await sleep(300);

// ------------------------------------------------------------ assert: search

await evaluate(
  `(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })), true)`
);
await sleep(350);
check(await evaluate(`!!document.querySelector('.search-bar')`), 'search opens on its shortcut');
check(
  (await focusPath()) === 'terminal' ? false : true,
  'search takes focus while open',
  await focusPath()
);

await evaluate(`
  (() => {
    const el = document.querySelector('.search-bar input');
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'Welcome to the Realm');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(600);
const count = await evaluate(`document.querySelector('.search-count')?.innerText ?? ''`);
check(/^\d+\/\d+$/.test(count), 'search finds the banner text in the backscroll', count);

await cdp('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await sleep(350);
check(!(await evaluate(`!!document.querySelector('.search-bar')`)), 'Escape closes search');
check(
  (await focusPath()) === 'terminal',
  'focus returns to the terminal when search closes',
  await focusPath()
);

// ------------------------------------------------------- assert: parsing/HUD

// Classification and the state it feeds are the phase-3 deliverable; the HUD is
// how a regression in either becomes visible rather than silent.
let character = null;
for (let i = 0; i < 40; i += 1) {
  character = await evaluate(`window.mudengine.getCharacter('${SESSION}')`);
  if (character?.phase === 'in-game' && character.room.name) break;
  await sleep(200);
}

check(character?.phase === 'in-game', 'the status line puts the session in-game', character?.phase);
// 98, not 100: the fixture's second status line is the current one.
check(
  character?.vitals?.hp === 98,
  'hp comes from the latest status line',
  String(character?.vitals?.hp)
);
check(
  character?.vitals?.mana === 50 && character?.vitals?.manaType === 'MA',
  'mana and its type come from the status line',
  JSON.stringify(character?.vitals)
);
check(
  character?.vitals?.hpMax === 400 && character?.vitals?.manaMax === 120,
  'maxima come from the stat sheet, not the status line',
  `${character?.vitals?.hpMax} / ${character?.vitals?.manaMax}`
);
check(
  character?.className === 'Warrior' && character?.race === 'Human',
  'the stat sheet identifies the character',
  `${character?.className} / ${character?.race}`
);
check(
  character?.room?.name === 'Newhaven, Village Entrance',
  'the room name is parsed without relying on its colour',
  character?.room?.name
);
check(
  JSON.stringify(character?.room?.exits?.map((e) => e.direction)) === JSON.stringify(['n', 's']),
  'exits are parsed and split',
  JSON.stringify(character?.room?.exits)
);
check(
  JSON.stringify(character?.room?.occupants?.map((who) => who.name)) ===
    JSON.stringify(['Nathaniel', 'orc rogue', 'giant rat']),
  'room occupants are parsed, and kept true by what happens next',
  JSON.stringify(character?.room?.occupants)
);
/*
 * The last two were never listed. `Also here:` said only Nathaniel; the orc
 * rogue and the giant rat are in the list because they *hit this character*,
 * and something hitting you is something in the room whatever the last listing
 * said.
 *
 * The same maintained-listing shape as the roster and the pack, and the case it
 * catches is the one a listing cannot: a monster that was already here when the
 * character walked in, or that walked in afterwards. Without it the list only
 * ever shrank — which is how a client came to spend a whole fight attacking a
 * monster it had already killed while a second one it had never heard of hit it
 * thirty times.
 */
/*
 * And each one says which of the two kinds it is, which is what auto-combat
 * turns on. `Nathaniel` is the interesting case rather than a convenient one:
 * the shipped realm has a *monster* of that name, so with nothing else to go on
 * the realm data is the best evidence there is and the client says `mob`. It
 * takes a `who` listing to overrule that — which is exactly the order
 * `classifyOccupant` tests its sources in, and getting it the other way round
 * is how a client comes to swing at a person.
 */
check(
  character?.room?.occupants?.[0]?.kind === 'mob',
  'an occupant says which kind it is, from the realm data',
  JSON.stringify(character?.room?.occupants?.[0])
);
check(
  JSON.stringify(character?.room?.items?.map((item) => item.name)) ===
    JSON.stringify(['newbie manual', 'grey robes']),
  'room items are parsed',
  JSON.stringify(character?.room?.items)
);
// The description has no marker of its own -- it is simply the prose between
// the name and the lines that do -- so it is the one part of a room that can
// only be recognised by position.
check(
  character?.room?.description === 'A dusty path leads away from the gates.',
  'the room description is collected from between the markers',
  JSON.stringify(character?.room?.description)
);

// ------------------------------------------------- assert: HUD threshold bands

/*
 * The one number that decides whether you run, and whether it looks like it.
 *
 * Thresholds are fractions of maximum, so this is checked against a character
 * whose maxima the client actually learned: 98/400 is 24.5% -- under a critical
 * of 0.25 -- and 50/120 is 41.7%, under a caution of 0.5 but above critical. A
 * fixed number of points could not distinguish the two.
 *
 * The colour is read back computed rather than as a class name, because the
 * token -> theme -> CSS path is where this can silently come apart: the level
 * attribute can be perfectly correct while the fill still paints green.
 */
const meters = await evaluate(`
  (() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const fill = getComputedStyle(el.querySelector('.fill')).backgroundColor;
      return { level: el.dataset.level, text: el.innerText.trim(), fill };
    };
    return { hp: read('.meter.hp'), mana: read('.meter.mana') };
  })()
`);

/**
 * The three colour channels of a computed background, for hue-family checks.
 *
 * Chrome resolves a `color-mix()` to `color(srgb 0.70 0.25 0.23 / 0.72)` rather
 * than to `rgb(...)`, so both spellings have to be read -- and 0-255 and 0-1
 * cannot be compared to each other. Only the *ordering* of the channels is
 * asserted, which is scale-free.
 */
const rgbOf = (value) => {
  const parts = (value ?? '').match(/[\d.]+/g)?.map(Number) ?? [];
  return parts.length >= 3 ? parts.slice(0, 3) : [];
};

check(meters?.hp?.level === 'critical', 'hp at 24.5% of maximum is critical', meters?.hp?.level);
check(
  meters?.mana?.level === 'caution',
  'mana at 41.7% of maximum is caution',
  meters?.mana?.level
);

// docs/ui-design.md §6: state is never colour-only. The word is the part a
// colour-blind player reads, so it is asserted as text, not as a class.
check(
  /critical/i.test(meters?.hp?.text ?? ''),
  'the hp meter says so in words as well as in hue',
  meters?.hp?.text
);
check(
  /low/i.test(meters?.mana?.text ?? ''),
  'the mana meter says so in words as well as in hue',
  meters?.mana?.text
);

const hpFill = rgbOf(meters?.hp?.fill);
const manaFill = rgbOf(meters?.mana?.fill);
check(
  hpFill.length === 3 && hpFill[0] > hpFill[1] && hpFill[0] > hpFill[2],
  'the critical fill actually paints red',
  meters?.hp?.fill
);
check(
  manaFill.length === 3 && manaFill[0] > manaFill[2] && manaFill[1] > manaFill[2],
  'the caution fill actually paints yellow rather than the mana accent',
  meters?.mana?.fill
);

// ------------------------------------------------------ assert: renderer side

/*
 * The rail's automation segment. The fixture reaches the realm, which fires the
 * realm-entry probe, so there is something queued to report -- and it must be
 * absent, not "idle", when there is not.
 */
const acting = await evaluate(`document.querySelector('.status-rail .acting')?.innerText ?? null`);
check(
  acting === null || /queued|walking|standing down/.test(acting),
  'the rail says what automation is doing, or says nothing at all',
  JSON.stringify(acting)
);

const status = (await evaluate(`document.querySelector('.status-rail').innerText`)).replace(
  /\s+/g,
  ' '
);
const chars = Number.parseInt(status.match(/([\d,]+) chars/)?.[1].replace(/,/g, '') ?? '0', 10);
check(chars > 100, 'decoded server output reached the renderer', `${chars} chars`);

// The configured point size is only observable in the rendered cell: xterm
// draws into a canvas and never writes font-size into the DOM. Deriving it
// from the grid the fit addon settled on is what proves the YAML value reached
// the renderer rather than merely being parsed in the main process.
const grid = status.match(/(\d+)×(\d+)/);
const screen = await evaluate(`
  (() => {
    const r = document.querySelector('.xterm-screen').getBoundingClientRect();
    return r.width + 'x' + r.height;
  })()
`);
if (!grid) {
  fail('status rail did not report a grid size');
} else {
  const [, cols, rows] = grid.map(Number);
  const [width, height] = screen.split('x').map(Number);
  const cellHeight = height / rows;
  check(
    Math.abs(cellHeight - SMOKE_FONT_SIZE) <= 2,
    'rendered cell height matches the configured font size',
    `${cols}×${rows} grid, ${screen}px -> ${cellHeight.toFixed(2)}px cell vs ${SMOKE_FONT_SIZE}px`
  );
  check(width / cols > 3, 'rendered cell width is plausible', `${(width / cols).toFixed(2)}px`);
}

// Open diagnostics and read back what was negotiated. The strip no longer
// carries a Diagnostics button — the palette is the only route, so driving it
// here is what proves that route works.
const railButtons = await evaluate(
  `[...document.querySelectorAll('.status-rail button')].map((b) => b.innerText.trim()).join('|')`
);
check(
  !/diagnostic/i.test(railButtons),
  'the status rail carries no Diagnostics button',
  railButtons
);

// The header that held a host, a port and an encoding is gone: those describe a
// character, not the client, and a pair of fields at the top of the window can
// only ever describe one of several.
check(
  (await evaluate(`!document.querySelector('.command-strip')`)) === true,
  'there is no command strip'
);

await evaluate(`(document.querySelector('.status-rail .kbd-hint').click(), true)`);
await sleep(200);
check(
  await evaluate(`!!document.querySelector('.palette')`),
  'command palette opens from the strip'
);

// The palette is the one dialog that takes typing focus.
check((await focusPath()) === 'palette', 'the palette takes focus while open', await focusPath());

/*
 * The shelf, and the pin that curates it.
 *
 * Opening the palette answers "the handful of commands I actually use": a
 * pinned section at the top, every group under it collapsed to its heading.
 * The shelf `internal.yaml` ships is only where somebody starts -- the pin on
 * any row moves a command on or off it, per client, remembered without
 * rewriting a file full of the user's own comments. All of which is worth
 * exactly nothing if the click does not survive the palette being closed, so
 * that is what this drives.
 */
const readShelf = async () =>
  await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.palette li')];
      const heading = (li) => li.classList.contains('palette-group-label');
      const first = rows[0];
      const shelf = [];
      for (const li of rows.slice(1)) {
        if (heading(li)) break;
        shelf.push(li.innerText.trim().split('\\n')[0]);
      }
      return {
        first: first ? first.innerText.trim().split('\\n')[0] : '',
        shelf,
        headings: rows.filter(heading).map((li) => li.innerText.trim().split('\\n')[0]),
        text: document.querySelector('.palette').innerText
      };
    })()
  `);

const shelfAtRest = await readShelf();
// `innerText` reports what is *rendered*, and a group heading is uppercased by
// its own type scale -- so the comparison is on the word, not on its casing.
check(
  /^pinned$/i.test(shelfAtRest.first),
  'the palette opens on a pinned section',
  shelfAtRest.first
);
check(
  shelfAtRest.shelf.some((row) => /Route to room/.test(row)),
  'and the shelf holds what internal.yaml pins',
  shelfAtRest.shelf
);
check(
  ['character', 'navigate', 'view', 'layout'].every((group) =>
    shelfAtRest.headings.some((h) => h.toLowerCase().startsWith(group))
  ),
  'with every group under it, collapsed to a heading',
  shelfAtRest.headings
);

const pinClicked = await evaluate(`
  (() => {
    const row = [...document.querySelectorAll('.palette li')]
      .find((li) => /Route to room/.test(li.innerText));
    const pin = row?.querySelector('.palette-pin');
    if (!pin) return false;
    pin.click();
    return true;
  })()
`);
check(pinClicked, 'every row carries a pin');
await sleep(200);
check(
  await evaluate(`!!document.querySelector('.palette')`),
  'unpinning a row does not run the command underneath it'
);
const unpinned = await readShelf();
check(
  !/Route to room/.test(unpinned.text),
  'an unpinned command leaves the shelf, and its group is collapsed over it',
  unpinned.shelf
);

// Closed and opened again: a shelf that forgets is a shelf nobody arranges.
await cdp('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await sleep(200);
await evaluate(`(document.querySelector('.status-rail .kbd-hint').click(), true)`);
await sleep(300);
const reopened = await readShelf();
check(
  !/Route to room/.test(reopened.text),
  'and the client remembers it was unpinned',
  reopened.shelf
);

// Typing still finds it -- pinning curates the shelf, it does not lock the
// warehouse -- and the pin puts it back from wherever it was found.
await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'route');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
check(
  await evaluate(
    `[...document.querySelectorAll('.palette li')].some((li) => /Route to room/.test(li.innerText))`
  ),
  'an unpinned command is still found by typing'
);
await evaluate(`
  (() => {
    const row = [...document.querySelectorAll('.palette li')]
      .find((li) => /Route to room/.test(li.innerText));
    row?.querySelector('.palette-pin')?.click();
    return true;
  })()
`);
await sleep(200);
await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
const repinned = await readShelf();
check(
  repinned.shelf.some((row) => /Route to room/.test(row)),
  'and pinning it again puts it back at the top',
  repinned.shelf
);

await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'options');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
check(
  await evaluate(
    `[...document.querySelectorAll('.palette li')].some((li) => /Show the options file/.test(li.innerText))`
  ),
  'palette offers the options file'
);
// Typed, because the next thing this visit reaches for is the toggle.
await evaluate(`
  (() => {
    const el = document.querySelector('.palette input');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    set.call(el, 'diagnostics');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);

// The rail container now persists for the HUD, so what the diagnostics toggle
// flips is the diagnostic cards, not the rail itself.
const railBefore = await evaluate(`!!document.querySelector('.link-card')`);
const opened = await evaluate(`
  (() => {
    const item = [...document.querySelectorAll('.palette li')]
      .find((li) => /diagnostics/i.test(li.innerText));
    if (!item) return false;
    item.click();
    return true;
  })()
`);
check(opened, 'palette offers the diagnostics toggle');
await sleep(250);
check(
  (await evaluate(`!!document.querySelector('.link-card')`)) !== railBefore,
  'the palette toggle actually flips the diagnostics cards'
);

// ...and hands it straight back on the way out.
for (let i = 0; i < 20; i += 1) {
  focus = await focusPath();
  if (focus === 'terminal') break;
  await sleep(100);
}
check(focus === 'terminal', 'focus returns to the terminal when the palette closes', focus);

// The rail takes no typed input, so opening it must not move focus at all.
check(
  (await focusPath()) === 'terminal',
  'toggling the rail leaves focus in the terminal',
  await focusPath()
);

/**
 * Ensures the diagnostics cards are on screen.
 *
 * Retried rather than assumed: the toggle is a flip, so a single blind press
 * lands in whichever state it did not start in, and the readouts below need a
 * known one.
 */
async function ensureDiagnostics() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await evaluate(`!!document.querySelector('.link-card')`)) return true;
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'D',
      code: 'KeyD',
      windowsVirtualKeyCode: 68,
      modifiers: 10
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'D',
      code: 'KeyD',
      windowsVirtualKeyCode: 68,
      modifiers: 10
    });
    await sleep(350);
  }
  return false;
}

check(await ensureDiagnostics(), 'diagnostics cards can be shown for the readouts below');
// `?? ''` rather than a bare read: a missing element should fail one check, not
// abort the whole run with an uncaught error.
const options = (await evaluate(`document.querySelector('.link-card')?.innerText ?? ''`)).replace(
  /\s+/g,
  ' '
);
check(/SUPPRESS-GO-AHEAD/.test(options), 'SUPPRESS-GO-AHEAD negotiated', options);
check(/ECHO/.test(options), 'server ECHO detected', options);

// The HUD cards render what the parser produced.
const vitals = (await evaluate(`document.querySelector('.vitals-card')?.innerText ?? ''`)).replace(
  /\s+/g,
  ' '
);
check(/98\/400/.test(vitals), 'vitals card shows health against its maximum', vitals.slice(0, 90));
check(/50\/120/.test(vitals), 'vitals card shows mana against its maximum', vitals.slice(0, 90));
check(/Warrior/.test(vitals), 'vitals card shows the class', vitals.slice(0, 90));

/*
 * The decision trace. `docs/legacy-assessment.md` §6 lists "why did the bot
 * run?" as a reason the outbound side is one arbiter rather than a fan-out --
 * and an arbiter nobody can see is only half of that argument.
 *
 * The realm-entry probe is what produces traffic here: reaching the realm makes
 * the client ask `st, i, exp, sc, l` on its own, each through the queue.
 */
const trace = (
  await evaluate(`document.querySelector('.automation-card')?.innerText ?? ''`)
).replace(/\s+/g, ' ');
// Case-insensitive: the headings are uppercased in CSS, and `innerText`
// returns the transformed text rather than the source.
check(/\bsent\b/i.test(trace), 'the automation card reports what was sent', trace.slice(0, 100));
check(
  /entering the realm/.test(trace),
  'and why it was sent, not merely that it was',
  trace.slice(0, 160)
);
check(
  DEFAULT_PROBE.some((command) => new RegExp(`\\b${command}\\b`).test(trace)),
  'the realm-entry probe appears in the trace',
  trace.slice(0, 160)
);

/*
 * The map is drawn from the realm data, so it only appears once the client has
 * resolved where it is standing -- which the fixture's room name does, because
 * `Newhaven, Village Entrance` is a real room in the shipped data.
 */
const mapCard = await evaluate(`
  (() => {
    const plan = document.querySelector('.map-card .map-plan');
    if (plan === null) return null;
    return {
      rooms: plan.querySelectorAll('.map-room').length,
      here: plan.querySelectorAll('.map-room[data-kind="here"]').length,
      links: plan.querySelectorAll('.map-links line').length,
      // Every colour must resolve to something the theme supplied; a literal
      // that slipped in would not change between themes. The room's *shape*
      // by name, not "a circle in a room": the group also holds the marks for
      // where you are and where you are going, and those have colours of
      // their own -- which is the whole reason the shape is named.
      roomFill: getComputedStyle(plan.querySelector('.map-room > .map-shape')).fill,
      // The "you" ring is a ring: an outline in the accent, with nothing
      // inside it. It drew as a filled grey disc for as long as this map
      // existed, because the room-shape rule was written as "a circle inside
      // a room" and outranked it -- see .map-shape in the stylesheet.
      // (No backticks in here: this whole block is a template literal.)
      youFill: getComputedStyle(plan.querySelector('.map-you')).fill,
      youStroke: getComputedStyle(plan.querySelector('.map-you')).stroke,
      // An *ordinary* room's edge, which is what the cascade was painting the
      // marks: the room the character stands in is accent-edged itself, so
      // comparing against that one would compare the ring to its own colour.
      shapeStroke: getComputedStyle(
        plan.querySelector('.map-room:not([data-kind="here"]) > .map-shape')
      ).stroke
    };
  })()
`);
check(mapCard !== null, 'the map card draws the rooms around the character');
check(
  mapCard !== null && mapCard.here === 1,
  'and marks the character exactly once',
  JSON.stringify(mapCard)
);
check(
  mapCard !== null && mapCard.rooms > 1 && mapCard.links > 0,
  'and joins the rooms it shows with corridors',
  JSON.stringify(mapCard)
);
// Vector, not characters, and every colour comes from the theme rather than
// from a literal in the map's own stylesheet.
check(
  mapCard !== null && /^(rgba?|color)\(/.test(mapCard.roomFill) && mapCard.roomFill !== 'none',
  'and paints rooms with a colour the theme resolved',
  mapCard?.roomFill
);
/*
 * And the one deliberately loud element on the surface is drawn in its own
 * colours rather than in the room's.
 *
 * A count of the marks cannot see this: the ring was *there* the whole time it
 * was being painted the room's grey. So the assertion is on what won -- the
 * ring is hollow, and its edge is not the edge every ordinary room wears.
 */
check(
  mapCard !== null && mapCard.youFill === 'none' && mapCard.youStroke !== mapCard.shapeStroke,
  'and draws the “you” ring in its own colours, not the room’s',
  JSON.stringify(mapCard)
);

// ------------------------------------------------- assert: the tab says who it is
//
// A profile's display name is a filename until the realm says who the character
// actually is. "Main" identifies nobody, and two characters on two BBSes need
// telling apart, so the tab carries the name the stat sheet gave and the realm
// they play on.
{
  const named = await evaluate(`window.mudengine.listSessions()`);
  const shown = await evaluate(`
    (() => {
      const tab = document.querySelector('.tab-rail .tab[data-active="true"]');
      if (!tab) return null;
      return {
        name: tab.querySelector('.name')?.innerText ?? '',
        on: tab.querySelector('.on')?.innerText ?? ''
      };
    })()
  `);
  check(
    named[0]?.name === 'Rayzor',
    'the roster takes the character name the realm gave, not the filename',
    JSON.stringify(named.map((entry) => entry.name))
  );
  check(
    named[0]?.server === 'Smoke Realm',
    'and the realm it plays on',
    JSON.stringify(named.map((entry) => entry.server))
  );
  check(
    shown?.name === 'Rayzor' && shown?.on === 'Smoke Realm',
    'and the tab shows both',
    JSON.stringify(shown)
  );
}

// ------------------------------------ assert: the whole route, without the mouse
//
// Ctrl-K, route, Enter, a name, Enter, Enter — and the character is moving. The
// last Enter used to do nothing at all: the panel showed the plan, the field
// kept the caret, and the only way on was to click "Walk it".
//
// This does not skip the review the panel exists for. The plan is drawn before
// the second Enter, so walking is still a separate keystroke on a route the
// player can see.
{
  const press = async (key, code, vk, modifiers = 0) => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers
    });
  };
  const type = async (selector, text) => {
    await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        set.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return true;
      })()
    `);
  };

  await press('k', 'KeyK', 75, 2);
  await sleep(350);
  await type('.palette input', 'route');
  await sleep(250);
  check(
    (
      await evaluate(
        `document.querySelector('.palette li[data-active="true"] span')?.innerText ?? ''`
      )
    ).includes('Route'),
    'typing "route" into the palette highlights the route command'
  );

  await press('Enter', 'Enter', 13);
  await sleep(450);
  check(
    await evaluate(`!!document.querySelector('.route-panel')`),
    'and Enter opens the route panel'
  );

  /*
   * The same field takes the pair the Room card's badge shows.
   *
   * `1/2150` is what a player reads off the badge, and typing it here used to
   * be a *name* search -- a substring query over 55,806 room names, which finds
   * nothing and says "No room by that name" about something that was never a
   * name. All three separators, because all three are what people type.
   */
  {
    const roomsFor = async (typed) => {
      await evaluate(`
        (() => {
          const el = document.querySelector('.route-panel input');
          const set = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          ).set;
          set.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(120);
      await type('.route-panel input', typed);
      await sleep(700);
      return JSON.parse(
        await evaluate(`
          JSON.stringify(
            [...document.querySelectorAll('.route-matches li')].map((li) =>
              li.innerText.replace(/\\s+/g, ' ').trim()
            )
          )
        `)
      );
    };

    for (const typed of ['1/2141', '1,2141', '1 2141']) {
      const found = await roomsFor(typed);
      check(
        found.length === 1 && /1\/2141/.test(found[0]),
        `typing ${JSON.stringify(typed)} finds exactly the room it names`,
        JSON.stringify(found)
      );
    }

    /*
     * Two numbers are already a unique key, so there is no candidate ladder to
     * fall back to -- and no name search either. A reference that misses is a
     * room the realm does not have, and saying "no room by that name" about it
     * would blame the wrong thing and have somebody retype it.
     */
    const missing = await roomsFor('1/999999');
    check(
      missing.length === 1 && /has no room 1\/999999/.test(missing[0]),
      'and a reference the realm has no room for says so, rather than blaming the name',
      JSON.stringify(missing)
    );

    // A bare number names no map, so it stays a name search -- room names can
    // be numbers, and reading one as a map would send somebody somewhere else.
    const bare = await roomsFor('2141');
    check(
      bare.every((row) => !/has no room/.test(row)),
      'while a bare number is still a name search',
      JSON.stringify(bare.slice(0, 3))
    );
  }

  /*
   * Somewhere the character is not. Plain "Newhaven" matches the room it is
   * standing in, and a plan of no steps is correctly unwalkable — which would
   * make the assertion below pass for the wrong reason.
   */
  await type('.route-panel input', 'Newhaven, D');
  await sleep(900);
  await press('Enter', 'Enter', 13);
  await sleep(900);
  const plan = await evaluate(
    `document.querySelector('.route-panel .route-summary')?.innerText.replace(/\\s+/g, ' ') ?? null`
  );
  check(plan !== null, 'a name and Enter plans a route to the highlighted room', plan);
  check(
    typeof plan === 'string' && /[1-9]\d* steps?/.test(plan),
    'and the plan has steps to walk',
    plan
  );

  /*
   * The picture of where the route ends, under the head.
   *
   * A route says how to get there completely and says nothing about what the
   * place *is* — a dead end off a corridor, or a junction with four ways out.
   * Asserted on the rooms actually drawn rather than on the frame existing,
   * because an empty `<svg>` in a bordered box would satisfy the frame and be
   * exactly the picture that claims a place has no neighbours.
   */
  const thereMap = JSON.parse(
    await evaluate(`
      JSON.stringify({
        frame: !!document.querySelector('.route-panel .route-map'),
        rooms: document.querySelectorAll('.route-panel .route-map .map-room').length,
        label: document.querySelector('.route-panel .route-map svg')?.getAttribute('aria-label') ?? null
      })
    `)
  );
  check(
    thereMap.frame && thereMap.rooms > 0,
    'and the panel draws the realm around the destination',
    JSON.stringify(thereMap)
  );
  /*
   * Centred on where the route ends, not on where the character is standing —
   * the loud ring is the map's centre, so a label saying "you" here would be
   * the one deliberately loud element on screen claiming the character is
   * somewhere it is not.
   */
  check(
    typeof thereMap.label === 'string' && /destination/.test(thereMap.label),
    'from the destination’s own point of view',
    thereMap.label
  );
  await capture('smoke-route-map.png', 'the destination’s neighbourhood in the route panel');

  /*
   * The one that was broken. Before the fix the panel simply sat there: the
   * list was empty so the navigation hook ignored Enter, and the form had
   * nothing to submit.
   */
  const beforeWalk = await evaluate(`
    (() => {
      const open = !!document.querySelector('.route-panel');
      const refused = !!document.querySelector('.route-refused');
      return { open, refused };
    })()
  `);
  await press('Enter', 'Enter', 13);
  await sleep(900);
  const afterWalk = await evaluate(`
    (() => {
      const open = !!document.querySelector('.route-panel');
      const refused = document.querySelector('.route-refused')?.innerText ?? null;
      return { open, refused };
    })()
  `);
  // Either it started walking — the panel closes and the caret goes back to the
  // terminal — or it said why not. Doing nothing is the regression.
  check(
    !afterWalk.open || afterWalk.refused !== null,
    'and a second Enter walks it, rather than doing nothing',
    `before ${JSON.stringify(beforeWalk)} after ${JSON.stringify(afterWalk)}`
  );

  // Leave nothing running, and put the caret back where it lives.
  await evaluate(`(window.mudengine.stopWalk('${SESSION}'), true)`);
  if (afterWalk.open) await press('Escape', 'Escape', 27);
  await sleep(400);

  /*
   * And answer the step the walk already sent.
   *
   * Stopping a walk cannot un-send the command in flight -- the protocol has no
   * cancel, which is the whole reason the queue exists -- so the tracker is
   * left holding an unanswered move. A real server always answers one; this
   * fixture does not unless it is told to, and an unanswered move sits in the
   * expectation queue until *some* room block arrives and is matched against a
   * direction typed twenty checks earlier. Which is exactly the failure the
   * queue exists to make impossible, arriving through the harness instead: the
   * discovery test below recorded its new room against `se` rather than against
   * the command that actually reached it.
   *
   * `There is no exit in that direction!` is the honest answer here, and the
   * one that consumes a move without moving anybody.
   */
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[0;31mThere is no exit in that direction!\x1b[0m\r\n' +
        '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ',
      'latin1'
    )
  );
  await sleep(400);
  // A loop is the palette command, the runner, the walker and the Navigation
  // card in one gesture: running "Loop: Smoke loop" must put a real step on the
  // socket and the loop's name on the card, and stopping it must stop both.
  // Sampled before the gesture: the step can reach the wire faster than the
  // evaluates that follow the click, and a snapshot taken after it misses it.
  /*
   * The picker lives on the Loop face, so get there first.
   *
   * Which face the card opens on follows what the character is doing, and a
   * walk was stopped a few lines above — so this is also the check that a
   * crumb click actually moves the card, before anything is asserted about
   * what is on the face it moved to.
   */
  {
    const clicked = await evaluate(`
      (() => {
        const card = document.querySelector('.navigation-card');
        if (!card) return 'no navigation card';
        const crumbs = [...card.querySelectorAll('.crumb')];
        const loop = crumbs.find((c) => /loop/i.test(c.innerText));
        if (!loop) return 'no loop crumb';
        loop.click();
        return 'ok';
      })()
    `);
    check(clicked === 'ok', 'the Navigation card offers a Loop face', String(clicked));
    await sleep(200);
  }
  /*
   * The loop face's picker opens when it is clicked.
   *
   * It did not: the `<select>` carried `keepFocus` on `mousedown` like every
   * other control in the rail, and on a `<select>` the default that
   * `keepFocus` prevents *is* the popup. Every loop was in the list and
   * clicking it showed none of them, which reads as a card that has lost its
   * loops rather than as a control refusing the caret.
   *
   * A native popup cannot be opened through CDP, so the assertion is on the
   * defect itself: dispatching a real `mousedown` and asking whether anything
   * cancelled it. That is exactly the bit that was wrong, and it fails again
   * the moment somebody puts `keepFocus` back.
   */
  {
    const cancelled = await evaluate(`
      (() => {
        const picker = document.querySelector('.loop-card-picker');
        if (!picker) return 'no picker';
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        picker.dispatchEvent(event);
        return event.defaultPrevented ? 'prevented' : 'ok';
      })()
    `);
    check(
      cancelled === 'ok',
      'the loop picker is left free to open its own popup',
      String(cancelled)
    );
    /* And it really is holding every loop, not merely the one on show: a
       collapsed `<select>` draws its selected option and nothing else, which
       is what made the defect look like a filtering bug. */
    const options = await evaluate(
      `[...document.querySelectorAll('.loop-card-picker option')].map((o) => o.value)`
    );
    check(
      Array.isArray(options) && options.includes('Smoke loop'),
      'and holds the character’s loops as its options',
      JSON.stringify(options)
    );
  }

  /*
   * The fixture's fight has run since the opening volley, and a loop started
   * mid-fight now waits it out rather than stepping out of the room
   * (`LoopRunner`'s fighting wait, captured live 2026-09-01) — the walker
   * likewise refuses to start a walk in combat. So the server ends the fight
   * here, before the loop is asked to walk, and the fixture re-engages it
   * after these checks: everything later about combat reads the fight as
   * still running.
   */
  for (const socket of liveSockets) {
    socket.write(
      Buffer.from('\x1b[0;36m*Combat Off*\x1b[0m\r\n\x1b[1;32m[HP=98/MA=50]:\x1b[0m\r\n', 'latin1')
    );
  }
  await sleep(700);

  const beforeLoop = received.length;
  await press('k', 'KeyK', 75, 2);
  await sleep(350);
  await type('.palette input', 'loop');
  await sleep(250);
  const row = await evaluate(`
    (() => {
      const li = [...document.querySelectorAll('.palette li')]
        .find((entry) => entry.innerText.includes('Loop: Smoke loop'));
      if (li) li.click();
      return !!li;
    })()
  `);
  check(row, 'the palette offers the loop the character configured');
  if (!row) {
    // Leave nothing half-open for the checks that follow: a palette left up
    // with 'loop' in its filter starves every later palette gesture.
    await press('Escape', 'Escape', 27);
    await sleep(200);
  }
  await sleep(900);
  /*
   * Starting a loop turns the Navigation card to its Loop face on its own.
   *
   * The card is one card with two faces and the face follows what the
   * character is actually doing, so this is the whole feature in one
   * assertion: the crumb is selected, and the body is the loop's rather than
   * the leg's. Read off `aria-selected`, which is the same fact the styling
   * hangs off, so a face that merely *looks* active does not pass.
   */
  const onLoopFace = await evaluate(`
    (() => {
      const card = document.querySelector('.navigation-card');
      if (!card) return 'no card';
      const active = card.querySelector('.crumb[aria-selected="true"]');
      return active ? active.innerText.trim() : 'none selected';
    })()
  `);
  check(
    /loop/i.test(String(onLoopFace)),
    'starting a loop shows the Loop face',
    String(onLoopFace)
  );
  const loopCard = await evaluate(
    `document.querySelector('.navigation-card')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  );
  check(/Smoke loop/.test(loopCard), 'and the card names the running loop', loopCard);
  /*
   * And a picture of it, for the reason the pack's own screenshot exists:
   * geometry is the one thing no assertion here catches, and this card is all
   * new geometry — two crumbs in the heading, and a bar where the loop's stop
   * used to be a row of text.
   */
  await evaluate(`
    (() => {
      const card = document.querySelector('.navigation-card');
      if (card) card.scrollIntoView({ block: 'center' });
      return !!card;
    })()
  `);
  await sleep(250);
  await capture('smoke-navigation.png', 'the Navigation card, running a loop');
  // The loop face is where a loop is driven from: pause, stop and skip rather
  // than the picker, which belongs to a character with nothing running.
  check(
    (await evaluate(
      `['pause', 'stop', 'skip'].every((id) => !!document.querySelector('.navigation-card [data-action="' + id + '"]'))`
    )) === true,
    'with pause, stop and skip to hand',
    loopCard
  );
  /*
   * And the Route face is one click away, still describing the leg the loop
   * is walking. It is the half the loop no longer talks about, so this is
   * also the check that the two faces did not collapse into one.
   */
  const routeFace = await evaluate(`
    (() => {
      const card = document.querySelector('.navigation-card');
      const crumbs = [...card.querySelectorAll('.crumb')];
      const route = crumbs.find((c) => /route/i.test(c.innerText));
      if (!route) return 'no route crumb';
      route.click();
      return 'ok';
    })()
  `);
  check(routeFace === 'ok', 'the Route face is still reachable by its crumb', String(routeFace));
  await sleep(200);
  const card = await evaluate(
    `document.querySelector('.navigation-card')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  );
  /*
   * The loop's own words are gone from it. `Stop looping` was a control on
   * this face for something the face beside it drives, and the loop's name and
   * lap were rows here duplicating the card next door -- which is what made
   * the two one card.
   */
  check(
    !/Stop looping/.test(card) && !/Loops Completed/.test(card),
    'and says nothing about the loop, which the other face owns',
    card
  );
  /*
   * A room the character is not in is a control, not text: the destination
   * the card names opens in the route panel, as a room clicked on the map
   * does -- the same `chooseOnMap`, so the two cannot drift apart.
   */
  const destinationControl = await evaluate(`
    (() => {
      const button = document.querySelector('.navigation-card .walk-destination button.lookup');
      if (!button) return '';
      button.click();
      return button.innerText.trim();
    })()
  `);
  check(destinationControl.length > 0, 'the Route face names its destination as a control', card);
  await sleep(500);
  const panelText = await evaluate(
    `document.querySelector('.route-panel')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  );
  // The reference, not the name: the route's last step is *named* the same,
  // so a name would match a plan to any like-named room. `1/2141` is the loop's
  // first stop and is unique.
  check(
    panelText.includes('1/2141'),
    'and pressing it opens the route panel on that room',
    JSON.stringify(panelText)
  );
  check(
    /Newhaven, Weapons Shop.*1\/2141/.test(panelText),
    'with the room named in its head, resolved from the realm',
    JSON.stringify(panelText)
  );
  await press('Escape', 'Escape', 27);
  await sleep(250);
  check(
    !(await evaluate(`!!document.querySelector('.route-panel')`)),
    'and Escape puts the panel away for the checks that follow'
  );
  check(
    // `received` holds what the socket got, which is not always a string.
    received.slice(beforeLoop).some((line) => /^(n|s)$/.test(String(line).trim())),
    'and the first step of the loop reached the wire',
    JSON.stringify(received.slice(beforeLoop))
  );

  /*
   * The map draws where the character is going, over the map of where it is.
   *
   * The leg being walked is a line along the corridors it walks, and the
   * stops the lap still owes are rings -- a loop is a list of places, so its
   * legs are drawn only as they are planned. Asserted here because this is the
   * one moment in the run when a route and a lap are both live: the loop is
   * running, its first leg is on the wire, and the fixture has not answered
   * the room, so nothing has been walked off the route yet.
   */
  const trail = await evaluate(`
    (() => {
      const plan = document.querySelector('.map-card .map-plan');
      if (plan === null) return null;
      const ring = plan.querySelector('.map-stop');
      const halo = plan.querySelector('.map-onroute');
      return {
        legs: plan.querySelectorAll('.map-trail line').length,
        onRoute: plan.querySelectorAll('.map-onroute').length,
        stops: plan.querySelectorAll('.map-stop').length,
        // What actually won, not merely what was drawn. Both marks sit inside
        // a room's group beside its shape, and the shape's own fill and edge
        // used to outrank them -- a lap stop on a shop came out amber, which
        // is the hue that already means "shop".
        ringFill: ring && getComputedStyle(ring).fill,
        ringStroke: ring && getComputedStyle(ring).stroke,
        ringDashes: ring && getComputedStyle(ring).strokeDasharray,
        haloStroke: halo && getComputedStyle(halo).stroke,
        shapeStroke: getComputedStyle(
          plan.querySelector('.map-room:not([data-kind="here"]) > .map-shape')
        ).stroke
      };
    })()
  `);
  check(
    trail !== null && trail.legs > 0 && trail.onRoute > 0,
    'the map draws the leg the loop is walking',
    JSON.stringify(trail)
  );
  check(
    trail !== null && trail.stops > 0,
    'and rings the stops the lap still owes',
    JSON.stringify(trail)
  );
  /*
   * Shape carries the difference and hue reinforces it (§6), so both have to
   * survive the cascade: the lap's ring is hollow and dashed where the `you`
   * ring is solid, and neither it nor the route's halo wears the edge an
   * ordinary room wears.
   */
  check(
    trail !== null &&
      trail.ringFill === 'none' &&
      trail.ringStroke !== trail.shapeStroke &&
      /\d/.test(String(trail.ringDashes)) &&
      trail.haloStroke === 'none',
    'and draws both marks in their own colours rather than the room’s',
    JSON.stringify(trail)
  );
  await evaluate(`(window.mudengine.stopLoop('${SESSION}'), true)`);
  await sleep(400);
  /*
   * Stopping takes the transport controls with it: pause, skip and stop are
   * for a loop that is running, and a control that does nothing is worse than
   * none. What is left is the picker and its play button.
   *
   * Asked of the Loop face on purpose, and the face is *selected* first — the
   * card follows the activity, so stopping brings the route face forward, and
   * reading `.loop-control` off whatever happened to be on screen would find
   * none of them and pass for the wrong reason.
   */
  const stopped = await evaluate(`
    (() => {
      const card = document.querySelector('.navigation-card');
      if (!card) return 'no card';
      const loop = [...card.querySelectorAll('.crumb')].find((c) => /loop/i.test(c.innerText));
      if (!loop) return 'no loop crumb';
      loop.click();
      return 'ok';
    })()
  `);
  check(
    stopped === 'ok',
    'the Loop face is still there once the loop has stopped',
    String(stopped)
  );
  await sleep(200);
  const controls = await evaluate(
    `[...document.querySelectorAll('.navigation-card .loop-control')].map((b) => b.dataset.action).join(',')`
  );
  check(
    !/pause|skip|stop/.test(String(controls)) && /play/.test(String(controls)),
    'and stopping the loop leaves the picker rather than its transport controls',
    String(controls)
  );

  /*
   * And the map stops drawing it. The positive control is the pair of checks
   * above: a route and a lap were both on the picture a moment ago, so an
   * empty map here cannot pass because the overlay was never drawn at all.
   * A plan the client is no longer following left on screen is the one thing
   * the drawing must never do.
   */
  const trailGone = await evaluate(`
    (() => {
      const plan = document.querySelector('.map-card .map-plan');
      if (plan === null) return null;
      return {
        rooms: plan.querySelectorAll('.map-room').length,
        legs: plan.querySelectorAll('.map-trail line').length,
        onRoute: plan.querySelectorAll('.map-onroute').length,
        stops: plan.querySelectorAll('.map-stop').length
      };
    })()
  `);
  check(
    trailGone !== null &&
      trailGone.rooms > 0 &&
      trailGone.legs === 0 &&
      trailGone.onRoute === 0 &&
      trailGone.stops === 0,
    'and the map stops drawing a route nothing is walking',
    JSON.stringify(trailGone)
  );

  /*
   * The palette follows the loop set while the client is running.
   *
   * Both halves separately, because they can pass for different reasons: an
   * *added* loop that never appears and a *removed* one that lingers are the
   * two faces of one stale `useMemo`, and a check that only added would go on
   * passing while every deleted loop stayed on the list for ever.
   *
   * A **character's own** loop rather than a global one, deliberately -- it is
   * the scope that was actually broken twice over. `setExtras` returns without
   * emitting when the servers and the global loops are unchanged, so a profile
   * loop never bumped `loadedAt` and the fetch was never re-asked; and even once
   * asked, the command list was built by a memo that did not depend on it.
   */
  {
    const added = path.join(PROFILES_DIR, 'smoke', 'loops', 'added-loop.yaml');
    const offered = async (name) => {
      await press('k', 'KeyK', 75, 2);
      await sleep(300);
      await type('.palette input', 'loop');
      await sleep(250);
      const seen = await evaluate(`
        [...document.querySelectorAll('.palette li')].some((entry) =>
          entry.innerText.includes(${JSON.stringify(`Loop: ${name}`)})
        )
      `);
      await press('Escape', 'Escape', 27);
      await sleep(200);
      return seen;
    };

    fs.writeFileSync(
      added,
      [
        'name: Added loop',
        'stops:',
        // Two, because one stop is a place to stand rather than a loop and
        // `asLoops` drops it -- which is what this fixture got wrong first.
        "  - 'Newhaven, Weapons Shop 1/2141'",
        "  - 'Newhaven, Armour Shop 1/2142'",
        ''
      ].join('\n'),
      'utf8'
    );
    // The stores poll rather than subscribe to inotify, and ProfileStore
    // debounces on top of that, so this waits for two hops rather than one.
    await sleep(2500);
    check(await offered('Added loop'), 'a loop added while the client runs reaches the palette');

    fs.rmSync(added, { force: true });
    await sleep(2500);
    check(
      !(await offered('Added loop')),
      'and a loop removed while it runs leaves it, rather than lingering stale'
    );
    check(await offered('Smoke loop'), 'without taking the character’s other loops with it');
  }

  /*
   * The fight, back on — the same volley the opener sent, so the Combat card,
   * the retreat window and the party checks below read the state they were
   * written against.
   */
  for (const socket of liveSockets) {
    socket.write(
      Buffer.from(
        '\x1b[1;31m*Combat Engaged*\x1b[0m\r\n' +
          '\x1b[0;37mYou slash the orc rogue for 12 damage!\x1b[0m\r\n' +
          '\x1b[0;31mThe orc rogue slashes you for 5 damage!\x1b[0m\r\n' +
          '\x1b[0;31mThe giant rat bites you for 2 damage!\x1b[0m\r\n' +
          '\x1b[1;32m[HP=98/MA=50]:\x1b[0m\r\n',
        'latin1'
      )
    );
  }
  await sleep(700);

  /*
   * The Loops modal: where a loop is *found*, as against the card that drives
   * the one running.
   *
   * Driven from the chord rather than from the palette, because the chord is
   * the half nothing else covers -- a binding that stops reaching the window
   * fails silently and looks exactly like a modal that was never built. Every
   * assertion is separate: the groups being collapsed, a search opening the
   * one that matches, and Escape handing the caret back are three different
   * ways for this to be broken and one check would pass on two of them.
   */
  {
    const modal = () => evaluate(`!!document.querySelector('.loops-modal')`);

    // Ctrl+L, which is what a player presses. Free in the client's own table
    // and claimed by nothing on this realm.
    await press('l', 'KeyL', 76, 2);
    await sleep(500);
    check(await modal(), 'Ctrl+L opens the Loops modal from the game');

    /*
     * Collapsed. Fifty-seven areas with four hundred loops under them is a
     * wall; the headings are the map, and a modal that opened expanded would
     * be the wall again.
     */
    const headings = await evaluate(
      `document.querySelectorAll('.loops-modal .palette-group-label').length`
    );
    check(headings > 0, 'with the areas drawn as headings', String(headings));
    check(
      (await evaluate(
        `document.querySelectorAll(
           '.loops-modal .palette-group-label[data-section="area"]'
         ).length`
      )) > 0,
      'and the areas among them',
      String(headings)
    );

    /*
     * The one section this run can prove, and it is a positive control for
     * every other: `Smoke loop` was started further up, so `Last walked` is
     * above the areas and **open**, holding exactly that row.
     *
     * The other two sections cannot be asserted here — they turn on the
     * character standing in a room some shipped loop names, which the fake
     * host does not put it in. Asserting only their absence would be the
     * negative-without-a-control shape this file already warns about, so the
     * start/waypoint ranking is proved in `lib/__tests__/loops.test.ts`, where
     * the room can be stated outright.
     */
    const sections = await evaluate(`
      [...document.querySelectorAll('.loops-modal .palette-group-label')]
        .map((li) => li.getAttribute('data-section'))
    `);
    check(
      Array.isArray(sections) && sections[0] === 'recent',
      'with the loop this character last walked above every area',
      JSON.stringify(sections?.slice(0, 4))
    );
    const opened = await evaluate(`
      [...document.querySelectorAll('.loops-modal li[role="option"]')]
        .map((row) => row.innerText.replace(/\\s+/g, ' '))
    `);
    check(
      Array.isArray(opened) && opened.length > 0 && opened.every((row) => /Smoke loop/.test(row)),
      'open, and holding only it — the areas below stay shut, so the shelf is a map not a wall',
      JSON.stringify(opened)
    );

    /* The shelf as it opens: the recent loop, then fifty-seven shut headings.
       Captured because this is the state somebody meets first. */
    await capture('smoke-loops-collapsed.png', 'the Loops modal as it opens');

    /* Typing opens exactly what it finds: a collapsed group hiding a match
       would be a search that lies. */
    await type('.loops-modal input', 'smoke');
    await sleep(350);
    const found = await evaluate(`
      [...document.querySelectorAll('.loops-modal li[role="option"]')]
        .map((row) => row.innerText.replace(/\\s+/g, ' '))
    `);
    check(
      Array.isArray(found) && found.some((row) => /Smoke loop/.test(row)),
      'and a search opens the group holding what it matched',
      JSON.stringify(found)
    );
    /* The character already walks this one, and the row says so rather than
       offering to file a second copy of it. */
    check(
      await evaluate(`!!document.querySelector('.loops-modal li[role="option"] .chip')`),
      'and marks a loop the character already walks'
    );

    /*
     * Where it would be kept, chosen before the row is clicked. Three chips,
     * and **`Don't Add` is the one held**: trying a loop once is the commonest
     * thing done with a shelf of four hundred, and a default that filed
     * silently is what turns an evening of trying them into a character
     * directory nobody can clean up.
     */
    const destinations = await evaluate(`
      [...document.querySelectorAll('.loops-destination .chip')].map((chip) => ({
        on: chip.getAttribute('aria-pressed'),
        where: chip.getAttribute('data-destination')
      }))
    `);
    check(
      Array.isArray(destinations) && destinations.length === 3,
      'the modal offers three places to keep a chosen loop',
      JSON.stringify(destinations)
    );
    check(
      destinations?.find((chip) => chip.on === 'true')?.where === 'none',
      'and keeps none of them unless asked, so trying a loop does not file it',
      JSON.stringify(destinations)
    );

    /*
     * Captured, for the reason the pack's own screenshot exists: every
     * assertion above passed the whole time the inventory looked like a form,
     * because nothing about the words changes when the geometry is wrong.
     */
    await capture('smoke-loops.png', 'the Loops modal');

    /*
     * Choosing the character's own hand-written loop actually walks it.
     *
     * This is the case that was broken: `loop:list` reports such a loop as a
     * name and a stop *count*, and the first version invented `{ room: '' }`
     * stops so every row could carry a whole loop. `asLoops` drops an empty
     * room, so it parsed to nothing and main refused the player's own valid
     * loop as one "the client cannot file" — a false claim about their data,
     * and a loop that did not walk. A held row is chosen by name now.
     *
     * Asserted through the console rather than the wire: the loop's first step
     * is a route the fake host never answers, and this check is about the
     * refusal *not* happening.
     */
    await press('Enter', 'Enter', 13);
    await sleep(700);
    /*
     * The Navigation card is the positive control, and the stronger one: it names
     * the loop the runner is actually holding, so it says the loop *started*
     * rather than merely that no refusal was printed. A check that only
     * asserted the absence of the refusal would pass just as well if the row
     * had done nothing at all.
     */
    const afterChoice = await evaluate(
      `document.querySelector('.navigation-card')?.innerText.replace(/\\s+/g, ' ') ?? ''`
    );
    check(
      /Smoke loop/.test(String(afterChoice)),
      'choosing the character’s own loop starts it rather than refusing it as unfilable',
      String(afterChoice)
    );
    check(
      /running|fighting|resting/i.test(String(afterChoice)),
      'and the card reports it as a loop that is actually running',
      String(afterChoice)
    );
    await evaluate(`(window.mudengine.stopLoop('${SESSION}'), true)`);
    await sleep(400);
    /*
     * Answer the step the loop's first leg already sent.
     *
     * Stopping cannot un-send the command in flight -- the protocol has no
     * cancel, which is the whole reason the queue exists -- so the tracker is
     * left holding an unanswered move, and the *next* room block to arrive
     * would be matched against a direction sent here. That is how this check
     * broke the Combat card's fixture twenty checks later. `There is no exit
     * in that direction!` consumes a move without moving anybody, which is the
     * same settling the route and loop checks above already do.
     */
    liveSockets[0]?.write(
      Buffer.from(
        '\x1b[0;31mThere is no exit in that direction!\x1b[0m\r\n' +
          '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ',
        'latin1'
      )
    );
    await sleep(400);

    /* Re-opened for the checks below, which are about the surface rather than
       about what choosing a row does. */
    await press('l', 'KeyL', 76, 2);
    await sleep(450);

    /* Escape belongs to whatever holds the caret, and it hands it back to the
       game in one press rather than two. */
    await press('Escape', 'Escape', 27);
    await sleep(350);
    check(!(await modal()), 'Escape puts the modal away');
    check(
      await evaluate(
        `!!document.activeElement?.closest('.terminal-cell') ||
         document.activeElement === document.body`
      ),
      'and hands the keyboard back to the game'
    );
  }
  // Settle the move the step left in flight, exactly as the route check does.
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[0;31mThere is no exit in that direction!\x1b[0m\r\n' +
        '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ',
      'latin1'
    )
  );
  await sleep(400);
}

// ------------------------------------------- assert: the optional rail cards
//
// Talk and Inventory are off by default and are brought back from the palette.
// What belongs on a rail is one player's business — a healer watches different
// things from a warrior — so the choice is remembered per character.
{
  const openCard = async (label) => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: 2
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: 2
    });
    await sleep(300);
    /*
     * Typed, not browsed. The palette opens to collapsed groups showing only
     * what internal.yaml pins, and the card toggles are deliberately not
     * pinned -- typing is how a person reaches them, so it is how the
     * harness does.
     */
    await evaluate(`
      (() => {
        const el = document.querySelector('.palette input');
        if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        set.call(el, ${JSON.stringify(label)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(250);
    const found = await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.palette li')]
          .find((li) => li.innerText.includes(${JSON.stringify(label)}));
        if (row) row.click();
        return !!row;
      })()
    `);
    /*
     * A missed row must not leave the palette open.
     *
     * Ctrl+K *toggles*, so an `openCard` that finds nothing leaves it up — and
     * the next call's Ctrl+K closes it again, finds nothing either, and every
     * `openCard` after that is inverted. One wrong label read as eleven
     * failures, none of them where the fault was. Closing here means a missed
     * row costs exactly the check it was for.
     */
    if (!found) {
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      });
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      });
    }
    await sleep(400);
    return found;
  };

  check(
    !(await evaluate(`!!document.querySelector('.conversation-card')`)),
    'Talk is not on the rail until it is asked for'
  );
  check(await openCard('Show card: Talk'), 'and the palette offers it');
  check(
    await evaluate(`!!document.querySelector('.conversation-card')`),
    'which puts it on the rail'
  );

  const said = (
    await evaluate(
      `document.querySelector('.conversation-log')?.innerText.replace(/\\s+/g, ' ') ?? ''`
    )
  ).trim();
  check(
    /gossip/.test(said) && /rope/.test(said),
    'the conversation feed holds what was said, off the block stream',
    said.slice(0, 90)
  );
  check(/telepath/.test(said), 'across every channel, not just one', said.slice(0, 90));

  /*
   * The channels are the heading's faces now — TALK is the whole stream and
   * each channel that has spoken earns a pill. GOS shows gossip alone, and
   * TALK brings everything back: the same guarantee the mute chips gave,
   * asked of the control that replaced them.
   */
  const clickFace = (word) => `
    (() => {
      const crumb = [...document.querySelectorAll('.conversation-card .crumbs .crumb')]
        .find((c) => c.innerText.trim().toLowerCase() === '${word}');
      if (crumb) crumb.click();
      return !!crumb;
    })()
  `;
  check(await evaluate(clickFace('gos')), 'the gossip channel earned a face in the heading');
  await sleep(300);
  const gossipFace = await evaluate(`document.querySelector('.conversation-log')?.innerText ?? ''`);
  check(
    !/telepath/.test(gossipFace) && /rope/.test(gossipFace),
    'a channel face shows that channel alone'
  );
  check(await evaluate(clickFace('talk')), 'and TALK is always offered');
  await sleep(300);
  check(
    /telepath/.test(await evaluate(`document.querySelector('.conversation-log')?.innerText ?? ''`)),
    'returning to TALK brings the whole stream back'
  );

  // The find row is put away until the search glyph in the action column
  // asks for it — the row it used to hold now shows conversation.
  check(
    !(await evaluate(`!!document.querySelector('.conversation-card .table-find')`)),
    'the find row is put away until asked for'
  );
  await evaluate(`document.querySelector('.conversation-card [data-action="find"]')?.click()`);
  await sleep(200);
  check(
    await evaluate(`!!document.querySelector('.conversation-card .table-find')`),
    'and the search glyph brings it out'
  );
  await evaluate(`document.querySelector('.conversation-card [data-action="find"]')?.click()`);
  await sleep(200);

  /*
   * Saying something back.
   *
   * The realm's own vocabulary, sent verbatim down the path a keystroke takes:
   * so the tracker sees the command, a walk stands down, the capture records it
   * and a password would be redacted. A second route to the socket would be a
   * second copy of all of that.
   */
  check(
    await evaluate(`!!document.querySelector('.conversation-say input')`),
    'the Talk card has somewhere to reply from'
  );

  // The filters and the reply box must not scroll away with the backlog: they
  // are reached for exactly when a feed is too busy to read.
  check(
    (await evaluate(`
      (() => {
        const body = document.querySelector('.conversation-card .body');
        const log = document.querySelector('.conversation-log');
        if (!body || !log) return 'missing';
        return getComputedStyle(body).overflowY === 'hidden' &&
          getComputedStyle(log).overflowY === 'auto'
          ? 'log'
          : getComputedStyle(body).overflowY + '/' + getComputedStyle(log).overflowY;
      })()
    `)) === 'log',
    'and it is the backlog that scrolls, not the card'
  );

  /*
   * The channel, and the two things it has to do.
   *
   * The composer sends verbatim — the realm's vocabulary is the vocabulary —
   * which is right and is also why every line had to start with `gos`. Nobody
   * types `gos` forty times. So the box carries a channel, and a line that
   * *does* start with one switches to it, so the next line goes there without
   * being told again.
   */
  check(
    (await evaluate(`document.querySelector('.conversation-say select')?.value ?? null`)) === 'gos',
    'the Talk card is pointed at a channel, and it is the one everybody is in'
  );

  /*
   * And the popup it opens is painted from the theme, not by the browser.
   *
   * The popup is drawn outside the DOM, so there are no pixels here to read --
   * but the two properties the paint is decided from are readable, and between
   * them they are the decision. Chromium cannot build a menu from a background
   * it can see through, so a translucent row makes it abandon the theme and
   * fall back to its own *light* menu chrome. That shipped once: a dark client
   * with a white dropdown, because every select states a tonal fill for the
   * closed control and nothing stated a surface for the open one.
   *
   * Opacity alone would be too weak a claim *here*, and weakest for the reason
   * that makes this spot convenient: the run is on `light`, whose --ink-raised
   * is white and whose fallback chrome is white too, so "is it opaque" is
   * satisfied by the bug as well as the fix. So it also asserts the row tracks
   * the appearance the theme wrote, which is what actually goes red when the
   * token stops being opaque or the colour stops coming from the theme.
   *
   * The dark half -- the side the bug was reported from -- cannot be asserted
   * from here without driving the theme, and doing that mid-run disturbs the
   * palette state every later check reads. It is covered instead by the token
   * itself being opaque in all sixteen themes, which is stated in the rule's
   * comment in index.css because nothing enforces it: ChromeTokens types
   * ink-raised as a plain string.
   */
  console.log(
    'PROBE ' +
      JSON.stringify(
        await evaluate(`
    (() => {
      const sel = document.querySelector('.conversation-say select');
      const opt = sel.options[sel.selectedIndex];
      return {
        selectColor: getComputedStyle(sel).color,
        selectedOptionColor: getComputedStyle(opt).color,
        theme: document.documentElement.dataset.theme
      };
    })()
  `)
      )
  );

  const optionPaint = await evaluate(`
    (() => {
      const option = document.querySelector('.conversation-say select option');
      if (!option) return null;
      const root = document.documentElement;
      return {
        background: getComputedStyle(option).backgroundColor,
        colorScheme: getComputedStyle(root).colorScheme,
        appearance: root.dataset.appearance
      };
    })()
  `);

  /* `rgb(r, g, b)` from getComputedStyle; an `rgba(...)` is the fallback bug. */
  const rowRgb = optionPaint?.background?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  const rowLuminance = rowRgb
    ? luminanceOf(
        '#' + [1, 2, 3].map((i) => Number(rowRgb[i]).toString(16).padStart(2, '0')).join('')
      )
    : NaN;

  check(
    Boolean(rowRgb),
    "a channel row in the popup is opaque, so the popup is the theme's and not the browser's",
    JSON.stringify(optionPaint)
  );

  check(
    optionPaint?.appearance === 'light' ? rowLuminance > 0.5 : rowLuminance < 0.5,
    'and it is the surface this appearance calls for, not whichever one happens to be white',
    JSON.stringify({ ...optionPaint, rowLuminance })
  );

  check(
    optionPaint?.colorScheme === optionPaint?.appearance,
    'and the engine has been told which way to paint the popup it draws itself',
    JSON.stringify(optionPaint)
  );

  const plainSay = Buffer.concat(received).length;
  await evaluate(`
    (() => {
      const input = document.querySelector('.conversation-say input');
      if (!input) return false;
      input.focus();
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      set.call(input, 'anyone selling a rope');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(120);
  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await sleep(400);
  check(
    Buffer.concat(received).subarray(plainSay).toString('latin1').includes('gos anyone selling'),
    'a line with no channel goes out on the one showing',
    JSON.stringify(Buffer.concat(received).subarray(plainSay).toString('latin1').slice(0, 60))
  );

  const switchSay = Buffer.concat(received).length;
  await evaluate(`
    (() => {
      const input = document.querySelector('.conversation-say input');
      input.focus();
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      set.call(input, 'auc halberd');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(120);
  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await sleep(400);
  const switched = Buffer.concat(received).subarray(switchSay).toString('latin1');
  check(
    switched.includes('auc halberd') && !switched.includes('gos auc'),
    'a line that names a channel goes as typed, not wrapped in the other one',
    JSON.stringify(switched.slice(0, 60))
  );
  check(
    (await evaluate(`document.querySelector('.conversation-say select')?.value ?? null`)) === 'auc',
    'and the picker moves, so the next line goes there without being told again'
  );

  /*
   * The four channels the realm names with punctuation instead of a word.
   *
   * None of them is in `Commands.cs`, so all four fell through the composer's
   * prefixing and went out as the literal text `gos .hi` — the sigil gossiped
   * to the realm rather than anything said to the room. Two are ordinary picker
   * entries; the two that address somebody are reached by typing the address,
   * and the picker then holds it so the reply needs no retyping.
   */
  for (const [typed, expected, showing] of [
    ['.hi there', '.hi there', '.'],
    ['"hi there', '"hi there', '"'],
    ['/soul hi there', '/soul hi there', '/soul']
  ]) {
    const before = Buffer.concat(received).length;
    await evaluate(`
      (() => {
        const input = document.querySelector('.conversation-say input');
        input.focus();
        const set = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        set.call(input, ${JSON.stringify(typed)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(120);
    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    });
    await sleep(400);
    const sent = Buffer.concat(received).subarray(before).toString('latin1');
    check(
      sent.includes(expected) && !sent.includes(`gos ${expected}`),
      `\`${typed}\` goes out as itself, not wrapped in the channel showing`,
      JSON.stringify(sent.slice(0, 60))
    );
    check(
      (await evaluate(`document.querySelector('.conversation-say select')?.value ?? null`)) ===
        showing,
      'and the picker follows it, like a channel word'
    );
  }

  /*
   * The picker has to open, and only a real mousedown proves it does.
   *
   * It carried `keepFocus`, which prevents the default on mousedown — and a
   * native select raises its popup on mousedown, so the whole control could be
   * read and never changed. Nothing about the markup changes when that comes
   * back, so the assertion is on the event: a mousedown on the channel picker
   * must reach the browser unprevented.
   */
  check(
    await evaluate(`
      (() => {
        const select = document.querySelector('.conversation-say select');
        if (!select) return false;
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        select.dispatchEvent(press);
        return !press.defaultPrevented;
      })()
    `),
    'a press on the channel picker is not swallowed, so the dropdown can drop down'
  );
  // Back to gossip, so the rest of this run sees the card as it was found.
  await evaluate(`
    (() => {
      const select = document.querySelector('.conversation-say select');
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value'
      ).set;
      set.call(select, 'gos');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(200);

  /*
   * A link somebody gossiped, followable.
   *
   * Split into runs of text and anchors rather than set as HTML: this text is
   * written by other players on a MUD, and `dangerouslySetInnerHTML` over it is
   * exactly the hole its name warns about. And only `http`/`https` — every
   * other scheme a URL can carry is a thing to hand the operating system only
   * when the person who typed it is the person running the client.
   */
  {
    const links = await evaluate(`
      JSON.stringify(
        [...document.querySelectorAll('.conversation-log a')].map((a) => a.getAttribute('href'))
      )
    `);
    check(
      /example\.test\/newhaven/.test(links),
      'a web address in what somebody said is followable',
      links
    );
    check(!/file:/.test(links), 'and a scheme that is not the web is left as text', links);
  }

  const beforeSay = Buffer.concat(received).length;
  await evaluate(`
    (() => {
      const input = document.querySelector('.conversation-say input');
      if (!input) return false;
      input.focus();
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      set.call(input, 'gos hello there');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(120);
  check((await focusPath()) === 'say', 'typing in it takes the caret, as a typed surface must');

  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  });
  await sleep(400);

  const onWire = Buffer.concat(received).subarray(beforeSay).toString('latin1');
  check(
    onWire.includes('gos hello there'),
    'what was typed reached the server',
    JSON.stringify(onWire)
  );
  check(/gos hello there\r/.test(onWire), 'and was committed with a CR, like a typed line');
  check(
    (await evaluate(`document.querySelector('.conversation-say input').value`)) === '',
    'the box clears, ready for the next line'
  );
  /*
   * Enter deliberately does *not* hand the caret back: a conversation is more
   * than one line, and a reply box that ejects you after every send is one you
   * have to re-enter to answer.
   */
  check((await focusPath()) === 'say', 'and keeps the caret, because a conversation continues');

  // Escape is the way out, and it is the same key that leaves every other
  // surface. A held caret is a swallowed keystroke, and that can cost a
  // character.
  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await sleep(250);
  check((await focusPath()) !== 'say', 'Escape gives the keyboard back to the game');

  await capture('smoke-talk.png', 'the Talk card, with somewhere to reply from');

  /*
   * The realm answers what a shop stocks, and what a spell costs, without
   * spending a command on either. Both come out of the shipped realm file —
   * a shop is a property of a *room*, and the realm database records which shop
   * each room holds, which is why `list` never has to be typed.
   */
  {
    /*
     * The shop is **on the room**, not a question the window asks.
     *
     * `shopHere` was an IPC channel until 2026-09-02, and this check called it
     * directly. The whole point of the entity work is that a card no longer
     * can: the tracker attaches the realm's shop the moment the room resolves,
     * so what proves it now is walking into one and reading the pushed state —
     * which is a stronger check than the old one, because it exercises the
     * path the card actually uses rather than a channel only this file called.
     *
     * The room walked into is read out of the shipped realm below; these two
     * are the standing claims about the index itself.
     */

    /*
     * The shop is a *face of the Room card*, not a card of its own.
     *
     * It was a card, and it appeared and disappeared from the rail as the
     * character walked in and out of shops -- which is the churn a fixed card
     * exists to prevent, applied to the rail itself. So the assertion is that
     * standing in one grows a second face on the Room card, that the face is
     * named for what the realm says the place *is*, and that copying the card
     * while it is shown puts the stock on the clipboard rather than the room:
     * a card with faces must never copy one of them while displaying another.
     *
     * The room is read out of the shipped realm data rather than written down
     * here -- a name and an exit list typed into this file would be a second
     * copy of the world, going stale the first time `build:world` ran.
     */
    const shopRoom = await evaluate(`
      (async () => {
        const map = await window.mudengine.localMap('${SESSION}', 1, 2141, 1);
        const cell = map.cells.find((entry) => entry.id === '1/2141');
        if (!cell) return null;
        return {
          name: cell.name,
          exits: cell.exits,
          place: cell.place ?? null,
          // cell.place is the map's own word for what the realm records here,
          // and it is what says a shop is worth walking into. The shop's name
          // and its stock now arrive on the room itself, and are read off the
          // pushed state once the character is standing in it.
          // (No backticks in here: this comment is inside a template literal.)
          shop: cell.place !== null && cell.place !== undefined
        };
      })()
    `);
    check(
      shopRoom !== null && shopRoom.shop && shopRoom.exits.length > 0,
      'the shipped realm has a shop room to stand in',
      JSON.stringify(shopRoom)
    );
    if (shopRoom?.shop) {
      const WORD = {
        n: 'north',
        s: 'south',
        e: 'east',
        w: 'west',
        ne: 'northeast',
        nw: 'northwest',
        se: 'southeast',
        sw: 'southwest',
        u: 'up',
        d: 'down'
      };
      /*
       * A room in the order the game sends one, and *whole*: name, description,
       * items, occupants, exits. Restoring it after this check means sending
       * all of it -- a block missing the item and occupant lines does not leave
       * the previous room's behind, it clears them, and every later assertion
       * about what is on the floor at Newhaven would fail on a room this check
       * walked out of.
       */
      const enter = (name, exits, extra = '') =>
        Buffer.from(
          `\x1b[1;36m${name}\x1b[0m\r\n` +
            '    A shopfront, with a counter.\r\n' +
            extra +
            `\x1b[0;32mObvious exits: ${exits.map((d) => WORD[d] ?? d).join(', ')}\x1b[0m\r\n` +
            '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ',
          'latin1'
        );
      liveSockets[0]?.write(enter(shopRoom.name, shopRoom.exits));
      await sleep(700);

      const faces = JSON.parse(
        await evaluate(`
          JSON.stringify(
            [...document.querySelectorAll('.room-card .crumb')].map((c) => c.innerText.trim())
          )
        `)
      );
      /*
       * **The shop arrived with the room.**
       *
       * This is the assertion the four deleted IPC channels were replaced by:
       * standing in a shop, the pushed `CharacterState` already carries the
       * realm's whole shop — its name and every line of its stock — because
       * `CharacterTracker.attachRealm` joined it the moment the room resolved.
       * Nothing was asked for, and the card that draws it makes no round trip.
       */
      const roomShop = await evaluate(`
        (async () => {
          const here = await window.mudengine.getCharacter('${SESSION}');
          const shop = here?.room?.shop ?? null;
          return shop === null
            ? null
            : { name: shop.name ?? null, lines: shop.items?.length ?? 0,
                firstItem: shop.items?.[0]?.name ?? null,
                allNamed: (shop.items ?? []).every((i) => typeof i.name === 'string' && i.name) };
        })()
      `);
      check(
        roomShop !== null && roomShop.lines > 0,
        'the room the character is standing in carries the realm’s shop, with no command sent',
        JSON.stringify(roomShop)
      );
      check(
        roomShop?.allNamed === true,
        'and every line of its stock is named rather than numbered',
        JSON.stringify(roomShop)
      );
      /*
       * Named for the kind, which is what made `WorldShop.kind` a fact with a
       * consumer: it was computed by `shopKind()` and read by nothing. A temple
       * reads TEMPLE and a bank BANK rather than all six reading SHOP.
       */
      const expected = { temple: 'Temple', tavern: 'Tavern', bank: 'Bank', trainer: 'Trainer' };
      const wanted = expected[shopRoom.place] ?? (shopRoom.place === 'inn' ? 'Inn' : 'Shop');
      check(
        faces.some((face) => face.toLowerCase() === wanted.toLowerCase()),
        `standing in a shop grows a ${wanted} face on the Room card`,
        JSON.stringify({ faces, place: shopRoom.place })
      );
      check(
        faces[0]?.toLowerCase() === 'room',
        'and the Room face stays first, wearing the card’s own title',
        JSON.stringify(faces)
      );
      check(
        !(await evaluate(`!!document.querySelector('.shop-card')`)),
        'without a Shop card appearing beside it on the rail'
      );

      // Switch to the shop face and copy: the clipboard must follow the eye.
      await evaluate(`
        (() => {
          const face = [...document.querySelectorAll('.room-card .crumb')]
            .find((c) => c.innerText.trim().toLowerCase() === ${JSON.stringify(wanted.toLowerCase())});
          if (face) face.click();
          return !!face;
        })()
      `);
      await sleep(250);
      await evaluate(`
        (() => {
          const copy = [...document.querySelectorAll('.room-card .card-side button')]
            .find((b) => /copy/i.test(b.getAttribute('aria-label') ?? b.title ?? ''));
          if (copy) copy.click();
          return !!copy;
        })()
      `);
      await sleep(300);
      const clip = await evaluate(`window.mudengine.pasteText()`);
      check(
        typeof clip === 'string' &&
          roomShop?.firstItem != null &&
          clip.includes(roomShop.firstItem),
        'and copying it takes the stock rather than the room it is in',
        JSON.stringify({ clip: String(clip).slice(0, 120), wanted: roomShop?.firstItem })
      );

      /*
       * The words a room answers, from the realm's own script table
       * (`Rooms.CMD` -> `TBInfo.Action`, see `src/main/world/roomScript.ts`).
       *
       * 1,077 rooms of the shipped realm carry one and some of the phrases move
       * you somewhere **no exit records** — which is the whole reason they are
       * drawn. Read out of the realm data rather than typed here, like the shop
       * room above: a phrase written into this file would be a second copy of
       * the world, stale the first time `build:world` ran.
       */
      const scripted = await evaluate(`
        (async () => {
          const map = await window.mudengine.localMap('${SESSION}', 3, 613, 1);
          const cell = map.cells.find((entry) => entry.id === '3/613');
          if (!cell) return null;
          /*
           * The name has to be *unique in the realm*, or the client cannot
           * resolve the room a bare block names and the face never appears —
           * which is what the first attempt at this check hit: 31 rooms are
           * called Mossy Tunnel. The room arrives here with no move behind it,
           * so a unique name is the only signal the resolver has.
           */
          const same = await window.mudengine.searchRooms('${SESSION}', cell.name);
          if (same.length !== 1) return { ambiguous: same.length, name: cell.name };
          // The realm's own script, off the room record. answersHere was an
          // IPC channel until 2026-09-02 and is now a field on the room the
          // tracker publishes. This is the *fixture*: what the face must show
          // is read back off the pushed state once the character is in it.
          // (No backticks in here: this comment is inside a template literal.)
          const answers = same[0]?.commands ?? [];
          if (answers.length === 0) return { name: cell.name, exits: cell.exits, say: null };
          return { name: cell.name, exits: cell.exits, say: answers[0].say[0], to: answers[0].to };
        })()
      `);
      check(
        scripted !== null && !!scripted.say && !!scripted.to,
        'the shipped realm has a room that answers a typed word',
        JSON.stringify(scripted)
      );
      if (scripted?.say) {
        liveSockets[0]?.write(enter(scripted.name, scripted.exits));
        await sleep(700);
        /*
         * And it arrived with the room, like the shop: the words a room
         * answers are on the pushed state rather than a question the card asks.
         */
        const onState = await evaluate(`
          (async () => {
            const here = await window.mudengine.getCharacter('${SESSION}');
            return (here?.room?.commands ?? []).length;
          })()
        `);
        check(
          typeof onState === 'number' && onState > 0,
          'and the room the character stands in carries them, with nothing asked for',
          String(onState)
        );
        const answerFace = await evaluate(`
          (() => {
            const face = [...document.querySelectorAll('.room-card .crumb')]
              .find((c) => c.innerText.trim().toLowerCase() === 'answers');
            if (!face) return null;
            face.click();
            return true;
          })()
        `);
        check(answerFace === true, 'and standing in it grows an Answers face on the Room card');
        await sleep(250);
        const said = await evaluate(
          `document.querySelector('.room-card .answers')?.innerText?.replace(/\\s+/g, ' ') ?? ''`
        );
        check(
          said.includes(scripted.say) && said.includes(scripted.to),
          'stating the phrase and where it leads',
          JSON.stringify({ said: said.slice(0, 160), want: scripted })
        );
        await capture('smoke-room-answers.png', 'the words a room answers');
      }

      /*
       * Put the character back where every later check expects it -- the whole
       * room, not only its name. The first attempt sent name and exits alone,
       * which restored the heading and left the floor and the occupants empty,
       * and three unrelated checks failed several thousand lines later.
       */
      liveSockets[0]?.write(
        enter(
          'Newhaven, Village Entrance',
          ['n', 's'],
          '\x1b[0;36mYou notice newbie manual, grey robes here.\x1b[0m\r\n' +
            '\x1b[0;35mAlso here: Nathaniel.\x1b[0m\r\n'
        )
      );
      await sleep(700);
    }

    const looked = await evaluate(`window.mudengine.lookup('${SESSION}', 'heal')`);
    check(
      Array.isArray(looked?.spells) &&
        looked.spells.length > 0 &&
        looked.spells.every((spell) => spell.name),
      'and the reference lookup answers out of the same file',
      JSON.stringify(looked?.spells?.slice(0, 3).map((spell) => spell.name))
    );
  }

  /*
   * Reference is on the rail already — it is not in `DEFAULT_AWAY`, which
   * holds only Carrying and Talk — so the palette never offers to *show* it
   * and asking it to would be asserting the opposite of the shipped layout.
   *
   * "A card the layout has never heard of appears anyway, in its shipped
   * position" (CLAUDE.md) is the rule being checked here, and the honest test
   * of it is that the card is simply there.
   */
  check(
    await evaluate(`!!document.querySelector('.reference-card')`),
    'the Reference card is on the rail without being asked for'
  );
  await evaluate(`
    (() => {
      const field = document.querySelector('.reference-card input');
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(field, 'heal');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  check(
    await evaluate(`document.querySelectorAll('.reference-card .reference li').length > 0`),
    'and narrows to what was typed',
    await evaluate(`document.querySelector('.reference-card')?.innerText?.slice(0, 120) ?? ''`)
  );
  // Choosing a match shows the realm's whole answer, not another list.
  await evaluate(`
    (() => {
      const row = document.querySelector('.reference-card .reference li');
      if (row) row.click();
      return true;
    })()
  `);
  await sleep(200);
  check(
    await evaluate(`!!document.querySelector('.reference-card .reference-detail')`),
    'and choosing a match shows the detail',
    await evaluate(
      `document.querySelector('.reference-card .reference-detail')?.innerText?.slice(0, 120) ?? ''`
    )
  );
  /*
   * What an item *does* — realm format 12, `Items.Abil-n` / `AbilVal-n`.
   *
   * The realm's whole effect system, unread by this client until 2026-08-31.
   * `chainmail hauberk` states `Stealth -5, Dodge -6` in the shipped realm,
   * which is the sentence that decides whether a thief wears it — and it is
   * a *negative* on purpose: a check against a `+` bonus would pass while the
   * sign was being thrown away.
   */
  const detail = async (typed) => {
    await evaluate(`
      (() => {
        const field = document.querySelector('.reference-card input');
        if (!field) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(field, ${JSON.stringify(typed)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(500);
    await evaluate(`
      (() => {
        const row = document.querySelector('.reference-card .reference li');
        if (row) row.click();
        return true;
      })()
    `);
    await sleep(250);
    return await evaluate(
      `document.querySelector('.reference-card .reference-detail')?.innerText?.replace(/\\s+/g, ' ') ?? ''`
    );
  };

  /*
   * A shop that sells an item is a **place**, not a word (todo 02).
   *
   * `Sold by: General Store, Newhaven General Store, …` was the client printing
   * an entity as its string representation: the realm knows which room each of
   * those is in, and the only thing anybody wants to do with the answer is go
   * there. Driven end to end here because the join runs in main, crosses on the
   * lookup, and only pays off if the click actually opens the route panel —
   * three seams a unit test covers one of.
   *
   * `torch` is the reported case and the shipped realm places all six of its
   * shops in exactly one room each.
   */
  {
    const torch = await detail('torch');
    check(/Sold by/.test(torch), 'an item names the shops that sell it', torch.slice(0, 200));

    const shops = await evaluate(`
      (() => {
        const labels = [...document.querySelectorAll('.reference-card .reference-detail dt')];
        const label = labels.find((dt) => /Sold by/.test(dt.innerText));
        const row = label && label.nextElementSibling;
        if (!row) return -1;
        return row.querySelectorAll('button.lookup').length;
      })()
    `);
    check(shops > 0, 'and every shop it can place is a control, not a word', String(shops));

    const opened = await evaluate(`
      (() => {
        const labels = [...document.querySelectorAll('.reference-card .reference-detail dt')];
        const label = labels.find((dt) => /Sold by/.test(dt.innerText));
        const button = label && label.nextElementSibling &&
          label.nextElementSibling.querySelector('button.lookup');
        if (!button) return false;
        button.click();
        return true;
      })()
    `);
    check(opened, 'and it can be pressed');
    await sleep(600);
    check(
      await evaluate(`!!document.querySelector('.route-panel')`),
      'and pressing one opens the routing dialog on that room, where the walk is chosen'
    );
    /*
     * The head is *resolved*, which is the half a bare pair loses: the panel
     * states the realm's facts about the destination, and a shop that opened it
     * with a blank head would look like the realm had never heard of the place.
     */
    check(
      ((await evaluate(`document.querySelector('.route-panel')?.innerText ?? ''`)) || '').trim()
        .length > 0,
      'with the destination named rather than a blank head'
    );
    // Put it away: everything after this reads the card behind it.
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await sleep(300);
    check(
      !(await evaluate(`!!document.querySelector('.route-panel')`)),
      'and Escape puts the routing dialog away again'
    );
  }

  const hauberk = await detail('chainmail hauberk');
  check(
    /Effects/.test(hauberk) && /Stealth/.test(hauberk) && /-5/.test(hauberk),
    'an item states what it does, sign and all',
    hauberk.slice(0, 160)
  );

  /*
   * And what a monster takes and is worth. `giant rat` in the shipped realm is
   * `ac=5 dr=5 mr=30 xp=5 rgn=1 fol=100` — the last of which is the one with a
   * safety consequence, because an automatic retreat cannot escape something that
   * always follows.
   */
  const rat = await detail('giant rat');
  check(
    /Defence/.test(rat) && /Pursuit/.test(rat) && /100%/.test(rat),
    'a monster states its defence and whether it follows you out',
    rat.slice(0, 220)
  );
  check(
    /HP Regen/.test(rat) && /Experience Value/.test(rat),
    'and its regeneration and experience value',
    rat.slice(0, 220)
  );
  await capture('smoke-reference-detail.png', 'the realm’s whole answer about a monster');

  // Put it away again: a check that leaves a card on the rail changes what
  // every later assertion about the rail sees.
  await evaluate(`
    (() => {
      const close = document.querySelector('.reference-card .card-close');
      if (close) close.click();
      return true;
    })()
  `);
  await sleep(250);

  check(await openCard('Show card: Inventory'), 'Inventory is offered too');
  check(
    await evaluate(`!!document.querySelector('.inventory-card')`),
    'and appears when asked for'
  );

  /*
   * What is carried stays true between `i` commands, from what the server
   * volunteers — the same reasoning as the realm roster and the room's
   * occupants, and free for the same reason.
   */
  check(
    /healing potion/i.test(
      await evaluate(`document.querySelector('.inventory-card')?.innerText ?? ''`)
    ),
    'and something picked up since the last listing is in it',
    await evaluate(`document.querySelector('.inventory-card')?.innerText?.slice(0, 200) ?? ''`)
  );

  /*
   * The coins are counted per denomination, not collapsed into one number.
   *
   * They were matched by the tracker's own regex and then dropped, on the
   * reasoning that the listing's `Wealth:` line already said it — one number
   * where the listing gives five. The total stays beside them, because it is
   * the *server's* arithmetic: `Wealth:` is a normalised total in copper, which
   * this fixture's 2 199 807 is exactly.
   */
  {
    const purse = await evaluate(
      `document.querySelector('.inventory-card .purse')?.innerText.replace(/\\s+/g, ' ') ?? ''`
    );
    check(/\b2\b/.test(purse) && /\b353\b/.test(purse), 'the purse counts each coin', purse);
    check(/2,199,807/.test(purse), 'and says what the realm makes of them, separated', purse);
    /*
     * One tier for the whole row: `48 plat, 18 g` is two vocabularies, and the
     * row is one sentence. Which tier is *measured* — no pixel constant may
     * exist in this path — so the assertion is that whichever was picked was
     * picked for every denomination at once.
     */
    const names = purse.match(/\d+ ([a-z]+)/g)?.map((part) => part.split(' ')[1]) ?? [];
    const tiers = new Set(
      names.map((name) =>
        name.length === 1
          ? 'short'
          : ['runic', 'platinum', 'gold', 'silver', 'copper'].includes(name)
            ? 'full'
            : 'medium'
      )
    );
    check(
      names.length >= 4 && tiers.size === 1,
      'in one vocabulary, at whichever length fits',
      JSON.stringify({ names, tiers: [...tiers] })
    );
    // Zero is never drawn: the fixture has all five, so nothing here should be
    // a `0`, and a denomination the listing did not name would not appear.
    check(!/\b0 /.test(purse), 'and never draws a denomination it has none of', purse);
    // Printed rather than screenshotted: the card is one row on a scrolling
    // rail, and a shot named for it caught whatever the rail was showing.
    log(`purse: ${purse}`);
  }

  /*
   * The server wrapped that listing mid-item, which is what it does to any
   * inventory long enough. Everything after the fold used to be dropped in
   * silence, and the card showed a character wearing half its kit.
   */
  {
    const carried = await evaluate(`document.querySelector('.inventory-card')?.innerText ?? ''`);
    const missing = ['padded helm', 'padded gloves', 'padded pants', 'quarterstaff'].filter(
      (item) => !carried.includes(item)
    );
    check(missing.length === 0, 'a wrapped inventory is read whole', missing.join(', '));
    /*
     * The fold ate a space: gluing the halves without one produces an item
     * nobody carries, and `padded gloves(Hands)` is exactly what that looks
     * like. The name and the slot are separate elements on the card, so this
     * asserts the pair rather than one string — the fold is proven by `Hands`
     * having landed against the gloves at all.
     */
    const gloves = await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.carried tbody tr')].find(
          (li) => li.querySelector('.what')?.innerText.trim() === 'padded gloves'
        );
        if (!row) return 'no such row';
        return \`\${row.dataset.equipped}|\${row.querySelector('.slot')?.innerText.trim() ?? ''}\`;
      })()
    `);
    check(
      gloves === 'true|Hands',
      'and the item the fold ran through is one item, worn where the listing said',
      gloves
    );
  }

  /*
   * A name clicked on a card opens the realm's answer *beside* the name, not
   * on the rail: a slide-out that is read and put away. The quarterstaff is
   * a weapon, so the detail leads with a weapon's own numbers — that is what
   * "each kind of item gets its own card" means in practice.
   */
  {
    const opened = await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.carried tbody tr')].find(
          (li) => li.querySelector('.what')?.innerText.trim() === 'quarterstaff'
        );
        const name = row?.querySelector('button.lookup');
        if (!name) return false;
        name.click();
        return true;
      })()
    `);
    check(opened, 'a carried item is a name that can be clicked');
    await sleep(400);
    const detail = await evaluate(
      `document.querySelector('.reference-popover .reference-detail')?.innerText ?? ''`
    );
    check(
      detail.length > 0,
      'and clicking it opens the answer beside the name',
      detail.slice(0, 80)
    );
    check(
      /damage/i.test(detail) && /weapon/i.test(detail),
      'which leads with what a weapon is: its damage',
      detail.slice(0, 120)
    );
    check(
      !(await evaluate(`!!document.querySelector('.reference-card')`)) ||
        (await evaluate(`document.querySelectorAll('.reference-card').length`)) ===
          (await evaluate(`document.querySelectorAll('.rail .reference-card').length`)),
      'and no card was put on the rail to do it'
    );
    // Escape closes it, and the caret never left the game.
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await sleep(250);
    check(
      !(await evaluate(`!!document.querySelector('.reference-popover')`)),
      'and Escape puts it away'
    );
    check(
      await evaluate(`!!document.activeElement?.closest('.terminal-cell')`),
      'with the caret still in the terminal'
    );
  }

  /*
   * The console and the chrome are two surfaces, and the console printing is
   * not news in the chrome.
   *
   * Clicking `sandals` opened the realm's answer beside it, and the next line
   * the game printed took the answer away again. `ReferencePopover` dismissed
   * on any captured scroll, and a scroll listener has to be captured at the
   * window to hear a scrolling element at all — so every scroller in the
   * client arrived at that handler, the loudest of them being a pinned
   * terminal, which scrolls to the bottom on each write and fires a real DOM
   * event doing it. In a MUD that is a panel nobody can read.
   *
   * Driven from the socket rather than from a synthetic event, because the
   * whole claim is about what real output does. The positive control is at the
   * bottom: a scroll of the pack's *own* scroller still closes it, so this
   * cannot pass by nothing dismissing anything ever again.
   */
  {
    const reopen = async () => {
      const opened = await evaluate(`
        (() => {
          const row = [...document.querySelectorAll('.carried tbody tr')].find(
            (li) => li.querySelector('.what')?.innerText.trim() === 'quarterstaff'
          );
          const name = row?.querySelector('button.lookup');
          if (!name) return false;
          name.click();
          return true;
        })()
      `);
      await sleep(400);
      return opened && (await evaluate(`!!document.querySelector('.reference-popover')`));
    };
    check(await reopen(), 'the answer opens again for the two-surface check');

    // Counted at the window in capture, which is where the app listens and the
    // only place a scrolling element reports at all.
    await evaluate(`
      (() => {
        window.__scrolls = 0;
        window.__countScroll = () => { window.__scrolls += 1; };
        window.addEventListener('scroll', window.__countScroll, true);
        return true;
      })()
    `);
    const heightBefore = await evaluate(
      `document.querySelector('.xterm-viewport')?.scrollHeight ?? -1`
    );
    liveSockets[0]?.write(
      Buffer.from(
        Array.from(
          { length: 8 },
          (_, i) => `\x1b[0;37mThe torchlight flickers. (two-surface ${i})\x1b[0m\r\n`
        ).join(''),
        'latin1'
      )
    );
    await sleep(500);
    const scrolls = await evaluate(`window.__scrolls`);
    check(
      scrolls > 0,
      'output from the game scrolls the console, which is what used to close it',
      // Whether the lines even painted, apart from whether anything scrolled:
      // a viewport that never grew never had a reason to.
      `scrolls=${scrolls} sockets=${liveSockets.length} viewport=${heightBefore}->${await evaluate(
        `document.querySelector('.xterm-viewport')?.scrollHeight ?? -1`
      )}`
    );
    check(
      await evaluate(`!!document.querySelector('.reference-popover')`),
      'and the answer beside the item is still there afterwards'
    );
    check(
      await evaluate(`!!document.activeElement?.closest('.terminal-cell')`),
      'with the caret still in the terminal, which never went anywhere'
    );

    /*
     * The positive control. A scroll of the list the name sits in *does* move
     * the name, so it does close the panel — without this, the checks above
     * would pass just as well if the panel had stopped dismissing entirely.
     */
    const moved = await evaluate(`
      (() => {
        const scroller = document.querySelector('.inventory-card .scroller');
        if (!scroller) return false;
        scroller.dispatchEvent(new Event('scroll'));
        return true;
      })()
    `);
    check(moved, 'the pack has a scroller of its own to move the row with');
    await sleep(250);
    check(
      !(await evaluate(`!!document.querySelector('.reference-popover')`)),
      'and scrolling that does put the answer away, because the name moved'
    );
    await evaluate(`(window.removeEventListener('scroll', window.__countScroll, true), true)`);
  }

  /*
   * Every card's controls live down its right edge: close at the top, the
   * settings gear directly under it, the pin where the card has one, then
   * copy and whatever the card itself offers. The button is enough here: the
   * clipboard is written in main.
   */
  check(
    await evaluate(
      `[...document.querySelectorAll('.rail .card')].every((c) =>
        !!c.querySelector('.card-side .card-close') &&
        !!c.querySelector('.card-side .card-action[data-action="settings"]') &&
        !!c.querySelector('.card-side .card-action[aria-label="Copy this card"]'))`
    ),
    'every card on the rail has close, settings and copy in its action column'
  );

  /*
   * And the order is the same on every card, so a control is learned once.
   * Read off the buttons as laid out rather than off the array that built
   * them: the fold below can only be judged against what is actually drawn.
   */
  check(
    await evaluate(
      `[...document.querySelectorAll('.rail .card')].every((c) => {
        const ids = [...c.querySelectorAll('.card-side .card-action')]
          .map((b) => b.getAttribute('data-action'))
          .filter((id) => ['close', 'settings', 'pin', 'copy'].includes(id));
        const wanted = ['close', 'settings', 'pin', 'copy'].filter((id) => ids.includes(id));
        return ids.join(',') === wanted.join(',');
      })`
    ),
    'and they are in one order on every card: close, settings, pin, copy'
  );

  /*
   * **Nothing folds while it fits.** The count that used to decide this was
   * five, so a card with room for nine hid four behind a kebab — a control
   * that is not there at the moment it is reached for. It is measured now, and
   * a rail card is far taller than its handful of glyphs.
   *
   * The positive control matters more than the assertion: a column that failed
   * to render at all would satisfy "no kebab" perfectly, so the same pass
   * counts the glyphs that *are* drawn.
   */
  const columns = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.rail .card')].map((c) => ({
      drawn: c.querySelectorAll('.card-side .card-action').length,
      folded: !!c.querySelector('.card-side .card-action[data-action="more"]')
    })))`
  );
  const sides = JSON.parse(String(columns ?? '[]'));
  check(
    sides.length > 0 && sides.every((side) => side.drawn >= 3 && !side.folded),
    'and no card folds its column into a kebab while its glyphs fit',
    JSON.stringify(sides)
  );

  /*
   * What a card is set to, opened from its own gear.
   *
   * The palettes offered are the half of the registry that matches the client's
   * appearance — a Dracula card on a light rail is not an accent, it is a hole
   * — and the checkbox is offered only for a card that can be empty. Both are
   * asserted on the Combat card, which is one of the five that can.
   */
  {
    await evaluate(
      `(document.querySelector('.combat-card .card-action[data-action="settings"]')?.click(), true)`
    );
    await sleep(250);
    const panel = JSON.parse(
      await evaluate(`
        (() => {
          const p = document.querySelector('.card-settings');
          if (!p) return JSON.stringify({ open: false });
          return JSON.stringify({
            open: true,
            palettes: p.querySelectorAll('.palette-pick').length,
            active: p.querySelector('.palette-pick[data-active="true"]')?.innerText.trim() ?? '',
            check: !!p.querySelector('input[type="checkbox"]')
          });
        })()
      `)
    );
    check(panel.open === true, 'the gear opens the card settings panel', JSON.stringify(panel));
    /* Eight themes of the appearance in force, plus "follow the client". */
    check(
      panel.palettes >= 7,
      'and offers a palette per theme of the mode the client is in',
      JSON.stringify(panel)
    );
    check(
      panel.active === 'Client',
      'with the client theme the one in force until somebody chooses otherwise',
      JSON.stringify(panel)
    );
    check(
      panel.check === true,
      'and the hide-while-empty switch, because Combat is a card that can be empty',
      JSON.stringify(panel)
    );

    /*
     * Choosing a palette repaints that card and no other. The whole point of a
     * per-card theme is that it is per card: a picker that wrote the root's
     * tokens would repaint the rail and nothing on screen would say why.
     */
    const painted = JSON.parse(
      await evaluate(`
        (() => {
          const picks = [...document.querySelectorAll('.card-settings .palette-pick')];
          const other = picks[2];
          if (!other) return JSON.stringify({ picked: false });
          other.click();
          return JSON.stringify({ picked: true });
        })()
      `)
    );
    check(painted.picked === true, 'a palette can be chosen from the panel');
    await sleep(250);
    const scoped = JSON.parse(
      await evaluate(`
        (() => {
          const combat = document.querySelector('.combat-card');
          const vitals = document.querySelector('.vitals-card');
          return JSON.stringify({
            worn: combat?.getAttribute('data-card-theme') ?? '',
            fill: combat ? getComputedStyle(combat).backgroundColor : '',
            others: vitals ? vitals.getAttribute('data-card-theme') : null,
            othersFill: vitals ? getComputedStyle(vitals).backgroundColor : ''
          });
        })()
      `)
    );
    check(
      scoped.worn.length > 0,
      'and the card says which palette it is wearing',
      JSON.stringify(scoped)
    );
    check(
      scoped.others === null,
      'while every other card on the rail is untouched',
      JSON.stringify(scoped)
    );
    /*
     * The fill is the check that earns its place. `--glass-fill` is *composed*
     * from `--ink-card`, and a custom property's `var()` is substituted where
     * it is declared — so a card that overrode `--ink-card` and nothing else
     * would keep the root's fill and repaint only its text. Nothing about the
     * markup says so; only the computed background does.
     */
    check(
      scoped.fill.length > 0 && scoped.fill !== scoped.othersFill,
      "and its fill is the chosen palette, not the client's",
      JSON.stringify(scoped)
    );
    await capture('smoke-card-settings.png', 'a card wearing a palette of its own');

    // Back to following the client, so the picture the rest of the run takes
    // is the client's own theme rather than whatever this check picked. The
    // gear toggles, which is the only close that works from a script: the
    // click-away listens for `pointerdown`, and `.click()` raises none.
    await evaluate(`(document.querySelector('.card-settings .palette-pick')?.click(), true)`);
    await sleep(200);
    await evaluate(
      `(document.querySelector('.combat-card .card-action[data-action="settings"]')?.click(), true)`
    );
    await sleep(150);
    check(
      !(await evaluate(`!!document.querySelector('.card-settings')`)),
      'and the gear closes the panel it opened'
    );
    check(
      !(await evaluate(`!!document.querySelector('.combat-card[data-card-theme]')`)),
      'and the card is back on the client theme, leaving nothing stored'
    );
  }

  /*
   * And what the realm says the things on the *floor* are worth.
   *
   * The same index the pack uses, asked a different question: on the floor the
   * question is "is this worth taking", so the figure is the price; in the pack
   * it is "what do I drop", so the figure there is the weight. One number each,
   * because a row carrying both answers neither at a glance.
   */
  {
    const floor = await evaluate(`
      (() => {
        const dd = document.querySelector('.room-card .floor');
        if (!dd) return 'no floor list';
        return JSON.stringify({
          text: dd.innerText.replace(/\\s+/g, ' ').trim(),
          prices: [...dd.querySelectorAll('.price')].map((p) => p.innerText.trim())
        });
      })()
    `);
    check(
      /"prices":\["5"\]/.test(floor),
      'something on the floor says what the realm says it is worth',
      floor
    );
    /*
     * And exactly one figure, not two: the realm has no price for a newbie
     * manual, and a `0` beside it would be a claim the data does not make.
     */
    check(
      /newbie manual/.test(floor) && !/"0"/.test(floor),
      'and says nothing about one it cannot place',
      floor
    );
  }

  /*
   * What the realm says each one weighs.
   *
   * The encumbrance meter above says 500 of 3,360 and could never say *what is
   * heavy*, which is the only question it is consulted for — the one that
   * decides what to drop. The realm has the answer for about 1,650 items and
   * the client already ships it, so this costs no command and no round trip to
   * the server.
   */
  {
    const weights = await evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.carried tbody tr')].map((li) => [
          li.querySelector('.what')?.innerText.trim() ?? '',
          // Empty is the same claim as absent here: the column exists for every
          // row and holds nothing for a name the realm cannot place.
          li.querySelector('.weight')?.innerText.trim() || null
        ]);
        return JSON.stringify(Object.fromEntries(rows));
      })()
    `);
    check(
      /"padded boots":"40"/.test(weights) && /"quarterstaff":"100"/.test(weights),
      'each carried item says what the realm says it weighs',
      weights.slice(0, 160)
    );
    /*
     * And absent, not zero, for a name the realm cannot place — which is most
     * of what a monster drops. A `0` would be a claim the data does not make,
     * the same rule the meter follows when no maximum has arrived.
     */
    check(
      /"a healing potion":null/.test(weights),
      'and says nothing at all about one it cannot place',
      weights.slice(0, 160)
    );
  }

  /*
   * A hundred items is not a list, it is a haystack.
   *
   * The pack is the listing on this client whose length the player least
   * controls, so it is the one that grew a find field and a row of chips for
   * what the realm says a thing *is*. All of it is exercised here through the
   * real controls, because every part of it is a claim about what somebody can
   * see: a query that narrows nothing, a chip that hides nothing, or a card
   * that quietly stays filtered are all the same failure — a card lying about
   * what is being carried.
   */
  {
    const rows = () =>
      evaluate(
        `[...document.querySelectorAll('.carried tbody tr .what')].map((w) => w.innerText.trim()).join('|')`
      );
    const before = await rows();
    check(before.split('|').length > 3, 'the pack has enough in it to need finding', before);

    // Typed into the field the way a person types into it, so the caret has to
    // be able to get there at all.
    const typed = await evaluate(`
      (() => {
        const input = document.querySelector('.inventory-card .table-find input');
        if (!input) return false;
        input.focus();
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(input, 'boots');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    check(typed, 'the pack has a find field');
    await sleep(250);
    const found = await rows();
    check(
      found === 'padded boots',
      'and typing into it leaves only what was asked for',
      found.slice(0, 120)
    );

    /*
     * And it says what it is hiding. Filters are remembered per character, so a
     * pack narrowed a fortnight ago opens narrowed — `3 of 40` and a way back
     * are what keep that from being a card that lies.
     */
    const count = await evaluate(
      `document.querySelector('.inventory-card .table-count')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`
    );
    check(/1 of \d+/.test(count), 'a narrowed table states both figures', count);

    /*
     * Escape means done, once: what was typed is cleared and the caret is back
     * in the game. Two meanings on two presses would be a mode.
     */
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await sleep(250);
    check((await rows()) === before, 'Escape gives the whole pack back');
    check((await focusPath()) === 'terminal', 'and hands the caret back to the game');

    /*
     * The chips are the realm's own item types, which cost no command: the
     * kinds come out of the shipped realm file with the weights.
     */
    const chips = await evaluate(
      `[...document.querySelectorAll('.inventory-card .table-facets .chip')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim()).join('|')`
    );
    check(/armour/i.test(chips) && /weapon/i.test(chips), 'the pack is filtered by kind', chips);

    const hid = await evaluate(`
      (() => {
        const chip = [...document.querySelectorAll('.inventory-card .table-facets .chip')].find(
          (c) => /^armour/i.test(c.innerText.trim())
        );
        if (!chip) return false;
        chip.click();
        return true;
      })()
    `);
    check(hid, 'and a kind can be put away');
    await sleep(250);
    const without = await rows();
    check(
      !without.includes('padded boots') && without.includes('quarterstaff'),
      'which hides that kind and leaves the rest',
      without.slice(0, 160)
    );
    check(
      (await focusPath()) === 'terminal',
      'and the caret never left the game to do it',
      await focusPath()
    );

    // Show all is the way back, and it clears every filter rather than the one
    // the pointer happens to be near.
    await evaluate(
      `(document.querySelector('.inventory-card .table-count button')?.click(), true)`
    );
    await sleep(250);
    check((await rows()) === before, 'and Show all puts every row back');
    check(
      (await evaluate(`!!document.querySelector('.inventory-card .table-count')`)) === false,
      'after which the card stops saying it is hiding anything'
    );

    /*
     * Sorting: the column the card is consulted for. Third click is the one
     * worth proving — a table that could only be sorted would have thrown the
     * listing's own order away with no way to ask for it back.
     */
    const sortBy = async (label) =>
      evaluate(`
        (() => {
          const th = [...document.querySelectorAll('.carried thead th')].find(
            (h) => h.innerText.trim().toLowerCase().startsWith('${label}')
          );
          if (!th) return false;
          th.querySelector('button.sort').click();
          return true;
        })()
      `);
    check(await sortBy('weight'), 'a column can be sorted by');
    await sleep(250);
    const up = await rows();
    await sortBy('weight');
    await sleep(250);
    const down = await rows();
    check(
      up !== down && down.split('|')[0] !== up.split('|')[0],
      'twice, the other way',
      `${up.slice(0, 60)} / ${down.slice(0, 60)}`
    );
    /*
     * And a weight the realm does not have sorts last whichever way the column
     * points: an absent figure is not the answer to "what is heaviest" nor to
     * "what is lightest".
     */
    check(
      up.split('|').at(-1) === 'a healing potion' && down.split('|').at(-1) === 'a healing potion',
      'with what the realm cannot place at the bottom either way',
      `${up.split('|').at(-1)} / ${down.split('|').at(-1)}`
    );
    await sortBy('weight');
    await sleep(250);
    check((await rows()) === before, 'and a third click gives the listing its own order back');

    /*
     * The equip glyph sits on its row, measured.
     *
     * Every cell is `vertical-align: baseline`, which is right for text and
     * wrong for a control: `.row-action` is an `inline-flex` around an SVG, and
     * a flex box's baseline is the bottom of its box, so aligning it to the
     * row's text baseline hung the glyph clear above the item it names. That is
     * the `.readout` baseline failure one level out, and it is measured here
     * for the same reason: nothing about the words changes when it comes back.
     *
     * Centres are compared rather than tops, because the glyph and the word are
     * deliberately different heights -- a 14px icon and a line of micro type
     * share a middle, never a top. The text is read off a range for the reason
     * the room card's check records: the `td` boxes share a top even when what
     * is drawn inside them does not.
     */
    const equipRow = JSON.parse(
      await evaluate(`
        (() => {
          const action = document.querySelector('.inventory-card .card-table td.control .row-action');
          if (!action) return JSON.stringify({ found: false });
          const row = action.closest('tr');
          const name = row.querySelector('td.wide');
          const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
          let text = null;
          let node;
          while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            if (box.height > 0) {
              text = box;
              break;
            }
          }
          if (!text) return JSON.stringify({ found: false });
          const glyph = action.getBoundingClientRect();
          return JSON.stringify({
            found: true,
            // Positive means the glyph sits lower than the word it belongs to.
            offset: Math.round((glyph.top + glyph.bottom) / 2 - (text.top + text.bottom) / 2),
            // The control must not have restored a control's box: it is one
            // line of the row's own type, not the 32px button that button.lookup
            // once left behind on every row of the pack. (No backticks here:
            // this comment is inside a template literal.)
            height: Math.round(glyph.height)
          });
        })()
      `)
    );
    check(
      equipRow.found === true,
      'the pack draws an equip control on a row it can act on',
      JSON.stringify(equipRow)
    );
    check(
      equipRow.found === true && Math.abs(equipRow.offset) <= 1,
      'and the glyph is centred on the item it belongs to, not hung off its baseline',
      JSON.stringify(equipRow)
    );
    check(
      equipRow.found === true && equipRow.height <= 20,
      'and takes the row’s own height rather than a control’s box',
      JSON.stringify(equipRow)
    );

    /*
     * And a picture of it, because spacing is the one thing no assertion here
     * catches: every check above passed while each row of the pack was a 32px
     * button with 12px of text in it.
     */
    await evaluate(`
      (() => {
        const card = document.querySelector('.inventory-card');
        if (card) card.scrollIntoView({ block: 'center' });
        return !!card;
      })()
    `);
    await sleep(250);
    await capture('smoke-inventory.png', 'the pack');
  }

  /*
   * The Self card's PACK face is the pack's own body, and has to be styled
   * as the pack: its meter was inheriting the Vitals bar, and at the old
   * height the table under the tools was nothing but a horizontal scrollbar
   * (todo 03). Three claims, each of which passed while it looked wrong.
   */
  {
    const opened = JSON.parse(
      await evaluate(`
        (() => {
          const card = document.querySelector('.rail .self-card');
          if (!card) return JSON.stringify({ found: false });
          const crumbs = Array.from(card.querySelectorAll('.crumb'));
          const pack = crumbs.find((crumb) => crumb.textContent.trim().toLowerCase() === 'pack');
          if (!pack) return JSON.stringify({ found: false, crumbs: crumbs.map((c) => c.textContent) });
          pack.click();
          return JSON.stringify({ found: true });
        })()
      `)
    );
    check(opened.found === true, 'the Self card offers its pack face', JSON.stringify(opened));
    await sleep(250);
    const face = JSON.parse(
      await evaluate(`
        (() => {
          const card = document.querySelector('.rail .self-card');
          const track = card && card.querySelector('.meter .track');
          const scroller = card && card.querySelector('.table-scroller');
          return JSON.stringify({
            track: track ? Math.round(track.getBoundingClientRect().height) : null,
            overflow: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
            room: scroller ? Math.round(scroller.clientHeight) : null,
            rows: card ? card.querySelectorAll('.card-table tbody tr').length : 0
          });
        })()
      `)
    );
    check(
      face.track !== null && face.track <= 6,
      'the Self card’s pack face draws the pack’s own meter, not the vitals bar',
      JSON.stringify(face)
    );
    check(
      face.overflow !== null && face.overflow <= 0,
      'and its table does not scroll sideways',
      JSON.stringify(face)
    );
    check(
      face.rows > 0 && face.room !== null && face.room >= 40,
      'and there is room under the tools to read the rows',
      JSON.stringify(face)
    );
    // Into view first, as the pack's own capture does: the rail scrolls, and
    // a picture of the wrong card proves nothing.
    await evaluate(`
      (() => {
        const card = document.querySelector('.rail .self-card');
        if (card) card.scrollIntoView({ block: 'center' });
        return !!card;
      })()
    `);
    await sleep(250);
    await capture('smoke-self-pack.png', 'the Self card’s pack face');
    // Back to the sheet, so whatever reads the Self card after this reads it.
    await evaluate(`
      (() => {
        const first = document.querySelector('.rail .self-card .crumb');
        if (first) first.click();
        return true;
      })()
    `);
    await sleep(150);
  }

  /*
   * Taking something off and putting it back on, which moves an item without
   * moving it anywhere — it was carried before and it is carried after.
   * Captured whole from the live realm:
   *
   *     [HP=34]:rem boo
   *     You have removed padded boots.
   *     [HP=34]:eq boo
   *     You are now wearing padded boots.
   *
   * Neither sentence names a slot. The listing above did, so the slot has to
   * come back from what was remembered rather than from a second `i`.
   */
  const bootRow = async () =>
    evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.carried tbody tr')].find(
          (li) => li.querySelector('.what')?.innerText.trim() === 'padded boots'
        );
        if (!row) return 'no such row';
        return \`\${row.dataset.equipped}|\${row.querySelector('.slot')?.innerText.trim() ?? ''}\`;
      })()
    `);

  liveSockets[0]?.write(
    Buffer.from('\x1b[0;33mYou have removed padded boots.\x1b[0m\r\n', 'latin1')
  );
  await sleep(400);
  {
    const boots = await bootRow();
    check(boots === 'false|', 'something taken off stays carried, and loses its slot', boots);
  }

  liveSockets[0]?.write(
    Buffer.from('\x1b[0;33mYou are now wearing padded boots.\x1b[0m\r\n', 'latin1')
  );
  await sleep(400);
  {
    const boots = await bootRow();
    check(boots === 'true|Feet', 'and putting it back on names the slot again, with no `i`', boots);
  }

  /*
   * And the third source. The quarterstaff was never listed in a slot and no
   * listing has taught what this realm prints for its `Worn` code, so the word
   * comes from the realm database itself — and is drawn as the realm's rather
   * than as the server's, which is the whole distinction the class carries.
   *
   * It used to read `in use` here, on the rule that only the server's own
   * words belong under that heading. The rule stands; what changed is that
   * saying nothing was not the only way to keep it (2026-08-31): a character
   * that bought and wore its first kit read `in use` on every piece, with the
   * realm file naming all four slots the whole time.
   */
  liveSockets[0]?.write(
    Buffer.from('\x1b[0;33mYou are now holding quarterstaff.\x1b[0m\r\n', 'latin1')
  );
  await sleep(400);
  {
    const staff = await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.carried tbody tr')].find(
          (li) => li.querySelector('.what')?.innerText.trim() === 'quarterstaff'
        );
        if (!row) return 'no such row';
        const slot = row.querySelector('.slot');
        const how = slot?.classList.contains('inferred') ? 'realm' : 'listed';
        return \`\${row.dataset.equipped}|\${slot?.innerText.trim() ?? ''}|\${how}\`;
      })()
    `);
    check(
      staff === 'true|Weapon Hand|realm',
      'a slot no listing has named comes from the realm file, and says so',
      staff
    );
  }

  /*
   * And putting one down takes it off the card, without an `i`.
   *
   * The listing annotates anything worn or wielded with the slot it is in and
   * the sentence reporting it put down does not, so every drop of something
   * equipped compared `quarterstaff (weapon hand)` against `quarterstaff`,
   * matched nothing, and left it on the card until the next listing — which is
   * the command the maintained list exists to make unnecessary.
   */
  liveSockets[0]?.write(Buffer.from('\x1b[0;33mYou dropped quarterstaff.\x1b[0m\r\n', 'latin1'));
  await sleep(400);
  {
    const carried = await evaluate(`document.querySelector('.inventory-card')?.innerText ?? ''`);
    check(
      !carried.includes('quarterstaff'),
      'something put down leaves the card at once, without asking again',
      carried.slice(0, 200)
    );
    check(
      carried.includes('padded helm'),
      'and the rest of the kit stays where it was',
      carried.slice(0, 200)
    );
  }

  /*
   * A shop trip, captured from the live realm where a starter shop sells and
   * buys back for nothing. Both directions move the item without an `i`:
   *
   *     [HP=34]:bu quar
   *     You just bought quarterstaff for 0 copper farthings.
   *     [HP=34]:sell qua
   *     You sold quarterstaff for 0 copper farthings.
   */
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[0;33mYou just bought iron ration for 5 copper farthings.\x1b[0m\r\n',
      'latin1'
    )
  );
  await sleep(400);
  check(
    (await evaluate(`document.querySelector('.inventory-card')?.innerText ?? ''`)).includes(
      'iron ration'
    ),
    'something bought is carried at once',
    (await evaluate(`document.querySelector('.inventory-card')?.innerText ?? ''`)).slice(0, 160)
  );

  liveSockets[0]?.write(
    Buffer.from('\x1b[0;33mYou sold iron ration for 2 copper farthings.\x1b[0m\r\n', 'latin1')
  );
  await sleep(400);
  {
    const carried = await evaluate(`document.querySelector('.inventory-card')?.innerText ?? ''`);
    check(!carried.includes('iron ration'), 'and something sold is not', carried.slice(0, 160));
    // The shop has it, not the floor: that is the difference from a drop, and
    // getting it wrong shows an item in the room nobody there can pick up.
    const room = await evaluate(`document.querySelector('.room-card')?.innerText ?? ''`);
    check(!room.includes('iron ration'), 'nor left lying in the room', room.slice(0, 160));
  }

  // And can be put away again, which is what makes the rail a choice.
  await evaluate(`
    (() => {
      const card = document.querySelector('.inventory-card .card-close');
      if (card) card.click();
      return !!card;
    })()
  `);
  await sleep(300);
  check(
    !(await evaluate(`!!document.querySelector('.inventory-card')`)),
    'and closing it puts it away'
  );

  // Every card closes, not only the optional ones, and the way back is a
  // control at the top of the rail rather than only the palette.
  check(
    (await evaluate(
      `[...document.querySelectorAll('.rail .card')].every((c) => !!c.querySelector('.card-close'))`
    )) === true,
    'every card on the rail can be put away'
  );
  check(
    await evaluate(`!!document.querySelector('.card-picker')`),
    'and the rail offers the put-away ones back at its top'
  );
  await evaluate(`
    (() => {
      const chip = [...document.querySelectorAll('.card-picker .chip')]
        .find((c) => /Inventory/i.test(c.innerText));
      if (chip) chip.click();
      return !!chip;
    })()
  `);
  await sleep(350);
  check(await evaluate(`!!document.querySelector('.inventory-card')`), 'clicking one puts it back');
  // Leave the rail as it was found.
  await evaluate(`
    (() => {
      const card = document.querySelector('.inventory-card .card-close');
      if (card) card.click();
      return true;
    })()
  `);
  await sleep(250);
}

// ------------------------------------------------ assert: the rail rearranges
//
// A rail is one player's instrument. The order is theirs, and a card can be
// lifted off it entirely and left over the console -- which is the third of the
// three placements asked for in TODO.md, and the one that also answers "a
// conversation area floating translucent over the terminal".
//
// Driven with real pointer events rather than by calling the hook: the whole
// risk in a drag is the hit-testing, and a test that skips the pointer skips
// the only part that can be wrong.
const boxOf = async (selector) =>
  JSON.parse(
    await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'null';
        const b = el.getBoundingClientRect();
        return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2,
                                top: b.top, bottom: b.bottom, left: b.left, right: b.right,
                                width: b.width, height: b.height });
      })()
    `)
  );

/** A press, a few moves so the gesture passes the slop threshold, and a release. */
const drag = async (from, to) => {
  await cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(from.x),
    y: Math.round(from.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse'
  });
  for (let step = 1; step <= 6; step += 1) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * step) / 6),
      y: Math.round(from.y + ((to.y - from.y) * step) / 6),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse'
    });
    await sleep(25);
  }
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(to.x),
    y: Math.round(to.y),
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse'
  });
  await sleep(350);
};

/*
 * The toolbar, which is the one card whose shipped home is a *strip*.
 *
 * Checked here rather than left to the unit tests because the failure this
 * guards against is not one a unit test can see: the tab rail shipped complete
 * and tested and then did not appear, because the layout the client actually
 * loaded put it somewhere else. A card nobody can find is a card that was
 * never built, and this one ships in a lane nothing else uses.
 *
 * The press is the other half. Every button writes one boolean into the
 * character's own YAML and the config store's poll brings it back — a round
 * trip through disk that nothing in `src/` can prove on its own, and one whose
 * failure mode (the button springs back) looks exactly like a broken control.
 */
{
  const toolbar = await evaluate(`
    (() => {
      const card = document.querySelector('.dock-above [data-card="toolbar"]');
      if (!card) return JSON.stringify({ found: false });
      const box = card.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        height: Math.round(box.height),
        keys: card.querySelectorAll('.toolbar-key:not(.toolbar-more)').length,
        picker: !!card.querySelector('.toolbar-more')
      });
    })()
  `);
  const bar = JSON.parse(toolbar);
  check(bar.found === true, 'the toolbar ships docked above the console', toolbar);
  // One icon high, whatever the strip has been dragged to: a toolbar with
  // empty space under it is not a taller toolbar.
  check(bar.height > 0 && bar.height < 80, 'and is one row high, not a card', toolbar);
  check(bar.keys > 0 && bar.picker === true, 'with buttons on it and a way to pick more', toolbar);

  /*
   * Press one and watch it stay pressed.
   *
   * **Retaliate When Attacked**, by name and never "whichever one is lit":
   * the dial is a toggle on this row too, and a check that pressed the first
   * lit button would disconnect the character every run. It is also the right
   * switch to test with — on by default within auto-combat, so the press turns something
   * *off*, which cannot be confused with a control that does nothing because
   * the value already was what it asked for.
   *
   * The words come from `locales/ui.en.yaml` (`toolbar.retaliate`); reword
   * them and this harness is updated in the same change.
   */
  const KEY = '.dock-above [data-card="toolbar"] .toolbar-key[title="Retaliate When Attacked"]';
  const litBefore = await evaluate(`
    (() => {
      const key = document.querySelector(${JSON.stringify(KEY)});
      return key ? String(key.getAttribute('aria-pressed')) : 'gone';
    })()
  `);
  check(litBefore === 'true', 'a switch the character has on is drawn lit', litBefore);
  await evaluate(`(document.querySelector(${JSON.stringify(KEY)}).click(), true)`);
  /*
   * The write goes to disk through `SettingsEditor` and comes back on the
   * config store's 500ms poll, so this is a real round trip rather than a
   * state update — which is the whole claim being checked: there is one source
   * of truth for whether this character fights on its own, and it is the
   * character's own YAML.
   */
  await sleep(2500);
  const litAfter = await evaluate(`
    (() => {
      const key = document.querySelector(${JSON.stringify(KEY)});
      return key ? String(key.getAttribute('aria-pressed')) : 'gone';
    })()
  `);
  check(litAfter === 'false', 'and pressing it turns it off and it stays off', litAfter);
  // Put it back, so nothing below this point inherits a character that has
  // stopped hitting back.
  await evaluate(`(document.querySelector(${JSON.stringify(KEY)}).click(), true)`);
  await sleep(1500);
  await capture('smoke-toolbar.png', 'the toolbar docked above the console');
}

{
  const railOrder = async () =>
    JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.rail [data-card]')].map((c) => c.dataset.card))`
      )
    );

  /*
   * Back to the top of the rail first.
   *
   * Every card in it is a fixed box now, so ten of them overflow any ordinary
   * window and the rail scrolls — and focusing the Talk card's reply box a
   * moment ago scrolled it to the bottom to reveal it, which is what it should
   * do. The cards this drags are then above the viewport, at negative
   * coordinates, and a pointer cannot reach them. A player scrolls back up; so
   * does this.
   */
  await evaluate(`(document.querySelector('.rail').scrollTop = 0, true)`);
  await sleep(150);
  const before = await railOrder();
  check(before.length >= 2, 'the rail has cards to rearrange', JSON.stringify(before));

  // Drag the second card's heading above the first. The drop indicator is drawn
  // between cards, so the assertion is on the order that results.
  /*
   * Grabbed by the grip, which is the affordance a player is given: the whole
   * heading is draggable, but its centre lands on a face crumb or a badge
   * depending on the card, and those are things you click.
   */
  const second = await boxOf(`.rail [data-card="${before[1]}"] .card-grip`);
  const first = await boxOf(`.rail [data-card="${before[0]}"]`);
  await drag(second, { x: first.x, y: first.top + 4 });

  const reordered = await railOrder();
  check(
    reordered[0] === before[1],
    'a card dragged above another takes its place',
    `${JSON.stringify(before)} -> ${JSON.stringify(reordered)}`
  );

  // And the arrangement is written down, per character -- not per client.
  const stored = await evaluate(`
    (() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith('mudengine.layout.'));
      return key ? window.localStorage.getItem(key) : '';
    })()
  `);
  check(
    typeof stored === 'string' && stored.includes(reordered[0]),
    'and the order is remembered for this character'
  );

  /*
   * Mid-drag, the rail shows the card's own shape moving and opens a gap its
   * size where it would land -- a line said where and moved nothing (todo
   * 03). Held rather than released: the gap and the ghost exist only while
   * the pointer is down, so the gesture is driven by hand here.
   */
  {
    const order = await railOrder();
    const grip = await boxOf(`.rail [data-card="${order[1]}"] .card-grip`);
    const card = await boxOf(`.rail [data-card="${order[1]}"]`);
    const top = await boxOf(`.rail [data-card="${order[0]}"]`);
    const to = { x: top.x, y: top.top + 4 };
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(grip.x),
      y: Math.round(grip.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse'
    });
    for (let step = 1; step <= 6; step += 1) {
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(grip.x + ((to.x - grip.x) * step) / 6),
        y: Math.round(grip.y + ((to.y - grip.y) * step) / 6),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse'
      });
      await sleep(25);
    }
    await sleep(120);
    const held = JSON.parse(
      await evaluate(`
        (() => {
          const slot = document.querySelector('.rail > .rail-slot');
          const ghost = document.querySelector('.drag-ghost');
          const box = (el) => el.getBoundingClientRect();
          return JSON.stringify({
            slot: slot ? Math.round(box(slot).height) : null,
            ghost: ghost ? { w: Math.round(box(ghost).width), h: Math.round(box(ghost).height) } : null
          });
        })()
      `)
    );
    check(
      held.slot !== null && Math.abs(held.slot - card.height) <= 2,
      'mid-drag, the rail opens a gap the dragged card’s own height where it would land',
      JSON.stringify({ held, card: Math.round(card.height) })
    );
    check(
      held.ghost !== null &&
        Math.abs(held.ghost.w - card.width) <= 2 &&
        Math.abs(held.ghost.h - card.height) <= 2,
      'and the ghost following the pointer is the card’s own shape',
      JSON.stringify({ held, card: { w: Math.round(card.width), h: Math.round(card.height) } })
    );
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(to.x),
      y: Math.round(to.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse'
    });
    await sleep(350);
    check(
      !(await evaluate(`!!document.querySelector('.rail > .rail-slot, .drag-ghost')`)),
      'and both go with the drop'
    );
    // Back where it was, so the checks after this read the rail they expect.
    const moved = await boxOf(`.rail [data-card="${order[1]}"] .card-grip`);
    const under = await boxOf(`.rail [data-card="${order[0]}"]`);
    await drag(moved, { x: under.x, y: under.bottom - 4 });
    check(
      (await railOrder())[1] === order[1],
      'and dragging it back below puts the rail back',
      JSON.stringify(await railOrder())
    );
  }

  /*
   * A rail card's height is the player's: the corner grip drags it, the figure
   * is kept as a fraction of the rail rather than in pixels, and a
   * double-click on the grip puts the card back at its own height.
   */
  {
    const [id] = await railOrder();
    const before = await boxOf(`.rail [data-card="${id}"]`);
    const grip = await boxOf(`.rail [data-card="${id}"] .card-resize`);
    await drag(grip, { x: grip.x, y: grip.y + 60 });
    const after = await boxOf(`.rail [data-card="${id}"]`);
    check(
      after.height - before.height >= 50 && after.height - before.height <= 70,
      'dragging a rail card’s corner grip makes it taller by what was dragged',
      `${Math.round(before.height)} -> ${Math.round(after.height)}`
    );
    const heights = JSON.parse(
      await evaluate(`
        (() => {
          const key = Object.keys(window.localStorage).find((k) => k.startsWith('mudengine.layout.'));
          const layout = key ? JSON.parse(window.localStorage.getItem(key)) : {};
          return JSON.stringify(layout.heights ?? {});
        })()
      `)
    );
    const rail = await boxOf('.rail');
    check(
      typeof heights[id] === 'number' &&
        heights[id] > 0 &&
        heights[id] <= 1 &&
        Math.abs(heights[id] * rail.height - after.height) <= 2,
      'and the height is remembered as a fraction of the rail, not in pixels',
      JSON.stringify({
        stored: heights[id],
        rail: Math.round(rail.height),
        card: Math.round(after.height)
      })
    );
    const again = await boxOf(`.rail [data-card="${id}"] .card-resize`);
    for (const clickCount of [1, 2]) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', {
          type,
          x: Math.round(again.x),
          y: Math.round(again.y),
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount,
          pointerType: 'mouse'
        });
      }
    }
    await sleep(250);
    const reset = await boxOf(`.rail [data-card="${id}"]`);
    check(
      Math.abs(reset.height - before.height) <= 2,
      'and a double-click on the grip puts the card back at its own height',
      `${Math.round(after.height)} -> ${Math.round(reset.height)} (was ${Math.round(before.height)})`
    );
  }

  // Now off the rail entirely, onto the console.
  const lifting = await railOrder();
  const handle = await boxOf(`.rail [data-card="${lifting[0]}"] .card-grip`);
  const console_ = await boxOf('.terminal-layers');
  await drag(handle, { x: console_.x, y: console_.y });

  check(
    await evaluate(`!!document.querySelector('.float-layer .float')`),
    'a card dragged onto the console floats there'
  );
  check((await railOrder()).includes(lifting[0]) === false, 'and leaves the rail');

  /*
   * The edge between the console and the rail is a handle. Dragged, the rail
   * takes the width and the console gives it up — but never below eighty
   * measured columns, and the rail never below its own minimum. Read from the
   * status rail's own `cols×rows` readout, which is the terminal's measurement.
   */
  {
    const railWidth = async () =>
      Number(
        await evaluate(`document.querySelector('.workspace > .rail').getBoundingClientRect().width`)
      );
    const columns = async () => {
      const text = await evaluate(`document.querySelector('.status-rail').textContent`);
      const m = /(\d+)\u00d7(\d+)/.exec(String(text));
      return m ? Number(m[1]) : null;
    };
    const handle = await boxOf('.splitter[data-edge="right"]');
    const before = await railWidth();
    check(handle !== null, 'the console and the rail meet at a handle');
    await drag(handle, { x: handle.x - 120, y: handle.y });
    const wider = await railWidth();
    // Up to what was dragged: the smoke window is narrow enough that the
    // console's eighty-column floor can stop the rail well short of 120px,
    // which is the floor doing its job rather than the handle failing.
    check(
      wider > before + 10 && wider <= before + 125,
      'dragging the handle widens the rail, up to what was dragged',
      `${before} -> ${wider}`
    );
    check((await columns()) >= 80, 'and the console keeps eighty columns', `${await columns()}`);
    const far = await boxOf('.splitter[data-edge="right"]');
    await drag(far, { x: 40, y: far.y });
    const cols = await columns();
    check(
      cols !== null && cols >= 80,
      'dragged past the floor, the console still has eighty columns',
      `${cols}`
    );
    check(
      (await railWidth()) <= 560,
      'and the rail stops at its own maximum',
      `${await railWidth()}`
    );
    const back = await boxOf('.splitter[data-edge="right"]');
    await drag(back, { x: back.x + 2000, y: back.y });
    check(
      (await railWidth()) >= 259,
      'dragged the other way, the rail stops at its minimum',
      `${await railWidth()}`
    );
    // Put back: a double-click on the handle is the reset, and later checks
    // measure the console against the width it started with.
    await evaluate(
      `document.querySelector('.splitter[data-edge="right"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
    );
    await sleep(400);
    check(
      Math.abs((await railWidth()) - before) < 2,
      'a double-click on the handle puts the rail back',
      `${before} -> ${await railWidth()}`
    );
  }

  /*
   * Two alphas, from one slider.
   *
   * The console has to show through the card -- that is the only reason to put
   * one there -- and the numbers on top of it have to stay legible. So the fill
   * runs 25-60% and the text 50-90%, and the text is always well ahead. A
   * single `opacity` on the card would fade both by exactly as much.
   */
  const alphas = JSON.parse(
    await evaluate(`
      (() => {
        const card = document.querySelector('.float > .card');
        if (!card) return JSON.stringify({ error: 'no float' });
        const read = (colour) => {
          const tail = colour.slice(0, colour.lastIndexOf(')'));
          const cut = Math.max(tail.lastIndexOf('/'), tail.lastIndexOf(','));
          return cut === -1 ? 1 : Number(tail.slice(cut + 1).trim());
        };
        return JSON.stringify({
          card: Number(getComputedStyle(card).opacity),
          fill: read(getComputedStyle(card).backgroundColor),
          text: Number(getComputedStyle(card.querySelector('.body')).opacity),
          blur: getComputedStyle(card).backdropFilter
        });
      })()
    `)
  );
  check(
    alphas.card === 1,
    'a floating card carries no blanket opacity of its own',
    JSON.stringify(alphas)
  );
  check(
    alphas.fill < 1,
    'the console shows through its fill even at its most solid',
    JSON.stringify(alphas)
  );
  check(
    alphas.text > alphas.fill,
    'and the readout on top of it stays well ahead of the fill',
    JSON.stringify(alphas)
  );
  /*
   * The glass language blurs what is behind a surface, and behind this one is
   * the game. An 18px blur turns the console into an unreadable smear, which
   * defeats the only reason to float a card over it.
   */
  check(
    !/blur/.test(alphas.blur ?? ''),
    'and nothing behind it is blurred, because what is behind it is the game',
    JSON.stringify(alphas)
  );

  // A standing mark that says the card can be moved -- drawn always, not only
  // on hover: an affordance you have to find by hovering is one most people
  // never find.
  check(
    (await evaluate(
      `[...document.querySelectorAll('.rail .card > header')].every((h) => !!h.querySelector('.card-grip'))`
    )) === true,
    'every draggable card wears the same grab handle'
  );
  check(
    (await evaluate(
      `Number(getComputedStyle(document.querySelector('.rail .card-grip')).opacity) > 0`
    )) === true,
    'and it is visible without hovering'
  );

  // Geometry is stored as fractions of the workspace, never pixels: users run
  // display scaling and drag windows between monitors.
  const floats = await evaluate(`
    (() => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith('mudengine.layout.'));
      const layout = key ? JSON.parse(window.localStorage.getItem(key)) : { floats: [] };
      return JSON.stringify(layout.floats ?? []);
    })()
  `);
  const parsed = JSON.parse(floats);
  check(
    parsed.length === 1 && parsed[0].x <= 1 && parsed[0].y <= 1 && parsed[0].w <= 1,
    'and its place is remembered as a fraction of the workspace, not in pixels',
    floats
  );

  // The layer must not swallow clicks meant for the game.
  check(
    (await evaluate(`getComputedStyle(document.querySelector('.float-layer')).pointerEvents`)) ===
      'none',
    'the float layer itself is inert, so the console still takes the pointer'
  );

  // Worth looking at, not only asserting: this is the one change whose whole
  // point is what it looks like over a console full of text.
  await capture('smoke-float.png', 'a card floating over the console');

  /*
   * And the third placement: docked *to* the console rather than over it.
   *
   * The one a floating card cannot give, because it does not cover the game.
   * Horizontal, because rows are cheap and columns are not.
   */
  {
    const consoleBox = await boxOf('.terminal-layers');
    const grip = await boxOf('.float > .card .card-grip');
    // The bottom edge of the console: the strip appears there mid-drag, which
    // is what gives the drop somewhere to land.
    await drag(grip, { x: consoleBox.x, y: consoleBox.bottom - 2 });
    const docked = await evaluate(`
      JSON.stringify([...document.querySelectorAll('.dock-below [data-card]')]
        .map((c) => c.dataset.card))
    `);
    check(
      JSON.parse(docked).length === 1,
      'a card dragged to the foot of the console docks below it',
      docked
    );
    check(
      !(await evaluate(`!!document.querySelector('.float-layer .float')`)),
      'and stops floating'
    );
    /* Docking is an explicit request to keep it in view, so it is exempt from
       the group toggle it is no longer part of. */
    check(
      (await evaluate(`
        (() => {
          const card = document.querySelector('.dock-below .card');
          if (!card) return 'missing';
          const box = card.getBoundingClientRect();
          return box.height > 0 && box.width > 0 ? 'shown' : 'hidden';
        })()
      `)) === 'shown',
      'and is on screen'
    );
    await capture('smoke-dock.png', 'a card docked below the console');

    // Back over the console, so the float assertions below still have a float
    // to work with -- and so the strip is seen to disappear behind it.
    const dockedGrip = await boxOf('.dock-below .card-grip');
    await drag(dockedGrip, { x: consoleBox.x, y: consoleBox.y });
    check(
      !(await evaluate(`!!document.querySelector('.dock-below')`)),
      'and the strip disappears once nothing is in it'
    );
    check(
      await evaluate(`!!document.querySelector('.float-layer .float')`),
      'and the card is floating again'
    );
  }

  // And back. A card that can only be lifted off is a card someone loses.
  const back = await boxOf('.float > .card .card-grip');
  const railBox = await boxOf('.rail');
  await drag(back, { x: railBox.x, y: railBox.top + 6 });
  check(
    (await railOrder()).includes(lifting[0]),
    'and dragging it back onto the rail docks it again'
  );
  check(
    !(await evaluate(`!!document.querySelector('.float-layer .float')`)),
    'leaving nothing floating'
  );
}

// ------------------------------------------ assert: settings without a text editor
//
// A host and a port describe a *character*, not the client, which is why they
// moved into profiles/*.yaml -- fine for somebody who edits YAML and not fine
// as the only way in. This drives the way in, and then reads the file it wrote:
// the whole point is a real file on disk, so a check that only asserts on the
// form has proven nothing.
{
  const openSettings = async () => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: ',',
      code: 'Comma',
      windowsVirtualKeyCode: 188,
      modifiers: 2
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ',',
      code: 'Comma',
      windowsVirtualKeyCode: 188,
      modifiers: 2
    });
    await sleep(450);
  };
  /**
   * Types into the field whose *label* matches, rather than into whichever
   * input happens to come first.
   *
   * A form grows fields, and every one of them shifts every position-based
   * selector below it -- silently, into a different field that also accepts
   * text. Naming the label is the only version of this that stays true.
   */
  const typeLabelled = async (label, value) =>
    evaluate(`
      (() => {
        const field = [...document.querySelectorAll('.settings-form label')]
          .find((l) => new RegExp(${JSON.stringify(label)}, 'i')
            .test((l.querySelector('span')?.innerText ?? '').trim()));
        const input = field?.querySelector('input');
        if (!input) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);

  const type = async (selector, value) => {
    await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(80);
  };
  const clickText = async (selector, text) =>
    evaluate(`
      (() => {
        const found = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((el) => el.innerText.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
        if (found) found.click();
        return !!found;
      })()
    `);

  /*
   * Findable, which is not the same as present.
   *
   * It was present all along -- twenty-sixth in the palette, called "Characters
   * and servers…" -- and could not be found, because the palette matched on
   * labels and no label contained the word somebody would type. A command
   * nobody can find is a command that does not exist.
   */
  {
    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: 2
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: 2
    });
    await sleep(300);

    /*
     * Browsing now opens to collapsed groups, so "first in the list" is a
     * claim about the *search*: the screen you go to in order to create a
     * character must be the first thing its own name finds.
     */
    await evaluate(`
      (() => {
        const el = document.querySelector('.palette input');
        if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        set.call(el, 'settings');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(250);
    const first = await evaluate(
      `document.querySelector('.palette li[role="option"]')?.innerText?.split('\\n')[0] ?? ''`
    );
    check(/settings/i.test(first), 'settings is the first match for its own name', first);

    for (const word of ['settings', 'config', 'password', 'add', 'character', 'server']) {
      await evaluate(`
        (() => {
          const input = document.querySelector('.palette input');
          const set = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          set.call(input, ${JSON.stringify(word)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(150);
      const found = await evaluate(`
        [...document.querySelectorAll('.palette li')].some((li) => /settings:/i.test(li.innerText))
      `);
      check(found === true, `searching "${word}" finds it`);
    }

    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    });
    await sleep(300);
  }

  await openSettings();
  check(await evaluate(`!!document.querySelector('.settings')`), 'settings opens on its shortcut');
  // It opens on a character rather than an empty pane, so there is something
  // to read and somewhere for the caret to be.
  check(
    (await focusPath()).startsWith('INPUT'),
    'and takes the caret, as a form must',
    await focusPath()
  );

  // The characters already on disk are listed, including the one that cannot
  // load -- the screen is where somebody can do something about that.
  const listed = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.settings-list .settings-name')].map((n) => n.innerText.trim()))`
    )
  );
  check(
    listed.includes('Smoke Character'),
    'it lists the characters on disk',
    JSON.stringify(listed)
  );

  // Make one.
  check(await clickText('.settings-list button', 'new character'), 'it offers a new character');
  await sleep(200);
  /*
   * Named by their labels, not by position. `label:nth-of-type(2)` was the
   * display name until "Copy From" appeared above it, and the run that found
   * that had typed a name into the file-name field and refused the save --
   * which reads as the form being broken rather than as the harness being
   * brittle.
   */
  await typeLabelled('file name', 'freshly');
  await typeLabelled('^name', 'Freshly Made');
  await evaluate(`
    (() => {
      const user = [...document.querySelectorAll('.settings-form label')]
        .find((l) => /username/i.test(l.querySelector('span')?.innerText ?? ''))
        ?.querySelector('input');
      const pass = [...document.querySelectorAll('.settings-form label')]
        .find((l) => /password/i.test(l.querySelector('span')?.innerText ?? ''))
        ?.querySelector('input');
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (user) { set.call(user, 'someone'); user.dispatchEvent(new Event('input', {bubbles:true})); }
      if (pass) { set.call(pass, 'smoke-password'); pass.dispatchEvent(new Event('input', {bubbles:true})); }
      return !!user && !!pass;
    })()
  `);
  /*
   * And pick the realm, rather than taking whichever one the form defaulted to.
   *
   * The form's default is the realm the client ships as its default
   * (`DEFAULT_REALM_NAME`), which is a value somebody may change; this run
   * writes a realm of its own into the home and the check below is about how
   * the file *refers* to a realm, not about which one. Reading the default was
   * how those two got confused -- the check passed for as long as the shipped
   * default happened to be absent from this home.
   */
  const picked = await evaluate(`
    (() => {
      const select = [...document.querySelectorAll('.settings-form label')]
        .find((l) => /plays on/i.test(l.querySelector('span')?.innerText ?? ''))
        ?.querySelector('select');
      if (!select) return '(no control)';
      const wanted = [...select.options].find((o) => o.value === 'Smoke Realm');
      if (!wanted) return '(not offered)';
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      set.call(select, wanted.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()
  `);
  check(picked === 'Smoke Realm', 'the realm can be chosen on the character form', picked);
  await sleep(150);
  await evaluate(`document.querySelector('.settings-actions .primary').click(), true`);
  await sleep(700);

  const problem = await evaluate(`document.querySelector('.settings-problem')?.innerText ?? ''`);
  check(problem === '', 'saving a new character is accepted', problem);

  // The point of the whole thing: a real file, that the client can load.
  const written = path.join(PROFILES_DIR, 'freshly', 'profile.yaml');
  check(fs.existsSync(written), 'and a character file appears on disk');
  const yaml = fs.existsSync(written) ? fs.readFileSync(written, 'utf8') : '';
  check(
    /server:\s*Smoke Realm/.test(yaml),
    'referring to the saved server by name, not by address',
    yaml
  );
  check(/username:\s*someone/.test(yaml), 'with the account it was given');

  /*
   * The password is written to the character's own gitignored file and nowhere
   * else -- not into the shared options file, which somebody may well paste
   * into a bug report.
   */
  check(/smoke-password/.test(yaml), 'the password is in the character file');
  check(
    !fs.readFileSync(CONFIG, 'utf8').includes('smoke-password'),
    'and not in the shared options file'
  );

  // And it is never handed back to the window that wrote it: a password in a
  // renderer can reach a devtools snapshot, a crash report or a screenshot.
  const snapshot = await evaluate(`
    window.mudengine.settingsSnapshot().then((s) => JSON.stringify(s))
  `);
  check(
    typeof snapshot === 'string' && !snapshot.includes('smoke-password'),
    'and never travels back to the window',
    typeof snapshot === 'string' ? snapshot.slice(0, 200) : String(snapshot)
  );

  /*
   * Starting a new character from one that already works.
   *
   * The second character on a realm otherwise means retyping a server, a login
   * script, four combat verbs and every threshold. What it must *not* carry is
   * the identity -- two characters under one name is not what anybody means --
   * or the password, which the screen was never told.
   */
  check(await clickText('.settings-list button', 'new character'), 'a new character to copy into');
  await sleep(250);
  {
    const copied = await evaluate(`
      (() => {
        const select = [...document.querySelectorAll('.settings-form label')]
          .find((l) => /copy from/i.test(l.querySelector('span')?.innerText ?? ''))
          ?.querySelector('select');
        if (!select) return 'no copy-from control';
        const option = [...select.options].find((o) => /smoke character/i.test(o.text));
        if (!option) return 'nothing to copy from';
        const set =
          Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        set.call(select, option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()
    `);
    check(copied === 'ok', 'a new character can be started from an existing one', copied);
    await sleep(250);

    const carried = JSON.parse(
      await evaluate(`
        (() => {
          const field = (what) =>
            [...document.querySelectorAll('.settings-form label')]
              .find((l) => new RegExp(what, 'i').test(l.querySelector('span')?.innerText ?? ''));
          const inputs = [...document.querySelectorAll('.settings-form input')];
          return JSON.stringify({
            id: inputs[0]?.value ?? '(none)',
            server: field('plays on')?.querySelector('select')?.value ?? '(none)',
            password: field('^password')?.querySelector('input')?.value ?? '(none)',
            select: field('copy from')?.querySelector('select')?.value ?? '(none)'
          });
        })()
      `)
    );
    check(carried.server === 'Smoke Realm', 'and takes where it plays with it', carried.server);
    check(carried.id === '', 'but not its name, which is what makes it a different character');
    check(carried.password === '', 'and not its password, which the screen was never told');
    // A select that snapped back to "start empty" the moment it was used would
    // read as one that had not worked.
    check(carried.select !== '', 'and the control keeps saying what it did');
  }

  // A character with nowhere to play is refused where somebody can still fix it,
  // rather than written and then reported and skipped on the next read.
  check(await clickText('.settings-list button', 'new character'), 'a second new character');
  await sleep(200);
  await typeLabelled('file name', 'nowhere');
  // Named by its label rather than taken as the first select in the form:
  // "Copy From" sits above it once there is a character to copy.
  await evaluate(`
    (() => {
      const select = [...document.querySelectorAll('.settings-form label')]
        .find((l) => /plays on/i.test(l.querySelector('span')?.innerText ?? ''))
        ?.querySelector('select');
      if (!select) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      set.call(select, '');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(200);
  await evaluate(`document.querySelector('.settings-actions .primary').click(), true`);
  await sleep(600);
  check(
    (await evaluate(`document.querySelector('.settings-problem')?.innerText ?? ''`)).length > 0,
    'a character with nowhere to play is refused, with a reason',
    await evaluate(`JSON.stringify({
      foot: document.querySelector('.settings-foot')?.innerText ?? '',
      id: document.querySelector('.settings-form input')?.value ?? '',
      select: document.querySelector('.settings-form select')?.value ?? '(none)',
      host: [...document.querySelectorAll('.settings-form label')]
        .find((l) => /host/i.test(l.querySelector('span')?.innerText ?? ''))
        ?.querySelector('input')?.value ?? '(no host field)'
    })`)
  );
  check(
    !fs.existsSync(path.join(PROFILES_DIR, 'nowhere', 'profile.yaml')),
    'and nothing is written for it'
  );

  /*
   * The panic button, and the warning that has to travel with it.
   *
   * Every MegaMUD-era client offers "disconnect at low health", and on this
   * server family it is one of the more reliable ways to die. A screen that
   * offers it without saying so is worse than one that does not offer it.
   */
  check(await clickText('.settings-list button', 'smoke character'), 'a character to look at');
  await sleep(250);
  /*
   * Running away and hanging up are in the **Health** section -- MegaMUD's own
   * tab name, which is the vocabulary somebody configuring a MajorMUD client
   * already has (docs/terminology.md §2.2). Reading either fieldset means
   * opening it first; it is not the one long scroll every field used to share.
   */
  check(await clickText('.settings-sections .crumb', 'health'), 'its Health section is reachable');
  await sleep(200);

  /*
   * One label column for the whole page, measured rather than eyeballed.
   *
   * This section is where the defect showed: three fieldsets of percentages,
   * one under the other, each drawing its fields a different width. They were
   * wrapping flex lines, and a wrapping flex container distributes each *line*
   * on its own -- so Auto-Retreat's lone threshold took half a row, Auto-Hangup's took
   * the whole of it, and Recover's fourth field wrapped to an x that nothing
   * above it shared. Every one of those is invisible to a DOM assertion about
   * *text*, which is why this one is about geometry.
   *
   * The form, every fieldset in it and every Advanced body are grids of uniform
   * columns now -- not only the `.settings-inline` groups, which is the whole
   * point of the change: a field written straight into a fieldset used to take
   * the entire row, and Spells' Attack Spell fieldset read that way while the
   * Healing fieldset under it was in columns. So every field-grid container on
   * the page is measured rather than the wrapped groups alone, and the check is
   * that every field starts at one of a small set of column positions and that
   * fields sharing a column share a width. Sub-pixel rounding is real -- a 1fr
   * track divided three ways does not land on whole pixels -- so positions are
   * compared to the nearest pixel.
   *
   * A checkbox row and a `wide` field are excluded because both say out loud
   * that they take the row: a checkbox's label is a sentence, and `wide` is
   * what a monster list or a path states about its own value.
   */
  const columns = JSON.parse(
    await evaluate(`
      JSON.stringify(
        [...document.querySelectorAll(
          '.settings-form, .settings-menus, .settings-inline, .settings-advanced-body'
        )].map((group) => {
          const rows = [...group.querySelectorAll(
            ':scope > .settings-field:not(.settings-check):not(.settings-field-wide)'
          )];
          // \s in a template literal is s, so the class is read off classList
          // rather than split out of a string with a regex that is not one.
          const container = [
            'settings-form', 'settings-menus', 'settings-inline', 'settings-advanced-body'
          ].find((name) => group.classList.contains(name));
          return rows.map((row) => {
            const box = row.getBoundingClientRect();
            const control = row.querySelector('input, select');
            const span = row.querySelector(':scope > span');
            const mark = row.querySelector('.hint-mark');
            return {
              label: span?.innerText.trim() ?? '',
              left: Math.round(box.left),
              width: Math.round(box.width),
              top: Math.round(box.top),
              spanH: span === null ? null : Math.round(span.getBoundingClientRect().height),
              lines: span === null ? 0 : span.getClientRects().length,
              markH: mark === null ? null : Math.round(mark.getBoundingClientRect().height),
              // Where the thing somebody types into actually starts.
              control: control === null ? null : Math.round(control.getBoundingClientRect().top),
              // Which kind of container laid it out -- see the loose-field check.
              container
            };
          });
        }).filter((group) => group.length > 0)
      )
    `)
  );
  const fields = columns.flat();
  check(fields.length > 0, 'the Health page draws its fields in columns', String(fields.length));
  const widths = [...new Set(fields.map((f) => f.width))];
  check(
    widths.length === 1,
    'every grouped field is one column wide, whatever group it is in',
    JSON.stringify(widths)
  );
  /*
   * And a group of one is not a group of one stretched: `auto-fill` keeps the
   * empty tracks precisely so Auto-Hangup's single threshold is the same width as
   * Recover's four. `auto-fit` would collapse them and put the defect back,
   * which is a one-word change nothing else here would catch.
   */
  const lefts = [...new Set(fields.map((f) => f.left))].sort((a, b) => a - b);
  check(
    fields.every((f) => f.left === lefts[0] || lefts.includes(f.left)),
    'and starts at a shared column position, not at one its own group invented',
    JSON.stringify(lefts)
  );
  const single = columns.find((group) => group.length === 1);
  check(
    single === undefined || single[0].left === lefts[0],
    'a group holding one field starts in the first column rather than filling the row',
    JSON.stringify(single ?? [])
  );
  /*
   * And a field written straight into a fieldset is one of those columns too --
   * which is the defect this page was reported for. Auto-Potion's verb and
   * Auto-Retreat's strategy are plain fields in a fieldset with no group around
   * them, so if `.settings-menus` ever stops being a grid they go back to full
   * width. Without this the whole measurement above would still pass, because
   * every remaining `.settings-inline` group would be as uniform as ever.
   */
  const loose = fields.filter((f) => f.container === 'settings-menus');
  check(
    loose.length > 0,
    'and a field written straight into a fieldset is a column, not a whole row',
    JSON.stringify(loose.map((f) => f.label))
  );
  /*
   * And the controls on one row start at one y.
   *
   * A field is a label above a control, so anything that makes one label taller
   * than its neighbour's pushes only that field's control down -- and a hint
   * mark is exactly that: an icon in a line of small caps. Auto-Retreat's pair had
   * one hinted field and one plain one, and the two inputs sat on different
   * lines because of it. Grouped by the row the fields landed on, since a group
   * of four wraps on a narrow dialog and row two is not row one.
   */
  const misaligned = columns
    .flatMap((group) => {
      const byRow = new Map();
      for (const field of group) {
        if (field.control === null) continue;
        byRow.set(field.top, [...(byRow.get(field.top) ?? []), field]);
      }
      return [...byRow.values()];
    })
    .filter((row) => new Set(row.map((f) => f.control)).size > 1);
  check(
    misaligned.length === 0,
    'and the controls on one row start at one y, hint mark above them or not',
    JSON.stringify(misaligned)
  );

  /* The page the misalignment was reported from, so the geometry above has a
     picture beside it. */
  await capture('smoke-settings-health.png', 'the Health page, whose fields share a column');

  const warning = await evaluate(`
    ([...document.querySelectorAll('.settings-menus')]
      .find((f) => /auto-hangup/i.test(f.querySelector('legend')?.innerText ?? ''))
      ?.innerText ?? '')
  `);
  /*
   * One sentence, in the open. The rule this screen now follows is that an
   * explanation goes behind a hint mark -- and a *warning* about something that
   * can cost a character does not, because a warning nobody sees until
   * afterwards is not a warning. So the assertion is that it still says what it
   * costs and still names the escape, not that it says it at length.
   */
  check(
    /maximum/i.test(warning) && /kills/i.test(warning),
    'the hangup setting says what it costs',
    warning.slice(0, 160)
  );
  check(/auto-retreat/i.test(warning), 'and names the escape that actually works');

  /* And that escape is on the same screen, above it: the safe option is the
     one somebody should meet first. */
  const escapes = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.settings-menus legend')]
        .map((l) => l.innerText.trim()))
    `)
  );
  check(
    escapes.some((legend) => /auto-retreat/i.test(legend)),
    'and running away is offered too',
    JSON.stringify(escapes)
  );
  check(
    escapes.findIndex((l) => /auto-retreat/i.test(l)) <
      escapes.findIndex((l) => /auto-hangup/i.test(l)),
    'and it comes first, because it is the one that works'
  );
  /*
   * And resting is above both, which is the ordering the whole section is for:
   * the thing a character does about a number *before* it becomes a decision
   * about whether to still be in the room. `automation.health`, MegaMUD's
   * "Rest if below".
   */
  check(
    escapes.findIndex((l) => /recover/i.test(l)) <
      escapes.findIndex((l) => /auto-retreat/i.test(l)),
    'with recovering above both, because it comes first in a fight going wrong',
    JSON.stringify(escapes)
  );

  /*
   * The Remotes section: whether this character answers another player's `@`
   * commands, and which ones.
   *
   * It exists because the engine shipped without it and the setting was
   * reachable only by finding `automation.remotes` in the options file -- the
   * same failure as a command nobody can find. So what is asserted is
   * *reachability*: the tab is there, the warning is in the open beside the
   * hangup one, and ticking the box reaches this character's own file rather
   * than only the options file everybody inherits.
   */
  check(
    await clickText('.settings-sections .crumb', 'remotes'),
    'its Remotes section is reachable'
  );
  await sleep(200);
  const answering = await evaluate(`
    ([...document.querySelectorAll('.settings-menus')]
      .find((f) => /answering other players/i.test(f.querySelector('legend')?.innerText ?? ''))
      ?.innerText ?? '')
  `);
  /*
   * In the open, not behind a hint mark, for the reason the hangup warning is:
   * what this switch turns on is a channel by which somebody else's typing
   * moves this character, and a warning read afterwards is not a warning.
   */
  /*
   * It used to assert the warning said *everyone* is answered, which was true
   * until the gate was built: the switch now says "be reachable" and the lists
   * say by whom and for what, and a warning still claiming the old behaviour
   * would be the screen describing a client that no longer exists.
   */
  check(
    /answers nobody/i.test(answering) && /granted/i.test(answering),
    'the remotes setting says in the open that the switch alone answers nobody',
    answering.slice(0, 200)
  );
  check(
    /@kill/i.test(answering) && /refused/i.test(answering),
    'and names what it will never do whatever the switch says'
  );

  check(
    await evaluate(`
      (() => {
        const box = [...document.querySelectorAll('.settings-check')]
          .find((l) => /enable remote control/i.test(l.innerText));
        const input = box?.querySelector('input');
        if (!input || input.checked) return false;
        input.click();
        return true;
      })()
    `),
    'answering can be switched on'
  );
  // The form saves itself, so the assertion is on the file rather than a click.
  await sleep(900);
  const answersInFile = await (async () => {
    const file = path.join(PROFILES_DIR, 'smoke', 'profile.yaml');
    if (!fs.existsSync(file)) return '(no profile file)';
    return fs.readFileSync(file, 'utf8');
  })();
  check(
    /remotes:\s*\n\s*enabled: true/.test(answersInFile),
    'and it reaches this character’s own file, not only the options file',
    (answersInFile.match(/remotes:[\s\S]{0,40}/)?.[0] ?? '(no remotes block)').replace(/\n/g, ' | ')
  );

  /*
   * And the grid that arrived with the per-command gate: fifty-seven rows, of
   * which only the ones this client can answer are settable. What is asserted
   * is that *Allow all* reaches the file -- the button exists because granting
   * twenty remotes one click at a time is a control nobody uses, and a bulk
   * action that silently wrote nothing would be indistinguishable from one that
   * worked.
   */
  await sleep(400);
  check(
    await evaluate(`
      (() => {
        const list = document.querySelector('.remote-list[data-mode="gang"]');
        if (!list) return false;
        const rows = list.querySelectorAll('.remote-rows > li').length;
        return rows > 40;
      })()
    `),
    'the gang grid lists the whole @ vocabulary, not only the answerable part'
  );
  check(
    await evaluate(`
      (() => {
        const list = document.querySelector('.remote-list[data-mode="gang"]');
        const button = [...(list?.querySelectorAll('.remote-list-bulk button') ?? [])]
          .find((b) => /allow all/i.test(b.innerText));
        if (!button) return false;
        button.click();
        return true;
      })()
    `),
    'and “Allow all” is one click'
  );
  await sleep(900);
  const grantedInFile = fs.existsSync(path.join(PROFILES_DIR, 'smoke', 'profile.yaml'))
    ? fs.readFileSync(path.join(PROFILES_DIR, 'smoke', 'profile.yaml'), 'utf8')
    : '(no profile file)';
  check(
    /gang:[\s\S]{0,400}- health/.test(grantedInFile),
    'which reaches the file as a written-out list rather than a wildcard',
    (grantedInFile.match(/gang:[\s\S]{0,80}/)?.[0] ?? '(no gang list)').replace(/\n/g, ' | ')
  );

  /*
   * Auto-combat, which is the one section of this form that makes the client
   * *start* something rather than stop it.
   *
   * A section exists when there is a typed config block behind it, and this one
   * is `automation.combat` -- attack *rules* are still `automation.rules`, and
   * a form field for one would be a second representation of what the YAML
   * already says. What is asserted here is that somebody can find it and that
   * it says what it will and will not do, because the refusals are the part
   * nobody would guess: never a player, at any setting.
   */
  check(await clickText('.settings-sections .crumb', 'combat'), 'its Combat section is reachable');
  await sleep(200);
  const fighting = await evaluate(`
    ([...document.querySelectorAll('.settings-menus')]
      .find((f) => /^attack$/i.test((f.querySelector('legend')?.innerText ?? '').trim()))
      ?.innerText ?? '')
  `);
  check(
    /never on a player/i.test(fighting),
    'the combat setting says it will never attack a player',
    fighting.slice(0, 200)
  );

  /*
   * Switching it on reveals what it swings with -- the realm's own verbs. They
   * are hidden until then on purpose: a field for an attack verb means nothing
   * to somebody who has not turned this on, and the section would open on three
   * boxes of vocabulary before saying what any of it is for.
   */
  check(
    await evaluate(`
      (() => {
        const box = [...document.querySelectorAll('.settings-check')]
          .find((l) => /auto-attack/i.test(l.innerText));
        const input = box?.querySelector('input');
        if (!input || input.checked) return false;
        input.click();
        return true;
      })()
    `),
    'auto-combat can be switched on'
  );
  await sleep(200);
  const verbs = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.settings-menus legend')]
        .map((l) => l.innerText.trim()))
    `)
  );
  check(
    verbs.some((legend) => /^attacks$/i.test(legend)),
    'and switching it on offers what to swing with',
    JSON.stringify(verbs)
  );
  check(
    verbs.some((legend) => /^monsters$/i.test(legend)),
    'and which monsters to leave alone'
  );
  // Switched back off, so the smoke character's file is left as it was found:
  // this run does not save, but a later assertion reads the same form.
  await evaluate(`
    (() => {
      const box = [...document.querySelectorAll('.settings-check')]
        .find((l) => /auto-attack/i.test(l.innerText));
      const input = box?.querySelector('input');
      if (input?.checked) input.click();
      return true;
    })()
  `);
  await sleep(150);

  /*
   * The loops a character walks, in the Movement section.
   *
   * The client ships 420 of MegaMUD's own in resources/loops/megamud.yaml, and
   * until this existed the only way to use one was to open that file, find a
   * loop among four hundred, and paste it into a character by hand. That is
   * the same failure as a command nobody can find: the feature was there and
   * was reachable only by somebody who already knew it was.
   *
   * So what is asserted here is the whole gesture -- the shelf opens, it is
   * full, a search narrows it, a click puts a loop on this character and
   * another takes it off -- because every one of those is a step where a
   * feature stops being reachable.
   */
  check(
    await clickText('.settings-sections .crumb', 'movement'),
    'its Movement section is reachable'
  );
  await sleep(200);
  {
    const legends = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.settings-menus legend')].map((l) => l.innerText.trim()))`
      )
    );
    check(
      legends.some((legend) => /^loops$/i.test(legend)),
      'the Movement section offers this character’s loops',
      JSON.stringify(legends)
    );

    /* The character's own list first: it states one in its profile, and a form
       that did not show it would write over it on the next save. */
    const listed = () =>
      evaluate(
        `JSON.stringify([...document.querySelectorAll('.settings-loops .loop-name')].map((n) => n.innerText.trim()))`
      ).then(JSON.parse);
    const already = await listed();
    check(
      already.some((name) => /smoke loop/i.test(name)),
      'and shows the loop this character already walks',
      JSON.stringify(already)
    );

    check(await clickText('.settings-menus button', 'add a loop'), 'the shelf can be opened');
    // The catalogue crosses IPC on the first open; four hundred loops out of
    // a file, so it is not instant.
    await sleep(600);

    const shelved = await evaluate(`document.querySelectorAll('.loop-options li').length`);
    check(shelved > 400, 'and it is full of the loops the client ships', `${shelved} on the shelf`);

    // Narrowing it: the names are `Area: Room-map room`, so a word from either
    // half finds a run of them.
    await type('.loop-search input', 'sewer');
    await sleep(150);
    const narrowed = await evaluate(`document.querySelectorAll('.loop-options li').length`);
    check(narrowed > 0 && narrowed < shelved, 'and typing narrows it', `${narrowed} match "sewer"`);

    const firstMatch = await evaluate(
      `document.querySelector('.loop-options .loop-name')?.innerText.trim() ?? ''`
    );
    await evaluate(`document.querySelector('.loop-options button').click(), true`);
    await sleep(200);

    const chosen = await listed();
    check(
      chosen.includes(firstMatch) && chosen.length === already.length + 1,
      'clicking one puts it on this character, beside what it already walks',
      `${firstMatch} -> ${JSON.stringify(chosen)}`
    );
    /* A shelf row that is already on this character says so, in the same place
       and the same way for every row -- otherwise "is this one on?" is a
       question you answer by scrolling somewhere else. */
    check(
      await evaluate(`document.querySelector('.loop-options button')?.dataset.taken === 'true'`),
      'and the shelf row says it is taken'
    );

    // The same gesture takes it off, which is why a row toggles rather than
    // adds: choosing one already on cannot quietly add a second under one name.
    await evaluate(`document.querySelector('.loop-options button').click(), true`);
    await sleep(200);
    check(
      JSON.stringify(await listed()) === JSON.stringify(already),
      'and clicking it again takes it back off, leaving the rest alone'
    );

    // Put it on again and take it off from the character's own list this time
    // -- the two removals are different controls and both have to work.
    await evaluate(`document.querySelector('.loop-options button').click(), true`);
    await sleep(150);
    check((await listed()).length === already.length + 1, 'a loop goes back on');
    await evaluate(
      `[...document.querySelectorAll('.settings-loops li button')].at(-1).click(), true`
    );
    await sleep(150);
    check(
      JSON.stringify(await listed()) === JSON.stringify(already),
      'and the × on its own row takes it off too, and only it',
      JSON.stringify(await listed())
    );

    check(await clickText('.loop-picker button', 'done'), 'the shelf puts itself away');
    await sleep(150);
    check(await evaluate(`!document.querySelector('.loop-picker')`), 'and it is gone');
  }

  // The realm database, which is what makes a character on a derivative able to
  // route at all -- back in Profile, where "Realm data" lives.
  check(await clickText('.settings-sections .crumb', 'character'), 'back to Character');
  /*
   * The menus on the way in, as a list rather than four named fields.
   *
   * MajorMUD, GreaterMUD, Paradigm and Shift all have different menu systems,
   * and MajorMUD behind WorldGroup can put any amount of custom ANSI and any
   * number of menus in between -- so `selection`, `realm`, `character` and
   * `enterRealm` were one realm's layout written into the client's vocabulary.
   *
   * On the *realm*, because that is what it belongs to: every character on one
   * realm meets the same menus, and a script stored per character is the same
   * answer written out four times with four places to drift.
   */
  {
    check(await clickText('.settings-head .crumb', 'realms'), 'the Realms page is reachable');
    await sleep(300);

    const legends = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.settings-menus legend')].map((l) => l.innerText.trim()))`
      )
    );
    check(
      legends.some((legend) => /menus/i.test(legend)),
      'a realm says how to get through its menus',
      JSON.stringify(legends)
    );

    const rowsNow = () => evaluate(`document.querySelectorAll('.settings-steps li').length`);
    const before = await rowsNow();

    // The `+`: as many rows as a realm asks for.
    check(
      await evaluate(`
        (() => {
          const add = [...document.querySelectorAll('.settings-menus button')]
            .find((b) => /add a menu/i.test(b.innerText));
          if (!add) return false;
          add.click();
          return true;
        })()
      `),
      'and offers a + to add another'
    );
    await sleep(250);
    const after = await rowsNow();
    check(after === before + 1, 'which adds a row', `${before} -> ${after}`);

    // Two fields per row -- when this arrives, send that -- and nothing else.
    // Enter is always sent, so a blank answer is a bare Enter.
    check(
      await evaluate(`
        (() => {
          const row = document.querySelector('.settings-steps li');
          return row ? row.querySelectorAll('input').length === 2 : false;
        })()
      `),
      'each row is a prompt and the answer to it'
    );

    // And taken away again, so this leaves the form as it found it.
    check(
      await evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('.settings-steps li')];
          const last = rows[rows.length - 1];
          const remove = last?.querySelector('button');
          if (!remove) return false;
          remove.click();
          return true;
        })()
      `),
      'and a row can be removed'
    );
    await sleep(250);
    check((await rowsNow()) === before, 'leaving the script as it was');

    /*
     * The loops that belong to the *place*.
     *
     * A loop names rooms in a realm, so it is a fact about where you are
     * playing rather than about who is walking it -- and one recorded here is
     * walked by every character that plays there without any of them stating
     * anything.
     */
    const serverLegends = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.settings-menus legend')].map((l) => l.innerText.trim()))`
      )
    );
    check(
      serverLegends.some((legend) => /^loops$/i.test(legend)),
      'and offers the loops every character playing there walks',
      JSON.stringify(serverLegends)
    );

    /*
     * And the map every character playing here walks.
     *
     * On the realm rather than on the character: two characters on one realm
     * cannot be walking two different maps, and stated per character it was the
     * same answer written out once each with as many places to drift -- a third
     * character added later silently got the shipped world instead. It was on
     * the character's own page until 2026-08-30, which is where this check used
     * to be.
     */
    check(
      await evaluate(`!!document.querySelector('.settings-file input')`),
      'a realm can be pointed at its own world database'
    );

    check(await clickText('.settings-head .crumb', 'characters'), 'back to the characters');
    await sleep(250);
  }

  await sleep(200);
  check(
    !(await evaluate(`!!document.querySelector('.settings-file input')`)),
    'and a character no longer states one of its own'
  );

  /*
   * Alerts, which is a section for a config block that had none.
   *
   * `ui.alerts` was added and the form did not expose it, which is the exact
   * trap the template rule exists for: a setting nobody can see is a setting
   * nobody uses, and it is how automatic login shipped, was verified, and still
   * appeared completely broken.
   */
  /*
   * The one sentence, and that it is *reachable*.
   *
   * The screen used to explain itself in prose beside every field — all true,
   * and four sentences between somebody and the number they came to change.
   * The explanation moved behind a mark; a mark nobody can open is worse than
   * the prose was, so what is asserted is that clicking one shows a sentence
   * and that the field it belongs to points at it.
   */
  // Click, *then* read, on two calls: reading in the same expression as the
  // click reads the DOM React has not re-rendered yet. Second time this has
  // been the difference between a check and a check that asserts the opposite.
  await evaluate(`
    (() => {
      const mark = document.querySelector('.settings-form .hint-button');
      if (mark) mark.click();
      return !!mark;
    })()
  `);
  await sleep(200);
  const hinted = await evaluate(`
    (() => {
      const bubble = document.querySelector('.settings-form .hint-bubble:not([hidden])');
      if (!bubble) return 'nothing opened';
      const described =
        document.querySelector('.settings-form [aria-describedby="' + bubble.id + '"]');
      return JSON.stringify({ text: bubble.innerText.trim().slice(0, 40), tied: !!described });
    })()
  `);
  check(
    /"tied":true/.test(hinted) && /"text":"[^"]{10,}/.test(hinted),
    'a hint opens one sentence, tied to the field it explains',
    hinted
  );
  check(
    Number(await evaluate(`document.querySelectorAll('.settings-form em.hint').length`)) === 0,
    'and no field explains itself in prose beside the value any more'
  );

  check(await clickText('.settings-sections .crumb', 'alerts'), 'its Alerts section is reachable');
  await sleep(200);
  const alerting = await evaluate(`
    (() => {
      const box = [...document.querySelectorAll('.settings-menus')]
        .find((f) => /^alerts$/i.test((f.querySelector('legend')?.innerText ?? '').trim()));
      if (!box) return 'no alerts fieldset';
      return JSON.stringify({
        keep: box.querySelector('select')?.value ?? null,
        channels: [...box.querySelectorAll('.settings-checks .settings-check')].length
      });
    })()
  `);
  check(
    /"keep":"info"/.test(alerting) && /"channels":1[01]/.test(alerting),
    'and offers a floor and the channels to mute, rather than a box to spell one into',
    alerting
  );
  check(await clickText('.settings-sections .crumb', 'character'), 'and back to Character');
  await sleep(200);

  /*
   * The client's own settings, and the defaults a new realm or character
   * starts from -- two pages over one file.
   *
   * They exist because every setting in the options file used to be reachable
   * only by finding the file and reading the comments in it, and they are two
   * rather than one because "make the console bigger" and "stop every new
   * character resting at 60%" are not the same question. Driven end to end
   * rather than unit-tested alone: what matters is that a number typed here
   * reaches the YAML on disk, which is the path a form can quietly not have.
   */
  {
    check(await clickText('.settings-head .crumb', 'mudengine'), 'the MudEngine page is reachable');
    await sleep(300);

    const sections = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.settings-sections .crumb')].map((c) => c.innerText.trim()))`
      )
    );
    /*
     * Only what the client itself is: nothing here belongs to a realm or to a
     * character, which is the whole reason the page was split in two.
     *
     * There is no Accounts section: every character carries its own username
     * and password inline, on its own page -- there is no shared credential
     * store for a MudEngine-level page to hold.
     */
    check(
      sections.some((name) => /appearance/i.test(name)) &&
        sections.some((name) => /records/i.test(name)) &&
        !sections.some((name) => /accounts|combat|realm|character/i.test(name)),
      'and holds the client itself, and nothing about a realm or a character',
      JSON.stringify(sections)
    );

    /*
     * The settings most people should never have to see, behind one press.
     * `cp437` is the example that made the case: the right answer for every
     * realm this client speaks to, and impossible to choose well without
     * already knowing what it is.
     */
    check(
      await evaluate(`!!document.querySelector('.settings-advanced')`),
      'an Advanced disclosure holds what has a right answer already'
    );
    check(
      await evaluate(`!document.querySelector('.settings-advanced-body')`),
      'and it is closed until it is asked for'
    );
    check(
      (await evaluate(`document.querySelector('.settings-advanced-toggle').click(), true`)) &&
        (await sleep(200), await evaluate(`!!document.querySelector('.settings-advanced-body')`)),
      'and opens on a press'
    );

    // A number that reaches the file. The console font size, because it is on
    // the first section and its effect is visible in the client afterwards.
    await evaluate(`
      (() => {
        const label = [...document.querySelectorAll('.settings-form label')]
          .find((l) => /size, px/i.test(l.innerText));
        const input = label?.querySelector('input');
        if (!input) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(input, '17');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    /*
     * No click: the Save button is gone, and what replaced it is the point.
     * A change is written on its own after the debounce -- the one thing on
     * this screen that could be forgotten, and forgetting it was silent.
     */
    await sleep(1600);

    const written = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '';
    check(
      /size: 17/.test(written),
      'a change made here saves itself into the options file, with no Save button'
    );
    check(
      /saved/i.test(await evaluate(`document.querySelector('.settings-saving')?.innerText ?? ''`)),
      'and the form says so, since there is no click to tie it to'
    );
    // The user's own file, patched rather than replaced: the comments in it are
    // the documentation, and there is only one of these.
    // Patched, never replaced: this file is the annotated template somebody
    // has been editing since first run, and there is only one of these.
    check(
      /scrollback: 12345/.test(written) && /host: 127\.0\.0\.1/.test(written),
      'and the rest of the file is left as it was'
    );

    /*
     * The other half of the same file: what a new realm and a new character
     * start from.
     *
     * Its own page because it answers a different question, and the check is
     * that it says so -- a page of starting values that does not tell you they
     * are starting values reads as a second, contradictory set of live
     * settings.
     */
    check(await clickText('.settings-head .crumb', 'global'), 'the Global page is reachable');
    await sleep(300);

    const defaults = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.settings-sections .crumb')].map((c) => c.innerText.trim()))`
      )
    );
    /*
     * `Character` is deliberately absent: the world database was the only
     * thing on it, and a map is a fact about a realm rather than about a
     * character, so the section went with the field (2026-08-30). A heading
     * with nothing under it is a control that does nothing.
     */
    check(
      defaults.some((name) => /realm/i.test(name)) &&
        !defaults.some((name) => /^character$/i.test(name)) &&
        defaults.some((name) => /combat/i.test(name)),
      'and offers what a new realm and a new character start with',
      JSON.stringify(defaults)
    );
    check(
      /starting values/i.test(
        await evaluate(`document.querySelector('.settings-form .settings-note')?.innerText ?? ''`)
      ),
      'and says outright that they are starting values, copied when you make one'
    );

    // Worth looking at while it is open: this page and the character form are
    // the two halves of the same vocabulary, and a screenshot of each is how a
    // wording that drifted between them gets noticed.
    await capture('smoke-defaults.png', 'the Global page');

    check(await clickText('.settings-head .crumb', 'characters'), 'back to the characters again');
    await sleep(250);
  }

  // Worth looking at while it is open, rather than after it has closed.
  await capture('smoke-settings.png', 'the settings screen');

  /*
   * Editing a character must not lose its password.
   *
   * The screen is never told what the password is, so a blank field means "I
   * did not touch this" — and getting that wrong would silently lock a
   * character out of its account, with a login that stops working as the only
   * sign. Driven through the real form rather than the editor, because the
   * risk is the form deciding to send a blank.
   */
  {
    const freshly = path.join(PROFILES_DIR, 'freshly', 'profile.yaml');
    const before = fs.existsSync(freshly) ? fs.readFileSync(freshly, 'utf8') : '';
    check(/smoke-password/.test(before), 'the character made earlier still has its password');

    check(await clickText('.settings-list button', 'freshly made'), 'reopening it');
    await sleep(300);
    // Change only the colour. Nothing else -- no Save.
    await evaluate(`
      (() => {
        const swatch = [...document.querySelectorAll('.accent-swatch')]
          .find((s) => s.dataset.accent === 'violet');
        if (swatch) swatch.click();
        return !!swatch;
      })()
    `);
    // Again with no click: editing an existing character saves itself.
    await sleep(1600);

    const after = fs.existsSync(freshly) ? fs.readFileSync(freshly, 'utf8') : '';
    check(/accent: violet/.test(after), 'the change saved itself', after.slice(0, 160));
    check(
      /smoke-password/.test(after),
      'and the password it was never shown is still there',
      after.replace(/password:.*/g, 'password: <redacted>')
    );

    /*
     * The way back, now that there is no way to *not* save.
     *
     * Saving on its own takes away the one thing on this screen that could be
     * forgotten, and takes away with it the "close without saving" that used to
     * be how a mistake was undone. So the way back has to be a control -- and
     * it has to reach the file, or it would put the form back and leave the
     * disk holding the mistake.
     */
    const button = (label) => `
      [...document.querySelectorAll('.settings-actions button')]
        .find((b) => /${label}/i.test(b.innerText))
    `;
    check(
      await evaluate(`!${button('undo')}.disabled`),
      'there is a way back from a change that has already saved itself'
    );
    await evaluate(`(${button('undo')}.click(), true)`);
    await sleep(1600);
    const undone = fs.existsSync(freshly) ? fs.readFileSync(freshly, 'utf8') : '';
    check(
      /accent: cyan/.test(undone),
      'undo puts the form back, and the file with it',
      undone.slice(0, 160)
    );

    check(await evaluate(`!${button('redo')}.disabled`), 'and redo is offered afterwards');
    await evaluate(`(${button('redo')}.click(), true)`);
    await sleep(1600);
    check(/accent: violet/.test(fs.readFileSync(freshly, 'utf8')), 'which puts it forward again');

    // And the chord, which is what anybody actually presses. It stands down
    // inside a text field, where it is the field's own undo -- so this is
    // pressed with the caret nowhere in particular.
    await evaluate(`document.querySelector('.settings-sections .crumb').focus(), true`);
    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'z',
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
      modifiers: 2
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'z',
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
      modifiers: 2
    });
    await sleep(1600);
    check(
      /accent: cyan/.test(fs.readFileSync(freshly, 'utf8')),
      'and Ctrl/Cmd Z does the same, which is what anybody actually presses'
    );
  }

  // Escape hands the keyboard back to the game: this dialog holds the caret
  // while a character is standing somewhere.
  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await sleep(350);
  check(!(await evaluate(`!!document.querySelector('.settings')`)), 'Escape closes settings');
  check((await focusPath()) === 'terminal', 'and the keyboard goes back to the game');
}

// --------------------------------------- assert: the way in is beside the way out
//
// The settings screen was reachable by a chord and by a palette entry, and the
// first person to look for it found neither. The rail is where somebody already
// is when they want to add or edit a character -- their characters are in it --
// so the two ways in live there: a `+` at the head, and a menu per tab.
{
  check(
    await evaluate(`!!document.querySelector('.tab-rail .new-character')`),
    'the rail carries a button for making a character'
  );

  /*
   * At the *head*, not trailing the last tab as a browser's does. A trailing
   * button moves every time a character is added or removed, and this rail
   * scrolls -- the trailing position is the one that scrolls out of sight.
   */
  check(
    await evaluate(`
      (() => {
        const rail = document.querySelector('.tab-rail');
        const plus = rail?.querySelector('.new-character');
        const tab = rail?.querySelector('.tab');
        if (!plus || !tab) return false;
        const a = plus.getBoundingClientRect();
        const b = tab.getBoundingClientRect();
        return rail.dataset.side === 'left' ? a.top < b.top : a.left < b.left;
      })()
    `),
    'ahead of the first tab, where it does not move as characters come and go'
  );

  // The kebab is gone: its two entries are a button each now. The pencil is
  // always drawn, like the card grips — an affordance you have to find by
  // hovering is one most people never find, and it is the way to a
  // character's own settings.
  check(
    await evaluate(`
      [...document.querySelectorAll('.tab-rail .tab')].every((tab) => {
        const edit = tab.querySelector('.tab-controls .edit');
        return !!edit && Number(getComputedStyle(edit).opacity) > 0;
      })
    `),
    'every tab wears its edit pencil without being hovered'
  );

  // Close is the destructive half, so it hides until the pointer is in the tab.
  check(
    await evaluate(`
      [...document.querySelectorAll('.tab-rail .tab')].every((tab) => {
        const close = tab.querySelector('.tab-controls .close');
        return !!close && Number(getComputedStyle(close).opacity) === 0;
      })
    `),
    'and hides its close button until the tab is pointed at'
  );

  /*
   * The controls line up *between* tabs: dial, bar, pencil, close is one row,
   * so the row sits at the same offset inside every tab. Measured from each
   * tab's own right edge, because that is the invariant in both orientations
   * — on the top rail a tab's width flexes with its name, and on the left
   * rail the tabs are equal-width blocks; either way the distance from the
   * tab's edge to its dial must not differ between tabs, which is exactly
   * what four absolutely-positioned `right:` offsets could quietly break.
   */
  check(
    await evaluate(`
      (() => {
        const offsets = [...document.querySelectorAll('.tab-rail .tab')].map((tab) => {
          const dial = tab.querySelector('.tab-controls .dial');
          if (!dial) return null;
          return Math.round(tab.getBoundingClientRect().right - dial.getBoundingClientRect().left);
        });
        return offsets.length > 1 && offsets.every((x) => x !== null && x === offsets[0]);
      })()
    `),
    'and the controls row sits at one offset inside every tab'
  );

  /*
   * The realm is the row's right edge, and the status sits inside it.
   *
   * Measured rather than read off the markup, for the reason the controls row
   * above is: nothing about the *words* changes when this breaks, so only
   * geometry catches it coming back. The realm is an address — the same word on
   * every tab of the same realm, which makes a column the eye runs down and
   * finds nothing in — and the status is what changes, so it belongs beside
   * that column rather than on it.
   */
  const tabEdge = await evaluate(`
      (() => {
        const tabs = [...document.querySelectorAll('.tab-rail .tab')];
        const measured = tabs
          .map((tab) => {
            const who = tab.querySelector('.who');
            const on = tab.querySelector('.who .on');
            const name = tab.querySelector('.who .name');
            if (!who || !on || !name) return null;
            const mark = tab.querySelector('.who .mark');
            return {
              // How far the realm's right edge is from the row's. Small and
              // equal across tabs is what "right-aligned" means here.
              inset: Math.round(who.getBoundingClientRect().right - on.getBoundingClientRect().right),
              // The realm starts after the name ends, and after the status
              // where there is one.
              afterName: on.getBoundingClientRect().left >= name.getBoundingClientRect().right,
              afterMark: mark === null
                ? true
                : on.getBoundingClientRect().left >= mark.getBoundingClientRect().right
            };
          })
          .filter((entry) => entry !== null);
        if (measured.length === 0) return 'no tab states a realm';
        if (!measured.every((m) => m.afterName)) return 'the realm is not past the name';
        if (!measured.every((m) => m.afterMark)) return 'the status is not inside the realm';
        if (!measured.every((m) => m.inset <= 2)) {
          return 'the realm is not on the edge: ' + JSON.stringify(measured.map((m) => m.inset));
        }
        return 'ok';
      })()
    `);
  check(
    tabEdge === 'ok',
    "the realm sits on each tab's right edge with the status inside it",
    String(tabEdge)
  );

  /*
   * Dial and hang up, from the tab that says who it is.
   *
   * Until this existed the only way back into the realm was a palette command
   * naming *the character on screen*, and the rail exists because three of four
   * characters are not on screen.
   */
  check(
    await evaluate(`
      [...document.querySelectorAll('.tab-rail .tab')].every((tab) => {
        const dial = tab.querySelector('.dial');
        return !!dial && !!dial.querySelector('svg') && Number(getComputedStyle(dial).opacity) > 0;
      })
    `),
    'every tab wears a dial button, drawn without being hovered'
  );

  // It states the *action*, not the state: the phase is already on the tab in
  // words and in colour, and a button repeating it offers no way to act.
  check(
    await evaluate(`
      (() => {
        const tab = [...document.querySelectorAll('.tab-rail .tab')]
          .find((t) => t.dataset.phase === 'connected');
        return tab?.querySelector('.dial')?.getAttribute('aria-label')?.startsWith('Disconnect') ?? false;
      })()
    `),
    'and offers to disconnect the character that is in the realm'
  );

  /*
   * The one control in the rail that carries its colour at rest. Everything
   * else on a tab reports a *condition* and is tonal; this is an action, and
   * the two actions are not interchangeable — one puts a character into the
   * realm and the other takes it out. It went in as a quiet grey glyph and was
   * missed, which for the way back into the realm is the whole feature lost.
   */
  check(
    await evaluate(`
      (() => {
        const tab = [...document.querySelectorAll('.tab-rail .tab')]
          .find((t) => t.dataset.phase === 'connected');
        const dial = tab?.querySelector('.dial');
        if (!dial) return null;
        const style = getComputedStyle(dial);
        return JSON.stringify({
          colour: style.color,
          danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim(),
          opacity: Number(style.opacity)
        });
      })()
    `).then((raw) => {
      if (raw === null) return false;
      const { colour, opacity } = JSON.parse(raw);
      // Red, and drawn at full strength rather than the pencil's half.
      const [r, g, b] = (colour.match(/\d+/g) ?? []).map(Number);
      return opacity === 1 && r > g + 40 && r > b + 40;
    }),
    'the stop button is red and drawn at full strength'
  );

  /*
   * The point of the whole thing: this character's own settings, not the
   * screen's idea of where it was left. The *second* character's pencil, so
   * "edit this one" is proven rather than "edit whichever the screen happened
   * to open on".
   */
  check(
    await evaluate(`
      (() => {
        const tab = [...document.querySelectorAll('.tab-rail .tab')]
          .find((t) => t.querySelector('.name')?.innerText === 'Second Character');
        const edit = tab?.querySelector('.edit');
        if (!edit) return false;
        edit.click();
        return true;
      })()
    `),
    'the pencil is clicked on its own tab'
  );
  await sleep(500);
  check(await evaluate(`!!document.querySelector('.settings')`), 'and opens the settings screen');
  check(
    (await evaluate(
      `document.querySelector('.settings-list button[data-active="true"] .settings-name')?.innerText?.trim()`
    )) === 'Second Character',
    'on the character whose pencil it came from'
  );

  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await sleep(350);

  // And the `+` opens an empty one rather than whichever character was last
  // edited -- which is the one thing it exists to do.
  // The gear sits left of it now, and shares the class, so this names the one
  // that makes a character rather than taking whichever comes first.
  await evaluate(
    `(document.querySelector('.tab-rail .new-character:not(.rail-settings)').click(), true)`
  );
  await sleep(500);
  check(
    await evaluate(`!!document.querySelector('.settings-list .settings-add[data-active="true"]')`),
    'the + opens settings on a blank character'
  );
  check(
    (await evaluate(`document.querySelector('.settings-form input')?.value`)) === '',
    'with nothing carried over from the character edited a moment ago'
  );

  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await sleep(350);
  check((await focusPath()) === 'terminal', 'and closing it returns to the game');
}

// ------------------------------------------------------ assert: the party
//
// The party roster is the only place another character's health is visible, and
// it costs one command rather than a second connection. For a client whose
// whole point is running several characters that makes it the most valuable
// listing on this server -- and it went unread until a probe with two accounts
// went looking for it.
{
  check(await evaluate(`!!document.querySelector('.party-card')`), 'the Party card appears');

  const members = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.party-list li')].map((li) => ({
        name: li.querySelector('.party-name')?.innerText.trim() ?? '',
        leader: li.querySelector('.party-name')?.dataset.leader ?? '',
        klass: li.querySelector('.party-class')?.innerText.trim() ?? '',
        health: li.querySelector('.party-meter.hp')?.innerText.trim() ?? '',
        level: li.querySelector('.party-meter.hp')?.dataset.level ?? '',
        mana: li.querySelector('.party-meter.mana')?.innerText.trim() ?? '',
        activity: li.querySelector('.party-activity')?.innerText.trim() ?? '',
        // The rank is the heading the row is under, not a word at the end of
        // it: the card is arranged by formation now, so the group is where the
        // fact lives.
        rank: li.closest('.party-rank-group')?.dataset.rank ?? '',
        rankHead: li.closest('.party-rank-group')?.querySelector('.party-rank-head')?.innerText.trim() ?? '',
        first: li === li.closest('.party-list')?.firstElementChild
      })))
    `)
  );
  /* A resting member used to take the whole party with it: its row matched
     nothing, two members became one, and one member is not a party. */
  check(members.length === 2, 'and lists everyone in it', JSON.stringify(members));
  check(
    members.some((m) => m.name.startsWith('Soul') && /40%/.test(m.health)),
    'with the one fact a second connection would otherwise be needed for',
    JSON.stringify(members)
  );
  check(
    members.some((m) => m.klass === 'Paladin' && m.rank === 'back' && /back/i.test(m.rankHead)),
    'and their class and where they stand, under a heading naming the rank',
    JSON.stringify(members)
  );
  /* Mana is the other half of "can they still act", and the roster is the only
     place it is visible either. */
  check(
    members.some((m) => m.name.startsWith('Soul') && /62%/.test(m.mana)),
    'and the mana a caster has left',
    JSON.stringify(members)
  );
  /* A member sitting down is one that will not answer a heal or a step. */
  check(
    members.some((m) => m.name.startsWith('Soul') && /resting/i.test(m.activity)),
    'and says who is resting, in words',
    JSON.stringify(members)
  );
  /*
   * The maximum, once Soul's client has answered `@health`. The `/40%/` check
   * above passes as a substring of this and proves nothing about the branch,
   * so the whole phrase is asserted -- and localised: `4,434`, not `4434`.
   */
  check(
    members.some((m) => m.name.startsWith('Soul') && /40% of 4,434/.test(m.health)),
    'and, once that member answered @health, the maximum beside the percentage',
    JSON.stringify(members.map((m) => m.health))
  );
  /*
   * Measured at the rail's floor, where the row is narrowest: the meter with
   * the longer value must still sit inside its row, and the value must not be
   * cut -- a `4,434` clipped to `4,4` is a wrong maximum stated confidently.
   * The card's CSS shortens with an ellipsis rather than clipping, so the
   * assertion is that at the floor nothing needs shortening at all.
   */
  {
    // A number, not a box: a missing rail reads as NaN and fails the checks by
    // name rather than throwing out of the harness.
    const railWidth = async () =>
      Number(
        await evaluate(
          `document.querySelector('.workspace > .rail')?.getBoundingClientRect().width ?? NaN`
        )
      );
    const before = await railWidth();
    const handle = await boxOf('.splitter[data-edge="right"]');
    check(handle !== null, 'the rail still meets the console at a handle');
    if (handle !== null) await drag(handle, { x: handle.x + 2000, y: handle.y });
    await sleep(300);
    const floor = await railWidth();
    // Against the floor itself (`RAIL_RANGE.min`, 260px), as the splitter block
    // does -- not against the starting width, which a drag that did nothing
    // would satisfy and leave every measurement below made on a wide rail.
    check(floor <= 262, 'the rail is at its floor for the measurement', `${before} -> ${floor}`);
    const fit = JSON.parse(
      await evaluate(`
        (() => {
          const li = [...document.querySelectorAll('.party-list li')]
            .find((el) => (el.querySelector('.party-name')?.innerText ?? '').startsWith('Soul'));
          const meters = li?.querySelector('.party-meters');
          const meter = li?.querySelector('.party-meter.hp');
          const value = li?.querySelector('.party-meter.hp .party-meter-value');
          if (!meters || !meter || !value) return 'null';
          return JSON.stringify({
            rowWidth: meters.clientWidth,
            meterWidth: meter.scrollWidth,
            meterRight: meter.getBoundingClientRect().right,
            rowRight: meters.getBoundingClientRect().right,
            valueShown: value.clientWidth,
            valueNeeds: value.scrollWidth,
            text: value.innerText
          });
        })()
      `)
    );
    check(fit !== null, 'and Soul has a health meter to measure', String(fit));
    check(
      fit !== null && fit.meterWidth <= fit.rowWidth && fit.meterRight <= fit.rowRight + 0.5,
      'the meter sits inside its row at the floor',
      JSON.stringify(fit)
    );
    check(
      fit !== null && fit.valueNeeds <= fit.valueShown,
      'and the maximum is shown whole, not shortened',
      JSON.stringify(fit)
    );
    await evaluate(
      `document.querySelector('.splitter[data-edge="right"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
    );
    await sleep(400);
    const after = await railWidth();
    check(
      Math.abs(after - before) < 2,
      'and the rail is put back for the checks that follow',
      `${before} -> ${after}`
    );
  }
  /*
   * Whoever this character follows is drawn first, however the listing came --
   * and *within its own group*, because the card is arranged by formation: a
   * back-rank leader is at the head of the Back group, not lifted out of the
   * formation the card exists to show.
   */
  check(
    members.some((m) => m.name.startsWith('Soul') && m.leader === 'true' && m.first === true),
    'and puts the head of the party at the top of its rank',
    JSON.stringify(members)
  );

  /* §6: the level is a word as well as a hue, on the card somebody decides
     whether to heal off. */
  check(
    members.some((m) => m.level === 'caution' && /low/i.test(m.health)),
    'and says in words that somebody is hurt',
    JSON.stringify(members)
  );

  // The badge reports the number somebody acts on, not the number of members.
  check(
    /together|hurt/i.test(
      await evaluate(`document.querySelector('.party-card .badge')?.innerText ?? ''`)
    ),
    'and the badge reports something actionable'
  );

  /*
   * The reason the roster matters at all: three of four characters are
   * unattended, and the one being watched is not usually the one that is dying.
   */
  const partyAlerts = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.alert-list tbody tr')].map((li) => ({
        level: li.dataset.level,
        channel: li.querySelector('.alert-channel')?.innerText ?? '',
        text: li.querySelector('.alert-text')?.innerText ?? ''
      })).filter((a) => a.channel === 'party'))
    `)
  );
  check(
    partyAlerts.some((alert) => /Soul/.test(alert.text)),
    'and somebody in the party getting hurt is worth interrupting for',
    JSON.stringify(partyAlerts)
  );
}

// ------------------------------------------------ assert: what fight this is
//
// `inCombat` was a boolean, which answers "am I fighting" and nothing else. The
// two things anybody wants under pressure are what am I hitting and what is
// hitting me, and those differ the moment a second monster joins in.
{
  check(await evaluate(`!!document.querySelector('.combat-card')`), 'the Combat card appears');

  const fight = JSON.parse(
    await evaluate(`
      (() => {
        const card = document.querySelector('.combat-card');
        if (!card) return JSON.stringify({});
        const rows = [...card.querySelectorAll('dt')].map((dt) => [
          dt.innerText.trim(),
          dt.nextElementSibling?.innerText.trim() ?? ''
        ]);
        const meter = card.querySelector('.target-meter');
        return JSON.stringify({
          rows: Object.fromEntries(rows),
          badge: card.querySelector('.badge')?.innerText ?? '',
          target: card.querySelector('.combat-name .name')?.innerText.trim() ?? '',
          provenance: card.querySelector('.combat-name .hint')?.innerText.trim() ?? '',
          meter: meter?.querySelector('.meter-label')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
          level: meter?.dataset.level ?? '',
          // The split line's own geometry, which is the only thing that proves
          // the damage overlay was actually laid over the depleted part of the
          // track rather than merely rendered somewhere.
          line: card.querySelector('.damage-line')?.getAttribute('style') ?? '',
          mine: card.querySelector('.damage-key.mine')?.innerText.trim() ?? '',
          others: card.querySelector('.damage-key.others')?.innerText.trim() ?? ''
        });
      })()
    `)
  );
  check(/orc rogue/.test(fight.target ?? ''), 'and names what is being hit', JSON.stringify(fight));

  /*
   * The bar, drawn against the *shipped world data*.
   *
   * The server never states a monster's health — not in a status line, not on a
   * hit, not on a death — so this number can only have come from the monster
   * index in `resources/world/rooms.jsonl.gz`. An orc rogue has 30 there and the
   * fixture hits it for 12, so `18/30` is the whole path in one assertion:
   * world file read, index loaded, name matched through the article, damage
   * subtracted, and the result rendered in a built app. A packaged build that
   * cannot find its resources fails here rather than at somebody's first fight.
   */
  check(
    /18\/30/.test(fight.meter ?? ''),
    'and draws its health against what the world data says it has',
    JSON.stringify(fight)
  );
  check(
    /world data/.test(fight.provenance ?? ''),
    'and says where that number came from rather than implying it',
    JSON.stringify(fight)
  );
  /*
   * 18/30 is 60%, which falls in the realm's own `heavily wounded` band — the
   * amber threshold is drawn from that boundary rather than from one picked to
   * look right. The label carries the same `low` the Vitals meters use, because
   * one scale read under pressure beats two.
   */
  check(
    fight.level === 'caution' && /\blow\b/i.test(fight.meter ?? ''),
    'and states the condition in a word as well as a hue',
    JSON.stringify(fight)
  );
  /*
   * The damage overlay starts where the fill ends. Nobody else has hit the orc
   * rogue in this fixture, so there is no second share and no marker between
   * them — a circle at the end of a bar marks nothing.
   */
  check(
    /left:\s*60%/.test(fight.line ?? ''),
    'and lays the damage line over exactly the ground the fill gave up',
    JSON.stringify(fight)
  );
  check(
    /Dealt: 12/.test(fight.mine ?? '') && fight.others === '',
    'and counts this character’s damage, with no legend for a colour nobody used',
    JSON.stringify(fight)
  );

  /*
   * A picture of the card itself, scrolled to the top of the rail where it
   * lives. The bar is the one part of this feature whose correctness is partly
   * a matter of looking at it — the fill, the damage line over it and the
   * marker between the two shares all have to line up — and a JSON assertion
   * about a percentage cannot say whether they do.
   */
  await evaluate(`(document.querySelector('.rail').scrollTop = 0, true)`);
  await sleep(250);
  await capture('smoke-combat.png', 'the Combat card');
  /* Being fought by two things is a different fact from fighting one, and it is
     the one that decides whether to keep swinging. */
  check(
    /orc rogue/.test(fight.rows?.['Attacking'] ?? '') &&
      /giant rat/.test(fight.rows?.['Attacking'] ?? ''),
    'and everything that is hitting back',
    JSON.stringify(fight)
  );
  check(
    /2 attacking/i.test(fight.badge ?? ''),
    'and the badge reports the number that decides something',
    JSON.stringify(fight)
  );

  /*
   * One condition on the Vitals badge, most urgent first. Combat outranks
   * everything, which is why sneaking is checked after the fight ends below.
   */
  check(
    /combat/i.test(
      await evaluate(`document.querySelector('.vitals-card .badge')?.innerText ?? ''`)
    ),
    'and Vitals says combat, which outranks everything else it could say'
  );

  /*
   * A picture of the rail with everything on it, scrolled to the bottom.
   *
   * The top of the rail is already in `smoke-screenshot.png`; the cards added
   * since all live below the fold, and a screenshot that never shows them is a
   * screenshot that cannot catch them looking wrong.
   */
  await evaluate(`
    (() => {
      const rail = document.querySelector('.rail');
      if (rail) rail.scrollTop = rail.scrollHeight;
      return !!rail;
    })()
  `);
  await sleep(250);
  await capture('smoke-rail.png', 'the rest of the rail');
  await evaluate(`(document.querySelector('.rail').scrollTop = 0, true)`);
}

// -------------------------------------------- assert: running away, for real
//
// A safety feature that sends a command on its own, driven through the whole
// client rather than only in a unit test: the failure nobody would notice is it
// quietly not firing.
//
// **After the Combat card's section**, and the order is the point: a confirmed
// move leaves the fight's participants behind (`CharacterTracker` clears
// `attackers` and `target` on one), so a character that has run away has
// nothing left for a Combat card to name. This sat before it, which was
// harmless only while the escape sent a word that moved nobody.
//
// **This check used to be `/\bflee\b/` and it passed for four phases.** It was
// asserting that a word reached the server, which it did; what it could not see
// was that the server had no such command and answered `Your command had no
// effect.` every time. A harness that watches for a token rather than for an
// effect grades the client on its intentions. So what is asserted now is that
// the escape sent one of the exits **this room printed** -- the fixture's
// `Obvious exits: north, south` -- because a direction is the only thing that
// can actually move a character out of a fight.
{
  /*
   * Driven here rather than left to the fixture's standing health, and then
   * answered -- which is what a server does and this host used not to.
   *
   * The character is put under `belowHealth` for the length of this section and
   * put back afterwards, so the escape is one bounded episode instead of a move
   * every three seconds for the rest of the run. The move is answered with the
   * room again: this one-room host's honest reply, and
   * `CharacterTracker.rememberTheWayBack` writes nothing down for a move whose
   * two ends are the same room.
   */
  const chunksBefore = received.length;
  liveSockets[0]?.write(Buffer.from('\x1b[1;32m[HP=20/MA=50]:\x1b[0m\x1b[79D\x1b[K', 'latin1'));
  await sleep(900);
  const escaped = Buffer.concat(received.slice(chunksBefore)).toString('latin1');

  /*
   * The room the move landed in -- **a different one**, which is the only
   * honest answer and the only one the client will accept.
   *
   * Reprinting the room the character is standing in was tried first and the
   * tracker refused it, correctly: a reprint of the current room is not the
   * answer to a move, and the server sends those unasked. The step stayed
   * outstanding and the *next* room block -- Hidden Hollow, four sections
   * later -- was read as its arrival, which filed `1/2140 n -> Hidden Hollow`
   * into the permanent discovery record in place of `climb cliff`. So the
   * fixture moves the character north into 1/2141, which the shipped realm
   * agrees is there, and then puts it back.
   */
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[1;36mNewhaven, Weapons Shop\x1b[0m\r\n' +
        '    Racks of blades along one wall.\r\n' +
        '\x1b[0;32mObvious exits: \x1b[1;33msouth\x1b[0m\r\n' +
        '\x1b[1;32m[HP=20/MA=50]:\x1b[0m\x1b[79D\x1b[K',
      'latin1'
    )
  );
  await sleep(400);
  // And back where every section after this one expects it, with the health
  // above the threshold again so the escape is this one bounded episode.
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[1;36mNewhaven, Village Entrance\x1b[0m\r\n' +
        '    A dusty path leads away from the gates.\r\n' +
        '\x1b[0;35mAlso here: Nathaniel.\x1b[0m\r\n' +
        '\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0;32m, \x1b[1;33msouth\x1b[0m\r\n' +
        '\x1b[1;32m[HP=98/MA=50]:\x1b[0m\x1b[79D\x1b[K',
      'latin1'
    )
  );
  await sleep(600);

  /*
   * And it is answerable. "Why did the bot run?" has to be readable from the
   * trace -- a command in the sent log says *what* was sent and this says why.
   */
  const decisions = JSON.parse(
    await evaluate(`
      (() => {
        const card = document.querySelector('.automation-card');
        if (!card) return '[]';
        const headings = [...card.querySelectorAll('.trace-heading')];
        const safety = headings.find((h) => /safety/i.test(h.innerText));
        if (!safety) return '[]';
        return JSON.stringify([...safety.nextElementSibling.querySelectorAll('.row')].map((r) => ({
          action: r.querySelector('.trace-command')?.innerText ?? '',
          why: r.querySelector('.trace-reason')?.innerText ?? ''
        })));
      })()
    `)
  );
  // Which stage is empty, when the rows are: the card, its headings, or the
  // safety section itself. `[]` alone cannot say.
  const traceShape = await evaluate(`
    (() => {
      const card = document.querySelector('.automation-card');
      if (!card) return 'no automation card';
      const headings = [...card.querySelectorAll('.trace-heading')].map((h) => h.innerText.trim());
      return 'headings: ' + JSON.stringify(headings);
    })()
  `);
  check(
    decisions.some((entry) => /retreat/i.test(entry.action)),
    'and the trace says it was the client that decided to',
    `${JSON.stringify(decisions)} — ${traceShape}`
  );
  check(
    decisions.some((entry) => /health at \d+%/i.test(entry.why)),
    'and why it decided to',
    `${JSON.stringify(decisions)} — ${traceShape}`
  );
  /*
   * And which way out, and how it knew. The reason reads
   * `health at 24% — n (printed)`: the direction it sent and the rung of
   * `SessionManager.wayOut` that answered. Both halves matter -- the direction
   * is the thing that moves the character, and the rung is what lets somebody
   * reading the console tell *retracing the way we came* from *taking the only
   * exit listed*.
   */
  const chosen = decisions.find((entry) => /retreat/i.test(entry.action))?.why ?? '';
  const wayOut = /—\s*([nsewud]|ne|nw|se|sw)\s*\((retrace|doubles-back|known|printed)\)/.exec(
    chosen
  );
  check(
    wayOut !== null,
    'and the trace names the exit it took and how it knew that exit',
    `${JSON.stringify(chosen)} — ${traceShape}`
  );
  if (wayOut !== null) {
    /*
     * The fixture's room prints `Obvious exits: north, south` and nothing else,
     * so any other direction is the client inventing one.
     */
    check(
      wayOut[1] === 'n' || wayOut[1] === 's',
      'and it is one of the two exits this room actually printed',
      wayOut[0]
    );
    /*
     * And the byte left the client, in the window the health was down. This is
     * the half the old `/\bflee\b/` check was standing in for: a decision
     * recorded and never sent is the same evening for the character as no
     * decision at all.
     */
    check(
      new RegExp(`(^|\r|\n)${wayOut[1]}\r\n`).test(escaped),
      'and the server got it, as a move rather than as a word',
      `${wayOut[1]} — ${JSON.stringify(escaped.slice(0, 120))}`
    );
  }
}

// ------------------------------- assert: what the fighting added up to
//
// The Combat Stats card, brought back from the shelf now that this run has a
// real fight behind it — damage dealt, damage taken and a kill.
//
// Two things are asserted and only one of them is about words. **The second
// figure on a row is a column of its own**: `Damage dealt  133 avg 10.2` used
// to be one cell with the average appended inside it, so every average and
// share started at whatever x the figure before it happened to end at. A grid
// can only align what it is given as separate cells, and nothing about the text
// changes when that regresses — which is why this is geometry.
{
  check(
    await evaluate(`
      (() => {
        const chip = document.querySelector('[data-card-chip="stats"]');
        if (chip) chip.click();
        return !!chip;
      })()
    `),
    'the Combat Stats card is offered on the shelf'
  );
  await sleep(300);
  check(
    await evaluate(`!!document.querySelector('.stats-card')`),
    'and docks onto the rail when its chip is pressed'
  );

  const readout = JSON.parse(
    await evaluate(`
      (() => {
        const list = document.querySelector('.stats-card .readout');
        if (!list) return JSON.stringify([]);
        return JSON.stringify([...list.children].map((cell) => {
          const box = cell.getBoundingClientRect();
          return {
            tag: cell.tagName,
            second: cell.classList.contains('second'),
            text: cell.innerText.trim(),
            left: Math.round(box.left),
            top: Math.round(box.top)
          };
        }));
      })()
    `)
  );
  check(readout.length > 0, 'and states the figures as a readout', String(readout.length));

  /*
   * One label column, one figure column, one second-figure column — and every
   * cell of a kind starting at one x. Three sets rather than one, because the
   * whole complaint was that the third *had* no column of its own.
   */
  const statsX = (kind) => [
    ...new Set(readout.filter((cell) => kind(cell)).map((cell) => cell.left))
  ];
  const labelX = statsX((c) => c.tag === 'DT');
  const valueX = statsX((c) => c.tag === 'DD' && !c.second);
  const secondX = statsX((c) => c.tag === 'DD' && c.second);
  check(labelX.length === 1, 'every label starts at one x', JSON.stringify(labelX));
  check(valueX.length === 1, 'and every figure starts at one x', JSON.stringify(valueX));
  check(
    secondX.length <= 1,
    'and every second figure starts at one x of its own',
    JSON.stringify(secondX)
  );
  /*
   * And it is a *third* column rather than more of the second: an average that
   * still began where its figure ended would satisfy the check above by
   * accident on a card whose figures happened to be the same width.
   */
  check(
    secondX.length === 0 || (valueX[0] !== undefined && secondX[0] > valueX[0]),
    'and after the figure it qualifies rather than inside it',
    JSON.stringify({ valueX, secondX })
  );
  /*
   * `dt { grid-column: 1 }` is what keeps a row with no second figure from
   * letting the next label auto-place into the empty third cell. Without it the
   * readout zig-zags, and the way that shows is two labels sharing a row.
   */
  const labelsPerRow = new Map();
  for (const cell of readout) {
    if (cell.tag !== 'DT') continue;
    labelsPerRow.set(cell.top, (labelsPerRow.get(cell.top) ?? 0) + 1);
  }
  check(
    [...labelsPerRow.values()].every((count) => count === 1),
    'and one label to a row, whether or not the row above carried two figures',
    JSON.stringify([...labelsPerRow.entries()])
  );

  /*
   * Every rate is a **figure**, not a dash.
   *
   * The regression this exists for (todo 01): the rates were read off a
   * rolling window of readings taken at most once a minute, and a reading
   * arriving inside that minute replaced the last one — so with one mark in
   * the array the anchor advanced with every block and the gap never reached
   * a minute. During a fight, where something is counted every few seconds,
   * `Exp. rate`, `Kill rate` and `Income rate` therefore read `—` for ever.
   * Every geometry check above passed for the whole time that was true, which
   * is why this one reads a row's *value*.
   *
   * Keyed on the row's own id rather than on an English label, and the
   * positive control is built in: with no scope the readout is replaced by an
   * empty state and these cells do not exist at all, so a missing cell fails
   * rather than passing as "no dash".
   */
  const rates = JSON.parse(
    await evaluate(`
      JSON.stringify(['exp-rate', 'kill-rate'].map((key) => {
        const cell = document.querySelector('.stats-card .readout dd[data-row="' + key + '"]');
        return [key, cell ? cell.innerText.trim() : null];
      }))
    `)
  );
  check(
    rates.length === 2 && rates.every(([, text]) => typeof text === 'string' && text !== '\u2014'),
    'every rate on the card is a figure once the scope has measured any time',
    JSON.stringify(rates)
  );

  /*
   * A row is drawn once the thing it counts has happened. This character has
   * dealt damage and taken it, and has cast nothing and backstabbed nothing —
   * so the accuracy table holds the kinds that happened and none of the rest.
   */
  const kinds = JSON.parse(
    await evaluate(`
      JSON.stringify(
        [...document.querySelectorAll('.stats-card .card-table tbody tr td:first-child')]
          .map((cell) => cell.innerText.trim())
      )
    `)
  );
  check(
    kinds.length > 0,
    'the accuracy table lists what has actually landed',
    JSON.stringify(kinds)
  );
  check(
    !kinds.includes('Backstab') && !kinds.includes('Cast'),
    'and draws no row for a kind this character has never used',
    JSON.stringify(kinds)
  );

  await evaluate(`
    (() => {
      const card = document.querySelector('.stats-card');
      if (card) card.scrollIntoView({ block: 'center' });
      return !!card;
    })()
  `);
  await sleep(250);
  await capture('smoke-stats.png', 'the Combat Stats card, whose figures share three columns');
  await evaluate(`(document.querySelector('.rail').scrollTop = 0, true)`);
}

// -------------------------------------- assert: who else is in the realm
//
// The `who` listing was parsed three phases ago and nothing ever showed it —
// and what it kept was only the names, which is the wrong half. On a PvP realm
// the fact that matters about somebody is what the realm thinks of them, and
// the listing states it.
//
// Nothing here asks the server for anything: a listing seeds the roster and the
// arrival broadcasts maintain it, both of which the fixture sends unprompted.
{
  check(await evaluate(`!!document.querySelector('.realm-card')`), 'the Realm card is on the rail');

  const roster = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.realm-list tbody tr')].map((li) => ({
        align: li.querySelector('.realm-align')?.innerText ?? '',
        name: li.querySelector('.realm-name')?.innerText ?? '',
        hostile: li.dataset.hostile === 'true',
        unknown: li.dataset.unknown === 'true'
      })))
    `)
  );
  check(roster.length >= 2, 'it lists who the realm said is here', JSON.stringify(roster));
  check(
    roster.some((entry) => entry.name === 'Grimjaw' && entry.hostile),
    'and marks the one the realm calls an Outlaw',
    JSON.stringify(roster)
  );

  /*
   * Worst first: the card is read at a glance and usually only the top of it,
   * so whoever the realm thinks least of belongs where the eye lands.
   */
  check(roster[0]?.name === 'Grimjaw', 'worst first, because that is what is read');

  /* §6, and this is the card where it matters most: a decision about whether to
     keep walking gets made off it. */
  check(
    roster.every((entry) => entry.align.trim().length > 0),
    'every standing is a word, not only a colour'
  );

  /*
   * Absent is not Neutral. Somebody who walked in since the last listing is a
   * name and nothing else, and the reassuring guess is the dangerous one.
   */
  check(
    roster.some((entry) => entry.unknown && /unknown/i.test(entry.align)),
    'somebody who only walked in is shown as unknown, not assumed harmless',
    JSON.stringify(roster)
  );

  // And the hostile one is what the badge reports, because that is the number
  // somebody acts on.
  check(
    /hostile/i.test(
      await evaluate(`document.querySelector('.realm-card .badge')?.innerText ?? ''`)
    ),
    'the badge reports the actionable number rather than a total'
  );

  /*
   * A name on the Realm card is a control. That is the half no unit test can
   * assert: the click handler, the layout rule that brings the detail out and
   * the subject reaching the card it opens are three separate pieces, and any
   * one of them failing leaves a name that looks clickable and does nothing.
   */
  check(
    await evaluate(`
      [...document.querySelectorAll('.realm-card button.realm-name')]
        .some((b) => b.innerText.trim() === 'Grimjaw')
    `),
    'a name on the Realm card is a control, not a label'
  );

  /*
   * And **this character's own row is not**, which is the case that would
   * otherwise ship broken: a `who` listing includes the person reading it, the
   * registry deliberately files everybody *except* self, so a clickable self
   * row is a control that opens a card saying "click a name". The row itself
   * stays -- the listing is what the server said, and dropping a line from it
   * would be the client editing the roster.
   */
  check(
    await evaluate(`
      (() => {
        const names = [...document.querySelectorAll('.realm-card .realm-name')];
        const me = names.find((n) => n.innerText.trim() === 'Rayzor');
        return !!me && me.tagName !== 'BUTTON';
      })()
    `),
    "and this character's own row in it is not, because there is nothing to open"
  );

  /*
   * The Players card: what this client has accumulated about the other people
   * in the realm, kept after they walk out.
   *
   * Driven here rather than unit-tested alone because the half that fails
   * silently is *reachability*: a card absent from the rail, a face nobody can
   * open and a permission button that writes nothing all pass every unit test
   * in the project. The registry itself is covered in
   * `src/main/parse/__tests__/players.test.ts`.
   */
  check(
    await evaluate(`!!document.querySelector('.players-card')`),
    'the Players card is on the rail'
  );

  /*
   * And no Player flyout is open, because nobody has been clicked. It is about
   * somebody, and until there is a somebody there is nothing to slide out —
   * this is the positive control for the click below, which would otherwise
   * pass against a panel that had been there the whole time.
   */
  check(
    !(await evaluate(`!!document.querySelector('.player-flyout')`)),
    'and no Player flyout is open, because nobody has been chosen yet'
  );

  const known = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.player-list tbody tr')].map((li) => ({
        name: li.querySelector('.player-name')?.innerText ?? '',
        where: li.querySelector('.player-where')?.innerText ?? '',
        seen: li.querySelector('.player-seen')?.innerText ?? ''
      })))
    `)
  );
  check(known.length >= 2, 'it keeps what it has seen of the other players', JSON.stringify(known));

  /*
   * Somebody who only ever *spoke* is in it. That is the whole point of the
   * registry over the roster: `Rayth telepaths:` reaches across the realm, and
   * before this card nothing recorded that the name existed at all.
   */
  check(
    known.some((entry) => entry.name === 'Rayth'),
    'including somebody known only from a telepath',
    JSON.stringify(known)
  );

  /*
   * **No monsters.** This is the check that earns its place: `combat.attackers`
   * holds whatever is swinging, so trusting it filled the card with `orc rogue`
   * and `giant rat` as people while every unit test still passed — they all fed
   * names that happened to be players. Only the picture showed it.
   */
  check(
    !known.some((entry) => /\b(orc|rat|rogue|kobold|slime)\b/i.test(entry.name)),
    'and files no monsters as people',
    JSON.stringify(known.map((entry) => entry.name))
  );

  /* A sighting with no room attached says so rather than showing a blank or a
     zero, which would read as a room this client had placed them in. */
  check(
    known.some((entry) => /not seen in a room/i.test(entry.where)),
    'and says where it has not seen somebody, rather than leaving it blank',
    JSON.stringify(known)
  );

  // Every row states when, because a sighting is a moment and not a position.
  check(
    known.every((entry) => entry.seen.trim().length > 0),
    'every row says when it last saw them'
  );

  /* A picture of the listing on its own, before anything is opened from it. */
  await evaluate(`
    (() => {
      const card = document.querySelector('.players-card');
      if (card) card.scrollIntoView({ block: 'center' });
      return !!card;
    })()
  `);
  await sleep(250);
  await capture('smoke-players.png', 'the Players card');

  /*
   * Clicking a name slides the Player flyout out on that person.
   *
   * `Rayth` on purpose: somebody known only from a telepath, so this also
   * proves the detail is drawn from the registry rather than from the roster —
   * a panel fed by `character.online` would find nobody by that name at all.
   */
  const chose = await evaluate(`
    (() => {
      const name = [...document.querySelectorAll('.players-card .player-name')]
        .find((b) => b.innerText.trim() === 'Rayth');
      if (!name) return false;
      name.click();
      return true;
    })()
  `);
  check(chose, 'clicking a name on the Players card is one gesture');
  await sleep(400);

  check(
    await evaluate(`!!document.querySelector('.player-flyout')`),
    'and the Player flyout slides out on its own'
  );

  /*
   * Beside the card it was opened from, lined up with the row: the flyout is
   * *of the card*, so it must not cover the listing it came from, and it must
   * not land on a side of the screen the client picked. Measured, because
   * nothing about the words changes when the geometry is wrong.
   */
  check(
    await evaluate(`
      (() => {
        const panel = document.querySelector('.player-flyout')?.getBoundingClientRect();
        const card = document.querySelector('.players-card')?.getBoundingClientRect();
        const row = [...document.querySelectorAll('.players-card .player-name')]
          .find((b) => b.innerText.trim() === 'Rayth')?.closest('tr')?.getBoundingClientRect();
        if (!panel || !card || !row) return false;
        const beside = panel.left >= card.right || panel.right <= card.left;
        return beside && Math.abs(panel.top - row.top) < 24;
      })()
    `),
    'and it opens beside the card, level with the row that was clicked'
  );

  const chosen = await evaluate(
    `document.querySelector('.player-flyout')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  );
  check(/Rayth/.test(chosen), 'and it is about the person who was clicked', chosen.slice(0, 240));

  /* The listing says which row the flyout is about, or nothing on screen
     connects the two. */
  check(
    await evaluate(`
      (() => {
        const row = document.querySelector('.players-card tr[data-selected]');
        return row ? row.innerText.includes('Rayth') : false;
      })()
    `),
    'and the row it came from says so'
  );

  /*
   * The same gesture from the *other* listing. Two cards open one flyout, and a
   * handler wired to only one of them is a name that looks clickable and does
   * nothing. The second click replaces the first panel rather than stacking.
   */
  /*
   * A **real** press, not `element.click()`: a synthetic click dispatches no
   * `pointerdown`, and `pointerdown` is exactly the event the open flyout's
   * click-away listens to. The claim under test is that pressing another name
   * replaces the panel rather than dismissing it on the press and re-opening
   * it on the click, and only a pointer sequence exercises that.
   */
  const grimjaw = JSON.parse(
    await evaluate(`
      (() => {
        const name = [...document.querySelectorAll('.realm-card button.realm-name')]
          .find((b) => b.innerText.trim() === 'Grimjaw');
        if (!name) return 'null';
        const r = name.getBoundingClientRect();
        return JSON.stringify({ who: name.innerText.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()
    `)
  );
  const fromRealm = grimjaw?.who ?? null;
  check(fromRealm === 'Grimjaw', 'a name on the Realm card is there to press', String(fromRealm));
  await evaluate(`window.__flyoutGone = false; new MutationObserver(() => {
    if (!document.querySelector('.player-flyout')) window.__flyoutGone = true;
  }).observe(document.body, { childList: true }); true`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', {
      type,
      x: grimjaw.x,
      y: grimjaw.y,
      button: 'left',
      clickCount: 1
    });
  }
  await sleep(400);
  check(
    !(await evaluate(`window.__flyoutGone`)),
    'and pressing it replaces the open flyout without ever taking it down'
  );
  check(
    (await evaluate(`document.querySelectorAll('.player-flyout').length`)) === 1,
    'and there is still exactly one flyout — the second click replaced the first'
  );
  const fromRealmText = await evaluate(
    `document.querySelector('.player-flyout')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  );
  check(
    fromRealmText.includes(fromRealm),
    'and the flyout follows it to that person',
    `${fromRealm} :: ${fromRealmText.slice(0, 200)}`
  );

  /*
   * The faces. `ACCESS` is the one with teeth -- it writes to the character's
   * own file -- so it has to be reachable by clicking, which is the half no
   * unit test can assert.
   */
  const faces = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.player-flyout .crumb')].map((c) => c.innerText))`
  );
  check(
    /player/i.test(faces) && /access/i.test(faces),
    'the flyout offers its own face and an Access face',
    faces
  );

  const openedAccess = await evaluate(`
    (() => {
      const crumbs = [...document.querySelectorAll('.player-flyout .crumb')];
      const access = crumbs.find((c) => /access/i.test(c.innerText));
      if (!access) return false;
      access.click();
      return true;
    })()
  `);
  check(openedAccess, 'the Access face opens');
  await sleep(250);

  const access = await evaluate(
    `document.querySelector('.player-flyout')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  );
  /*
   * With `remotes.enabled` off -- which is the shipped default and what this
   * run uses -- the face says so rather than showing a gate that cannot matter.
   * The two states need different actions from the reader: "off entirely" and
   * "on, and this person has been granted nothing".
   */
  check(
    /off for this character|nothing yet|of \d+/i.test(access),
    'and states whether this person is currently getting through',
    access.slice(0, 240)
  );

  /* Whose access it is. The heading says `Player` and the name is on the
     other face, so a gate stated without one is a decision about nobody. */
  check(
    access.includes(fromRealm),
    'and names the person it is a gate for',
    `${fromRealm} :: ${access.slice(0, 200)}`
  );

  /*
   * Per command, not per person. Two chips a row -- Allow and Deny, with
   * neither pressed meaning *unset*, which is what nearly every pair is and
   * what falls through to the gang.
   */
  const stances = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.remote-stance button')]
       .slice(0, 2).map((b) => b.innerText))`
  );
  check(
    /allow/i.test(stances) && /deny/i.test(stances),
    'and offers allow and deny per @ command rather than one decision per person',
    stances
  );

  /*
   * The permission reaches the character's own file. That is the assertion
   * worth the most here: a button that looks right and writes nothing is a
   * permission somebody sets, trusts, and does not have.
   */
  const denied = await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.remote-rows > li')]
        .find((li) => li.querySelector('.remote-name')?.innerText === '@health');
      const button = [...(row?.querySelectorAll('.remote-stance button') ?? [])]
        .find((b) => /deny/i.test(b.innerText));
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  check(denied, 'denying one @ command is one click');

  /*
   * Wait for the write to come *back* — the chip lights only once the file
   * has reloaded and the profiles have republished — rather than sleeping and
   * hoping. A fixed wait followed by "the panel is still there" passes just as
   * well when the write never happened; the lit chip is the positive control
   * that the round trip the panel has to survive actually ran.
   */
  let lit = false;
  for (let i = 0; i < 40 && !lit; i += 1) {
    lit = await evaluate(`
      (() => {
        const on = document.querySelector('.remote-stance button[data-on="true"]');
        return !!on && /deny/i.test(on.innerText);
      })()
    `);
    if (!lit) await sleep(100);
  }
  check(lit, 'and the deny comes back from the file as the lit chip');

  /*
   * And the panel is still there. This is the assertion that lets a flyout do
   * the Access face's job at all: the click wrote to the options file, the
   * file reloaded, the profiles republished and every card redrew — and a
   * slide-out that went away on any of that would be a gate that closes the
   * moment it is used.
   */
  check(
    await evaluate(`!!document.querySelector('.player-flyout')`),
    'and the flyout stays open through the write it caused'
  );

  const profileFile = path.join(PROFILES_DIR, SESSION, 'profile.yaml');
  const profileText = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : '';
  check(
    /deny:\s*\n\s*- health/.test(profileText),
    "and it reached this character's own file, not only the screen",
    (profileText.match(/players:[\s\S]{0,160}/)?.[0] ?? profileText.slice(0, 200)).replace(
      /\n/g,
      ' | '
    )
  );

  /* A picture of it, for the same reason the pack has one: spacing is the thing
     no assertion here catches. */
  await capture('smoke-player.png', 'the Player flyout');

  /*
   * Escape puts it away, and the caret is still the game's. A slide-out that
   * could only be closed by clicking elsewhere would be one more thing between
   * the player and the console.
   */
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await sleep(250);
  check(
    !(await evaluate(`!!document.querySelector('.player-flyout')`)),
    'and Escape puts the flyout away'
  );

  // The arrival and the standing are two moments, and they reach the Alerts
  // card at two different volumes.
  const alerts = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.alert-list tbody tr')].map((li) => ({
        level: li.dataset.level,
        text: li.querySelector('.alert-text')?.innerText ?? ''
      })))
    `)
  );
  check(
    alerts.some((a) => a.level === 'critical' && /Grimjaw/.test(a.text)),
    'somebody hostile in the realm is worth interrupting for',
    JSON.stringify(alerts.filter((a) => /Grimjaw|Soul/.test(a.text)))
  );
}

// ------------------------------- assert: a card on the rail is a fixed box
//
// Every card here has content whose size the player does not control: a room
// with four items and three people is taller than an empty one, Carrying grows
// with loot, Talk grows as people speak, Alerts grow as things go wrong. A card
// that grows moves every control below it -- and **Stop Movement** is the one
// control reached for *while* the thing moving it is running.
//
// So the check is not "the rail is stable in this fixture"; it is that no card
// derives its height from its contents at all.
{
  const heights = async () =>
    JSON.parse(
      await evaluate(`
        JSON.stringify([...document.querySelectorAll('.rail > .card')].map((c) => ({
          card: c.dataset.card ?? c.className,
          h: Math.round(c.getBoundingClientRect().height),
          // Either the body scrolls, or the card keeps its own scroll region
          // with something pinned around it -- Talk's filters and reply box,
          // Alerts' filters. Both are "the contents move, the card does not".
          scrolls: (() => {
            const body = c.querySelector('.body');
            if (!body) return 'none';
            if (getComputedStyle(body).overflowY === 'auto') return 'body';
            const inner = c.querySelector('.scroller');
            return inner && getComputedStyle(inner).overflowY === 'auto' ? 'scroller' : 'no';
          })()
        })))
      `)
    );

  const before = await heights();
  check(before.length > 0, 'the rail has cards to measure');
  check(
    before.every((c) => c.scrolls === 'body' || c.scrolls === 'scroller'),
    'every card on the rail scrolls its contents rather than growing',
    JSON.stringify(before)
  );

  /*
   * Force the content well past the box: if height came from content at all,
   * this is where it would show. The Alerts card takes anything appended to it.
   */
  await evaluate(`
    (() => {
      const body = document.querySelector('.alert-card .body');
      if (!body) return false;
      const filler = document.createElement('div');
      filler.id = 'smoke-filler';
      filler.style.height = '2000px';
      body.appendChild(filler);
      return true;
    })()
  `);
  await sleep(200);
  const after = await heights();
  const grew = before
    .map((card, index) => ({ card: card.card, before: card.h, after: after[index]?.h ?? 0 }))
    .filter((row) => Math.abs(row.after - row.before) > 1);
  check(
    grew.length === 0,
    'and 2000px of content does not change a single card height',
    JSON.stringify(grew)
  );

  // Which is the whole point: the control below stays where the pointer left it.
  await evaluate(`document.getElementById('smoke-filler')?.remove(), true`);
  await sleep(150);
}

// --------------------------------------------- assert: what is worth knowing
//
// The terminal carries every line and that is exactly the problem: the one that
// mattered is three screens up behind a combat burst, and the moment you need
// it is the moment you cannot go looking. The Alerts card is the same facts,
// ranked, and it is proven against lines the real classifier produced -- not
// against a fixture written to match the card.
{
  check(
    await evaluate(`!!document.querySelector('.alert-card')`),
    'the Alerts card is on the rail'
  );

  const rows = await evaluate(`
    JSON.stringify([...document.querySelectorAll('.alert-list tbody tr')].map((li) => ({
      level: li.dataset.level,
      text: li.querySelector('.alert-text')?.innerText ?? ''
    })))
  `);
  const alerts = JSON.parse(rows);
  check(
    alerts.some((a) => a.level === 'warning' && /no exit in that direction/i.test(a.text)),
    'a command that did not run is ranked a warning',
    rows
  );
  check(
    alerts.some((a) => a.level === 'info' && /entered the Realm/i.test(a.text)),
    'and somebody arriving is the record, not an emergency'
  );

  /*
   * The default is silence. A feed carrying every block is the terminal again,
   * which is the thing this card exists because of.
   */
  check(
    !alerts.some((a) => /gossips|telepaths/i.test(a.text)),
    'conversation stays on the Talk card rather than being alerted twice'
  );

  /* §6: nothing states a condition by colour alone. */
  check(
    (await evaluate(
      `[...document.querySelectorAll('.alert-list .alert-level')].every((l) => l.innerText.trim().length > 0)`
    )) === true,
    'every alert says its level in words as well as in hue'
  );

  // Filtering, so someone who does not want the record does not get it.
  await evaluate(`
    (() => {
      const chip = [...document.querySelectorAll('.alert-card .chip.toggle')]
        .find((c) => /info/i.test(c.innerText));
      if (chip) chip.click();
      return !!chip;
    })()
  `);
  await sleep(250);
  check(
    !(await evaluate(
      `[...document.querySelectorAll('.alert-list tbody tr')].some((li) => li.dataset.level === 'info')`
    )),
    'muting a level drops it out of the feed'
  );
  /*
   * And it is remembered, per character, like the rail's arrangement. Having to
   * mute the same thing on every launch is the client asking again after being
   * told.
   */
  check(
    (
      await evaluate(`
      (() => {
        const key = Object.keys(window.localStorage).find((k) => k.startsWith('mudengine.alerts-muted.'));
        return key ? window.localStorage.getItem(key) : '';
      })()
    `)
    ).includes('info'),
    'and the choice is remembered for this character'
  );
  check(
    await evaluate(
      `[...document.querySelectorAll('.alert-list tbody tr')].some((li) => li.dataset.level === 'warning')`
    ),
    'and leaves the others alone'
  );
}

// -------------------------------- assert: the rail keeps its space when offline
//
// Measured here while the character is in the realm; the offline half of the
// check runs after the disconnect at the end of the run, because taking a
// character out of the realm mid-suite would break every assertion after it.
const railWidthInGame = await evaluate(
  `Math.round(document.querySelector('.terminal-layers').getBoundingClientRect().width)`
);
check(
  await evaluate(`!!document.querySelector('.rail')`),
  'the rail is on screen while the character is in the realm'
);

// ------------------------------- assert: chrome never takes the caret from the game
//
// The terminal is where focus lives. A surface that takes no typed input must
// not move it — a card is *read*, and switching it to its second face is a
// mouse action after which the next thing typed still has to reach the game.
{
  await evaluate(`(document.querySelector('.terminal-cell textarea')?.focus(), true)`);
  await sleep(150);
  const before = await focusPath();
  await evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('.room-card .crumb')].find((t) => /how/i.test(t.innerText));
      if (!tab) return false;
      // A real click, mousedown first: that is the event that moves focus, and
      // the one the guard refuses.
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      tab.click();
      return true;
    })()
  `);
  await sleep(250);
  check(
    before === 'terminal' && (await focusPath()) === 'terminal',
    'switching a card face leaves the caret in the terminal',
    `${before} -> ${await focusPath()}`
  );

  // Put the card back on its first face: later checks read what it shows, and
  // a test that quietly leaves the UI somewhere else is a test that breaks the
  // next one for a reason nobody can see.
  await evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('.room-card .crumb')].find((t) => /room/i.test(t.innerText));
      if (tab) tab.click();
      return true;
    })()
  `);
  await sleep(250);
}

// --------------------------------- assert: every filtered list navigates alike
//
// The palette and the room search are the same interaction — type to narrow,
// arrow to choose, Enter to take it — and they were not, because each
// hand-rolled its own key handling. They share `useListNavigation` now, so this
// drives the one that used to be missing it.
{
  const press = async (key, code, vk) => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: vk
    });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };

  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'g',
    code: 'KeyG',
    windowsVirtualKeyCode: 71,
    modifiers: 2
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'g',
    code: 'KeyG',
    windowsVirtualKeyCode: 71,
    modifiers: 2
  });
  await sleep(400);
  check(await evaluate(`!!document.querySelector('.route-panel')`), 'the route panel opens');

  // Type into it the way React listens for.
  await evaluate(`
    (() => {
      const el = document.querySelector('.route-panel input');
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'Newhaven');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return true;
    })()
  `);
  await sleep(900);

  const matched = await evaluate(
    `document.querySelectorAll('.route-matches li[data-active]').length`
  );
  check(matched > 1, 'the room search finds rooms to choose between', `${matched} matches`);

  const firstActive = await evaluate(
    `[...document.querySelectorAll('.route-matches li[data-active]')].findIndex((li) => li.dataset.active === 'true')`
  );
  await press('ArrowDown', 'ArrowDown', 40);
  await sleep(250);
  const afterDown = await evaluate(
    `[...document.querySelectorAll('.route-matches li[data-active]')].findIndex((li) => li.dataset.active === 'true')`
  );
  check(
    firstActive === 0 && afterDown === 1,
    'the down arrow moves the highlight in the room search',
    `${firstActive} -> ${afterDown}`
  );

  await press('ArrowUp', 'ArrowUp', 38);
  await sleep(250);
  check(
    (await evaluate(
      `[...document.querySelectorAll('.route-matches li[data-active]')].findIndex((li) => li.dataset.active === 'true')`
    )) === 0,
    'and the up arrow moves it back'
  );

  // Typing still types: the arrows are a layer over the field, not a mode.
  await evaluate(`
    (() => {
      const el = document.querySelector('.route-panel input');
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'Newhaven, D');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(800);
  check(
    (await evaluate(`document.querySelector('.route-panel input').value`)) === 'Newhaven, D',
    'and the field keeps taking typed input'
  );

  await press('Enter', 'Enter', 13);
  await sleep(900);
  check(
    await evaluate(`!!document.querySelector('.route-panel .route-result')`),
    'Enter takes the highlighted room, not merely the first'
  );

  await press('Escape', 'Escape', 27);
  await sleep(400);
  check(!(await evaluate(`!!document.querySelector('.route-panel')`)), 'and Escape closes it');
  check(
    (await focusPath()) === 'terminal',
    'handing the caret back to the terminal',
    await focusPath()
  );

  /*
   * The palette reaches the same index.
   *
   * It used to search one flat list of the client's own commands, so the one
   * thing somebody types a place name into a search box wanting -- to go there
   * -- was the one thing it could not answer. Driven here rather than in the
   * palette section above because that one runs before a realm is loaded, and
   * a room search with no world answers nothing at all.
   *
   * Asserted as a row, not as a walk: what walking a planned route does is
   * already covered a few hundred lines up, and a smoke run that sends a
   * character somewhere on its way past has to put it back.
   */
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2
  });
  await sleep(400);
  await evaluate(`
    (() => {
      const el = document.querySelector('.palette input');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, '1 2141');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(900);
  const gotoRow = await evaluate(`
    [...document.querySelectorAll('.palette li')]
      .map((li) => li.innerText.replace(/\\s+/g, ' ').trim())
      .find((text) => /^Goto:/.test(text)) ?? ''
  `);
  check(
    /^Goto: .+1\/2141$/.test(gotoRow),
    'a room reference typed into the palette offers a row that walks there',
    JSON.stringify(gotoRow)
  );
  // And a name, which is the other half of the ask: `1 297` or `Bank of god`.
  await evaluate(`
    (() => {
      const el = document.querySelector('.palette input');
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'Newhaven, Weapons');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(900);
  check(
    /Goto: Newhaven, Weapons Shop/.test(
      await evaluate(`document.querySelector('.palette').innerText`)
    ),
    'and a partial room name does too'
  );
  await press('Escape', 'Escape', 27);
  await sleep(300);
  check(
    !(await evaluate(`!!document.querySelector('.palette')`)),
    'and Escape puts the palette away for the checks that follow'
  );
}

const roomCard = (await evaluate(`document.querySelector('.room-card')?.innerText ?? ''`)).replace(
  /\s+/g,
  ' '
);
check(
  /Newhaven, Village Entrance/.test(roomCard),
  'room card shows the room',
  roomCard.slice(0, 90)
);
check(
  /north/i.test(roomCard) && /south/i.test(roomCard),
  'room card shows exits',
  roomCard.slice(0, 90)
);
check(/Nathaniel/.test(roomCard), 'room card shows occupants', roomCard.slice(0, 90));

/*
 * One label column per card, measured -- and the reason it has to be measured.
 *
 * `.readout` is `grid-template-columns: auto minmax(0, 1fr)`, and CSS sizes an
 * `auto` track from *one grid container's own children*. Every `<dl>` is its
 * own container, so while the Room card drew `Here` and `Items` in two of them
 * each sized its label column against its own longest label and the two value
 * columns began at different x inside one card. Nothing about the text changes
 * when that happens, so only geometry can catch it coming back.
 *
 * The baselines are read off text ranges rather than off the boxes: `dt` and
 * `dd` are stretched to the row, so their *boxes* share a top whatever the type
 * inside them is doing. A value carrying a chip -- an occupant with `hostile`
 * or an alignment cost after it -- has a taller line box than its label, and
 * where the two sit inside those boxes is the thing a reader actually sees.
 */
{
  const layout = JSON.parse(
    await evaluate(`
      (() => {
        const card = document.querySelector('.room-card');
        const lists = [...card.querySelectorAll('.readout')];
        // The first line of text in an element, wherever it is nested.
        const textTop = (el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            if (box.height > 0) return { top: box.top, bottom: box.bottom };
          }
          return null;
        };
        const rows = lists.flatMap((list) => {
          const terms = [...list.querySelectorAll(':scope > dt')];
          return terms.map((dt) => {
            const dd = dt.nextElementSibling;
            const label = textTop(dt);
            const value = textTop(dd);
            return {
              term: dt.innerText.trim(),
              ddLeft: Math.round(dd.getBoundingClientRect().left),
              // Positive means the value sits lower than its own label.
              drop: label && value ? Math.round(value.top - label.top) : null
            };
          });
        });
        return JSON.stringify({ lists: lists.length, rows });
      })()
    `)
  );
  check(
    layout.lists === 1,
    'the room card states its rows in one grid, so one label column serves them all',
    String(layout.lists)
  );
  const dds = [...new Set(layout.rows.map((r) => r.ddLeft))];
  check(
    dds.length === 1,
    'and every value starts at the same x, whichever row it is on',
    JSON.stringify(layout.rows)
  );
  /*
   * The occupants row was the one reported, and the claim under test is that
   * only the `dt` column was ever at fault -- that the run of names is not
   * itself sitting low. A row whose value carries a chip is exactly where that
   * would show, so it is asserted rather than assumed.
   */
  check(
    layout.rows.every((r) => r.drop === null || Math.abs(r.drop) <= 1),
    'and sits on its label’s own line, chips in the value or not',
    JSON.stringify(layout.rows)
  );
}

// ------------------------------- assert: right-click to copy, on the cards
//
// The console has had this since copy and paste went in and the cards had
// nothing — which is backwards: what a player wants to send somebody is a room
// name, a route, a party member's health or an alert, and every one of those is
// on a card. Reading it off the screen and typing it back in is the thing a
// client exists to avoid.
//
// On `BentoCard`, so it is every card at once rather than the ones somebody
// remembered.
{
  const openOn = (selector) =>
    evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left + Math.min(20, r.width / 2)),
          clientY: Math.round(r.top + Math.min(10, r.height / 2))
        }));
        return true;
      })()
    `);

  const labels = async () =>
    JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.popup-menu .entry')].map((b) => b.innerText.trim()))`
      )
    );

  check(await openOn('.room-card .body'), 'right-clicking a card opens a menu');
  await sleep(250);
  const entries = await labels();
  // Nothing is selected, so "Copy" is absent rather than greyed: unlike the
  // console's menu there are other entries here that do work, and a dead row
  // would only be in the way.
  check(
    entries.some((e) => /copy line/i.test(e)) && entries.some((e) => /copy card/i.test(e)),
    'offering the line under the pointer and the whole card',
    JSON.stringify(entries)
  );
  check(
    !entries.some((e) => /^copy$/i.test(e)),
    'and not offering a Copy that would copy nothing',
    JSON.stringify(entries)
  );
  check(
    entries.every((e) => e.length > 0),
    'every entry says what it does'
  );

  const before = await evaluate(`window.mudengine.pasteText()`);
  await evaluate(`
    (() => {
      const entry = [...document.querySelectorAll('.popup-menu .entry')]
        .find((b) => /copy card/i.test(b.innerText));
      if (entry) entry.click();
      return !!entry;
    })()
  `);
  await sleep(400);
  const after = await evaluate(`window.mudengine.pasteText()`);
  check(
    typeof after === 'string' && /Newhaven, Village Entrance/.test(after) && after !== before,
    'and Copy card puts what the card says on the clipboard',
    JSON.stringify(String(after).slice(0, 80))
  );
  check(
    (await focusPath()) === 'terminal',
    'leaving the caret in the game, like every other menu',
    await focusPath()
  );
}
// ------------------------- assert: what the realm data does not have, written down
//
// The shipped world is a snapshot of one build of one server. A derivative adds
// rooms, an operator rewires a corridor, and a way through that nobody wrote
// down turns out to work — and the client cannot be told, only shown. So it
// watches: the character walks somewhere the data said was not there, and the
// fact is written down against that character.
//
// Everything it *refuses* to record is the point, and that is unit-tested
// against the tracker. What this proves is the wiring: a discovery made in main
// reaches a window, appears on the card, and is said out loud once.
{
  /*
   * Click, *then* read — on two calls, not one.
   *
   * Clicking a card face and reading `innerText` in the same expression reads
   * the face that was showing before the click: React has not re-rendered yet.
   * That made this assert against the Room face while its own failure message
   * printed the Found face, which is a diagnostic saying the opposite of the
   * check beside it.
   */
  const found = async () => {
    await evaluate(`
      (() => {
        const crumb = [...document.querySelectorAll('.room-card .crumb')]
          .find((t) => /found/i.test(t.innerText));
        if (crumb) crumb.click();
        return true;
      })()
    `);
    await sleep(150);
    return evaluate(`document.querySelector('.room-card')?.innerText ?? ''`);
  };

  /*
   * No Found face until this room has something found behind it: a face that
   * would say "nothing found here" on every room is a control that almost
   * never does anything, and the heading changing shape as the character
   * walks is what says a room has something the map is missing.
   */
  check(
    !(await evaluate(
      `[...document.querySelectorAll('.room-card .crumb')].some((t) => /found/i.test(t.innerText))`
    )),
    'the Room card offers no Found face while nothing has been found here'
  );

  /*
   * A command this client does not model as movement, which nonetheless moves
   * the character — and into a room the shipped realm has never heard of. Both
   * halves matter: the command is unguessable, and the room is unroutable.
   */
  /*
   * `climb cliff`, not `jump cliff`: `jump` **is** in the server's command
   * table, as `Jumpkick`, so typing it aims a kick at something called cliff
   * rather than going anywhere. A text exit is by definition a word the table
   * does not have — `Commands.cs` has no `Go` and no `Enter` either, because
   * those phrasings are room data. See `shared/commands.ts`.
   */
  await evaluate(`(window.mudengine.input('${SESSION}', 'climb cliff\\r'), true)`);
  await sleep(200);
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[1;36mHidden Hollow\x1b[0m\r\n' +
        '    A cleft in the rock nobody mapped.\r\n' +
        '\x1b[0;32mObvious exits: \x1b[1;33msouth\x1b[0m\r\n' +
        '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ',
      'latin1'
    )
  );
  await sleep(600);

  /*
   * Walk back *before* reading the card, which is not merely tidying up.
   *
   * The card lists what was found **from the room the character is standing
   * in** — a client that made somebody scroll a hundred observations to find
   * the two about this room would have buried the two. Hidden Hollow is by
   * construction a room the realm data has never heard of, so while standing in
   * it there is no room id to file anything against and the card correctly says
   * "Nothing found here. 1 more found elsewhere."
   *
   * The discovery is about the *edge*: it leads from Newhaven, Village
   * Entrance, and that is where it is listed.
   */
  liveSockets[0]?.write(
    Buffer.from(
      '\x1b[1;36mNewhaven, Village Entrance\x1b[0m\r\n' +
        '    A dusty path leads away from the gates.\r\n' +
        '\x1b[0;35mAlso here: Nathaniel.\x1b[0m\r\n' +
        '\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0;32m, \x1b[1;33msouth\x1b[0m\r\n' +
        '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ',
      'latin1'
    )
  );
  await sleep(500);

  const learned = (await found()).replace(/\s+/g, ' ');
  check(/climb cliff/.test(learned), 'the way in is written down verbatim', learned.slice(0, 200));
  check(/Hidden Hollow/.test(learned), 'beside where it led', learned.slice(0, 200));
  // A word as well as a hue: a missing edge and a missing room are different
  // facts, and only the second is unroutable.
  check(/new room/i.test(learned), 'and says which kind of gap it is', learned.slice(0, 200));

  // And put the card back on its first face, for the same reason.
  await evaluate(`
    (() => {
      const crumb = [...document.querySelectorAll('.room-card .crumb')]
        .find((t) => /^room$/i.test(t.innerText.trim()));
      if (crumb) crumb.click();
      return true;
    })()
  `);
  await sleep(250);
}

await ensureDiagnostics();

// The HUD must not depend on the diagnostics rail. It was originally rendered
// only inside it, so it never appeared unless you already knew to open a panel
// named after something else.
await evaluate(
  `(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, shiftKey: true, bubbles: true })), true)`
);
await sleep(300);
check(
  !(await evaluate(`!!document.querySelector('.link-card')`)),
  'the diagnostics cards close with the rail toggle'
);
check(
  await evaluate(`!!document.querySelector('.vitals-card')`),
  'the HUD stays visible with diagnostics closed'
);
// Restore for the checks below.
await evaluate(
  `(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, shiftKey: true, bubbles: true })), true)`
);
await sleep(300);

// Removing the dropdown must not remove the information: the session card is
// where the encoding in force is reported now.
const session = (
  await evaluate(`document.querySelector('.session-card')?.innerText ?? ''`)
).replace(/\s+/g, ' ');
check(/cp437/.test(session), 'session card reports the encoding in force', session);

// The Stream card is the window onto framing; without it a broken tokenizer is
// invisible until phase 3's parser starts producing nonsense.
const streamCard = (
  await evaluate(`document.querySelector('.stream-card')?.innerText ?? ''`)
).replace(/\s+/g, ' ');
check(
  /HP=98\/MA=50/.test(streamCard),
  'stream card shows the framed stream, newest last',
  streamCard.slice(-120)
);

/*
 * And the *live* feed, distinctly from the catch-up. Everything asserted above
 * was framed before the rail was opened, so it can be satisfied by the
 * `getLines` re-ask alone — which means a window whose `Send.diagnostics`
 * never reached main would show history and then silently freeze, and every
 * check above would still pass. A line the fixture sends only *after* the rail
 * is open can arrive by exactly one path: main marking this window interested
 * and routing `Push.line` to it.
 */
clientSocket.write(Buffer.from('\x1b[0;37mstream-live-marker\x1b[0m\r\n', 'latin1'));
await sleep(500);
check(
  /stream-live-marker/.test(
    await evaluate(`document.querySelector('.stream-card')?.innerText ?? ''`)
  ),
  'a line framed after the rail opened reaches the stream card by push'
);
check(
  /TERMINAL-TYPE/.test(options) && /NAWS/.test(options),
  'TERMINAL-TYPE and NAWS enabled locally',
  options
);

const resolvedDensity = await evaluate(`document.documentElement.dataset.density`);
const viewport = await evaluate(
  `window.innerWidth + 'x' + window.innerHeight + ' dpr' + window.devicePixelRatio`
);
check(
  resolvedDensity === 'comfortable' || resolvedDensity === 'compact',
  'density resolved from the real window size',
  `${resolvedDensity} @ ${viewport}`
);
log('     viewport', viewport, '-> density', resolvedDensity);

/*
 * The negotiation log lives behind the Link card's second tab now. Traffic used
 * to be a card of its own saying the same thing at greater length; it is the
 * working for what Link states, and a live negotiation log is something almost
 * nobody needs to look at, so it should not cost a cell in the rail.
 */
const tabbed = await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll('.link-card .crumb')]
      .find((t) => /traffic/i.test(t.innerText));
    if (tab) tab.click();
    return !!tab;
  })()
`);
check(tabbed, 'the Link card carries its negotiation log on a tab');
await sleep(250);
check(
  !(await evaluate(`!!document.querySelector('.traffic-card')`)),
  'and Traffic no longer costs a card of its own'
);

const telnetLog = await evaluate(`document.querySelector('.telnet-log')?.innerText ?? ''`);
check(/\bGA\b/.test(telnetLog), 'GA prompt marker observed in the Telnet log');

// The Room card's working is one tooltip, not a face: the `How` face was
// removed once the room resolved reliably, and a face nobody opens costs a pill
// on every room. What survives is the badge saying how the room was resolved.
check(
  !(await evaluate(
    `[...document.querySelectorAll('.room-card .crumb')].some((t) => /how/i.test(t.innerText))`
  )),
  'the Room card no longer offers a How face'
);
const why = await evaluate(
  `document.querySelector('.room-card header .chip')?.getAttribute('title') ?? ''`
);
check(
  typeof why === 'string' &&
    /resolved by (coordinates|movement|unique-name|exit-signature)/.test(why),
  'and its badge still says which evidence answered',
  why
);

// ------------------------------------- assert: copy and paste out of the console
//
// The console is the one surface in this client somebody reads *while* it is
// being written to, so a selection has to survive the writing. It does that by
// being the same thing as a backscroll -- the pin the jump-to-latest button
// already reports on -- rather than a second kind of stillness that would have
// to be kept in step with it.
//
// Driven through the real clipboard, in main, because that is the part a unit
// test cannot reach: `clipboardIntent` decides what a chord means and is tested
// on its own, and everything after the decision is IPC.
{
  const shown = '.terminal-layer[data-shown="true"]';

  const menuEntries = async () =>
    JSON.parse(
      await evaluate(`
        JSON.stringify([...document.querySelectorAll('.popup-menu .entry')]
          .map((b) => ({ label: b.innerText.trim(), disabled: b.disabled })))
      `)
    );

  // A synthetic event, dispatched where a right-click would land: what is under
  // test is the menu, and CDP's own button-2 press would additionally exercise
  // Chromium's context-menu synthesis, which is not ours to prove.
  const rightClick = () =>
    evaluate(`
      (() => {
        const cell = document.querySelector('${shown} .terminal-cell');
        if (!cell) return false;
        const r = cell.getBoundingClientRect();
        cell.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.top + r.height / 2)
        }));
        return true;
      })()
    `);

  // A real key, so this also proves the menu keeps its own Escape: `useHotkeys`
  // listens in capture and stops propagation, and a menu that did not claim the
  // key would be dismissed by whatever the window does with it instead -- or
  // not at all.
  const dismissMenu = async () => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27
      });
    }
  };

  const clickEntry = (pattern) =>
    evaluate(`
      (() => {
        const entry = [...document.querySelectorAll('.popup-menu .entry')]
          .find((b) => ${pattern}.test(b.innerText));
        if (!entry || entry.disabled) return false;
        entry.click();
        return true;
      })()
    `);

  // Start from the live edge, so the pin this section is about is proven to
  // have been taken rather than found already off.
  await evaluate(`(document.querySelector('.jump-latest')?.click(), true)`);
  await sleep(300);
  check(
    !(await evaluate(`!!document.querySelector('.jump-latest')`)),
    'the console is following the game before anything is selected'
  );

  check(await rightClick(), 'right-clicking the console opens a menu');
  await sleep(250);
  const cold = await menuEntries();
  check(
    cold.length === 2 && /copy/i.test(cold[0]?.label) && /paste/i.test(cold[1]?.label),
    'offering Copy and Paste',
    JSON.stringify(cold)
  );
  // Greyed rather than absent: a menu whose entries come and go is one nobody
  // can learn the shape of, and this answers "why did nothing happen" first.
  check(cold[0]?.disabled === true, 'with Copy greyed out while nothing is selected');
  check(cold[1]?.disabled === false, 'and Paste offered regardless');

  await dismissMenu();
  await sleep(200);
  check(!(await evaluate(`!!document.querySelector('.popup-menu')`)), 'Escape closes it');
  check((await focusPath()) === 'terminal', 'and hands the keyboard back to the game');

  /*
   * A real drag across the grid. The press is what starts the hold -- xterm
   * does not announce a selection until the mouse comes up, and a gesture that
   * scrolled away under the hand would never finish.
   */
  const dragged = await evaluate(`
    (() => {
      const screenEl = document.querySelector('${shown} .xterm-screen');
      if (!screenEl) return 'no screen element';
      const r = screenEl.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return 'screen has no size: ' + JSON.stringify(r);
      const send = (target, type, x, y, buttons) =>
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window, detail: 1, button: 0, buttons,
          clientX: Math.round(x), clientY: Math.round(y)
        }));
      /*
       * A press, several moves and a release. One move is not a drag as far as
       * xterm's selection service is concerned: it extends the selection on
       * each mousemove, and a single jump to the far corner has been seen to
       * land outside the rows it has cells for.
       */
      const x0 = r.left + 4;
      const y0 = r.top + 4;
      const x1 = r.left + Math.min(r.width - 8, 240);
      const y1 = r.top + Math.min(r.height - 8, 80);
      send(screenEl, 'mousedown', x0, y0, 1);
      for (let step = 1; step <= 6; step += 1) {
        send(document, 'mousemove', x0 + ((x1 - x0) * step) / 6, y0 + ((y1 - y0) * step) / 6, 1);
      }
      send(document, 'mouseup', x1, y1, 0);
      return 'dragged';
    })()
  `);
  await sleep(250);
  const grabbed = await evaluate(
    `(window.__mudengineSelection ?? (window.getSelection()?.toString() ?? '')).slice(0, 60)`
  );

  await rightClick();
  await sleep(250);
  const hot = await menuEntries();
  const selected = hot[0]?.disabled === false;
  check(
    selected,
    'dragging across the console selects text, and Copy lights up',
    `${dragged}; selection ${JSON.stringify(grabbed)}; menu ` + JSON.stringify(hot)
  );
  await dismissMenu();
  await sleep(200);

  /*
   * The point of the hold, proved before anything lets go of it: the game goes
   * on talking and the reader keeps what they were reading.
   */
  liveSockets[0]?.write(
    Buffer.from('\r\nthe realm keeps talking while you read\r\n'.repeat(6), 'latin1')
  );
  await sleep(500);
  check(
    await evaluate(`!!document.querySelector('.jump-latest')`),
    'a selection holds the console still, exactly as backscrolling does'
  );

  /*
   * And copying is the *end* of the gesture. It used to leave the selection in
   * place, which left the console frozen where the reader had stopped it —
   * somebody who had just taken a copy went on playing into a view that had
   * quietly stopped following the game.
   */
  await rightClick();
  await sleep(250);
  check(await clickEntry('/copy/i'), 'Copy is clickable');
  await sleep(400);
  const copied = await evaluate(`window.mudengine.pasteText()`);
  check(
    typeof copied === 'string' && copied.trim().length > 0,
    'and what was selected reached the system clipboard',
    JSON.stringify(String(copied).slice(0, 40))
  );
  check(
    !(await evaluate(`!!document.querySelector('.jump-latest')`)),
    'copying releases the hold and returns to the live edge'
  );
  await rightClick();
  await sleep(250);
  const released = await menuEntries();
  check(
    released[0]?.disabled === true,
    'and drops the selection that was holding it -- otherwise it would freeze again on the next line',
    JSON.stringify(released)
  );
  await dismissMenu();
  await sleep(200);

  /*
   * Paste, down the path a keystroke takes. Nothing here reaches the socket on
   * its own: `Terminal.paste` raises the run as ordinary input, so it arrives
   * at the server having passed everything a typed command passes.
   */
  const pasted = `smoke-paste-${Date.now()}`;
  await evaluate(`window.mudengine.copyText(${JSON.stringify(pasted)})`);
  const beforePaste = Buffer.concat(received).length;
  await rightClick();
  await sleep(250);
  check(await clickEntry('/paste/i'), 'Paste is clickable');
  await sleep(400);
  check(
    Buffer.concat(received).subarray(beforePaste).includes(Buffer.from(pasted, 'latin1')),
    'and the clipboard reaches the server as input',
    JSON.stringify(Buffer.concat(received).subarray(beforePaste).toString('latin1').slice(0, 60))
  );
  check((await focusPath()) === 'terminal', 'leaving the caret in the game afterwards');
}

// ------------------------------------------------------ assert: server side

await evaluate(`(window.mudengine.input('${SESSION}', 'look\\r'), true)`);
await sleep(400);

const inbound = Buffer.concat(received);
check(
  inbound.includes(Buffer.from('look\r\n', 'latin1')),
  'command reached the server as CR LF',
  JSON.stringify(inbound.toString('latin1').slice(-40))
);
check(inbound.includes(Buffer.from('ANSI', 'latin1')), 'TERMINAL-TYPE answered with ANSI');

const nawsAt = inbound.indexOf(Buffer.from([IAC, SB, OPT_NAWS]));
check(nawsAt !== -1, 'NAWS window size reported');
if (nawsAt !== -1) {
  const cols = (inbound[nawsAt + 3] << 8) | inbound[nawsAt + 4];
  const rows = (inbound[nawsAt + 5] << 8) | inbound[nawsAt + 6];
  check(cols > 0 && rows > 0, 'NAWS carries a plausible geometry', `${cols}x${rows}`);
}

await capture('smoke-screenshot.png', 'workspace');

// ---------------------------------------------------- assert: command palette

// A real input event rather than a synthetic one, so this exercises the same
// capture-phase path a keystroke takes while the terminal holds focus.
await cdp('Input.dispatchKeyEvent', {
  type: 'keyDown',
  modifiers: 2,
  key: 'k',
  code: 'KeyK',
  windowsVirtualKeyCode: 75
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  modifiers: 2,
  key: 'k',
  code: 'KeyK',
  windowsVirtualKeyCode: 75
});
await sleep(400);
const paletteOpen = await evaluate(`!!document.querySelector('.palette')`);
check(paletteOpen, 'command palette opens on Ctrl+K');
if (paletteOpen) {
  const items = await evaluate(`document.querySelectorAll('.palette li').length`);
  check(items >= 4, 'palette lists its commands', `${items} items`);
  const iconless = await evaluate(`
    JSON.stringify([...document.querySelectorAll('.palette li[role=option]')]
      .filter((row) => !row.querySelector('svg.icon'))
      .map((row) => row.innerText.trim())
      .slice(0, 5))
  `);
  check(iconless === '[]', 'every command in the palette carries an icon', iconless);
  await capture('smoke-palette.png', 'palette');
}

// ------------------------------------------------------------------ screenshot

async function capture(file, label) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  if (!shot.result?.data) return fail(`screenshot capture failed (${label})`);
  const out = path.resolve('out', file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  pass(`${label} screenshot -> ${path.relative(process.cwd(), out)}`);
}

// ------------------------------------------------------- assert: session log

// The log is what you reach for after the backscroll is gone, so it has to be
// greppable: ANSI stripped, one session per file. The capture sits beside it
// now that `logging.capture` defaults on — one of each per connection, and a
// third file of either kind would mean a reconnect leaked into this session.
const allFiles = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : [];
const logFiles = allFiles.filter((name) => name.endsWith('.log'));
const captureFiles = allFiles.filter((name) => name.endsWith('.mudcap.jsonl'));
check(logFiles.length === 1, 'one log file per connection', JSON.stringify(allFiles));
check(captureFiles.length === 1, 'one capture file per connection', JSON.stringify(allFiles));
if (logFiles[0]) {
  const body = fs.readFileSync(path.join(LOG_DIR, logFiles[0]), 'utf8');
  check(/Obvious exits: north, south/.test(body), 'the session log captured server output');
  /*
   * The client asked `rm` on its own behalf and the console was spared the
   * answer -- but the log is a record of what happened, not of what was
   * painted, and the answer happened. The backscroll is what the console was
   * fed, so it is the one place the withheld line must be absent from.
   */
  /*
   * The Room card's action asks `rm` through the arbiter — the same path
   * every automated command takes — so the fake host must receive a second
   * `rm`, and the console must be spared its answer exactly as before.
   */
  const rmBefore = (
    Buffer.concat(received)
      .toString('latin1')
      .match(/rm\r\n/g) ?? []
  ).length;
  const asked = await evaluate(`
    (() => {
      const button = document.querySelector('.room-card .card-action[aria-label*="rm"]');
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  check(asked, "the Room card offers to ask 'rm' quietly");
  await sleep(600);
  const rmAfter = (
    Buffer.concat(received)
      .toString('latin1')
      .match(/rm\r\n/g) ?? []
  ).length;
  check(
    rmAfter === rmBefore + 1,
    'and pressing it sends one rm to the realm',
    `${rmBefore} -> ${rmAfter}`
  );
  check(/Location: 1,2140/.test(body), 'the log still holds the answer to a quiet command');
  const fed = await evaluate(`window.mudengine.attach('${SESSION}').then((s) => s.backscroll)`);
  check(
    typeof fed === 'string' && fed.length > 0 && !fed.includes('Location: 1,2140'),
    'and the console was never shown it',
    typeof fed === 'string' ? `${fed.length} chars` : String(fed)
  );
  // The echo follows the prompt's repaint marker, not a newline, so the
  // test is for `rm` at the start of a row however the row was started.
  check(
    typeof fed === 'string' && !/(?:\n|\[K)rm\r\n/.test(fed),
    'nor the echo of the command that asked'
  );
  check(
    typeof fed === 'string' &&
      /Obvious exits: north, south/.test(fed.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')),
    'while everything else reached it'
  );
  check(!/\u001b\[/.test(body), 'the session log is stripped of ANSI, so it greps');
  check(/^--- session 127\.0\.0\.1:/.test(body), 'the log names the server it recorded');
}

// ------------------------------------------------------------------ disconnect

await cdp('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await sleep(300);
check(!(await evaluate(`!!document.querySelector('.palette')`)), 'palette dismisses on Escape');
check(
  (await focusPath()) === 'terminal',
  'focus returns to the terminal after Escape',
  await focusPath()
);

// Escape also dismisses the rail, which never held focus. That key is bound at
// the window only while something is open, because a bare Escape has to keep
// reaching the game the rest of the time.
if (!(await evaluate(`!!document.querySelector('.link-card')`))) {
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'D',
    code: 'KeyD',
    windowsVirtualKeyCode: 68,
    modifiers: 10
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'D',
    code: 'KeyD',
    windowsVirtualKeyCode: 68,
    modifiers: 10
  });
  await sleep(300);
}
check(
  await evaluate(`!!document.querySelector('.link-card')`),
  'diagnostics open from the rail shortcut'
);
check(
  (await focusPath()) === 'terminal',
  'opening the rail leaves focus in the terminal',
  await focusPath()
);

await cdp('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await cdp('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27
});
await sleep(300);
check(
  !(await evaluate(`!!document.querySelector('.link-card')`)),
  'Escape dismisses the diagnostics'
);
check((await focusPath()) === 'terminal', 'the terminal still holds focus', await focusPath());

// Scrolling away from the live edge offers the jump affordance; using it has to
// land focus back in the terminal rather than leaving it on the button.
// A real wheel event rather than assigning `scrollTop`: xterm only publishes a
// scroll when its own viewport handler runs, so a synthetic property write
// moves the element without the terminal ever noticing.
const box = await evaluate(`
  (() => {
    const r = document.querySelector('.xterm-screen').getBoundingClientRect();
    return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2);
  })()
`);
const [wheelX, wheelY] = box.split(',').map(Number);
for (let i = 0; i < 12; i += 1) {
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: wheelX,
    y: wheelY,
    deltaX: 0,
    deltaY: -240
  });
}
await sleep(400);
const jumpShown = await evaluate(`!!document.querySelector('.jump-latest')`);
check(jumpShown, 'scrolling up offers the jump-to-latest affordance');
if (jumpShown) {
  await evaluate(`(document.querySelector('.jump-latest').click(), true)`);
  await sleep(300);
  check(
    (await focusPath()) === 'terminal',
    'jump to latest returns focus to the terminal',
    await focusPath()
  );
}

// --------------------------------------------- assert: two characters, no leaks
//
// Cross-talk -- one character's bytes, state or keystrokes reaching another's
// surface -- is the defining bug of a multi-session client, and the one least
// likely to be noticed by playing: it looks like a glitch until the day it
// looks like the wrong character casting.
{
  // Let anything already in flight land, so what follows measures the click
  // rather than whatever the previous check set going.
  await sleep(800);
  const beforeSwitch = Buffer.concat(received).length;

  await evaluate(`(document.querySelectorAll('.tab-rail .tab')[1].click(), true)`);
  await sleep(400);

  check(
    (await evaluate(
      `document.querySelector('.tab-rail .tab[data-active="true"] .name')?.innerText`
    )) === 'Second Character',
    'clicking a tab shows that character'
  );
  check(
    (await focusPath()) === 'terminal',
    'switching characters puts the caret in the terminal it switched to',
    await focusPath()
  );
  // Switching is a change of view, never a command. A bare Enter to "refresh"
  // would be a full room description that re-triggers everything listening for
  // one -- and the player did not type it.
  const sentOnSwitch = Buffer.concat(received).subarray(beforeSwitch);
  check(
    sentOnSwitch.length === 0,
    'switching characters sends nothing on the wire',
    `${sentOnSwitch.length} bytes: ${[...sentOnSwitch].map((b) => b.toString(16)).join(' ')}`
  );

  // Connect the second character. The status rail acts on the character being
  // shown, so this is the same gesture as before, aimed at a different one --
  // and it needs no address, because that character's file has its own.
  await evaluate(`(document.querySelector('.status-rail .phase').click(), true)`);

  let both = false;
  for (let i = 0; i < 60; i += 1) {
    if (perSocket.length === 2) {
      both = true;
      break;
    }
    await sleep(250);
  }
  check(both, 'the second character opens its own connection', `${perSocket.length} sockets`);
  await sleep(1200);

  // The stream card is the only place a character's framed output is readable
  // from the DOM -- xterm draws to a canvas -- so the rail has to be open. An
  // earlier check dismisses it with Escape.
  if (!(await evaluate(`!!document.querySelector('.stream-card')`))) {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'D',
      code: 'KeyD',
      windowsVirtualKeyCode: 68,
      modifiers: 10
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'D',
      code: 'KeyD',
      windowsVirtualKeyCode: 68,
      modifiers: 10
    });
    await sleep(400);
  }

  /** The framed stream for whichever character is being shown. */
  const streamText = () => evaluate(`document.querySelector('.stream-card')?.innerText ?? ''`);

  const second = await streamText();
  check(
    second.includes('marker-for-connection-1') && !second.includes('marker-for-connection-0'),
    "the shown character's stream is its own",
    second.includes('marker-for-connection-0') ? 'leaked connection 0' : 'ok'
  );

  // A keystroke reaches one socket. This is the runtime half of the addressed
  // contract: the type system makes an unaddressed send impossible to write,
  // and this proves the address is the right one.
  const beforeTyping = perSocket.map((chunks) => Buffer.concat(chunks).length);
  await evaluate(`(window.mudengine.input('smoke2', 'wave\\r'), true)`);
  await sleep(500);
  const firstGot = Buffer.concat(perSocket[0]).toString('latin1');
  const secondGot = Buffer.concat(perSocket[1]).toString('latin1');
  check(secondGot.includes('wave\r\n'), 'a keystroke reaches the character it was aimed at');
  check(
    !firstGot.slice(beforeTyping[0]).includes('wave'),
    'and reaches no other character',
    firstGot.slice(beforeTyping[0]).replace(/[^\x20-\x7e]/g, '.')
  );

  /*
   * The multibox instrument: an alert on a character nobody is looking at.
   *
   * The point of running four characters is that three of them are unattended,
   * and the point of the tab rail is that it reports on the ones whose terminal
   * is not on screen. Vitals and walk state already reached it; alerts did not,
   * so a hostile arriving in an unattended character's room raised nothing
   * anybody would ever see.
   *
   * Sent to *both* characters, so the assertion is about attendance rather than
   * about which socket got which bytes: the one being looked at must not raise
   * a mark, and the one that is not must.
   */
  {
    const hostile =
      '\x1b[0;36m         Current Adventurers\x1b[0m\r\n' +
      '\x1b[0;36m         ===================\x1b[0m\r\n' +
      '\x1b[0;31m         Villain  Cutthroat   -  Assassin\x1b[0m\r\n' +
      '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ';
    for (const socket of liveSockets) socket.write(Buffer.from(hostile, 'latin1'));
    await sleep(1500);

    const tabs = JSON.parse(
      await evaluate(`
        JSON.stringify([...document.querySelectorAll('.tab')].map((t) => ({
          active: t.dataset.active === 'true',
          mark: t.querySelector('.mark')?.innerText ?? '',
          level: t.querySelector('.mark')?.dataset.level ?? '',
          detail: t.querySelector('.mark')?.title ?? ''
        })))
      `)
    );
    const quiet = tabs.find((tab) => !tab.active);
    const watched = tabs.find((tab) => tab.active);

    check(
      /alert/i.test(quiet?.mark ?? ''),
      'an alert on an unattended character reaches its tab',
      JSON.stringify(tabs)
    );
    check(quiet?.level === 'critical', 'and says how loud it is', JSON.stringify(quiet));
    /* The count says how much; the tooltip says what, without the tab growing
       to hold a sentence. */
    check(
      /Cutthroat/.test(quiet?.detail ?? ''),
      'and names what happened, without growing to fit it',
      JSON.stringify(quiet)
    );
    /* Seen is seen: the character being looked at raises nothing, because
       whatever happened is already on its Alerts card. */
    check(
      !/alert/i.test(watched?.mark ?? ''),
      'and the character being watched raises nothing',
      JSON.stringify(watched)
    );

    /*
     * And once the fight is over, the condition underneath it.
     *
     * A character that thinks it is sneaking and is not walks into the next
     * lair in plain sight, so this is on screen and not only in a guard. Sent
     * here rather than in the opening volley because combat outranks it on the
     * badge, and the fight has to end before anything else can be said.
     */
    for (const socket of liveSockets) {
      socket.write(Buffer.from('\x1b[0;36m*Combat Off*\r\nSneaking...\r\n', 'latin1'));
    }
    await sleep(900);
    check(
      /sneaking/i.test(
        await evaluate(`document.querySelector('.vitals-card .badge')?.innerText ?? ''`)
      ),
      'and once the fight is over, Vitals says the character is moving unseen',
      await evaluate(`document.querySelector('.vitals-card .badge')?.innerText ?? ''`)
    );

    // Looking at it is what "seen" means.
    await evaluate(`
      (() => {
        const tab = [...document.querySelectorAll('.tab')].find((t) => t.dataset.active !== 'true');
        if (tab) tab.click();
        return !!tab;
      })()
    `);
    await sleep(700);
    check(
      !/alert/i.test(
        await evaluate(`document.querySelector('.tab[data-active="true"] .mark')?.innerText ?? ''`)
      ),
      'and clears once somebody looks at it'
    );
  }

  /*
   * The other orientation, from the palette. Not one control at two angles:
   * `left` spends horizontal space, which is the expensive axis, and buys room
   * for health in numbers and the room the character is in.
   */
  await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', ctrlKey: true, bubbles: true
  })), true)`);
  await sleep(300);
  await evaluate(`
    (() => {
      const el = document.querySelector('.palette input');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'tabs');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(250);

  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.palette li')]
        .find((li) => /Tabs on the left/.test(li.innerText));
      if (row) row.click();
      return !!row;
    })()
  `);
  await sleep(450);
  check(
    (await evaluate(`document.querySelector('.tab-rail')?.dataset.side`)) === 'left',
    'the rail moves to the other edge from the palette'
  );
  check(
    await evaluate(`!!document.querySelector('.tab-rail .tab .figures')`),
    'the vertical rail shows health in numbers, which the compact one cannot'
  );
  // The vertical rail plus an open diagnostics rail can push the console below
  // the width the game formats to. The client must say so rather than correct
  // it -- and rather than let a sheared map be the first anyone hears of it.
  const cols = await evaluate(`
    (document.querySelector('.status-rail .metric b')?.innerText ?? '').split('\u00d7')[0]
  `);
  const narrow = await evaluate(
    `!!document.querySelector('.status-rail .metric[data-narrow="true"] .narrow')`
  );
  check(
    Number(cols) >= 80 ? !narrow : narrow,
    'a console below 80 columns is reported as narrow, and one at or above is not',
    `${cols} columns, ${narrow ? 'flagged' : 'not flagged'}`
  );

  // Everything still has to fit: a rail on the left must not push the console
  // past the bottom of the window.
  const leftBox = await evaluate(`
    (() => {
      const q = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      };
      return {
        win: window.innerHeight,
        app: q('.app'),
        work: q('.workspace'),
        stack: q('.terminal-stack'),
        layers: q('.terminal-layers'),
        cell: q('.terminal-cell'),
        rail: q('.status-rail')
      };
    })()
  `);
  log('     left layout', JSON.stringify(leftBox));
  check(
    leftBox.rail && leftBox.rail.bottom <= leftBox.win + 1,
    'the status rail is still on screen with the rail on the left',
    `rail bottom ${leftBox.rail?.bottom} vs window ${leftBox.win}`
  );
  check(
    leftBox.cell && leftBox.cell.bottom <= leftBox.rail.top,
    'the console ends above the status rail rather than under it',
    `console bottom ${leftBox.cell?.bottom} vs rail top ${leftBox.rail?.top}`
  );

  /*
   * And at a window tall enough to change the row count. The reported clipping
   * was height-dependent, so a check that only ever runs at one height would
   * have kept passing while the console lost its bottom line.
   */
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1400,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(900);
  const fitBox = await evaluate(`
    (() => {
      const mount = document.querySelector('.terminal-mount');
      const screen = document.querySelector('.xterm-screen');
      if (!mount || !screen) return null;
      const cs = getComputedStyle(mount);
      return {
        win: window.innerHeight,
        content: Math.round(mount.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
        screen: Math.round(screen.getBoundingClientRect().height),
        railBottom: Math.round(document.querySelector('.status-rail').getBoundingClientRect().bottom)
      };
    })()
  `);
  log('     tall layout', JSON.stringify(fitBox));
  check(
    fitBox && fitBox.screen <= fitBox.content,
    'every terminal row fits inside the console rather than being clipped',
    `${fitBox?.screen}px of rendered rows in ${fitBox?.content}px of room`
  );
  check(
    fitBox && fitBox.railBottom <= fitBox.win + 1,
    'the status rail stays on screen at a tall window',
    `rail bottom ${fitBox?.railBottom} vs window ${fitBox?.win}`
  );
  await cdp('Emulation.clearDeviceMetricsOverride', {});
  await sleep(600);

  await capture('smoke-tabs-left.png', 'vertical tab rail');
  // Back to top, so the rest of the run sees the shape the options file asked
  // for.
  await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k', ctrlKey: true, bubbles: true
  })), true)`);
  await sleep(300);
  await evaluate(`
    (() => {
      const el = document.querySelector('.palette input');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'tabs');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(250);

  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.palette li')]
        .find((li) => /Tabs on top/.test(li.innerText));
      if (row) row.click();
      return !!row;
    })()
  `);
  await sleep(400);

  /*
   * Split, so both characters are on screen at once. Stacked first, because
   * rows are cheap: the smoke window is 1100px wide and two 80-column consoles
   * do not fit beside each other in it -- which is the case the gate exists for.
   */
  const split = async (label) => {
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true
    })), true)`);
    await sleep(300);
    // Typed, not browsed: the palette opens to collapsed pinned groups.
    await evaluate(`
      (() => {
        const el = document.querySelector('.palette input');
        if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        set.call(el, ${JSON.stringify(label)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(250);
    return evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.palette li')]
          .find((li) => ${JSON.stringify(label)} && li.innerText.includes(${JSON.stringify(label)}));
        if (row) row.click();
        return !!row;
      })()
    `);
  };

  await split('Split: also show');
  await sleep(700);
  const panes = await evaluate(`
    (() => {
      const box = document.querySelector('.terminal-layers');
      const shown = [...document.querySelectorAll('.terminal-layer[data-shown="true"]')];
      return {
        flow: box.dataset.flow,
        shown: shown.length,
        focused: document.querySelectorAll('.terminal-layer[data-focused="true"][data-shown="true"]').length,
        widths: shown.map((el) => Math.round(el.getBoundingClientRect().width)),
        tops: shown.map((el) => Math.round(el.getBoundingClientRect().top))
      };
    })()
  `);
  check(
    panes.shown === 2,
    'splitting puts two characters on screen at once',
    JSON.stringify(panes)
  );
  check(
    panes.flow === 'rows' && panes.tops[0] !== panes.tops[1],
    'stacked, because rows are cheap and columns are not',
    JSON.stringify(panes)
  );
  check(panes.focused === 1, 'and exactly one pane has the keyboard', `${panes.focused} focused`);
  // Both panes are the full width, so neither has been narrowed below the floor.
  check(
    panes.widths[0] === panes.widths[1] && panes.widths[0] >= 400,
    'stacked panes keep the full width of the slate',
    JSON.stringify(panes.widths)
  );

  /*
   * Now ask for side by side in a window that cannot afford it. The client must
   * refuse and say why: the server never negotiates NAWS, so there is no third
   * remedy where it reformats to a narrower console.
   */
  await split('Panes side by side');
  await sleep(700);
  const sideBySide = await evaluate(`
    (() => {
      const box = document.querySelector('.terminal-layers');
      const cols = (document.querySelector('.status-rail .metric b')?.innerText ?? '').split('\u00d7')[0];
      return { flow: box.dataset.flow, cols: Number(cols) };
    })()
  `);
  log('     side-by-side', JSON.stringify(sideBySide));
  check(
    sideBySide.flow !== 'columns' || sideBySide.cols >= 80,
    'a side-by-side split either fits 80 columns or does not happen',
    JSON.stringify(sideBySide)
  );

  /*
   * And at a window that can afford it. A gate that always refuses is
   * indistinguishable from a feature that does not work, so the interesting
   * assertion is not that narrow is refused but that wide is allowed.
   */
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 2400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(900);
  await split('Panes side by side');
  await sleep(900);
  const wide = await evaluate(`
    (() => {
      const box = document.querySelector('.terminal-layers');
      const cols = (document.querySelector('.status-rail .metric b')?.innerText ?? '').split('\u00d7')[0];
      const narrow = !!document.querySelector('.status-rail .metric[data-narrow="true"]');
      return { flow: box.dataset.flow, cols: Number(cols), narrow };
    })()
  `);
  log('     wide side-by-side', JSON.stringify(wide));
  check(
    wide.flow === 'columns',
    'a window wide enough gets its side-by-side split',
    JSON.stringify(wide)
  );
  check(
    wide.cols >= 80 && !wide.narrow,
    'and each console still has the columns the game formats to',
    JSON.stringify(wide)
  );
  await capture('smoke-panes.png', 'side-by-side panes');
  await cdp('Emulation.clearDeviceMetricsOverride', {});
  await sleep(700);

  // Back to stacked and one pane for the rest of the run.
  await split('Panes stacked');
  await sleep(600);
  await split('Close this pane');
  await sleep(600);
  check(
    (await evaluate(`document.querySelectorAll('.terminal-layer[data-shown="true"]').length`)) ===
      1,
    'closing a pane leaves the other showing'
  );

  // Back to the first, and its own stream is still its own.
  await evaluate(`(document.querySelectorAll('.tab-rail .tab')[0].click(), true)`);
  await sleep(500);
  const first = await streamText();
  check(
    first.includes('marker-for-connection-0') && !first.includes('marker-for-connection-1'),
    'switching back shows the first character, and only it',
    first.includes('marker-for-connection-1') ? 'leaked connection 1' : 'ok'
  );
}

// ------------------------------------------- assert: a character in its own window
//
// docs/profiles.md §7.4: a popped-out character is a second window loading the
// same renderer, with its own tab rail. **The session does not move** — it is
// in main and it never moves, so this is a `detach` from one window and an
// `attach` to another. Nothing here may touch a socket.
//
// The gesture is a command rather than a drag: Electron has no built-in for
// dragging a tab between windows, and doing it properly means a hand-rolled
// drag session, a drop protocol and a fallback for the drag that ends over
// nothing. This is the whole capability minus the gesture.
{
  /** Every renderer window the app currently has, as CDP page targets. */
  const pages = async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.filter((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  };

  /** Asks one question of another window, over its own CDP connection. */
  const askWindow = async (page, expression) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      socket.onopen = res;
      socket.onerror = rej;
    });
    const answer = await new Promise((resolve) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message.result?.result?.value);
      };
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      );
    });
    socket.close();
    return answer;
  };

  const socketsBefore = liveSockets.length;
  /*
   * Keyed on the session id, not the displayed name: the realm names characters
   * and one account's alts often differ only by slot, so two tabs can read the
   * same and comparing text would pass by accident.
   */
  const tabsBefore = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.tab')].map((t) => t.dataset.session))`
    )
  );
  check(
    tabsBefore.length >= 2,
    'two characters to move between windows',
    JSON.stringify(tabsBefore)
  );

  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2
  });
  await sleep(300);
  await evaluate(`
    (() => {
      const el = document.querySelector('.palette input');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'window');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(250);

  const popped = await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.palette li')]
        .find((li) => /Move to a new window/.test(li.innerText));
      if (row) row.click();
      return row ? row.innerText : '';
    })()
  `);
  check(popped !== '', 'the palette offers a window of its own', popped);
  await sleep(1500);

  const after = await pages();
  check(after.length === 2, 'a second window opens', `${after.length} windows`);

  /*
   * The whole point, and the thing that would be worst to get wrong: no socket
   * was closed and none was opened. A pop-out that reconnected would look
   * identical on screen and cost somebody their place in the realm.
   */
  check(
    liveSockets.length === socketsBefore,
    'and no character was disconnected or redialled',
    `${socketsBefore} -> ${liveSockets.length}`
  );

  /*
   * Told apart by CDP target id, not by how many tabs each has: with two
   * characters both windows hold one, so counting would classify them at
   * random and pass by accident.
   */
  const tabsIn = async (page) =>
    JSON.parse(
      (await askWindow(
        page,
        `JSON.stringify([...document.querySelectorAll('.tab')].map((t) => t.dataset.session))`
      )) ?? '[]'
    );
  const fresh = after.find((page) => page.id !== target.id);
  const original = after.find((page) => page.id === target.id);

  // A brand-new window has a renderer to boot before it has a rail.
  let popOutTabs = [];
  for (let i = 0; i < 20; i += 1) {
    popOutTabs = fresh ? await tabsIn(fresh) : [];
    if (popOutTabs.length > 0) break;
    await sleep(400);
  }
  const mainTabs = original ? await tabsIn(original) : [];

  check(popOutTabs.length === 1, 'the new window holds one character', JSON.stringify(popOutTabs));
  /* Two tabs for one character in two windows is two places to type at it, and
     typing has to reach exactly one session. */
  check(
    popOutTabs.length === 1 && !mainTabs.includes(popOutTabs[0]),
    'and it is gone from the window it came from',
    JSON.stringify({ popOutTabs, mainTabs })
  );
  check(
    mainTabs.length === tabsBefore.length - 1,
    'and the window it came from keeps the rest',
    JSON.stringify({ tabsBefore, mainTabs })
  );

  // And back, which is what makes popping out something somebody will risk.
  await cdp('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 75,
    modifiers: 2
  });
  await sleep(300);
  // Typed, not browsed: the palette opens to collapsed pinned groups.
  await evaluate(`
    (() => {
      const el = document.querySelector('.palette input');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      set.call(el, 'window');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(250);
  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.palette li')]
        .find((li) => /every character into this window/i.test(li.innerText));
      if (row) row.click();
      return !!row;
    })()
  `);
  await sleep(1500);

  check((await pages()).length === 1, 'moving them back closes the empty window');
  const home = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.tab')].map((t) => t.dataset.session))`
    )
  );
  check(
    home.length === tabsBefore.length,
    'and every character has a tab again',
    JSON.stringify({ tabsBefore, home })
  );
  check(
    liveSockets.length === socketsBefore,
    'still without touching a socket',
    `${socketsBefore} -> ${liveSockets.length}`
  );
}

// ------------------------------------- assert: a remount does not lose the session
//
// Sessions belong to the app, not to a window (docs/profiles.md §4), and main
// owns the retained output and replays it on attach (§6). A renderer that
// remounts must therefore come back to a live, populated client rather than a
// blank one that has quietly dropped its connection.
//
// Nothing else in this run reaches that path: the smoke session connects after
// the first mount, so its backscroll is empty when the terminal first attaches.
// Reloading is the only way to attach to a session that has already spoken.
//
// The stream card is the observable that matters. It renders from renderer
// state, and after a reload that state can only have come from the attach
// snapshot — so a populated card is proof the snapshot arrived, and an empty
// one is exactly the regression where `line` is routed to attached windows but
// nothing replays it.
{
  const railWasOpen = await evaluate(`!!document.querySelector('.stream-card')`);
  await cdp('Page.reload', {});
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(`!!document.querySelector('.status-rail')`)) break;
    await sleep(250);
  }
  await sleep(800);

  check(
    await evaluate(`!!document.querySelector('.status-rail .dot.connected')`),
    'the session survives a renderer remount'
  );

  // Open the rail if an earlier check left it closed: the stream card is the
  // whole point of reloading, so it has to be on screen to be read.
  if (!(await evaluate(`!!document.querySelector('.stream-card')`))) {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'D',
      code: 'KeyD',
      windowsVirtualKeyCode: 68,
      modifiers: 10
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'D',
      code: 'KeyD',
      windowsVirtualKeyCode: 68,
      modifiers: 10
    });
    await sleep(400);
  }

  /*
   * Rows, not innerText. Every card carries its own heading, so the card's text
   * is non-empty even when it has framed nothing — an earlier version of this
   * check asserted on that and passed with the replay deliberately disabled.
   * The fixture also stops talking 400 ms after connect, so any row present
   * here was framed before the reload and can only have come from the snapshot.
   */
  const rows = await evaluate(`document.querySelectorAll('.stream-card .row').length`);
  check(
    rows > 0,
    'the framed stream is replayed into a freshly mounted window',
    `${rows} rows, rail was ${railWasOpen ? 'open' : 'closed'}`
  );
}

/*
 * ------------------------------------------------------------ auto-reconnect
 *
 * A socket the **far end** kills, and the character coming back on its own.
 *
 * The one seam nothing else covers: `SessionHost.test.ts` supplies its own
 * `autoReconnect`, so the join between the profile file and the feature —
 * `autoReconnect: (id) => profileFor(id)?.autoReconnect ?? false` in
 * `index.ts` — is exercised by nothing, and the fixture never dropped a socket.
 * That is the shape this project already has two write-ups of: complete,
 * tested, and reached by nobody.
 *
 * `smoke.yaml` states no `autoReconnect`, so this also proves the default: a
 * profile written before the setting existed reads as **on**.
 */
{
  const before = liveSockets.length;
  check(before > 0, 'the fake host is holding a socket to drop', String(before));

  // Destroyed rather than ended: an unclean close from the far end is what a
  // dropped link looks like, and it is the only kind that is ever redialled.
  liveSockets[0]?.destroy();

  // The first rung is immediate, so this is one round trip rather than a wait.
  let back = false;
  for (let waited = 0; waited < 12_000 && !back; waited += 200) {
    await sleep(200);
    back = liveSockets.length >= before;
  }
  check(back, 'a dropped character is dialled back without being asked', `${liveSockets.length}`);
  await sleep(600);
  check(
    await evaluate(`!!document.querySelector('.status-rail .dot.connected')`),
    'and is connected again',
    await evaluate(`document.querySelector('.status-rail .dot')?.className ?? 'no dot'`)
  );
}

await evaluate(`(window.mudengine.disconnect('${SESSION}'), true)`);
await sleep(700);
const closed = await evaluate(`
  !!document.querySelector('.status-rail .dot.closed') ||
  !!document.querySelector('.status-rail .dot.closing')
`);
check(closed, 'disconnect returns the session to a closed state');

/*
 * The rail used to disappear entirely whenever a character was not in the realm.
 * With two characters on screen that reads as damage rather than as offline --
 * one has an instrument beside it and the other has a blank column, and nothing
 * says which. It also moved the console's width, which re-wraps a scrollback
 * nobody asked to re-wrap.
 */
check(
  await evaluate(`!!document.querySelector('.rail')`),
  'the rail keeps its space when the character leaves the realm'
);
check(
  await evaluate(`!!document.querySelector('.standby-card')`),
  'and says it is offline rather than emptying out',
  await evaluate(
    `JSON.stringify([...document.querySelectorAll('.rail .card')].map((c) => c.className))`
  )
);
/*
 * The bug this check found: the phase stayed `in-game` after the socket closed,
 * so the HUD went on reporting vitals and a room for a character that was gone.
 * It was invisible while the rail disappeared along with the connection.
 */
check(
  !(await evaluate(`!!document.querySelector('.rail .vitals-card')`)),
  'and stops reporting vitals for a character that is no longer in the realm'
);
const railWidthOffline = await evaluate(
  `Math.round(document.querySelector('.terminal-layers').getBoundingClientRect().width)`
);
check(
  Math.abs(railWidthOffline - railWidthInGame) <= 2,
  'and the console keeps its width, so the scrollback is not re-wrapped',
  `${railWidthInGame} -> ${railWidthOffline}`
);

/*
 * And every fight is written down.
 *
 * Nothing reads these yet, which is the point of collecting them: every
 * question worth asking about how a character fights needs a record that
 * predates the question. What is asserted is that a fight in this run reached
 * a file, and that the record carries the *conditions* as well as the
 * measurement — a damage figure with no level, class or gear beside it cannot
 * be compared with anything.
 */
{
  const file = path.join(HOME, 'fights', `${SESSION}.jsonl.gz`);
  let written = [];
  try {
    written = zlib
      .gunzipSync(fs.readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    written = [];
    check(false, 'the fight this run had is written down', `${file}: ${String(error)}`);
  }
  if (written.length > 0) {
    check(true, 'the fight this run had is written down');
    const fight = written[0];
    check(
      fight.mob === 'orc rogue' && fight.mine === 12,
      'with what it cost',
      JSON.stringify(fight).slice(0, 120)
    );
    check(
      fight.className === 'Warrior' && fight.level === 4 && fight.hpMax === 400,
      'and the character that fought it',
      JSON.stringify(fight).slice(0, 200)
    );
    check(
      Array.isArray(fight.gear) && fight.gear.some((worn) => worn.slot === 'Feet'),
      'and what it had on, which is half of why the number means anything',
      JSON.stringify(fight.gear)
    );
  }
}

// -------------------------------------------------------------------- shutdown

/*
 * Ending the app is a check, not just cleanup.
 *
 * This harness used to SIGKILL its way out, which is why a client that could
 * not finish quitting shipped: the app was never asked to end, so nothing ever
 * observed that it did not. What is asserted is the teardown itself: the line
 * the app prints on its way out, which is the same one a hung shutdown stops
 * before.
 *
 * The signal is what can be asserted on here rather than the window's own
 * close: quitting with somebody in the realm raises a modal confirmation, and
 * a headless run has nobody to answer it. The signal path skips the question
 * deliberately and runs the same teardown.
 */
if (!keepOpen) {
  /*
   * Ask first, let go of the debugger second.
   *
   * Closing the CDP socket and *then* signalling was the order for a while and
   * the signal was never acted on — the process stayed alive, which is not what
   * a lost stdout write looks like. The app is being asked to end either way;
   * this way it is asked while everything about it is still in the state the
   * run left it in, which is also the more faithful thing to assert about.
   */
  /*
   * Is main even answering?
   *
   * The two ways this check can fail look identical from outside and have
   * nothing in common: a signal handler that ran and lost its output, and a
   * main thread that never serviced the watcher. One IPC round trip separates
   * them — `listSessions` is answered *in main*, so a reply means the loop is
   * turning and a hang means it is not.
   */
  let responsive = 'no answer';
  try {
    const answered = await Promise.race([
      evaluate(`window.mudengine.listSessions().then(() => 'answered')`),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))
    ]);
    responsive = String(answered);
  } catch (error) {
    responsive = `threw: ${String(error)}`;
  }

  askAppToQuit();
  let ended = false;
  for (let i = 0; i < 120 && !ended; i += 1) {
    ended = /shutdown: disconnecting/.test(appOut);
    if (!ended) await sleep(50);
  }
  /*
   * Alive or not, because "it did not print the line" has two very different
   * causes and the diagnostic has to tell them apart: a signal that was ignored
   * leaves the process running, and a teardown whose output was lost leaves it
   * gone.
   */
  let alive = 'gone';
  try {
    process.kill(Number(signalledPid), 0);
    alive = 'still running';
  } catch {
    /* gone, which is what is expected */
  }
  ws.close();
  check(
    ended,
    'the app tears its sessions down on a signal instead of being killed',
    // Which process was asked, and the tail of what it said: "it did not print
    // the line" is not a diagnosis, and this is the check that runs when
    // nobody is watching.
    `main was ${responsive}; signalled ${signalledPid} (${alive}); out: ` +
      appOut.split('\n').slice(-2).join(' | ').slice(0, 120) +
      `; err: ` +
      appErr.split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 200)
  );
}

// ---------------------------------------------------------------------- finish

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);

if (!keepOpen) {
  clientSocket?.destroy();
  server.close();
  setTimeout(() => {
    // Whatever ignored the polite request goes now; the `exit` handler above
    // catches anything this misses.
    killApp('SIGKILL');
    process.exit(failures === 0 ? 0 : 1);
  }, 400);
}
