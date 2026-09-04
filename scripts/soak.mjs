/**
 * The overnight run: two characters, eight hours, and a record of everything
 * the client could not read or would not do.
 *
 * `play-probe.mjs` is one character playing for twenty minutes; this is the
 * same machinery pointed at the question that only *time* answers — what
 * breaks on the two-hundredth lap, what the client has no handler for, and
 * what a second character makes visible that one cannot. It is a **gap
 * finder**, not a feature: nothing here belongs in `src/`, and the run is
 * expected to end with a list of tickets rather than with a level.
 *
 *   SOAK_MS=28800000 npm run soak
 *
 * ## What it drives
 *
 * A **leader** (a fighter) and a **support** (a caster) chosen by the account
 * name in their own profile, never by the directory: two directories on this
 * machine point at the same account, and picking by filename would log one
 * account in twice and blame the server for the collision. Both dial the
 * sanctioned local realm through `localProfiles`, which is the only thing that
 * hands out a password.
 *
 * ## `sys` is the operator's, and only ever the harness's
 *
 * `sys go`, `sys addlives`, `sys create` are administrator commands that no
 * ordinary player on any realm has. **Nothing in `src/` may depend on them**
 * (docs/game-behaviour.md) and nothing here sends one unless `SOAK_SYS=1`,
 * because a run that leans on them measures a realm nobody else is playing.
 * They exist here for one reason: eight hours must not end at hour two behind
 * a door, in the dark, or on the temple floor with no lives left.
 *
 * ## What it writes
 *
 * One JSONL file per run, every line stamped and tagged, holding: every line
 * off the wire with the block types it classified into (or none, which is the
 * finding), every command sent and by whom, every notice the client raised,
 * every safety decision, and a phase line per act of the loop. `unread` is the
 * tag the analysis is built on — a line the classifier had no rule for is a
 * handler this client does not have.
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { FightLog } from '../src/main/session/FightLog.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import { commandOf } from '../src/shared/commands.ts';
import { isBlinding } from '../src/shared/character.ts';
import { HOST, PORT, configPath, localProfiles, skip, target } from './lib/local-realm.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SOAK_MS = Number(process.env.SOAK_MS ?? 8 * 60 * 60 * 1000);
const SYS = process.env.SOAK_SYS === '1';
const LEADER_ACCOUNT = (process.env.SOAK_LEADER ?? 'vaelor').toLowerCase();
const SUPPORT_ACCOUNT = (process.env.SOAK_SUPPORT ?? 'soul').toLowerCase();

/** Where the staging area is: somewhere quiet, reachable, and on the map. */
const STAGING = 'Newhaven, Village Entrance';
const GUILD = "Newhaven, Adventurer's Guild";
/* Not the road: the arena's monsters wander onto it and a rest there is
   rest, attack, fight, rest all evening (`play-probe`'s own finding). */
const REST = 'Newhaven, Narrow Path';
const RETREAT_BELOW = 0.35;
const RESUME_ABOVE = 0.85;
/** `sys create 1234` — the glowing pearl, for a room the character cannot see in. */
const PEARL_ITEM = 1234;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(`out/soak-${stamp}.jsonl`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT, { flags: 'w' });

/**
 * One line of the record.
 *
 * Everything goes to the file; only the decisions go to the console, because
 * eight hours of wire at one line each is not something a person reads as it
 * happens — it is something the analysis reads afterwards.
 */
function log(who, kind, text, extra = {}) {
  /*
   * `t` is when the line was *written down* and `at` is when it arrived; the
   * two differ by up to four seconds for a line, because the verdict on
   * whether anything read it waits for a batch to close. Anything reading this
   * file to reconstruct the order of the evening has to sort on `at ?? t`, or
   * every command appears to have been sent before the answer it was replying
   * to — which is how the first read of a dry run concluded `sys` produced no
   * output when it had produced four lines.
   */
  out.write(`${JSON.stringify({ t: Date.now(), at: Date.now(), who, kind, text, ...extra })}\n`);
  if (kind !== 'line') console.log(`[${new Date().toISOString().slice(11, 19)}] ${who} ${kind}: ${text}`);
}

/**
 * One soak at a time, enforced with a lock file rather than by remembering.
 *
 * A second run dials the *same accounts*, and the server answers by closing
 * one of the two sockets — which arrives in the record as `Connection closed
 * by remote host` ten seconds after a clean login, indistinguishable from the
 * realm dropping the client. It cost a dry run to work that out, and an
 * overnight run started on top of a forgotten one would cost the night.
 *
 * The pid is written down, and a lock whose process is gone is a leftover
 * rather than a claim: a run killed with `SIGKILL` must not lock the machine
 * out of the next one.
 */
const LOCK = path.resolve('out/soak.lock');
function claimTheRun() {
  try {
    const held = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (Number.isFinite(held) && held > 0) {
      try {
        // Signal 0 asks "is this pid alive" without sending anything.
        process.kill(held, 0);
        skip(`another soak is already running (pid ${held}); stop it first.`);
      } catch {
        console.log(`  (stale lock from pid ${held}; taking it)`);
      }
    }
  } catch {
    // No lock, or one that cannot be read: either way this run may have it.
  }
  fs.writeFileSync(LOCK, String(process.pid), 'utf8');
}
claimTheRun();

const profiles = localProfiles();
if (profiles.length === 0) skip(`no character on ${HOST}:${PORT} with credentials.`);

