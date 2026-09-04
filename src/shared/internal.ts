/**
 * The client's *internal* settings: how it behaves about its own commands.
 *
 * Not the options file, and deliberately not a profile. The options file is
 * the player's — what to send, when to run, which alerts to raise — and every
 * value in it is a choice a player makes about a character. This is a choice
 * the *client* makes about itself: which of the commands it sends on its own
 * behalf are housekeeping the console should not be cluttered with. It lives
 * in its own file so that it can still be read, edited and hot-reloaded like
 * everything else, without a settings screen learning about it and without a
 * profile being able to override it into something two characters disagree
 * on.
 *
 * Dependency-free: main reads and coerces it, and the renderer may show it.
 */
import { bool, isRecord } from './values';

/**
 * Which of the client's own commands stay out of the console.
 *
 * A quiet command is one automation sends whose echo and answer are
 * withheld from the terminal until the status line that acknowledges it —
 * `rm`, which answers `Location: 1,2147` and is asked on every arrival so the
 * map knows where it is, and the idle `l` that re-reads the room every
 * forty-five seconds. Everything the *player* types is always shown, and so
 * is anything the server volunteers in the middle of the answer — a monster
 * walking in, somebody talking — because those are not the answer.
 */
export interface QuietConfig {
  enabled: boolean;
  /**
   * Command words, matched against the first word of what automation sent.
   *
   * The client's own room read has no first word — it is a bare Enter, so
   * that `l`'s `<name> is looking around the room.` is not broadcast every
   * few rounds — and answers to `enter` here instead (`BARE_ENTER`).
   */
  commands: string[];
}

export interface TerminalInternalConfig {
  quiet: QuietConfig;
  /**
   * Whether the console decorates what it recognises — a glyph beside a shop
   * or bank's name, a name that can be clicked for what the realm knows.
   * Nothing here touches the grid: decorations sit outside the cells, and a
   * sequence that counts rows or columns never sees them.
   */
  enrich: boolean;
}

/**
 * Which commands the palette pins to the top on a fresh client.
 *
 * The palette grew a command per loop, per server, per theme and per card —
 * useful to *search*, unreadable to *browse*. So it opens on a pinned section
 * and four collapsed group headings; typing still finds everything, because a
 * command nobody can find does not exist. Patterns are command ids, exact or
 * with a trailing `*` — `loop:*` is every configured loop, `pane:*` every
 * split — and are matched against the group the command *itself* declares, so
 * a pattern filed under the wrong heading names nothing.
 *
 * This is the shelf somebody *starts* with, not the shelf they keep: every
 * row's pin moves a command on or off it, and that choice is remembered per
 * client (`usePinnedCommands`) rather than written back here. A preference
 * changed by clicking must not make the client rewrite a file full of the
 * user's own comments — and editing this block still wins for any command it
 * changes its mind about.
 */
export interface PaletteInternalConfig {
  pinned: Record<string, string[]>;
}

/**
 * Which toolbar buttons a fresh client draws.
 *
 * The toolbar is one row of glyphs and the vocabulary behind it is every
 * automation switch plus the transport controls — far more than a row. So the
 * same two-source rule the palette's shelf follows applies here: this states
 * what somebody *starts* with, the kebab at the end of the row moves a button
 * on or off, and that choice is remembered per client rather than written back
 * (`useToolbarPins`). A preference changed by clicking must not make the
 * client rewrite a file full of the user's own comments — and editing this
 * block still wins for any button it changes its mind about.
 *
 * A flat list rather than the palette's map, because a toolbar button belongs
 * to no group: the row is the group.
 */
export interface ToolbarInternalConfig {
  pinned: string[];
}

/**
 * Every number the client uses to decide something, in one place.
 *
 * The rule this exists for: **no value that makes a determination is written
 * into the code that acts on it.** A timeout that turns out to be too short on
 * somebody's link, a retry count that is one too few for their realm, a cap
 * that truncates a listing their server actually sends — every one of those was
 * a code change, a rebuild and a release, for a number. They are all here now,
 * so the answer is an edit to a file the player owns.
 *
 * Two things follow from that, and both are deliberate:
 *
 * - **The type is derived from the defaults, not written beside them.**
 *   `TUNING_DEFAULTS` is the only statement of what exists; `TuningConfig` is
 *   `typeof` it. That is the closed-union rule taken one step further — a
 *   field cannot be in the type and not in the runtime shape, because there is
 *   only one shape.
 * - **The coercion walks that shape rather than naming each key.** A number
 *   added below is read, bounded and defaulted with no second edit, so the
 *   half that validates cannot fall behind the half that declares.
 *
 * What is deliberately *not* here: anything in `src/shared/` that is not this
 * file. That directory is dependency-free by rule so main, preload and the
 * renderer can all import it, which means nothing in it can read a file — so
 * `MAX_BLESSINGS`, `COPPER_PER_GOLD` and the filename cap stay where they are.
 * The first two are the realm's own arithmetic rather than a determination
 * this client makes; the third is a filesystem limit.
 */
const TUNING_DEFAULTS = {
  /** Framing, negotiation and the socket itself — `src/main/net/`. */
  net: {
    /**
     * How long to wait for a socket to open before giving up on it.
     *
     * Generous for a BBS on a slow link and far short of the operating
     * system's own patience, which is what matters: the OS gives up on an
     * unanswered SYN after roughly two minutes, and a client that waits that
     * long has already stopped being usable.
     */
    connectTimeoutMs: 15_000,
    /**
     * Trailing window in which repeated geometry changes coalesce into one
     * NAWS report. A pane transition remeasures on every frame; without this,
     * one drag puts a report on the wire per frame of it.
     */
    nawsCoalesceMs: 150,
    /**
     * Cap on a single unterminated line held in the framing buffer. Past this
     * the content is not a line in any useful sense and is released as one:
     * losing the framing beats losing the process.
     */
    maxPendingBytes: 64 * 1024,
    /**
     * Longest partial escape sequence held back while the rest of it is
     * awaited. CSI sequences in this domain are far shorter; the cap only
     * stops a stuck stream when a lone ESC arrives and nothing follows.
     */
    maxPartialEscapeBytes: 32,
    /**
     * How long after `end()` a closing socket is destroyed outright. `end()`
     * waits for the FIN handshake; this guarantees the socket is gone even if
     * the peer never replies.
     */
    destroyDelayMs: 250
  },
  /**
   * Dialling back a connection that was *lost* — `src/main/session/Reconnect.ts`.
   *
   * The ladder is `min(maxDelayMs, attempts * stepMs)`, so with the shipped
   * numbers the first attempt is immediate and the rest wait 5s, 10s, then 15s
   * for as long as it takes. Two keys rather than a list of four waits because
   * the shape generalises: somebody on a link that takes a minute to come back
   * raises `maxDelayMs` and gets a slower ladder, without a schedule to edit.
   */
  reconnect: {
    /** What each consecutive failure adds to the wait before the next one. */
    stepMs: 5_000,
    /** Where the wait stops growing, and sits for every attempt afterwards. */
    maxDelayMs: 15_000,
    /**
     * Consecutive failures before the client stops and says so.
     *
     * Effectively no limit, which is what somebody who left a character
     * connected overnight wants: a router that comes back at 4am should find
     * the client still asking. It is a number rather than a boolean so that a
     * limit is *available* — and so that "it retried for ever" is a value
     * somebody chose rather than a behaviour with nothing behind it.
     */
    maxAttempts: 999_999,
    /**
     * Consecutive connections that **opened and were dropped** before settling,
     * before the client stops dialling and says so.
     *
     * Far lower than `maxAttempts` and bounding a different thing. An outage
     * refuses or never answers, and dialling that for as long as it takes is
     * the whole point of the number above. A server that accepts and hangs up
     * seconds later is a full BBS, a realm rebooting — or a front end
     * answering a refused password with a sentence this client has no pattern
     * for, in which case the credentials go back out on every rung.
     */
    maxFlaps: 5,
    /**
     * How long a connection must hold before the next loss starts the ladder
     * over rather than continuing it.
     *
     * Without this the ladder resets on every socket that opens, and a server
     * that *accepts and immediately drops* — a full BBS, a realm rebooting —
     * is dialled again at the speed TCP can manage, for ever. That is the one
     * shape of this feature that would be worse than not having it, and it is
     * aimed at somebody else's host.
     */
    settledMs: 30_000
  },
  /** Reading the stream — `src/main/parse/`. */
  parse: {
    /** A text match on its own. Most blocks never get a colour opinion. */
    baseConfidence: 0.8,
    /** Text match plus the colour the rule expected. */
    colourAgrees: 0.95,
    /** Text matched, but not in the colour this rule usually wears. */
    colourDisagrees: 0.6,
    /**
     * Cap on description lines held for one room. A description is defined by
     * what it is *not*, so a room that never completes must not accumulate
     * without bound. Comfortably above the longest seen from the live server.
     */
    descriptionLines: 20,
    /**
     * Cap on the lines of a `who` listing.
     *
     * A key rather than a constant because it is the only listing whose length
     * is the **realm's** business: a `who` has one row per person logged in.
     * What actually ends the listing is the status line the server prints after
     * it, so this is the backstop for a realm whose prompt this client has
     * never met — and it has to sit above any population somebody plays on.
     *
     * It shipped as 60 beside the pattern, and a realm with more adventurers
     * than that truncated the roster: everybody past the sixtieth row was
     * dropped, the listing stopped marking them online, and the rows after the
     * cut were fed back through the classifier one at a time. The symptom was a
     * `who` listing on screen with the client saying the person on it was
     * offline.
     */
    rosterLines: 400,
    /**
     * How often a monster heals itself, in milliseconds.
     *
     * A monster regenerates on a server tick and **nothing announces it**, so a
     * wound estimate built from damage alone only ever falls and drifts below
     * the truth as a fight drags on. The realm data states the amount per
     * monster (`Monsters.HPRegen`) and the cadence is realm-wide; this is the
     * cadence.
     *
     * 30 s on GreaterMUD (6 rounds of 5 s) and 90 s on stock MajorMUD (18
     * rounds), read out of MMUD-Explorer's `GMUD_MOB_HPREGEN_ROUNDS` /
     * `STOCK_MOB_HPREGEN_ROUNDS` and its monster detail line, which spells both
     * out in words. GreaterMUD's is the default because it is this client's
     * default realm.
     *
     * **A key rather than a constant because realms change it.** The test realm
     * on `orohost` runs five times faster on purpose, which makes its tick 6 s —
     * and a number that moves by a factor of five between two servers of the
     * same game is exactly the kind this project refuses to bury beside the code
     * that acts on it.
     */
    mobRegenMs: 30_000,
    /** Remembered attackers in one fight. The names matter, not the count. */
    maxAttackers: 12,
    /** Monsters tracked in one fight. The oldest ledger is dropped. */
    maxLedgers: 8,
    /**
     * Unanswered room blocks remembered — directions, peeks and the client's
     * own re-reads share the queue. Deep enough for a burst a player can type
     * or a walk can enqueue, shallow enough that a client which has lost the
     * thread stops pretending.
     */
    maxPendingMoves: 12,
    /**
     * How long one of them may wait before the client gives up on it.
     *
     * The depth cap above and this are the same claim on two axes — *this
     * client has lost the thread* — and until 2026-09-03 only the depth one
     * existed. A sentence the parser cannot read answering a move leaves the
     * claim outstanding for ever, and six things gate on it: the escape,
     * `Walker.start`, `LoopRunner.advance`, the walk home and auto-combat.
     * Exactly one of those had a clock of its own, so a lost step cost a
     * character every one of the others for the rest of the session.
     *
     * Long enough to cover a step the server is slow with — the movement round
     * measured 1,239ms — and short enough that a fight is still a fight when
     * it lapses.
     */
    staleMoveMs: 8000,
    /**
     * Pack changes held against a listing that has not finished arriving. A
     * listing takes about a second; this covers what a person or a fight can
     * do in one, and no more.
     */
    maxPackChanges: 16,
    /** Possible rooms kept for the resolution trace. */
    maxRoomCandidates: 8,
    /**
     * The band a line has to be inside to be read as a room's name.
     *
     * Tuned against the capture corpus: the shipped realm's longest is well
     * inside the ceiling, and the floor is what keeps a two-letter answer from
     * being taken for a place. Losing a name is not cosmetic — the room block
     * completes with nothing to look up, so the client stops knowing where it
     * is standing.
     */
    roomNameMinChars: 3,
    roomNameMaxChars: 60
  },
  /** The one writer to the socket, and what drives it. */
  queue: {
    /**
     * How long a half-typed line keeps holding automation after the last
     * keystroke, before it is written off as abandoned. It has to survive any
     * pause a person actually takes mid-word — a release landing in the middle
     * of one produced `lpu thin kobold thief`, said out loud in the room
     * (captured live, 2026-08-26) — and it must not silence the keep-alive for
     * a whole evening because somebody typed two characters and walked away.
     */
    abandonedLineMs: 20_000,
    /** How long after the last combat message `mid-round` fires. */
    midRoundMs: 100,
    /**
     * A floor on the idle poll rate, not on the configured quiet period.
     * Unreachable from any options file — it exists so a config that arrived
     * here unnormalised cannot spin a timer hot.
     */
    minIdleTickMs: 100,
    /**
     * The shortest gap between two roster catch-up `who` commands.
     *
     * Somebody entering the realm is a fact about who is online, and the only
     * thing that settles what they *are* is a listing. Asking on each arrival
     * would spend a command per arrival on a busy realm; asking only when the
     * character next goes quiet meant a character that fights and walks all
     * evening never asked at all, which is how a `who` on screen and a record
     * saying *offline* ended up on the same screen.
     *
     * So it is a debounce rather than a quiet period: the first arrival asks,
     * and the arrivals inside the window are answered by the same listing.
     */
    rosterAskMs: 60_000,
    /** Decision-trace entries kept; it answers "why did it do that?". */
    traceLimit: 200
  },
  /** Fighting on the character's behalf — `AutoCombat`. */
  combat: {
    /**
     * How long after the last combat line a round verb goes out. Inside a
     * round rather than between rounds, and the one piece of timing worth
     * taking from `tproxy`. It also collapses a burst of six combat lines into
     * the one round they are.
     */
    roundMs: 100,
    /**
     * The shortest gap between two attempts to open a fight on the same thing.
     * Not pacing — pacing comes from the prompt — but a floor on *asking*: an
     * attack refused for a reason this client cannot see leaves the room
     * exactly as it was.
     */
    engageCooldownMs: 4000,
    /**
     * How long an arrival sentence stays pending its own state change. Short,
     * because what it bounds is the case where the change never comes.
     */
    arrivalWindowMs: 2000,
    /**
     * How long a typed `break` stands auto-combat down. The stand-down ends
     * early when the player attacks or the room changes; this is the backstop
     * for standing still.
     */
    breakStandoffMs: 30_000,
    /** How old a sighting of the leader's target may be before it is nobody's. */
    assistFreshMs: 60_000
  },
  /**
   * How a monster's hazards are priced when auto-combat decides what to hit
   * first — `src/shared/menace.ts`.
   *
   * A blow is hit points and needs no pricing. Everything else a monster can
   * do is priced in **rounds of the whole room's blows against this
   * character**: a round spent paralysed costs whatever everything in the
   * room lands in a round, because that is exactly what happens during it.
   * These are judgements, which is why they are here and not in code.
   */
  menace: {
    /**
     * A round held (`HoldPerson`): unable to leave, in a realm where leaving
     * is the only escape. Whole rounds, like `afraid`, `summon` and
     * `teleported` — a whole-number default takes whole numbers — where the
     * three halves below are fractions of one.
     */
    held: 1,
    /** A round confused, scaled by the spell's stated chance of an action misfiring. */
    confused: 0.5,
    /** A round blind. */
    blinded: 0.5,
    /** A round slowed. */
    slowed: 0.25,
    /** A round afraid, scaled by the stated chance of being shoved out of the room. */
    afraid: 1,
    /** One summoned ally: a fresh monster, in this room, now. */
    summon: 2,
    /** Being teleported somewhere the character did not choose. */
    teleported: 1,
    /**
     * Multiplier for a spell that reaches everybody in the room: it lands on
     * the character whoever the monster is facing, and on the party besides.
     * A whole number, because a whole-number default here takes whole numbers.
     */
    roomWide: 2,
    /**
     * How many three-second effect ticks of a poison or a lasting damage
     * spell are counted. A bite that poisons for a hundred ticks runs five
     * minutes and is cured or outrun long before that; twenty is a minute.
     */
    lastingTicks: 20,
    /**
     * The least one round of the room is worth, in hit points. A room of
     * pure casters lands no blows, and a round held in it is still not free.
     */
    unitFloor: 10,
    /**
     * A death spell fires once; it is spread over this many rounds so it
     * counts towards the order — taken early, at full health — without
     * outweighing every round of blows before it.
     */
    deathOverRounds: 5
  },
  /** Casting on the character's behalf — `AutoHeal`, `Cures`, `Blessings`. */
  spells: {
    /** How long a heal proposal stays worth sending. */
    healExpiresMs: 3000,
    /** Long enough for the next status line to say whether the heal worked. */
    healCooldownMs: 6000,
    /** How long a cure proposal stays worth sending. */
    cureExpiresMs: 3000,
    /** How often the blessing maintainer looks at what has lapsed. */
    buffTickMs: 1000,
    /** How long a blessing proposal stays worth sending. Never urgent. */
    buffExpiresMs: 10_000,
    /**
     * The gap between blessing proposals, module-wide: one blessing at a
     * time, at the pace the server confirms casts, because a second spell in
     * the same round is answered with a refusal.
     */
    blessCooldownMs: 6000,
    /**
     * How long a proposed blessing that was never confirmed is trusted to be
     * in flight before it is proposed again — a cast refused, under-manaed
     * or expired in the queue. The cures' own retry, for the same reason.
     */
    blessRetryMs: 30_000,
    /**
     * The watchdog behind a self blessing whose duration has never been
     * measured: how long the buff is trusted when no wear-off frame is read.
     * Once a cast→wear-off pair has been observed, the measured duration
     * (plus `blessSlack`) replaces this — the realm's own `Dur` column is
     * deliberately never used, its units being unestablished.
     */
    blessWatchdogMs: 300_000,
    /**
     * Slack on a measured duration, as a fraction of it: the watchdog fires
     * this much *after* the buff should have ended, so the wear-off frame —
     * the honest signal — always gets to speak first.
     */
    blessSlack: 0.25,
    /**
     * How soon after this character's own cast an onset sentence must arrive
     * to be learned as that spell's — `You feel safe from evil!` lands the
     * same tick, so this only has to reject an unrelated `You feel …!` a room
     * or a potion prints much later.
     */
    onsetWindowMs: 3000
  },
  /** Drinking on the character's behalf — `Potions`. */
  potions: {
    expiresMs: 3000,
    /** Long enough for the next status line to say whether it worked. */
    cooldownMs: 6000
  },
  /** Picking things up — `AutoLoot`. */
  loot: {
    expiresMs: 5000
  },
  /** Readying a light before a dark step — `AutoLight`. */
  light: {
    /** A `light`/`remove` still queued after this is for a room already left. */
    expiresMs: 4000
  },
  /** Keeping the pack stocked — `Supplies`. */
  supplies: {
    /** A `buy` unanswered by `You just bought …` for this long is taken as refused. */
    buyTimeoutMs: 8000,
    /** How long a queued `buy` waits for its turn before it is stale. */
    expiresMs: 6000,
    /** After a refused errand, how long before the same item is tried again. */
    retryMs: 300_000,
    /** Legs replanned after a fight or a stopped walk, before the errand gives up. */
    maxLegs: 4,
    /**
     * The whole errand's deadline, after which it gives the lap back.
     *
     * `Walker.start` raises no `ended` when it replaces a running walk, so a
     * leg superseded by the player's own route leaves the errand with nothing
     * to wake it. Generous: a shop several maps away, walked through fights
     * and rests, is a legitimate few minutes.
     */
    errandTimeoutMs: 300_000
  },
  /** Shedding named junk — `AutoDrop`. */
  drop: {
    expiresMs: 5000
  },
  /**
   * Looking for what a room did not print — `AutoSearch`.
   *
   * Short, and shorter than the loot's on purpose: a search is about the room
   * the character is *standing in*, so one still queued after the character has
   * walked out would look somewhere else for something it was never asked
   * about. Loot is about the floor, which is worth waiting a moment for.
   */
  search: {
    expiresMs: 3000
  },
  /** Banking the purse — `AutoDeposit`. */
  banking: {
    /**
     * Long enough for the deposit sentence to move the purse; without it a
     * status line arriving before the answer would propose the same deposit
     * again.
     */
    cooldownMs: 10_000,
    expiresMs: 10_000
  },
  /** Sitting down — `Recovery`. */
  rest: {
    /**
     * Generous, unlike an attack's: what this reacts to is a number that moves
     * slowly, and a `rest` that arrives two seconds late is still a rest.
     */
    expiresMs: 5000,
    /**
     * How long a proposed `rest` is trusted to be in flight before it is
     * proposed again.
     *
     * `Recovery` re-derives from every status line and keeps nothing, and its
     * whole silence comes from the `(Resting)` flag — which does not arrive
     * until the server has answered the `rest`. With eight probe answers
     * outstanding at login, eight status lines came back before the first one
     * did and each got its own `rest`: captured 2026-09-02
     * (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`, eight `You are now
     * resting.` inside 80ms). The state guard is right and needs a memory of
     * having asked behind it, with a deadline so a `rest` the server swallowed
     * is still asked for again. Cleared the moment the flag does arrive, so a
     * rest broken a second later is re-proposed at once.
     */
    askedMs: 3000
  },
  /** Commands on a clock — `Events`. */
  events: {
    tickMs: 1000,
    /** How long a proposal stays worth sending. A timed command is not urgent. */
    expiresMs: 10_000
  },
  /** Walking a planned route — `Walker`. */
  walk: {
    /** How long one hold lasts before the walk tries the step again. */
    holdMs: 1_500,
    /** How many holds run back to back before it walks on regardless. */
    maxHolds: 3,
    /**
     * How long a route waits out a fight before it gives up on the journey.
     *
     * A fight normally ends by itself — the monster dies, the character runs,
     * or the character does — so the hold that waits for it has no clock of
     * its own to need. This is the floor under the case where **nothing in
     * this client can end it**: auto-combat and the retreat are both off by
     * default, so on a fresh configuration a wandering monster can open on an
     * unattended character and neither of the two things that would finish the
     * fight is switched on. The route would then stand there silently for the
     * evening, which is the failure the whole hold exists to avoid, wearing
     * the other face.
     *
     * Generous on purpose: a fight this client *is* fighting is seconds, so
     * two minutes only ever expires on one it is not.
     */
    fightHoldMs: 120_000,
    /**
     * How much longer than this realm's own slowest answer a step may go
     * unanswered before the walk sends one bare Enter to force a status line
     * out of the server.
     *
     * **A margin over a measurement, never a claim about the server.** This
     * read `1000` and meant "a move that landed is answered in well under a
     * second", which is a fact about one realm stated as a fact about all of
     * them. Measured on paramud.mudinfo.net 2026-09-02
     * (`2026-09-02_21-04-28_festus.mudcap.jsonl`, 22 uninterrupted town
     * steps): a move is answered in a **median 1,239ms**, p25 1,228 and p90
     * 1,250 — the realm's movement round, tight enough to be a constant of
     * the server. Against a flat second the fallback therefore fired on
     * *every* step of every walk, and the bare Enter it sends is answered
     * with a full reprint of the room, so the console showed each room twice
     * all the way round the lap.
     *
     * So `Walker` measures what a move actually costs here and this is the
     * headroom on top — see `nudgeSamples`. It is also the whole deadline
     * until the realm has answered a move even once, which is the only
     * moment there is nothing to measure against.
     *
     * One per step; the full `stepTimeoutMs` runs behind it before the walk
     * gives up.
     */
    nudgeAfterMs: 1_000,
    /**
     * How many recent move answers the deadline above is measured over.
     *
     * The statistic is the **slowest** of them, because the deadline exists
     * to be later than a normal answer and a single fast one says nothing
     * about the slow case — a step whose room dead reckoning had already
     * placed answers in a millisecond and is not evidence the realm is
     * quick. A window rather than an all-time maximum so that one lagged
     * answer ages out instead of standing the fallback down for the evening.
     */
    nudgeSamples: 5,
    /** Confirmed steps kept for a retreat to look back over. */
    recentSteps: 5,
    /**
     * How far below a barrier's stated number the character's own skill may
     * sit and still be worth spending a command on.
     *
     * **Not measured.** The realm records one number per barrier and nothing
     * says what a roll against it looks like. The two differ because the two
     * attempts do not cost the same: a failed pick costs a command, a failed
     * bash costs a command *and* health, so the cheaper attempt is allowed the
     * longer reach.
     */
    bashMargin: 10,
    pickMargin: 20,
    /**
     * How many searches one hidden exit is worth before the walk gives up. The
     * router already priced the leg including the search, so spending the
     * command keeps a promise rather than making a new decision.
     */
    searchTries: 2
  },
  /** Running a loop — `LoopRunner`. */
  loop: {
    /** Consecutive non-combat failures before the loop gives up on itself. */
    maxFailures: 3,
    /** How many times a lost loop asks the realm where it is before giving up. */
    maxLocates: 5,
    /**
     * How long to give a fact already on its way before asking for it. Long
     * enough that the answer normally arrives first, short enough that a move
     * the server swallowed does not leave a loop reporting progress it is not
     * making.
     */
    locateWaitMs: 2_500,
    /**
     * How long an arrival stands in a stop that asked for no longer.
     *
     * Not a politeness pause. Engagement fires from character state while the
     * character is *standing somewhere*, and a loop that advanced the moment
     * each leg confirmed walked past twelve laps of monsters engaging nothing.
     */
    dwellMs: 2_000,
    /**
     * How long a loop stands still after an escape before it will plan again.
     *
     * An escape leaves the character one room from what it ran from, and the
     * lap's next leg is planned from where it landed — which is how a
     * step-back escape sent `e` and the loop sent `w` two seconds later, back
     * into the room with the cave worm in it. The health hold (`restTo`) is
     * what covers running away hurt; this is the floor under it, for running
     * away from a crowd at full health, where no threshold has anything to
     * say.
     */
    escapeSettleMs: 8_000,
    /**
     * The margin a lap held for health resumes above the floor it paused at,
     * when no ceiling is configured.
     *
     * `restTo` is the ceiling, and it is also the resume floor — but `restTo:
     * 0` means *the single sit-down* rather than *no hysteresis*, and it is a
     * value the settings screen offers, the template documents and
     * `statedTheRestCeiling` writes into every existing file. Read literally, a
     * lap would resume marching at exactly the health it paused at and the next
     * hit would put it straight back: pause and resume at status-line cadence,
     * which is the churn the pair exists to prevent. Clamping `loopResumeAt` up
     * to `loopPauseBelow` had the same worst case and nobody ever met it,
     * because the shipped pair was never equal.
     *
     * So a 0 ceiling resumes a fraction of maximum above the floor instead. Not
     * a multiplier: a proportional margin is nothing at all under a low floor,
     * which is the character that most needs the gap.
     */
    resumeMarginWhenUncapped: 0.1
  },
  /**
   * How many commands one press or one `@` may spend.
   *
   * One budget, because it is one budget: each `wear`, `get` or `drop` comes
   * out of the same allowance the fight is being fought with, and a pack's
   * worth of them queued behind an escape is the failure pacing exists to
   * prevent. Said out loud when it bites, rather than silently doing ten of
   * eighteen.
   */
  spending: {
    /** One `@get-all`, or one `@drop-all`. */
    maxGets: 10,
    /** One press of the gear button. */
    maxGear: 10
  },
  /** What one session keeps in memory for the diagnostics cards. */
  session: {
    /** Negotiation records the diagnostics pane can look back over. */
    telnetLogLimit: 500,
    /** Framed lines retained; the terminal keeps the real backscroll. */
    lineLogLimit: 500,
    /**
     * Sent commands the decision trace keeps — enough to cover the minute
     * before something went wrong, which is the window anyone asks about.
     */
    sentLogLimit: 60,
    /**
     * Safety decisions kept. Small on purpose: these are rare by construction,
     * so a long list means something is wrong rather than something is busy.
     */
    safetyLogLimit: 40,
    /** How long a `safe-haven` retreat waits for the fight to end. */
    retreatPatienceMs: 20_000,
    /** How long a `safe-haven` retreat waits for the escape move to land. */
    retreatSettleMs: 5_000,
    /**
     * Minimum gap between decision-trace publishes. The queue changes several
     * times a second in combat and every change interests a diagnostics card
     * and nothing else.
     */
    automationPublishMs: 250,
    /**
     * Actions offered on the room line the console just printed. Capped
     * because a row of eight buttons pushes the room's name off the screen.
     */
    roomActions: 4,
    /**
     * Cap on the half-typed line the client keeps a copy of. Past this it is
     * not a command anybody is typing, and dropping it beats growing for ever.
     */
    outboundLineLimit: 512,
    /**
     * How long a direction the *player* typed is watched for its room before
     * it is written off.
     *
     * A walk or a loop stands down when the player moves the character
     * themselves, and it is the arrival that says they did — a direction into
     * a wall moves nobody and must not end a lap. So the typed move is held
     * until a room answers it, and this is how long that wait may last before
     * the client stops attributing the next room change to it. Generous
     * against a slow link, because the cost of waiting too long is one
     * misattributed stop and the cost of too short is a lap that keeps
     * walking while somebody steers.
     */
    playerMoveWindowMs: 15_000,
    /**
     * How often the number-driven modules re-decide with no new status line.
     *
     * Everything automated here is derived from a state change, and a state
     * change needs a status line — which a **standing, idle** character gets
     * only when the server's own regen tick moves a vital, once every thirty
     * seconds. So a decision deferred for a reason with a clock behind it —
     * a heal's `healCooldownMs`, a potion's, a cure's retry — was not taken
     * when its clock lapsed; it was taken whenever the game next happened to
     * speak, or whenever the player pressed Enter. Measured 2026-09-02
     * (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`): a heal cast at 91.6s
     * came off cooldown at 97.6s and the next status line was the player's
     * own keystroke at 120.5s — twenty-three seconds of *should have cast,
     * did not*, which is what a player reads as "it only works when I type".
     *
     * `Blessings` already owns exactly this clock for exactly this reason
     * ("one owned interval, checked rather than trusted") and is therefore
     * **not** driven from here. Only the modules with no clock of their own
     * are: the heal, the potion, the cures and `Recovery`. Every one of them
     * re-derives from the state it is handed and guards itself, so a tick
     * where nothing has changed proposes nothing.
     */
    reconsiderMs: 1000
  },
  /** What the client writes to disk about a character and a realm. */
  records: {
    /** How long the fight log holds records before writing them. */
    fightFlushMs: 2000,
    /** How many it holds if a flush never happens. */
    fightsHeld: 2000,
    /** How long the conversation log holds lines before writing them. */
    talkFlushMs: 2000,
    /** How many it holds if a flush never happens. */
    talkHeld: 500,
    /** How long a balance change waits before it is written. */
    belongingsWriteDelayMs: 2000,
    /**
     * Vaults kept for one character. The shipped realm has seven banks; a file
     * past this is one being fed something that is not a bank name.
     */
    maxVaults: 100,
    /**
     * How long a discovery waits before it is written. A discovery happens
     * while somebody is walking, which is the one time this process must not
     * touch a disk.
     */
    memoryWriteDelayMs: 2000,
    /** Observations one character keeps. */
    memoryLimit: 2000,
    /** How long learned monster health waits before it is written. */
    loreSaveDelayMs: 5_000,
    /**
     * Learned monsters per realm. The shipped realm names about 1,450 and
     * learning is only for the ones it does not, so a file past this is keyed
     * on something that is not a monster name.
     */
    maxLearned: 4_000,
    /** How long a walk's destination waits before it is written. */
    destinationsSaveDelayMs: 5_000,
    /**
     * Destinations kept per realm. Generous: a row is one place somebody
     * deliberately walked to, so the list grows at the speed a person plays
     * rather than at the speed the server talks, and the whole point of it is
     * that somewhere visited months ago is still the answer to a search.
     */
    maxDestinations: 500,
    /**
     * Recent destinations offered above the realm's own answer.
     *
     * Five, because the list is a *shortcut* and not the search: past a handful
     * it stops being scannable at a glance and starts being a second set of
     * results to read, which is the thing it exists to save somebody from.
     */
    destinationsShown: 5,
    /** How long a change to the player book waits before it is written. */
    playersSaveDelayMs: 5_000,
    /**
     * Players per realm. Low deliberately: the registry rides on
     * `CharacterState`, which is structured-cloned to the window on every
     * status line.
     */
    maxPlayers: 1_000,
    /** How long a book that could not read its file waits before retrying. */
    playersRetryMs: 30_000
  },
  /** The realm knowledge base — conversion, routing and the local map. */
  world: {
    /**
     * Converted realms kept on disk. Editing a realm leaves the old conversion
     * behind, which makes going back free and was unbounded until this.
     */
    keepRealms: 8,
    /** Ceiling on placed rooms, so a dense area cannot produce a vast grid. */
    mapCells: 200,
    /**
     * What a barrier the character cannot force costs to route through.
     *
     * Priced as a wall that can still be walked through when there is no other
     * way at all — never `null`, because refusing outright would hide the only
     * route there is.
     */
    wallCost: 100_000,
    /**
     * What a room-script teleport costs over an ordinary step, so the router
     * prefers plain corridors unless the portal genuinely shortens the way —
     * usually across maps, which is what most of them are for.
     */
    portalPenalty: 3
  },
  /** The process itself. */
  app: {
    /**
     * How long a quitting client waits for its last message to reach a pipe
     * nobody may be reading. The one thing worse than losing the message is not
     * exiting at all.
     */
    exitDrainMs: 500
  },
  /** Watching the files the client owns. */
  files: {
    /** One listing twice a second costs nothing. */
    pollIntervalMs: 500,
    /** Collapses the burst of writes an editor emits into a single reload. */
    debounceMs: 80
  },
  /**
   * The window's own numbers.
   *
   * Read through `src/renderer/src/lib/tuning.ts`, which is fed the moment
   * this file reaches the window. A render that happened before it arrived ran
   * on these defaults, which is the correct fallback rather than a gap.
   */
  view: {
    /** Diagnostics log kept in renderer memory. */
    telnetLogLimit: 500,
    /** Framed lines kept for the Stream card. */
    lineLogLimit: 200,
    /**
     * Remembered conversation. Generous, because the point of keeping it is
     * that somebody can come back to what they missed.
     */
    talkLimit: 500,
    /** Remembered notices. Same reasoning, same generosity. */
    noticeLimit: 400,
    /** The most panes worth having; see docs/profiles.md §7.3. */
    maxPanes: 4,
    /**
     * Minimum gap between chrome state flushes in a window.
     *
     * Every pushed fact — a line, a character change, a block — used to be its
     * own React state update, and each one re-rendered every card on the rail;
     * on a busy realm the renderer spent its whole budget redrawing chrome and
     * the player watched their own keystrokes crawl onto the console. Pushes
     * now queue and flush together at most this often. Leading edge, so a lone
     * change still paints at once; the console itself never waits on this —
     * it is written imperatively, outside React.
     */
    chromeFlushMs: 100,
    /** Characters per second above which the window is under pressure. */
    streamHighWater: 1500,
    /**
     * Consecutive high samples before quieting the chrome.
     *
     * The exit had hysteresis from the beginning and the entry had none, so
     * one sample above the water line dimmed the whole window: at a 250ms
     * sample, that is **375 characters in a quarter of a second** — which is
     * one ordinary combat round with its colour codes, arriving in a single
     * packet. Every round therefore pulsed the blur, the secondary text and
     * every transition in the client, and relaxed two seconds later, for as
     * long as somebody was fighting. Reported as "the UI flickers every five
     * or ten seconds"; measured against a fake host, it was once per round.
     *
     * Four samples is one second of *sustained* pressure, which is the state
     * this feature was written for — a spam channel, a long fight, a screen
     * of description scrolling past. A burst that is over before then has
     * finished painting anyway, so dimming for it buys nothing and costs the
     * flicker.
     */
    streamHighSamples: 4,
    /** Consecutive calm samples before relaxing, so it cannot flicker. */
    streamCalmSamples: 8,
    streamSampleMs: 250,
    /**
     * Long enough that typing a sentence is one save, short enough that
     * somebody who stops to think has been saved by the time they look up.
     */
    autoSaveDelayMs: 700,
    /** How far an undo will go back. Bounded so a long session cannot grow. */
    historyDepth: 50,
    /** Below this height the rail cannot show three cards comfortably. */
    compactHeight: 820,
    compactWidth: 1180,
    /** How old a sighting of what a party member is fighting may be. */
    fightingFreshMs: 60_000,
    /**
     * Where a monster's bar turns from green to amber to red.
     *
     * **Not chosen, and changing them makes the client contradict itself.**
     * These are the server's own wound bands (`src/shared/wounds.ts`)
     * collapsed to three, so the colour and the word under it can never
     * disagree. They are here because everything is; they are the two numbers
     * in this block least likely to be worth moving.
     */
    woundCaution: 0.7,
    woundCritical: 0.3,
    /**
     * The width below which the console stops being a character grid.
     *
     * **Not a preference either.** The game lays out maps and stat columns by
     * counting characters and the server repaints its status line with a
     * literal `CSI 79 D`; there is no width this client can report that
     * changes what it sends.
     */
    minColumns: 80,
    /** Advance widths differing by more than this fraction count as uneven. */
    fontTolerance: 0.02,
    /**
     * The longest name the console will try to recognise, in words. Eight,
     * counted against the shipped realm's room table rather than chosen: 396
     * of its 55,806 names are six words or more.
     */
    maxNameWords: 8,
    /**
     * How far the pointer must travel before a press becomes a drag. Not zero:
     * a card header carries a close button, and a press that dragged
     * immediately would make it unclickable for anyone whose hand is not
     * perfectly still.
     */
    dragSlop: 5,
    /** Between a popover and its anchor, and between a popover and the edge. */
    popoverGap: 8,
    popoverMargin: 8,
    /** How close a popup menu may come to the edge of the window. */
    menuMargin: 4,
    /** Room radius on the map, and the margin that keeps one in the viewBox. */
    mapRoomRadius: 3,
    /**
     * How far out the local map walks, as the bounds a *measured* radius is
     * clamped into.
     *
     * The card asks for the radius its own size can show — `radiusForBox`,
     * from the card's own laid-out box — rather than always asking for five,
     * which is what it did until 2026-08-31: a map dragged twice as tall drew
     * the same six rooms twice as large, because the viewBox scaled the
     * picture and nothing ever fetched more of it.
     *
     * The floor is what a rail card can show and the ceiling is what stops a
     * full-screen float walking the whole realm — the breadth-first search is
     * exponential in the radius, and `world.mapCells` alone bounds the
     * *result* rather than the work.
     *
     * Under `view` rather than `world` because it is a fact about how big the
     * card is, which is the renderer's to know: `world` is what the realm is,
     * and only main reads it.
     */
    mapRadiusMin: 2,
    mapRadiusMax: 12,
    /**
     * How many pixels one room's cell wants, at each end of the Map card's
     * density slider — sparse first, dense second.
     *
     * Neither is a layout constant of the kind the pixel rule forbids: nothing
     * is *positioned* by either, and the box they divide is measured from the
     * laid-out element every time. They are the legibility budget — how small a
     * room may be drawn and still be a thing somebody can point at — and the
     * slider chooses between them (`roomPixelsFor`).
     *
     * There was one figure, 34, until 2026-09-02, and it was the whole answer:
     * how much of the realm a map showed was decided for the player. The two
     * ends are chosen so a **rail-sized** card (its picture is about 200px on
     * the short side) spans 5×5 rooms at the sparse end and 20×20 at the dense
     * one, which is what the request asked for. The middle lands at 25 against
     * the 34 it replaces, and with the floor moving too a railed map goes from
     * 7×7 to 9×9 for somebody who never opens the slider — a step, not a
     * redesign, and the control to put it back is on the card. A float is
     * bigger and shows more at every setting, which is the behaviour the
     * measured radius already had.
     *
     * `mapRadiusMin` went 3 → 2 with them: 5×5 is a radius of two, and the old
     * floor would have quietly refused the sparse end of the slider.
     */
    mapRoomPixelsSparse: 40,
    mapRoomPixelsDense: 10,
    /**
     * How often a card redraws a running clock — the uptime readout, and how
     * long a loop has been going. A second, because that is the unit shown.
     */
    clockTickMs: 1000,
    /**
     * How long a room search waits after the last keystroke, and the shortest
     * query worth running.
     *
     * The realm has 55,806 rooms and a two-letter query matches a lot of them.
     * Shared by the route panel's own field and by the palette, which searches
     * the same index — two debounces that drifted would be two surfaces
     * answering the same typing at different speeds.
     */
    roomSearchDebounceMs: 150,
    roomSearchMinChars: 2,
    /**
     * The server's own combat pulse, in milliseconds.
     *
     * Damage per round is the one figure on the Combat Stats card that needs a
     * length for a round, and the client never sees a round boundary — the
     * stream carries blows, not ticks. Five seconds is what MegaMUD's own
     * status bar counted down and what its damage-per-round figure divided by;
     * it is here rather than beside the card because it is a fact about the
     * *server*, and a derivative that pulses differently is a number to change
     * rather than a build to make.
     */
    combatRoundMs: 5000,
    /**
     * How long a scope must have run before the Combat Stats card claims a
     * rate for it.
     *
     * The rates divide a total by the scope's own clock, which is answerable
     * from the first millisecond and *absurd* there: 66 experience 300ms into a
     * session reads as 792,000/hr, and `Will level in` — the figure somebody
     * decides *keep going or go and train* on — reads as nine seconds. It
     * settles over the following minute, which makes it a number that is wrong
     * exactly while it is newest.
     *
     * **Deliberately short.** The complaint this card's rates were fixed for
     * (todo 01) was a dash where a figure was wanted, at forty seconds
     * elapsed — so a floor long enough to be statistically comfortable would
     * put that dash straight back for the first minute of every session and
     * after every Reset. Five seconds is the server's own combat round: long
     * enough that the divisor is not tens of milliseconds, short enough that
     * the reader sees a number while they are still looking.
     */
    rateFloorMs: 5_000
  }
};