/**
 * Chosen by the **account**, not the directory.
 *
 * `profiles/main` logs in as `vaelor` and `profiles/vaelor2` logs in as
 * `soul`; a harness that picked `profiles/vaelor` would find nothing, and one
 * that picked by display name would run two sessions on one account and read
 * the server throwing the first out as a client defect. A profile with no
 * password never reaches here — `localProfiles` filters it out.
 */
function byAccount(account) {
  return (
    profiles.find(
      (profile) => (profile.config.connection.login.username ?? '').toLowerCase() === account
    ) ?? null
  );
}

const leaderProfile = byAccount(LEADER_ACCOUNT);
const supportProfile = byAccount(SUPPORT_ACCOUNT);
if (!leaderProfile) skip(`no character on ${HOST}:${PORT} logs in as "${LEADER_ACCOUNT}".`);
log('run', 'phase', `leader ${leaderProfile.id} plays ${LEADER_ACCOUNT}`);
if (supportProfile && supportProfile.id !== leaderProfile.id) {
  log('run', 'phase', `support ${supportProfile.id} plays ${SUPPORT_ACCOUNT}`);
} else {
  /*
   * Said out loud and the run continues single-handed. A soak that refused to
   * start because the second account is not configured would deliver eight
   * hours of nothing; a soak that quietly ran one character and reported on
   * "the party" would be worse.
   */
  log(
    'run',
    'phase',
    supportProfile
      ? `support skipped: "${SUPPORT_ACCOUNT}" resolves to the same character as the leader`
      : `support skipped: no character with credentials logs in as "${SUPPORT_ACCOUNT}"`
  );
}

const library = new RealmLibrary({
  shippedFile: path.resolve('resources/world/rooms.jsonl.gz'),
  cacheDir: path.join(path.dirname(configPath()), 'realms'),
  notify: (message) => log('run', 'realm', message)
});

/** Every kind of thing the run counts, so the summary is a measurement. */
const tally = {
  unread: new Map(),
  notices: new Map(),
  refusals: new Map(),
  deaths: 0,
  redials: 0,
  levels: 0,
  laps: 0,
  blows: 0,
  monsters: 0,
  sys: 0
};
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/**
 * How long a line waits before the run decides nothing read it.
 *
 * Longer than a batch takes to close — a listing ends on the status line that
 * follows it, which on this realm is one round trip — and short enough that a
 * crash loses seconds of record rather than minutes.
 */
const LINE_VERDICT_MS = 4000;

const MONSTER_BLOCKS = new Set(['mob-arrives-room', 'mob-hits', 'mob-misses']);
/** Every shape of "the server said no", counted apart from the unread lines. */
const REFUSAL_BLOCKS = new Set([
  'command-not-understood',
  'direction-failed',
  'open-failed',
  'bash-failed',
  'skill-failed',
  'attack-refused',
  'attack-ineffective',
  'spell-refused',
  'target-missing',
  'target-ambiguous',
  'command-ignored',
  'slow-down'
]);
const BLOW_BLOCKS = new Set(['user-hits', 'user-misses', 'mob-hits', 'mob-misses']);
/**
 * Lines that are noise rather than a gap.
 *
 * A blank line, the status line and the room's own decoration are not
 * "unhandled server responses" — they are lines the classifier deliberately
 * has no rule for, and counting them would bury the sixty that matter under
 * ninety thousand that do not.
 */
const NOISE = [
  /^\s*$/,
  /^\[HP=/,
  /^-{5,}$/,
  /^={5,}$/,
  /^\s*\.{3,}\s*$/
];

/** One character, driven. */
class Driver {
  constructor(profile, role) {
    this.profile = profile;
    this.role = role;
    this.blocksBySeq = new Map();
    /** Lines held until the batch that may cover them has closed. */
    this.pending = [];
    /** Line text a multi-line block has claimed, and when. */
    this.covered = new Map();
    this.unusable = new Set();
    this.recent = [];
    this.linesSeen = 0;
    this.phaseNote = '(connect)';
    this.equipRefusals = 0;
    /* When this character last died, so the two sentences of one death are one. */
    this.diedAt = 0;
    /** Set once the realm has said this character is not an operator. */
    this.noSys = false;
    this.world = library.load(profile.database).graph;
    this.fights = new FightLog(
      path.join(path.dirname(configPath()), 'fights', `${profile.id}.jsonl.gz`),
      { notice: (message) => log(role, 'fights', message) }
    );
    this.session = new SessionManager(
      {
        data: () => {},
        line: (line) => this.onLine(line),
        block: (block) => this.onBlock(block),
        character: () => {},
        command: (command, origin) => log(role, 'sent', command, { origin }),
        state: (state) => log(role, 'link', state.phase),
        telnet: () => {},
        notice: (message) => {
          bump(tally.notices, message.replace(/\d+/g, 'N').slice(0, 120));
          log(role, 'notice', message);
        },
        automation: (snapshot) => {
          const decision = snapshot?.safety?.at(-1);
          if (decision) log(role, 'safety', JSON.stringify(decision));
        }
      },
      this.world,
      {
        ...profile.config.automation,
        enabled: true,
        // The idle probe would spend commands on `l` all night; the run's own
        // loop asks for what it needs when it needs it.
        idle: { ...profile.config.automation.idle, enabled: false },
        loot: { coins: true, items: [] },
        combat: {
          ...profile.config.automation.combat,
          enabled: true,
          retaliate: true,
          whileWalking: true
        },
        health: { ...profile.config.automation.health, restBelow: 0.5 },
        /*
         * Running away is on, and that is a decision about the *characters*
         * rather than about the measurement.
         *
         * These are the player's own, one of them level 28 with forty million
         * experience on it, and an eight-hour unattended run is exactly the
         * shape of evening that ends with everything on the temple floor.
         * Walking out costs nothing a hangup does not cost far more of
         * (docs/greatermud/combat.md), and the escape path is worth measuring
         * in its own right — a client that never runs away all night has not
         * proved that it would. Which is precisely how the `flee` defect
         * survived: the escape *fired* every evening and the command it sent
         * did nothing, and no unattended run could tell the difference.
         */
        safety: {
          ...profile.config.automation.safety,
          retreat: {
            ...profile.config.automation.safety.retreat,
            enabled: true,
            belowHealth: Math.max(0.3, profile.config.automation.safety.retreat.belowHealth)
          }
        },
        /*
         * The feature this run exists to exercise hardest, and the reason the
         * transcript that started it exists: a route that stops at a locked
         * door stops the loop, and a loop that stops is an evening lost.
         */
        movement: {
          ...profile.config.automation.movement,
          openDoors: true,
          openTries: 2,
          pickLocks: true,
          pickTries: 3,
          bashDoors: true,
          bashTries: 3
        }
      },
      profile.config.connection.login,
      undefined,
      undefined,
      this.fights
    );
    this.session.resize({ cols: 80, rows: 24 });
    // Owned, and unref'd: a pending verdict must never be the thing keeping
    // the process alive after the run has finished.
    this.ticker = setInterval(() => this.flush(), 1000);
    this.ticker.unref?.();
  }

  onLine(line) {
    const text = line.plain.replace(/\s+$/, '');
    if (text.trim().length === 0) return;
    this.recent.push(text);
    if (this.recent.length > 200) this.recent.shift();
    this.linesSeen += 1;
    /*
     * Held, not decided.
     *
     * A one-line block is classified before the next tick and a **multi-line**
     * one is not: a batch carries the seq of its *first* line and closes only
     * when the status line terminates it, so a stat sheet's other nine lines
     * have no block against their own seq at all. Deciding at `setTimeout(…,
     * 0)` reported every one of them as a sentence the client cannot read —
     * ten false gaps per `st`, which over eight hours is the analysis buried
     * under the two listings this client parses best.
     *
     * So the verdict waits for the batch to close, and `flush` reconciles by
     * text as well as by seq.
     */
    this.pending.push({
      seq: line.seq,
      text,
      at: Date.now(),
      after: this.phaseNote,
      playing: this.me.phase === 'in-game'
    });
  }

  /** Everything held long enough for a batch to have closed over it. */
  flush(force = false) {
    const ripe = Date.now() - (force ? 0 : LINE_VERDICT_MS);
    while (this.pending.length > 0 && this.pending[0].at <= ripe) {
      const held = this.pending.shift();
      const types = (this.blocksBySeq.get(held.seq) ?? []).filter((t) => t !== 'unknown');
      const covered = this.covered.has(held.text.trim());
      /*
       * **The tag the whole analysis rests on.** A line inside the realm with
       * no block type and no batch over it is a sentence the server said and
       * this client had no rule for — which is exactly "server responses that
       * triggered no bot action". Counted by shape, digits folded to `N`, so
       * ninety thousand lines collapse to the few dozen distinct things
       * nobody has written a pattern for.
       *
       * **Only inside the realm.** Everything before the login prompt is a
       * BBS front-end's banner — a realm menu, an ANSI logo, a topten list —
       * and the client has no rule for any of it on purpose: it is not the
       * game. Counted, it was 200 of the 208 unread lines in a two-minute dry
       * run and would have buried every real gap under a menu.
       */
      if (held.playing && types.length === 0 && !covered && !NOISE.some((r) => r.test(held.text))) {
        bump(tally.unread, held.text.replace(/\d+/g, 'N').slice(0, 110));
        log(this.role, 'unread', held.text, { after: held.after, at: held.at });
      } else {
        log(this.role, 'line', held.text, { after: held.after, at: held.at, types });
      }
    }
    // The covering record only has to outlive the hold.
    const stale = Date.now() - LINE_VERDICT_MS * 4;
    for (const [text, at] of this.covered) if (at < stale) this.covered.delete(text);
  }

  onBlock(block) {
    const types = this.blocksBySeq.get(block.seq) ?? [];
    types.push(block.type);
    this.blocksBySeq.set(block.seq, types);
    /*
     * A batch covers lines whose own seq it does not carry — see `onLine`.
     * Matched on the text, which is the only thing the block and the lines
     * that made it are guaranteed to share.
     */
    if (typeof block.text === 'string' && block.text.includes('\n')) {
      for (const part of block.text.split('\n')) {
        const key = part.trim();
        if (key.length > 0) this.covered.set(key, Date.now());
      }
    }
    if (MONSTER_BLOCKS.has(block.type)) tally.monsters += 1;
    if (BLOW_BLOCKS.has(block.type)) tally.blows += 1;
    if (block.type === 'shop-list' && 'rows' in block) {
      this.lastListing = block.rows;
      for (const row of block.rows) if (row.note) this.unusable.add(row.item.toLowerCase());
    }
    if (block.type === 'user-equipped-failed' && block.groups?.['item'] === undefined) {
      this.equipRefusals += 1;
    }
    /*
     * Everything the server refused, by shape. Not the same question as an
     * unread line: these *were* read, and the finding is how often the client
     * asked for something it could not have.
     */
    if (REFUSAL_BLOCKS.has(block.type)) {
      /*
       * `plain` is optional on a block — a multi-line one is assembled from
       * several and carries none — and reading it blind threw inside the
       * classifier, which `guardTheProcess` caught and reported as *"something
       * on this line could not be read"* twice per run. The harness must not
       * be the thing that breaks the parse it is measuring.
       */
      const said = typeof block.plain === 'string' ? block.plain : block.type;
      bump(tally.refusals, `${block.type}: ${said.slice(0, 80)}`);
    }
    /*
     * This character's own death.
     *
     * There is no `user-dies` block: the server composes a player's death as
     * `<Name> drops to the ground!` and then `<Name> is dead.`, so the *only*
     * thing separating our death from somebody else's is the name in it. Both
     * sentences carry the name, so the guard also keeps one death from being
     * counted twice.
     */
    if (block.type === 'player-dies') {
      const who = (block.groups?.['player'] ?? '').toLowerCase();
      const mine = (this.me.name ?? '').toLowerCase();
      if (who.length > 0 && who === mine && Date.now() - this.diedAt > 20_000) {
        this.diedAt = Date.now();
        void this.onDeath();
      }
    }
  }

  get me() {
    return this.session.character;
  }

  get health() {
    const { hp, hpMax } = this.me.vitals;
    return hp !== null && hpMax ? hp / hpMax : null;
  }

  get hereId() {
    const { map, number } = this.me.room;
    return map === null || number === null ? null : `${map}/${number}`;
  }

  get hereName() {
    return this.me.room.name ?? '';
  }

  /**
   * The command table is the gate: an unknown word is said out loud in the
   * room, and a run that spends eight hours doing that is a run announcing
   * this character's typos to everybody in Newhaven.
   *
   * **Except when the realm supplied the phrase.** A `Text:` exit exists
   * precisely *because* its verb is not in `Commands.cs` — `go skiff`,
   * `enter crimson` — so gating on the table refuses the one command that
   * works. The first dry run walked into the Docks and reported *"expected
   * Small Pier, arrived in Newhaven, Docks"* three times over, having sent
   * nothing at all, and then reached for the operator's teleport to get past
   * a gate the client can simply walk through.
   */
  async say(command, settle = 1500, fromRealm = false) {
    const word = command.split(/\s+/)[0] ?? '';
    if (command !== '' && !fromRealm && commandOf(word) === null) {
      log(this.role, 'refused', `not in the command table: ${command}`);
      return;
    }
    this.phaseNote = command === '' ? '<enter>' : command;
    this.session.send(`${command}\r`);
    await wait(settle);
  }

  /**
   * An operator command. Never sent unless the run was asked to, and never
   * again once this character has been told it is not an operator.
   *
   * `sys` is a *test realm's* and operator status is per character: measured
   * on 2026-08-30, `soul` answers every `sys` with `Your command had no
   * effect.` while `vaelor` does not. Sending them anyway is a command per
   * attempt out of the same budget the fight is being fought with, all night —
   * so the first refusal retires the whole vocabulary for that character and
   * says so once. Everything that reaches for `sys` already has a fallback
   * (walk instead of warp, carry a light instead of creating one), because
   * nothing in this run may *depend* on being an operator.
   */
  async sys(rest, settle = 2500) {
    if (!SYS) {
      log(this.role, 'phase', `sys declined (SOAK_SYS is not 1): sys ${rest}`);
      return false;
    }
    if (this.noSys) return false;
    tally.sys += 1;
    const before = this.linesSeen;
    await this.say(`sys ${rest}`, settle);
    if (this.sawSince(before, /^Your command had no effect\.$/)) {
      this.noSys = true;
      log(this.role, 'phase', 'this character is not an operator; no more sys commands');
      return false;
    }
    return true;
  }

  sawSince(mark, pattern) {
    return this.recent
      .slice(Math.max(0, this.recent.length - (this.linesSeen - mark)))
      .some((t) => pattern.test(t));
  }

  async untilOutOfCombat(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && this.me.inCombat) await wait(500);
  }

  /**
   * Death: put a life back and get out of the temple.
   *
   * Announced whatever happens. A run that died eleven times and said nothing
   * is a run whose experience curve nobody can read.
   */
  async onDeath() {
    tally.deaths += 1;
    log(this.role, 'death', `died in ${this.hereName || 'somewhere unplaced'}`);
    await wait(4000);
    /*
     * The **leader** puts the life back, whoever died: `sys` is granted per
     * character and only one of these two has it, and every operator command
     * takes the player it acts on by name. `this.sys` from the support would
     * spend a command to be told `Your command had no effect.`
     */
    await operator(`addlives ${this.profile.config.connection.login.username} 1`);
    await this.say('i', 2000);
  }

  async connect() {
    await this.session.connect(target());
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && this.me.phase !== 'in-game') await wait(250);
    return this.me.phase === 'in-game';
  }

  /** Back into the realm after a drop. Bounded: a server that is down stays down. */
  async redial() {
    tally.redials += 1;
    log(this.role, 'phase', `connection lost; redialling (${tally.redials})`);
    try {
      await this.session.connect(target());
    } catch (error) {
      log(this.role, 'phase', `redial failed: ${error?.message ?? error}`);
      return false;
    }
    const back = Date.now() + 90_000;
    while (Date.now() < back && this.me.phase !== 'in-game') await wait(500);
    if (this.me.phase !== 'in-game') return false;
    await this.say('rm', 2000);
    return true;
  }

  /**
   * What this character may walk through unaided.
   *
   * `text` is here because it is not an obstacle at all — the realm's own
   * `edgePenalty` prices it at zero, and `RouteStep.command` already carries
   * the phrase to send (`go skiff` rather than `w`). Leaving it out sent the
   * support back to the leader by *operator teleport* because `Small Pier is
   * gated (Text: borrow skiff, go skiff, row skiff)` — a gate the client can
   * walk through and this harness had talked itself out of.
   */
  passable(requirement) {
    if (requirement.kind === 'door' || requirement.kind === 'text') return true;
    if (requirement.kind === 'level') {
      const level = this.me.progress.level ?? 1;
      return level >= (requirement.minLevel ?? 0) && level <= (requirement.maxLevel ?? 999);
    }
    return false;
  }

  /**
   * Walks somewhere, one verified step at a time, and says why it stopped.
   *
   * The client's own `Walker` is exercised by the loop; this is the harness's
   * own legs for the errands a loop does not run — the guild, a shop, back to
   * the staging area — and it deliberately drives the *same* door ladder by
   * hand so the run reports whether opening, picking and bashing worked on the
   * live realm rather than only in the tests.
   */
  async walkTo(name, limit = 45) {
    let from = this.hereId;
    if (from === null) {
      await this.say('rm', 2500);
      from = this.hereId;
    }
    const destination = this.world.findByName(name)[0];
    if (from === null || destination === undefined) return `no route to ${name}`;
    const route = this.world.route(from, `${destination.map}/${destination.room}`);
    if (route.blocked) return route.reason ?? `no route to ${name}`;
    if (route.steps.length > limit) return `${name} is ${route.steps.length} steps away`;

    for (const step of route.steps) {
      if (step.requirement?.kind === 'door' || step.requirement?.kind === 'key') {
        const before = this.linesSeen;
        await this.say(`open ${step.direction}`, 1400);
        if (this.sawSince(before, /^The (?:door|gate) is locked\./)) {
          const forced = await this.force(step);
          log(this.role, 'barrier', `${step.name}: ${forced}`, {
            requirement: step.requirement.raw
          });
        }
      } else if (step.requirement && !this.passable(step.requirement)) {
        return `${step.name} is gated (${step.requirement.raw})`;
      }
      // A `Text:` exit is walked by its own phrase, which the step carries and
      // the command table does not have.
      await this.say(step.command, 1600, step.requirement?.kind === 'text');
      if (this.me.inCombat) await this.untilOutOfCombat(90_000);
      if (this.hereName.toLowerCase() !== step.name.toLowerCase()) {
        if (SYS) {
          const [map, room] = step.to.split('/');
          const account = this.role === 'leader' ? LEADER_ACCOUNT : SUPPORT_ACCOUNT;
          log(this.role, 'phase', `TEST REALM ONLY: warping past ${step.name} to ${map}/${room}`);
          /*
           * `sys move <plyr>`, never `sys go`: `go` moves *the character
           * typing it*, and only one of these two is an operator. The support
           * spent three attempts on `sys go` in a dry run and was told `Your
           * command had no effect.` each time.
           */
          await operator(`move ${account} ${map} ${room}`, 3000);
          if (this.hereName.toLowerCase() === step.name.toLowerCase()) continue;
        }
        return `expected ${step.name}, arrived in ${this.hereName || 'nowhere the data knows'}`;
      }
    }
    return null;
  }

  /**
   * Pick then bash, in that order and by hand — the ladder the walker now
   * drives itself, run here against the live realm so the record says which
   * rung actually opened the door.
   */
  async force(step) {
    const need = step.requirement ?? {};
    const picklocks = this.me.progress.picklocks;
    const strength = this.me.progress.strength;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.linesSeen;
      await this.say(`pi ${step.direction}`, 2500);
      if (this.sawSince(before, /^You successfully unlocked the/)) {
        await this.say(`open ${step.direction}`, 1500);
        return `picked (picklocks ${picklocks ?? '?'} against ${need.pickDifficulty ?? 'no number'})`;
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.linesSeen;
      await this.say(`bas ${step.direction}`, 2500);
      if (this.sawSince(before, /^You bashed the/)) {
        return `bashed (strength ${strength ?? '?'} against ${need.bashDifficulty ?? 'no number'})`;
      }
    }
    return `held (picklocks ${picklocks ?? '?'} / strength ${strength ?? '?'} against ${need.pickDifficulty ?? '?'})`;
  }

  dispose() {
    clearInterval(this.ticker);
    // Everything still held is still a record; a run that dropped its last
    // four seconds would drop the four that explain how it ended.
    this.flush(true);
    try {
      this.session.disconnect();
    } catch {
      // Already closed; a disposal must not be the thing that fails a run.
    }
    this.session.dispose();
    this.fights.dispose();
  }
}