/**
 * Every tunable number, typed from the defaults themselves.
 *
 * `typeof` rather than a hand-written interface on purpose: a field cannot be
 * in one and missing from the other when there is only one statement of it.
 */
export type TuningConfig = typeof TUNING_DEFAULTS;

export interface InternalConfig {
  terminal: TerminalInternalConfig;
  palette: PaletteInternalConfig;
  toolbar: ToolbarInternalConfig;
  tuning: TuningConfig;
}

export const DEFAULT_INTERNAL: InternalConfig = {
  terminal: {
    quiet: { enabled: true, commands: ['rm', 'look'] },
    enrich: true
  },
  palette: {
    pinned: {
      character: ['settings'],
      navigate: ['route', 'loop:*', 'loop:stop'],
      layout: ['pane:*', 'cards:reset']
    }
  },
  /*
   * The shipped row: dial in, the master switch, fighting, and the loop's
   * transport. Everything the user named in the request, and nothing else —
   * a toolbar that ships full is one nobody curates, and the kebab is right
   * there.
   */
  tuning: structuredClone(TUNING_DEFAULTS),
  toolbar: {
    pinned: [
      'connect',
      // Putting the kit back on: the first press after a death, beside the dial
      // rather than with the loop's transport because it is what somebody does
      // on arriving rather than while walking.
      'gear:restore',
      'automation',
      'combat',
      'retaliate',
      'loot',
      /*
       * Searching every room, on the row rather than in the kebab.
       *
       * It costs a command per room, which is the kind of thing somebody turns
       * on for one corridor and off again — and a switch you toggle that often
       * behind a menu is one you stop toggling. Everything else here is on the
       * row for the same reason.
       */
      'search',
      // Where a loop is found, beside the controls that drive the one running.
      // Pinned rather than left to the kebab: this is the way in to four
      // hundred and twenty loops, and a shelf reachable only from a menu at
      // the end of a row is the "command nobody can find" failure again.
      'loop:open',
      'loop:toggle',
      'loop:stop',
      'walk:stop'
    ]
  }
};