const leader = new Driver(leaderProfile, 'leader');
const support =
  supportProfile && supportProfile.id !== leaderProfile.id
    ? new Driver(supportProfile, 'support')
    : null;

/**
 * The spells a support character asks its guild for, in the order a priest
 * learns them.
 *
 * By name, because the realm's own spell table is what `train` matches
 * against, and a name it does not know is refused in one line — which is a
 * finding rather than a failure. Nothing here decides *which* class the
 * character is: the run asks, the server answers, and the record says.
 */
const SUPPORT_SPELLS = ['cure light wounds', 'cure serious wounds', 'bless', 'protection'];

/**
 * A lair the realm data knows, holding something this character can fight.
 *
 * The hunting ground cannot be a constant: `Newhaven, Arena` is behind
 * `Level: 0 to 5` and the leader on this machine is level 28, so the first dry
 * run spent its whole two minutes reporting *"Docks is gated"*. The realm
 * already records what every lair spawns and what each of those has for
 * health, so the ground is **chosen** — the nearest lair whose occupants are
 * inside this character's reach and none of which the realm calls good, since
 * attacking one of those costs ten evil points a fight.
 */
function nearestLair(driver, exclude) {
  const from = driver.hereId;
  if (from === null) return null;
  const level = driver.me.progress.level ?? 1;
  const ceiling = 8 + level * 6;
  const floor = Math.max(3, level - 4);
  return driver.world.nearest(
    from,
    (room) => {
      if (room.name === exclude) return false;
      const mobs = driver.world.lairOf(room);
      return (
        mobs.length > 0 &&
        mobs.every((mob) => mob.hp >= floor && mob.hp <= ceiling && mob.costly !== 'always')
      );
    },
    80,
    (requirement) => driver.passable(requirement)
  );
}

/** What the leader does all night: hunt, retreat, rest, train, repeat. */
async function runLeader(until) {
  let lastCheck = 0;
  let lastLevel = leader.me.progress.level ?? 0;
  let ground = null;

  /*
   * Walk to the ground, choosing a new one when the old is unreachable.
   *
   * Three chances rather than one: a lair the route cannot reach is a fact
   * about *that* lair, and giving up on the evening because the nearest one is
   * behind a locked door is what this run exists to stop happening.
   */
  const reachGround = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (ground !== null) {
        const failed = await leader.walkTo(ground, 80);
        if (!failed) return true;
        log('leader', 'phase', `could not reach ${ground}: ${failed}`);
      }
      const lair = nearestLair(leader, ground);
      if (!lair || lair.steps.length === 0) {
        log('leader', 'phase', 'no lair within reach that this character can fight');
        ground = null;
        return false;
      }
      const there = lair.steps.at(-1);
      const mobs = leader.world
        .lairOf(leader.world.byId(there.to))
        .map((mob) => `${mob.name}(${mob.hp})`)
        .join(', ');
      log('leader', 'phase', `hunting ${there.name}, ${lair.steps.length} steps: ${mobs}`);
      ground = there.name;
    }
    return false;
  };
  await reachGround();

  while (Date.now() < until) {
    if (leader.me.phase !== 'in-game') {
      if (!(await leader.redial())) {
        await wait(60_000);
        continue;
      }
      await reachGround();
      continue;
    }
    const h = leader.health;
    if (h !== null && h < RETREAT_BELOW && !leader.me.inCombat) {
      log('leader', 'phase', `retreating at ${Math.round(h * 100)}%`);
      const road = await leader.walkTo(REST, 20);
      if (road) log('leader', 'phase', `retreat failed: ${road}`);
      const rested = Date.now() + 240_000;
      while (Date.now() < rested) {
        await wait(3000);
        const now = leader.health;
        if (now !== null && now >= RESUME_ABOVE) break;
        if (leader.me.inCombat) await leader.untilOutOfCombat(60_000);
      }
      await reachGround();
      continue;
    }
    if (leader.me.inCombat) {
      await wait(1000);
      continue;
    }

    if (Date.now() - lastCheck > 120_000) {
      lastCheck = Date.now();
      await leader.say('exp');
      const level = leader.me.progress.level ?? 0;
      if (level !== lastLevel) {
        tally.levels += 1;
        lastLevel = level;
      }
      log(
        'leader',
        'phase',
        `level ${level}, exp ${leader.me.progress.expThisSession} this session, ` +
          `needed ${leader.me.progress.expNeeded ?? '?'}, wealth ${leader.me.inventory.wealth ?? '?'}`
      );
      if ((leader.me.progress.expNeeded ?? 1) <= 0) {
        const guild = await leader.walkTo(GUILD, 25);
        if (!guild) {
          await leader.say('train', 3000);
          await leader.say('exp');
          // A level moved the maxima; the sheet is the cheap way to learn them.
          await leader.say('st', 2500);
        } else log('leader', 'phase', `could not reach the guild: ${guild}`);
        await reachGround();
        continue;
      }
      // Somewhere the server would not describe at all. `isBlinding` is the
      // client's own reading of which phrases mean that: `barely visible` and
      // `dimly lit` annotate a room that *was* described, and treating them as
      // darkness would send the character home from every lit corridor.
      if (isBlinding(leader.me.room.light)) await lightUp(leader);
      /*
       * The one enhancement this run will spend: `sys heal <plyr>`, on both,
       * when either is short and out of combat. Additive, undoable by simply
       * playing on, and it is what keeps eight hours from being spent sitting
       * down — the other half of the same question `restBelow` answers.
       */
      const low = (driver) => {
        const h = driver.health;
        return h !== null && h < 0.9;
      };
      if (!leader.me.inCombat && low(leader)) await operator(`heal ${LEADER_ACCOUNT}`);
      if (support && !support.me.inCombat && low(support)) {
        await operator(`heal ${SUPPORT_ACCOUNT}`);
      }
    }
    await wait(4000);
  }
}