/**
 * One number out of the file, bounded by the shape of its default.
 *
 * Two rules, both mechanical so that a key added to `TUNING_DEFAULTS` needs no
 * second edit here:
 *
 * - **A fractional default means a fraction**, clamped to 0–1. Every one of
 *   them is a confidence, a threshold or a tolerance.
 * - **A key ending `Ms` is a duration and floors at 1.** A zero-millisecond
 *   timer spins a core, and this file is one somebody edits by hand.
 *
 * Anything unreadable takes the default rather than throwing, for the reason
 * the whole file works that way: a bad edit must never take the client down.
 */
function tunedNumber(key: string, value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  if (!Number.isInteger(fallback)) return Math.min(1, Math.max(0, n));
  return Math.min(1_000_000_000, Math.max(key.endsWith('Ms') ? 1 : 0, Math.round(n)));
}

/**
 * Coerces the `tuning:` block by **walking the defaults**, not by naming keys.
 *
 * The alternative is the closed-union failure this project has already paid
 * for twice: a field in the declaration and not in the reader type-checks,
 * then quietly never takes effect. Here there is nothing to fall behind — the
 * defaults are the only list, and anything the file states outside it is
 * ignored rather than carried, so a typo is a value that does not apply rather
 * than a key nothing validates.
 */