/**
 * The support: follow, keep the leader up, and learn what it can.
 *
 * Deliberately thin. What is being measured is whether a *second* automated
 * character makes the client behave differently — whether the command window
 * is per connection or per host is unmeasured (docs/profiles.md §9.2) and this
 * is the run that would show it — not whether this harness can play a priest
 * well.
 */
async function runSupport(until) {
  log(
    'support',
    'phase',
    `${support.me.name} is a ${support.me.className ?? 'class the sheet has not said'} ` +
      `at level ${support.me.progress.level ?? '?'}`
  );

  /*
   * What this character already knows, once. The *guild* is not visited yet:
   * `train` at level 1 with 31 experience answers *"You do not have the
   * required experience necessary to train!"*, and walking eleven rooms away
   * from the leader to be told so breaks the party in its first minute — which
   * is what the dry run did.
   */
  await support.say('spells', 2500);

  let lastCheck = 0;
  let lastReunite = 0;
  let lastParty = 0;
  while (Date.now() < until) {
    if (support.me.phase !== 'in-game') {
      if (!(await support.redial())) {
        await wait(60_000);
        continue;
      }
      continue;
    }
    /*
     * Following is the whole of the coordination, and it is the realm's own
     * verb: `follow <name>` is how a leader is made here, and there is no verb
     * for the other direction. Re-asked when the party listing stops naming
     * one, because a death or a disconnect ends a party without saying so.
     */
    if (support.me.party.following === null && Date.now() - lastParty > 120_000) {
      lastParty = Date.now();
      await formParty();
    }
    /*
     * Back to wherever the leader actually is.
     *
     * Following keeps a party together while it walks and does nothing at all
     * once the two are apart — a death puts the support in the temple and no
     * amount of `follow` walks it back. Checked every minute, and only when
     * both characters are placed: a character the client cannot locate is not
     * a character in the wrong room, and warping on a guess is exactly the
     * move this project refuses everywhere else.
     */
    if (Date.now() - lastReunite > 60_000) {
      lastReunite = Date.now();
      const there = leader.hereId;
      const here = support.hereId;
      if (there !== null && here !== null && there !== here && !support.me.inCombat) {
        log('support', 'phase', `apart: leader in ${there}, support in ${here}`);
        const walked = await support.walkTo(leader.hereName, 40);
        if (walked) {
          log('support', 'phase', `could not walk back: ${walked}`);
          await moveBeside(support, leader);
        }
        await support.say(`follow ${leader.me.name || LEADER_ACCOUNT}`, 2000);
      }
    }
    /*
     * A level-1 priest walking behind a level-28 fighter is the shape this run
     * has, and it is the shape that kills it: the leader's lair holds things
     * with more health than the support has. Retreat is the same rule the
     * leader follows, and it is checked more often because the support has
     * further to fall.
     */
    const hurt = support.health;
    if (hurt !== null && hurt < RETREAT_BELOW && !support.me.inCombat) {
      log('support', 'phase', `retreating at ${Math.round(hurt * 100)}%`);
      const away = await support.walkTo(REST, 25);
      if (away) log('support', 'phase', `retreat failed: ${away}`);
      const rested = Date.now() + 240_000;
      while (Date.now() < rested) {
        await wait(3000);
        const now = support.health;
        if (now !== null && now >= RESUME_ABOVE) break;
        if (support.me.inCombat) await support.untilOutOfCombat(60_000);
      }
      lastReunite = 0;
      continue;
    }
    if (Date.now() - lastCheck > 180_000) {
      lastCheck = Date.now();
      await support.say('party', 2000);
      if ((support.me.progress.expNeeded ?? 1) <= 0) {
        const back = await support.walkTo(GUILD, 30);
        if (!back) {
          await support.say('train', 3000);
          for (const spell of SUPPORT_SPELLS) await support.say(`train ${spell}`, 2000);
        }
      }
      if (isBlinding(support.me.room.light)) await lightUp(support);
    }
    await wait(5000);
  }
}

/**
 * A room the character cannot see in.
 *
 * Three answers in order, and the run says which one it took. The first is the
 * operator's shortcut and the last is giving up on the room rather than on the
 * evening — a character stalled in the dark for six hours measures nothing.
 */
async function lightUp(driver) {
  log(driver.role, 'phase', `dark: ${driver.me.room.light}`);
  const carried = driver.me.inventory.items.map((item) => item.name.toLowerCase());
  const pearl = carried.find((name) => name.includes('pearl'));
  if (pearl) {
    await driver.say(`use ${pearl}`, 2000);
    if (!isBlinding(driver.me.room.light)) return 'used what it had';
  }
  if (await operator(`create ${PEARL_ITEM}`, 3000)) {
    await driver.say('get pearl', 2000);
    await driver.say('use pearl', 2000);
    if (!isBlinding(driver.me.room.light)) return 'created one';
  }
  const back = await driver.walkTo(STAGING, 45);
  log(driver.role, 'phase', back ? `still dark and stuck: ${back}` : 'still dark; went back to staging');
  return back ?? 'retreated';
}

/**
 * Gets the two travelling together, and says what the realm allowed.
 *
 * **Together first.** The first dry run sent `invite` from the Docks and
 * `join` from the Village Entrance and then read `You are not in a party at
 * the present time.` as a client defect; a party is formed between people in
 * the same room.
 *
 * **And a party is not what this realm gives.** Measured 2026-08-30: `join`
 * answers `Your party is full. Max party size is set to 0.` — parties are
 * switched off in this server's configuration and no operator command in the
 * whole `sys` list changes it. What *does* work is `follow`, which is a
 * different thing here: the follower walks behind the leader, the server says
 * so on every step (` -- Following your Party leader north --`), and the
 * party *listing* stays empty. So following is what this run coordinates on,
 * and the invitation is still attempted once so the refusal is on the record.
 *
 * All three words are the realm's own: `invite` offers, `join` accepts, and
 * following somebody *is* making them the leader here.
 */