function normalizeTuning(raw: unknown): TuningConfig {
  const root = isRecord(raw) ? raw : {};
  const out = structuredClone(TUNING_DEFAULTS) as Record<string, Record<string, number>>;
  for (const [group, fields] of Object.entries(out)) {
    const stated = isRecord(root[group]) ? (root[group] as Record<string, unknown>) : {};
    for (const key of Object.keys(fields)) {
      fields[key] = tunedNumber(key, stated[key], fields[key] as number);
    }
  }
  return out as TuningConfig;
}

/** Whether a pinned pattern names this command id. `loop:*` is a prefix. */
export function pinnedMatches(pattern: string, id: string): boolean {
  if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
  return pattern === id;
}

/**
 * Coerces whatever the file said into a complete configuration.
 *
 * Every value falls back to the default rather than throwing, for the same
 * reason the options file does: a bad edit must never take the client down.
 * A command list that is not a list of words becomes the default list, not an
 * empty one — an empty list is a real choice ("nothing is quiet") and this
 * does not make it for somebody by accident.
 */
export function normalizeInternal(raw: unknown): InternalConfig {
  const d = DEFAULT_INTERNAL;
  const root = isRecord(raw) ? raw : {};
  const terminal = isRecord(root['terminal']) ? root['terminal'] : {};
  const quiet = isRecord(terminal['quiet']) ? terminal['quiet'] : {};

  const commands = Array.isArray(quiet['commands'])
    ? quiet['commands']
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0 && !/\s/.test(entry))
    : d.terminal.quiet.commands;

  const palette = isRecord(root['palette']) ? root['palette'] : {};
  const pinnedRaw = isRecord(palette['pinned']) ? palette['pinned'] : null;
  const pinned: Record<string, string[]> = {};
  if (pinnedRaw) {
    for (const [group, value] of Object.entries(pinnedRaw)) {
      if (!Array.isArray(value)) continue;
      const patterns = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      pinned[group.trim().toLowerCase()] = patterns;
    }
  }

  const toolbarBlock = isRecord(root['toolbar']) ? root['toolbar'] : {};
  const toolbarRaw = Array.isArray(toolbarBlock['pinned']) ? toolbarBlock['pinned'] : null;
  const toolbar = (toolbarRaw ?? [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    terminal: {
      quiet: {
        enabled: bool(quiet['enabled'], d.terminal.quiet.enabled),
        commands: Array.isArray(quiet['commands']) ? commands : [...d.terminal.quiet.commands]
      },
      enrich: bool(terminal['enrich'], d.terminal.enrich)
    },
    palette: {
      // A stated block replaces the default whole: pinning is a curation, and
      // merging a curation with a default is nobody's list.
      pinned: pinnedRaw ? pinned : structuredClone(d.palette.pinned)
    },
    // Same rule, one list rather than a map of them.
    toolbar: { pinned: toolbarRaw ? toolbar : [...d.toolbar.pinned] },
    tuning: normalizeTuning(root['tuning'])
  };
}