async function formParty() {
  if (!support) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (leader.hereId !== null && support.hereId !== leader.hereId) {
      const walked = await support.walkTo(leader.hereName, 60);
      if (walked) {
        log('support', 'phase', `could not walk to the leader: ${walked}`);
        await moveBeside(support, leader);
      }
    }
    const name = support.me.name || SUPPORT_ACCOUNT;
    await leader.say(`invite ${name}`, 2500);
    await support.say(`join ${leader.me.name || LEADER_ACCOUNT}`, 2500);
    await support.say(`follow ${leader.me.name || LEADER_ACCOUNT}`, 2500);
    await leader.say('party', 2500);
    const together = support.me.party.following !== null || leader.me.party.members.length > 1;
    if (together) {
      log(
        'run',
        'phase',
        `travelling together on attempt ${attempt + 1}` +
          (leader.me.party.members.length > 1 ? ' (a real party)' : ' (following, no party)')
      );
      return true;
    }
    log('run', 'phase', `not together on attempt ${attempt + 1}`);
  }
  // Said out loud and the run continues. A soak that stopped because two
  // characters would not group would measure nothing at all.
  log('run', 'phase', 'not together; both characters run on their own');
  return false;
}

/**
 * Puts one character in the other's room with the operator's own command.
 *
 * **Issued by the leader**, always: `sys` is granted per character and only
 * the leader has it here — `soul` answers every `sys` with `Your command had
 * no effect.` — and every operator command in the list takes the player it
 * acts on by name. A harness that sent each character its own `sys` would have
 * concluded the command does not exist.
 */
async function moveBeside(who, beside) {
  const there = beside.hereId;
  if (there === null) return false;
  const [map, room] = there.split('/');
  const account = who === leader ? LEADER_ACCOUNT : SUPPORT_ACCOUNT;
  return leader.sys(`move ${account} ${map} ${room}`, 3000);
}

/**
 * An operator command, issued by whichever character actually has the powers.
 *
 * The realm grants `sys` per character: `vaelor` prints the whole list and
 * `soul` answers `Your command had no effect.` for every one. Every command in
 * that list takes the player it acts on **by name**, so one operator can look
 * after both — which is what makes the death, warp and heal paths work at all
 * for the character that is not one.
 *
 * **What this run will not send.** The list also holds `addexp`, `setability`,
 * `addcopper`, `retrain`, `seteps`, `setfirstname` and `removeitem`. These are
 * the player's own characters, one of them level 28 with forty million
 * experience on it, and none of those is undoable from here — "use available
 * enhancement commands" does not name one, and a soak is not the place to
 * decide which. `heal`, `addlives`, `create`, `go` and `move` are additive or
 * positional and are the whole of what is used.
 */
async function operator(rest, settle = 2500) {
  return leader.sys(rest, settle);
}

/** What the run found, as numbers and as the shapes behind them. */
function summarise() {
  const top = (map, n) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([text, count]) => ({ count, text }));
  const summary = {
    ranMs: Date.now() - started,
    deaths: tally.deaths,
    redials: tally.redials,
    levels: tally.levels,
    blows: tally.blows,
    monsterLines: tally.monsters,
    sysCommands: tally.sys,
    distinctUnread: tally.unread.size,
    unread: top(tally.unread, 60),
    refusals: top(tally.refusals, 40),
    notices: top(tally.notices, 40)
  };
  log('run', 'summary', 'what the run found', summary);
  console.log(`\n${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Record: ${OUT}\n`);
}

const started = Date.now();

async function main() {
  log('run', 'phase', `soaking for ${Math.round(SOAK_MS / 60000)} minutes; sys ${SYS ? 'on' : 'off'}`);
  if (!(await leader.connect())) {
    log('leader', 'phase', 'never reached the realm');
    return;
  }
  await wait(2500);
  await leader.say('who');
  await leader.say('exp');
  await leader.say('st', 2500);
  await leader.say('i');
  log(
    'leader',
    'phase',
    `${leader.me.name} (${leader.me.className}) level ${leader.me.progress.level} in ${leader.hereName}`
  );

  /*
   * Ask the operator what it can do, once, and write the answer down.
   *
   * The run knows four `sys` commands by name and the realm has a couple of
   * dozen. Rather than guess at the rest — `sys` is a *test realm's* and
   * guessing at an operator command is how a run reconfigures a character it
   * cannot put back — bare `sys` prints the list, and the list goes into the
   * record for whoever reads it afterwards.
   */
  await leader.sys('', 3000);

  if (support) {
    if (await support.connect()) {
      await wait(2500);
      await support.say('exp');
      await support.say('st', 2500);
      await formParty();
    } else {
      log('support', 'phase', 'never reached the realm; running single-handed');
    }
  }

  const until = started + SOAK_MS;
  const runs = [runLeader(until)];
  if (support && support.me.phase === 'in-game') runs.push(runSupport(until));
  /*
   * `allSettled`, never `all`: one character crashing must not take the other
   * down and lose the record of what it was doing when it happened. The
   * rejection is written to the file like everything else.
   */
  const settled = await Promise.allSettled(runs);
  for (const result of settled) {
    if (result.status === 'rejected') {
      log('run', 'phase', `a driver crashed: ${result.reason?.stack ?? result.reason}`);
    }
  }
}

let closing = false;
async function finish(code) {
  if (closing) return;
  closing = true;
  try {
    summarise();
  } finally {
    leader.dispose();
    support?.dispose();
    // The lock is this run's, so it goes with this run — including the one
    // that crashed, which is the run most likely to be started again at once.
    try {
      if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.rmSync(LOCK);
    } catch {
      // Already gone, or never written. Not a reason to fail an exit.
    }
    await wait(500);
    out.end(() => process.exit(code));
  }
}

/*
 * A run stopped by hand still has to leave its record behind: eight hours of
 * wire with no summary written because somebody pressed Ctrl-C is eight hours
 * spent for nothing.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('run', 'phase', `stopped by ${signal}`);
    void finish(0);
  });
}

main().then(
  () => finish(0),
  (error) => {
    log('run', 'phase', `crashed: ${error?.stack ?? error}`);
    void finish(1);
  }
);
