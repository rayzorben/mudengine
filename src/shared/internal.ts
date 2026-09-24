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
    settledMs: 30_000,
    /**
     * How long a command may go unanswered before the link is called dead.
     *
     * The socket staying open is not evidence that anything is on the other
     * end of it: a NAT table that forgot the flow, a host that went away
     * without a FIN, a link that dropped mid-round all leave a writable socket
     * that will never answer again, and the client sat at one reporting
     * `connected` until somebody noticed. Nothing else here can see that —
     * `Reconnect` only ever hears about a socket that *closed*.
     *
     * Counted only while an answer is **owed**: the clock starts when a
     * command goes on the wire and stops at the next byte in. Wire silence on
     * its own would be the wrong reading twice over — this realm repaints its
     * status line unprompted every thirty seconds (`Routines.noteSent`), so
     * fifteen seconds of it is ordinary, and a client that has asked for
     * nothing is owed nothing. Every command this family answers is answered
     * with at least a status line, and promptly.
     *
     * `0` switches it off. The keep-alive (`automation.idle`) is what supplies
     * the traffic on a character nobody is playing; with both off, a link that
     * dies while nothing is being sent stays undetected, which is the honest
     * answer rather than a guess about silence.
     */
    silentForMs: 15_000
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
    /**
     * How long after this character's own landed blow an unattributed damage
     * line still reads as that blow's weapon proc, in milliseconds.
     *
     * **The backstop, not the discriminator.** What actually binds a proc to
     * the blow that fired it is that the server composes the two into one
     * write, so nothing but the repainted prompt sits between them — see
     * `CharacterTracker.apply`, which breaks the binding on any other block.
     * A window on its own could not do that job: the server writes a whole
     * round in one breath, so a party member's article-led spell is inside 41
     * ms as readily as a proc is (`A withering blast of dragonfire sears
     * storm giant king for 163 damage!`, captures/168, which is Vulcan's).
     *
     * This bounds the case adjacency cannot: a blow, then a long silence, and
     * then an unattributed line that is nobody's proc. **Measured, not
     * chosen**: 581 procs across the recorded sessions of 2026-09-06, median
     * 3 ms behind the blow and slowest 41 ms. A second is two orders of
     * magnitude above that and still a fifth of a combat round.
     */
    procWindowMs: 1000,
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
     * Commands sent and not yet seen echoed back.
     *
     * The server echoes what it is given, in order, and it does not wait for
     * one command to be answered before echoing the next: a burst arrives back
     * as a run of bare lines, one per command. So *what this client sent* has
     * to be a queue for the same reason `maxPendingMoves` is one — sends are
     * pipelined and answers are not instant.
     *
     * It shipped as a single value, and only the **last** command of any burst
     * was ever recognised as its own echo. Everything else was typed against
     * the rule table as though the game had said it, which is how a paste came
     * to teach the client a room it had never been in.
     *
     * Above the ~20 commands the server will hold in flight, so a legitimate
     * burst cannot overflow it and lose an echo out of the front.
     */
    maxPendingEchoes: 32,
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
     * A step unanswered this long is probed: `rm` goes out behind it, and its
     * answer is an ordered one — the server answers in the order it was
     * asked — so a `Location:` arriving with the step still unanswered proves
     * the step produced nothing and it is dropped at once, while a probe
     * still unanswered proves the server is slow and the step waits, up to
     * `staleMoveMaxMs` (todo 10: a `n` answered after nine seconds cost a
     * loop its place). Three seconds is two movement rounds; thirty is a
     * link that has gone, not a server that is slow.
     */
    staleProbeMs: 3000,
    staleMoveMaxMs: 30_000,
    /**
     * Pack changes held against a listing that has not finished arriving. A
     * listing takes about a second; this covers what a person or a fight can
     * do in one, and no more.
     */
    maxPackChanges: 16,
    /** Possible rooms kept for the resolution trace. */
    maxRoomCandidates: 8,
    /**
     * How often the experience total is sampled for the Combat Stats card's
     * rate graph, and how many samples are kept: a minute, and a day of them.
     * The newest sample is updated in place until its minute is spent, so a
     * burst of kills is one point.
     */
    statsSampleMs: 60_000,
    statsSamplesKept: 1440,
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
    /**
     * How long a command the server threw away waits before it is sent again.
     *
     * `You fumble in confusion!` is `ActionFigure.CheckConfusion` discarding
     * whatever was sent at the top of `Player.HandleCommand` — and the same
     * branch puts the character in a **1,000ms `DelayCommand`**, so the status
     * line that follows the fumble arrives *inside* that wait and a resend on
     * it would be sent into a server that is not listening yet.
     *
     * The server's own figure, which is a reading rather than a guess, and the
     * safe direction of the two: waiting too long costs latency where waiting
     * too little costs the command a second time.
     */
    fumbleRetryMs: 1_000,
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
    /**
     * The floor between two looks at other players.
     *
     * A room that fills up should not spend six commands at once on something
     * nobody asked for urgently, and the budget it spends from is the one a
     * fight is fought with. Short enough that a room of three is read within
     * the time somebody stands in it.
     */
    lookAskMs: 4_000,
    /**
     * How long a queued look is worth sending.
     *
     * The answer is about somebody standing in *this room*, so a look held
     * behind a fight for a minute arrives at a person who has walked out —
     * which is the failure reported 2026-09-07, from the other side. Longer
     * than `lookAskMs` by enough that a look queued behind one round still
     * goes; shorter than anybody stays put.
     */
    lookExpiresMs: 20_000,
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
    deathOverRounds: 5,
    /**
     * The room's fight, run (`simulateFight`): how many times, how long a
     * fight may run before it is called, and the shares of fights survived
     * that read as safe and as merely risky — under `riskyAbove` is deadly.
     * Three hundred runs of a long fight are a millisecond or two on the
     * socket's thread; the figures move by a point or two between seeds.
     */
    survivalTrials: 300,
    survivalRoundCap: 120,
    survivalSafeAbove: 0.95,
    survivalRiskyAbove: 0.6
  },
  /** Casting on the character's behalf — `AutoHeal`, `Cures`, `Blessings`. */
  spells: {
    /**
     * How sure one cast has to be of finishing the monster before the
     * cheapest spell that would outranks the hardest hitter (`chooseAttackSpell`,
     * todo 09). The reviewer's worked example switched at 99%.
     */
    killConfidence: 0.9,
    /** How long a heal proposal stays worth sending. */
    healExpiresMs: 3000,
    /** Long enough for the next status line to say whether the heal worked. */
    healCooldownMs: 6000,
    /**
     * How long a member's `@heal` stands waiting for a cast. Past one
     * `healCooldownMs`, so a request arriving just after a heal to that member
     * still gets its own once the first has been read; after that the asker's
     * client asks again if it is still low.
     */
    healRequestMs: 10_000,
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
    onsetWindowMs: 3000,
    /**
     * How long an unread sentence is kept as a possible ending for the buffs
     * whose ending the client does not know, waiting for an `st` sheet to say
     * which of them is gone. Past this the sentence is forgotten unresolved.
     */
    pendingStopMs: 600_000,
    /**
     * How soon after a *learned* ending removed a buff the same buff
     * reappearing unprompted — on an `st` sheet, typically — counts as the
     * wire contradicting the lesson, so the sentence is unlearned. A recast
     * arrives through its own cast frame and never trips this.
     */
    stopContradictionMs: 120_000,
    /**
     * The least often an `st` is asked for to settle a buff ending nothing
     * recognised. One ask per new question would be one per room emote in a
     * crowded room; this is the floor between two.
     */
    sheetAskMs: 30_000,
    /**
     * The longest a sentence nothing recognised may wait for a stat sheet and
     * still have the sheet's *silence* count against it (todo 00). The sheet
     * carries every lasting effect's own landing line, so one asked for after
     * the sentence and printed without it says the sentence was not a lasting
     * effect — unless the effect expired in between, which is the only reason
     * for a bound at all. Past this the candidate is dropped unresolved
     * rather than refused, and either way the next sheet that does carry the
     * sentence overwrites the verdict.
     */
    effectVerdictMs: 15_000,
    /**
     * How far apart an unnameable effect ending and a condition ending may be
     * and still be read as one event — which is what turns a *suspicion* about
     * what the effect causes into a verdict acted on (`deduceCauses`).
     *
     * The server ends a spell and everything it granted in one tick, so the
     * two sentences arrive inside a single combat round (`hunting.roundSeconds`,
     * five). Wider would let an unrelated cure a round later confirm the wrong
     * effect, and the confirmed verdict is what *clears* a condition — the
     * reassuring direction, which wants the higher bar.
     */
    effectCauseMs: 5000
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
  /**
   * Where to hunt — `src/shared/hunting.ts`, the cycle model MMUD-Explorer's
   * Model D is built on (`.scratch/MMUD-Explorer/docs/exp-per-hour-models.md`),
   * closed-form. Every figure here is one of that model's stated mechanics.
   */
  hunting: {
    /** A combat round, seconds — the server's `ROUND_SECONDS`, and MME's tick. */
    roundSeconds: 5,
    /** A resting regeneration tick, seconds (`Player.cs`: resting ticks at 15s, triple the rate). */
    restTickSeconds: 15,
    /** A standing regeneration tick, seconds (`REGEN_TICK_SECONDS`). */
    passiveTickSeconds: 121,
    /** Per kill: looting, retargeting, latency (MME's `cephD_KILL_OVERHEAD_SEC`, 1.5s). */
    killOverheadMs: 1500,
    /** One step of a walk — the movement round measured at 1,239ms. */
    stepMs: 1250,
    /**
     * GreaterMUD's regen adds thirty seconds to the elapsed time before it
     * compares with the room's delay (`RegenSlot.cs:33`, the author's own
     * comment calls it a kept bug), so a lair comes back this much sooner
     * than `Rooms.Delay` says. Measured 18–20s after the kill in a `Delay=1`
     * lair; MajorMUD has no such offset.
     */
    greatermudRespawnOffsetSeconds: 30,
    /**
     * What the opening backstab is worth in ordinary swings. Measured
     * 2026-09-12 on `orohost`: 62 backstabs at a mean 156.5 damage against
     * 218 swings at 38.5.
     */
    backstabMultiplier: 4,
    /** How many rooms a suggested loop visits at most, fillers included. */
    maxLoopRooms: 8,
    /**
     * How many of the best suggestions are measured — the ring's legs, its
     * size, its fillers. Every other one is still listed, on the survey's
     * first estimate: measuring all of them costs the thread a second.
     */
    maxSpots: 24,
    /**
     * How many of this character's own opened fights its measured damage a
     * round needs before the survey prices a kill with it, where the realm's
     * arithmetic cannot (`measuredPerRound`, off the GreaterMUD lineage).
     */
    measuredFightsMin: 30,
    /** How far the loop's own low-experience stop looks for a better lair, in steps. */
    betterSpotRadius: 80,
    /**
     * A room whose one cycle takes more than this share of the health bar is
     * left out before the ranking: a lair that costs half the bar a visit is
     * a lair whose rate is mostly resting, and starting there wastes the
     * evening whatever it pays (todo 00, 2026-09-13).
     */
    maxDamageShare: 0.5,
    /**
     * And a room that could not take this share off an *unarmoured* character
     * — every blow landing, at full damage — is beneath this level and left
     * out too. The bar is read `trivialLevelMargin` lower for the test, which
     * is the todo's *level minus five percent*.
     */
    trivialShare: 0.1,
    trivialLevelMargin: 0.05,
    /**
     * How far apart a loop's own rooms are measured, in steps, by a bounded
     * sweep from each — the ring's real length rather than the survey's
     * out-and-back guess. Measured 0.8ms a sweep at thirty on Paradigm.
     */
    clusterRadius: 30,
    /** How far off the ring a filler lair may lie, in steps, out and back. */
    fillerRadius: 8,
    /**
     * How far under the best rate a smaller loop may fall and still be the
     * one chosen. Past the clock the rate is flat but for the rounding of
     * rest ticks, and the fewest rooms that reach it is the loop worth
     * walking — the todo's *just enough to meet the timing requirements*.
     */
    sizeTolerance: 0.05,
    /**
     * How often automatic hunting may ask the survey — `AutoHunt`.
     *
     * A sweep is every room the exits reach and every lair in them priced, and
     * a status line arrives every few seconds: without a floor, a character
     * standing still would survey the realm two hundred times a minute. What
     * *re-opens* a settled answer is a level, the kit, or the lap stopping for
     * earning too little; this is only the floor under how often those may be
     * acted on.
     */
    resurveyMs: 60_000,
    /**
     * What a lair pays while somebody else is working it — `AutoHunt`.
     *
     * Experience divides among everybody who hit the kill (`Mob.cs:2270`), so
     * a second player in the lair is the plain halving this states. A price on
     * a candidate, never on the spot being walked: once a rate has actually
     * been *measured* there, the measurement is the figure and a model's guess
     * at the sharing is not needed.
     */
    contestedShare: 0.5,
    /**
     * How long a lair stays priced as somebody else's after they were seen in
     * it.
     *
     * A sighting is a fact with a shelf life: people leave. Without a clock a
     * stranger walking through once would price that lair at half for the rest
     * of the session, which is a lair the client never goes back to on the
     * strength of a passer-by. Long enough that somebody working a lair is
     * still working it, short enough that a passer-by is forgotten.
     */
    contestedForgetMs: 1_800_000,
    /**
     * How much better another lair must look before a hunt moves to it.
     *
     * A margin *and* a grace (`tuning.loop.expRateGraceMs`, the low-experience
     * stop's own), because the alternative is a character chasing estimates
     * round the realm: every move costs the walk there and the first cycle,
     * and two lairs within a few per cent of each other are the same lair for
     * this purpose.
     */
    moveMargin: 0.25
  },
  /** Spending character points on the stat screen — `StatScreen`. */
  train: {
    /**
     * How long the screen has to echo a keystroke before the driver lets go
     * of it. The live form answered every key inside a quarter of a second.
     */
    echoMs: 4000,
    /**
     * Once every trainer was out of reach, how long before the routes are
     * planned again — and only from a different room. A lap changes room
     * every three seconds and six routes per room is main-thread work spent
     * to learn nothing (todo 103).
     */
    reaskMs: 60000,
    /** A `train stats` still queued after this is for a moment that has passed. */
    expiresMs: 8000,
    /**
     * How long a sent `train` has to move the level before the errand gives up
     * on it and says so.
     *
     * The level moving is the confirmation — the server answers a paid `train`
     * with a welcome and a refused one with a band or a price, and the figure
     * the client already tracks says which without reading any of them. So
     * this covers only the case where nothing at all comes back, and it is
     * generous: the answer arrives with the next status line, and a realm
     * under load is still seconds rather than tens of them.
     */
    confirmMs: 10_000
  },
  /** Going back for the kit after a death — `GearRecovery`. */
  gearRecovery: {
    /** How long the pack has to reflect the `get`s before the kit is put on with what arrived. */
    collectMs: 8000,
    /** A `get` or `wear` still queued after this is for a room already left. */
    expiresMs: 6000
  },
  /** Getting back into the shadows between fights — `AutoStealth`. */
  stealth: {
    /**
     * The floor between two asks. A `hide` that failed its roll is asked for
     * again at this rate, not once per status line: at Stealth 20 the roll
     * fails seven times in eight, and a prompt answers every ask.
     */
    askEveryMs: 4000,
    /** A `hide` or `sn` still queued after this is for a room already left. */
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
    errandTimeoutMs: 300_000,
    /**
     * What one **doubling** of a counter's price is worth in steps of detour,
     * when the client is choosing which of several to stop at.
     *
     * Detour decides and this breaks the tie, which is the ordering a person
     * asking for petrol already has: 4.01 two minutes off the road beats 3.99
     * twenty-five minutes off it. The realm's markups run from 100% to 32,760%
     * over Paradigm's 242 shops, so the choice is real — but a torch is a
     * torch, and no price on one is worth crossing a map for.
     *
     * **A doubling rather than a percentage**, because the ratio is the part
     * the data states exactly: the base figure belongs to the *item* and is the
     * same at every counter that stocks it (0 of 1,539 rows differ), so between
     * two of them the markup is the whole difference and `(100 + markup)` is
     * the price in the item's own unknown unit. Ranking on its logarithm makes
     * the gap between two counters exactly the number of doublings, and stops a
     * sixtyfold markup from buying sixty times the walking.
     *
     * At twenty: twice the price is worth twenty moves of going out of the way,
     * and the whole realm's span of markups is worth about a hundred and
     * seventy. Zero makes the price count for nothing and detour decide alone.
     */
    dearerSteps: 20,
    /**
     * Copper withdrawn over what a purchase costs, where the vault holds it.
     *
     * The price is the server's own arithmetic and exact, but a counter's
     * markup is the realm's to change, and a purse withdrawn to the copper is
     * one refused the moment anything moves. A thousand is ten gold crowns: a
     * second waterskin, not a fortune carried about. Zero withdraws exactly.
     */
    cashBuffer: 1000
  },
  /** Carrying a quest's plan through the arbiter — `QuestRunner`. */
  quests: {
    /**
     * How long an act has to move the counter, or a handover to reach the
     * pack, before the silence is read as a refusal. The server answers an
     * ask with the next prompt and `abil` lists everything in one burst, so
     * this covers only a realm under load; a step with an `adddelay` waits
     * that delay on top.
     */
    replyMs: 12_000,
    /**
     * How many times a step that rolls (`testskill`) is asked again after
     * the counter stayed put. The red book passes one try in seven at
     * Intellect 45; twelve tries fail one time in six, and every try is one
     * ask and one listing.
     */
    rollTries: 12,
    /**
     * How many times a listing the outcome waits on — `abil` for a counter,
     * `i` for a pack a script handed something to — is asked for, `replyMs`
     * apart, before the silence is a setback.
     */
    listingAsks: 3,
    /**
     * How long to stand at a step's room waiting for its asker or its
     * monster to be there before the run gives up on it. A lair's clock is
     * minutes; a boss summoned by a step before this one is seconds.
     */
    waitForMs: 600_000,
    /** Legs planned again after a stopped walk, before the run gives up. A fight spends none. */
    maxLegs: 6,
    /**
     * How long the run stands still after a setback before trying the same
     * thing again. Long enough for what caused one to pass — a move nobody
     * answered, an escape, a monster between the character and the door —
     * and short enough that a night's run is not spent waiting.
     */
    retryMs: 20_000,
    /**
     * Setbacks in a row, with nothing achieved between them, before the run
     * gives up for good. Anything going right — a leg started, an item in the
     * pack, a step confirmed — puts the count back to zero, so this counts a
     * run that is stuck rather than a run having a hard night.
     */
    setbacks: 20,
    /** A queued ask, phrase or `abil` still waiting after this is for a moment that has passed. */
    expiresMs: 8000
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
     * A lair whose effective respawn is at most this many seconds is not a
     * resting place (`RestAway`, todo 08). A rest from 20% to 70% takes
     * minutes, so a clock of ten minutes or less is one that runs out during
     * it; a boss's clock of hours is not.
     */
    lairClockMaxSeconds: 600,
    /** How long a `l <direction>` and then the step next door may go unanswered. */
    peekMs: 4000,
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
     * How long a walk stands in the room it has just arrived in before
     * stepping out of it again, where the room it left held a monster.
     *
     * The server works the follow out **inside** the move — `Exits.cs:165`
     * collects every mob in the room whose `CurrentTarget` is this character,
     * rolls each against `MobType.FollowPercent` and moves the winners with
     * the player — so the arrival sentences are composed *after* the room
     * block, and `Also here:` is absent from a room block that is about to
     * hold five monsters. Measured on
     * `2026-09-23_09-33-51_festus.mudcap.jsonl` t=1678757: one socket read
     * carried the room block, the prompt and all five
     * `saracen ... moves into the room from the west.` lines, and the walk
     * sent `ne` six milliseconds in.
     *
     * **A margin over that window, and only that window.** Across every
     * session log on this machine, 28 monsters arrived from the direction the
     * character had just come, naming something the departure room's own
     * listing held. 22 are that synchronous follow: none later than 39ms, and
     * four of them a socket read behind the room block rather than in it, so
     * the read boundary alone is not the bound. One straggler at 330ms. This
     * covers both with room to spare.
     *
     * **It does not cover the chase, and nothing could.** The other five
     * arrived 959–1,670ms on: `Mob.CheckFollow` tracks through
     * `Room.RecentMovers` on the monster's own clock and forgets the target
     * only after thirty seconds, so a chaser can arrive at any tick. One that
     * arrives while the character is standing there is the ordinary arrival's
     * to answer; one that catches up after the walk has moved on is a
     * different problem, and a longer settle would buy a slower walk rather
     * than a solution.
     *
     * **Paid only where something could follow.** A room the character left
     * empty settles for nothing, so an ordinary corridor walks at the speed
     * it always did.
     */
    followSettleMs: 350,
    /**
     * How far the character may have wandered from what it was walking before
     * pressing play asks about it first.
     *
     * A stop is a pause that may or may not be permanent, so the thing it
     * stopped is still there hours later — and the character may have been
     * walked across the realm, or killed and reborn in a temple on another
     * map, in between. Picking it back up is then a journey in its own right
     * that nobody asked for, which on a realm full of wandering monsters is
     * not free. Past this many steps `SessionManager.startMoving` answers with
     * a question instead of a command.
     *
     * Measured as how much *further* away the character is now than when the
     * movement stopped — for a route and for a lap alike, so a movement
     * stopped and started again from the same room never asks however far it
     * still has to go, and a character killed and reborn two maps away does.
     */
    resumeAskSteps: 30,
    /**
     * How far the character may have strayed from the room a drawn plan starts
     * in before pressing Walk asks about the plan it is redrawn as.
     *
     * A plan is drawn from where the character stood when it was drawn, and a
     * lap or a party leader moves it while the panel is open — so the press
     * used to earn *that route does not start here*, with nothing to do about
     * it but draw the same plan again. It is redrawn from here instead, and
     * the only question left is whether the reader is still looking at the
     * journey they agreed to.
     *
     * **Counted in the router's own steps, not in map squares**: how many
     * moves the character has actually made away from where the plan began.
     * Ten is a lap's worth of wandering — the case this exists for — and well
     * inside the distance at which a way somewhere else stops being the same
     * way. Past it the new plan is put back on screen to be read.
     *
     * Its own figure rather than `resumeAskSteps`: that one bounds walking a
     * *stopped* movement back across the realm, which is a journey nobody
     * asked for, and this one bounds how far a plan may drift before it is
     * worth a second look. 0 asks about every redrawn plan.
     */
    replanDriftSteps: 10,
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
     * How long an errand keeps offering the way it owes before giving up.
     *
     * The window this exists for is a move of the client's own still on the
     * wire. Collecting is a loop, and a loop steps on without waiting for the
     * server to confirm what was picked up — measured 2026-09-14
     * (`logs/2026-09-14_16-00-21_festus.mudcap.jsonl`): `get black serpent
     * key` at t=783180, the lap's `n` at t=783182, `You took black serpent
     * key.` only at t=783262. So the instant the pack holds the thing there is
     * a step outstanding, `Walker.start` rightly refuses to plan across it
     * (`refusalMoveInFlight`, the room on the books is the one being left),
     * and the errand had exactly one attempt: the key was collected and the
     * journey it was collected for was never walked.
     *
     * A retry rather than a hold, because each attempt re-plans from where the
     * character now stands — so waiting costs nothing and catches the answer
     * whenever it lands. Seconds, not minutes: an unanswered move resolves in
     * about one, and past this the refusal is a real one worth reporting.
     */
    errandHandoverMs: 15_000,
    /**
     * How long a walk stands still for a condition before spending one step
     * to find out whether it is over.
     *
     * **A retry, not a deadline.** The other two bounds in this block give up;
     * this one asks. A hold ends when the realm says so and the client reads
     * twenty-two of those sentences — the two fixed in the server's code
     * (`You can move again!`, and `You are held!`'s own pair) and the twenty
     * the message table pairs with a spell whose `HoldPerson` row the realm
     * states. A realm is free to ship a twenty-third, and a wear-off nothing
     * here can read would otherwise stand a route still for the evening.
     *
     * One step is what settles it, and it is the cheapest thing that can:
     * `Exits.Move` either walks the character or prints the holding spell's
     * own sentence again, which re-arms the hold with a fresh window. So the
     * cost of being wrong is one command every half minute, and the cost of
     * having no bound at all is the journey.
     *
     * Long enough that a hold this client *can* read is over well inside it —
     * the realm states `knockdown` at `Dur` 4 against `hold person`'s 4 and
     * `sphere of isolation`'s 200, in units nothing has measured — and short
     * enough that an unreadable one costs seconds rather than an evening.
     */
    heldFallbackMs: 30_000,
    /**
     * How long a walk stands still in a room too dark to read, waiting for the
     * light `AutoLight` is readying.
     *
     * The whole of what it is waiting for is three commands and two server
     * answers — `light <thing>`, `You lit the torch.`, `l`, the room — and
     * measured live on 2026-09-15 that took **145ms** end to end. What makes
     * this seconds rather than a fifth of one is the queue: the light goes out
     * in the `movement` band behind whatever else is in flight, and the band
     * is paced by the prompt, so a busy corridor can put a couple of prompts
     * between the proposal and the wire.
     *
     * A deadline and not a retry, unlike `heldFallbackMs`: there is nothing
     * further to ask. Past it the room is dark for a reason no light in the
     * pack fixes — a pearl that lifts `pitch black` only as far as `very
     * dark` — and the walk stops with the sentence it always had.
     */
    lightWaitMs: 8_000,
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
    /**
     * Confirmed steps a retreat looks back over.
     *
     * Its own figure, and deliberately a small one: the `doubles-back` rung
     * prefers an exit leading somewhere the character has already stood, and
     * with the whole session's history to hand that rung would claim every
     * exit in the realm. The trail itself is far longer (`trailSteps`); the
     * escape reads its tail.
     */
    recentSteps: 5,
    /**
     * How many confirmed moves the trail keeps — the back button's history.
     *
     * *Where we came from*, as a list of rooms and the move that joined each
     * pair, so going back is a route to the previous room rather than the
     * opposite of the last direction (which for a one-way exit leads nowhere,
     * and for a text exit is not a direction at all). Each press walks back
     * one entry and gives it up; the forward moves push.
     */
    trailSteps: 500,
    /**
     * How long a room the character ran out of stays a room it must not run
     * back into, once nothing is recorded fighting.
     *
     * The list used to be emptied by the first instant the client saw no
     * fight, and a fight against two monsters manufactures that instant for
     * free: `*Combat Off*` names the death of the current target and the dead
     * leave the attacker list with the kill, so between one monster dying and
     * the second swinging again there is nothing recorded at all. The next
     * escape then picked the room fled three seconds earlier and the character
     * died there — four times, across three areas and two monster families.
     *
     * Set from the gap actually measured rather than chosen for comfort: in
     * `out/drive-L30-long.jsonl` the second champion's blow lands in the same
     * millisecond as the `*Combat Off*` and again 915ms later, and the escape
     * that killed the character fired 2,009ms after the gap opened. Ten
     * seconds covers that with room to spare while staying far short of a
     * walk back through a corridor minutes later being refused, which is the
     * cost of setting it too high.
     */
    ranFromForgetMs: 10_000,
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
     * How long a walk stands at a hidden exit between two searches for it.
     *
     * There is no *count*: the realm's own data says a search reveals this
     * exit, and a client that stopped asking after two rolls of a skill check
     * would be deciding the realm is wrong — which is the reported failure
     * (todo 04), where a hand-typed third search found it a moment after the
     * route had struck the corridor out. So the ceiling is gone and this is
     * the pace instead, which is the whole of what bounds the spend.
     *
     * A little over one status line, which is the cadence the server answers
     * at: the search and the step behind it are two commands, and a floor
     * shorter than a round would put both into one.
     */
    searchRetryMs: 1_500,
    /**
     * How often a walk repeats the line about the hidden exit it is waiting
     * for.
     *
     * The searching has no ceiling, so the hold can outlast a lap — and said
     * once, the reason for a standstill is a line eight hours up the
     * scrollback. A hold that lasts one round says itself once (the barrier's
     * rule); one that can last a night has to keep saying so, or a character
     * standing in a corridor is silent about why.
     *
     * Five minutes: long enough that it is never the chrome talking over the
     * game, short enough that somebody who looks at the console gets an
     * answer without scrolling.
     */
    searchSayEveryMs: 300_000,
    /**
     * How many failed searches before the walk asks the server to reprint the
     * room, rather than only after a search that succeeded.
     *
     * A found exit joins the room's own `Obvious exits:` line, and that line is
     * what `Walker.mustSearchFirst` reads to decide the exit is there — but the
     * server prints `You found an exit to the south!` and **does not reprint
     * the room**. So the walk went on searching a room whose exit it had
     * already found, reported off the wire as todo 03: eleven `search s`, seven
     * of them answered `You found an exit to the south!`, and not one step.
     *
     * A success is always answered with a reprint; this is the same reprint on
     * a count, for the two ways the success can be missed — the sentence
     * arriving in a burst the walk was not holding for, and somebody else
     * opening the way. Three: cheap enough beside three searches, and far
     * enough apart that a reprint is not queued behind every one of them.
     */
    searchRecheckEvery: 3,
    /**
     * How many rounds of levers one action-gated exit is worth — format 23's
     * other kind of hidden exit (`Walker.pullLevers`).
     *
     * Counted where a search is paced, and the difference is what the data
     * says: the realm names the exact phrase that opens this one, so a couple
     * of rounds either works or the phrase is not what the realm claims. A
     * search is a skill check the realm expects to fail sometimes.
     */
    leverTries: 2,
    /**
     * How long a walk stands at a shut door it could not force before running
     * the whole ladder again.
     *
     * The figure is the one the report asked for. It is long enough that a
     * character resting under `restBelow` gets several status lines of
     * recovery between rounds — which is the case the retry exists for, since
     * a bash costs health and the rung that spends it is refused while the
     * character is too hurt to travel.
     */
    barrierRetryMs: 5_000,
    /**
     * How many times the ladder is run again before the walk gives up on the
     * door.
     *
     * `fightHoldMs`'s argument in the other shape: a hold whose end nothing in
     * this client can bring about needs a floor under it, or an unattended
     * character stands at a portcullis sending `bas w` all evening. What ends
     * *this* hold is the door opening — by this character's next bash, by a
     * lock that rolls better, or by somebody else walking through it — and
     * none of the three is guaranteed to happen at all.
     *
     * Twelve rounds at five seconds is a minute of trying, which is far longer
     * than the ladder used to get (it stopped on the first exhausted round)
     * and short enough that a lap whose route is genuinely walled off is
     * reported rather than silently stalled.
     */
    barrierRetries: 12
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
    resumeMarginWhenUncapped: 0.1,
    /**
     * How long a lap runs before its experience rate is held against
     * `automation.walk.minExpPerHour`. The first minutes of any lap are the
     * walk to the first lair, at no experience at all, and a floor judged
     * then would stop every lap on the way out of town.
     */
    expRateGraceMs: 900_000
  },
  /** Answering for an absent player; see `automation.afk`. */
  afk: {
    /**
     * How often one sender is told the player is away. A person who telepaths
     * twice in a minute has been answered once; a reply per line is a client
     * arguing with them.
     */
    replyEveryMs: 600_000
  },
  /** The `@` conversation with another player's client. */
  remotes: {
    /**
     * How long a question sent to another client waits for its answer before
     * it is written off.
     *
     * It decides one thing only: whether an **extended** remote — a question
     * only this client can answer — went to somebody who is not running it, so
     * the plain wording is sent instead and the player is recorded as not
     * reachable that way. Erring long costs a question its latency once; erring
     * short records somebody as the wrong client on a slow evening and stops
     * asking them the better question.
     *
     * **Not measured against a peer.** There is no capture of two of these
     * clients talking, because there has never been a second one. Thirty
     * seconds is chosen against what a telepath round trip costs on the wire
     * here — a status line answers in about 1.2s and the slowest measured
     * command answer is well under ten — with the rest as margin for a client
     * whose player is mid-fight. Revisit with a capture.
     */
    replyMs: 30_000,
    /**
     * How often a character still under `party.askForHealBelow` says `@heal`
     * again. MegaMUD's own party clock (`ParPeriod=15` in its sample.ini) is
     * how often it re-reads the listing in a fight; a healer that could not
     * answer the first request hears the second about as often.
     */
    healAskAgainMs: 15_000
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
    /**
     * How far experience must fall before it counts as a sign of a reset.
     *
     * The weakest of the four signals and the only one with an innocent
     * explanation: a death costs experience. So it is a *share* of what was
     * there rather than any drop at all, and at 0.3 a death would have to cost
     * a third of everything the character had earned to raise it — which on
     * this server family it does not. `0` switches the signal off; the other
     * three are facts a character cannot do to itself and have no threshold.
     */
    resetExpDropShare: 0.3,
    /** Negotiation records the diagnostics pane can look back over. */
    telnetLogLimit: 500,
    /** Framed lines retained; the terminal keeps the real backscroll. */
    lineLogLimit: 500,
    /**
     * The most commands one talk-box line may stand for (todo 04). The line
     * is paced by the prompt, so this is not the realm's flood limit; it is
     * what `99s` typed for `9s` would cost before anyone could stop it.
     */
    macroCommands: 40,
    /**
     * How long a prompt that has opened its bracket and not closed it may
     * keep arriving before the client stops waiting for the rest.
     *
     * The bearfather BBS writes its prompt in two pieces about a tenth of a
     * second apart — `[HP=40/40,…,S= (Resting)` and then ` ]:` — and both the
     * idle flush that frames a prompt and the hold that draws a designed one
     * used to give up between them, so the prompt was neither read nor
     * redrawn. Measured on 2026-09-09 over 504 split prompts: median 123ms,
     * p99 258ms, longest 686ms. A prompt still arriving costs nothing to wait
     * for, since nothing else can follow it on the wire until it ends, so the
     * bound is generous; it is only what paints a prompt a server never
     * finishes. `mudengine-wire` § Line framing is not CRLF.
     */
    promptHoldMs: 1000,
    /**
     * How long a tail that is *not* a prompt may keep arriving before the
     * client frames it anyway.
     *
     * The quiet period that releases a prompt is 150ms, and over the internet
     * that is not long enough to mean a sentence ended: bearfather's BBS
     * paused 178ms in the middle of `Intersection of River St. & Mystic
     * Alley`, and the half in hand was framed as a line, read as a room name,
     * and written into the character's memory as a place that does not exist.
     * Measured over 670 captured sessions, 25 server sentences were cut in
     * half this way — room exits, a monster's arrival, and `who` roster rows
     * split mid-name; 700ms covers 22 of them. The three left are two BBS
     * banner lines nothing parses and one 33-second stall, where waiting
     * would be worse than splitting. Nothing waits on this deadline but text
     * the server appended after a prompt, which is why it is not longer.
     * `mudengine-wire` § Line framing is not CRLF.
     */
    sentenceHoldMs: 700,
    /**
     * How long the lines of a listing the client redraws (`ui.rewrites`) are
     * withheld while the rest of it arrives, before they are painted as sent.
     *
     * A listing is redrawn whole, at the status line that ends it, so its
     * lines wait for that prompt: the idle flush frames it 150ms after the
     * last byte, and the whole exchange is one round trip. This is the bound
     * behind that, for a server that stalls mid-listing or never ends it —
     * the same span a sent command waits for its acknowledgement.
     */
    rewriteHoldMs: 2000,
    /**
     * Records the debug window keeps, and therefore how far back a bug report
     * reaches.
     *
     * Larger than the others on purpose: this ring holds every kind of record
     * at once — the raw stream, the framed line, the classification, the state
     * change and the decision — so one line of the game costs several entries,
     * and a report that only covers the last few seconds does not cover the
     * thing somebody is reporting. It fills whether or not the window is open,
     * because a trace you have to turn on before the surprise is one that never
     * catches it.
     */
    debugLogLimit: 4000,
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
    /**
     * How many recorded fights are folded per turn of the event loop when a
     * character's record is first read back. Forty thousand fights parse in
     * a quarter of a second, and that quarter used to be one stall of the
     * socket; sliced, the socket is read between the slices.
     */
    fightsFoldSlice: 500,
    /** How long the conversation log holds lines before writing them. */
    talkFlushMs: 2000,
    /** How many it holds if a flush never happens. */
    talkHeld: 500,
    /** How long painted console output waits before it is written down. */
    backscrollFlushMs: 2000,
    /**
     * Rewrite the backscroll file once it holds this many times what is kept,
     * rather than appending for ever: it is read whole at launch, and a cap
     * on the lines kept is not a cap on a file that only grows.
     */
    backscrollRewriteAt: 2,
    /** How long a balance change waits before it is written. */
    belongingsWriteDelayMs: 2000,
    /**
     * How long the running totals wait before the record is written. Longer
     * than a balance, because they move on every blow and the record is
     * rewritten whole; a crash costs at most this much of them, and a quit
     * writes them exactly.
     */
    statsWriteDelayMs: 30_000,
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
    /**
     * Rows in one realm's find log before the oldest is dropped.
     *
     * A find is one thing in one room, so this is a count of *places worth
     * searching* rather than of searches: a room searched every lap is one
     * row. Larger than `memoryLimit` would buy nothing — the shipped realm has
     * 2,150 rooms — and smaller would start dropping a realm somebody has
     * actually explored.
     */
    findLimit: 2000,
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
    portalPenalty: 3,
    /**
     * What using an item that teleports costs over an ordinary step
     * (`WorldItem.lands`).
     *
     * Dearer than a portal by a wide margin, and deliberately: a room script's
     * teleport is scenery the realm lets anybody walk through as often as they
     * like, and this **spends a charge somebody has to go and replace** — one
     * of a potion's one, one of a token's five. So the figure is not what the
     * move is worth in moves, it is the price at which the router stops
     * preferring a shortcut to a walk: at forty, a token is taken only where
     * it saves more than forty rooms of walking, and the potion of levitation
     * is still taken at any price at all because the Catacombs have no other
     * entrance and every alternative is `wallCost`.
     */
    itemLandingCost: 40,
    /**
     * What a step along a route the player saved costs, as a fraction of an
     * ordinary one.
     *
     * A route drawn on the loop builder and saved (`prefer: true` in its
     * file) is the player saying *this is the way*; every step on it is
     * priced at this fraction, so the router follows it wherever it can and
     * leaves it only for a way shorter by more than the discount. A tenth
     * means a saved route of a hundred rooms still beats a shortcut of
     * eleven. Zero would make it free, which the router survives; one would
     * make saving a route mean nothing.
     */
    preferredStepCost: 0.1,
    /**
     * What a lair expected to take half of the character's current health in
     * one pass costs to route through, in plain steps.
     *
     * A lair is priced by one pass through it (`lairPassage`): its worst
     * monster that attacks on sight, as many as the lair holds at once, for
     * the rounds spent inside (`passRounds`), as a share of the health the
     * character has *now*. The step costs `dangerCost × share / (1 − share)`:
     * a tenth of the bar costs about two doors, a quarter about five, a half
     * this figure, and the price climbs without bound as a pass approaches
     * the whole bar — up to `deadlyShare`, where it is a wall. Two hundred is
     * about what resting half a bar back takes, in commands: `HPRegen`, three
     * times over, every fifteen seconds (docs/greatermud/player-and-world.md).
     */
    dangerCost: 200,
    /**
     * The share of current health one pass is expected to take at which a
     * lair is priced as a wall (`wallCost`): walked only when there is no
     * other way at all, never preferred while there is. One is *expected to
     * die there*.
     */
    deadlyShare: 1,
    /**
     * The most of the bar a pass **nobody can say will happen** may be priced
     * at, however bad it would be if it did.
     *
     * A monster's disposition can be conditional — `hates-evil` opens on an
     * Outlaw and leaves a Saint alone — so a character whose standing the
     * client has not read meets *nobody can say*, and `lairPassage` counts
     * such a monster **in** rather than out, because unknown is never the
     * reassuring answer. Counted in at its full share it reaches
     * `deadlyShare`, and a fact nobody has read then **walls** a corridor —
     * which is the one thing `edgePenalty` was fixed not to do for a gate it
     * cannot evaluate, and which sent a route 46 steps around a town square
     * it could have crossed (bearfather, 2026-09-17). So the share is capped
     * rather than the monster dropped: a tenth of the bar is about twenty
     * plain steps, enough to prefer a way round that exists and never enough
     * to justify a map. `deadlyShare` or above restores the wall; zero says
     * *safe*, which is the other way to be wrong.
     */
    unsureShare: 0.1,
    /**
     * What one pass through a room whose spell this client **cannot read** is
     * priced at, as a share of the bar.
     *
     * A room's own spell is followed to its harm at build time
     * (`spellHazard.ts`), and 27 of the shipped realm's room spells end in a
     * verb this reader cannot evaluate — `graveyard summon`, `fire trigger`.
     * Unknown is never the reassuring answer, and here the reassuring answer
     * is *walk through it for free*, which is what put a route down eighty-
     * eight rooms of the Silver River. Small on purpose: a few plain steps
     * each, so a corridor of them is avoided where there is an alternative
     * and still walked where there is not. Zero would restore the bug.
     */
    unreadHazardShare: 0.02,
    /**
     * The share of the bar a room's own spell has to take before the router
     * goes looking for a way round it (`Route.otherWay`).
     *
     * A second A* per route, so it is worth spending only where the answer
     * would change somebody's mind. A twentieth of the bar per room is
     * nothing on its own and a hundred rooms of it is the Silver River, so
     * the threshold is per *room*: anything at or above this is worth asking
     * *is there another way*, and anything below it is weather.
     */
    otherWayShare: 0.05,
    /**
     * How many steps shorter the way with the right items has to be before it
     * is offered beside the plan (`Route.carrying`).
     *
     * The river with a log raft against the slums without one is 88 steps
     * against 107 and worth a choice; a way two steps shorter is the same way
     * with a corner cut, which is exactly what the reader asked not to be
     * shown. One more A* per route planned for a reader.
     */
    alternativeMinSteps: 10,
    /**
     * What a step along the plan costs while the router is asked for a way
     * that differs from it (`Route.another`): the plan's own edges are priced
     * this many times over and the search asked again, so it leaves the plan
     * wherever a detour costs less than this much of what it replaces. 1
     * finds the plan again and offers nothing.
     */
    anotherWayPenalty: 3,
    /**
     * How much longer than the plan a different way may be and still be
     * offered, as a share of the plan's steps: 0.5 is half again as long. A
     * way that differs is expected to be dearer — that is why it was not the
     * plan — and past this it is a tour rather than a choice.
     */
    anotherWayLonger: 0.5,
    /**
     * How many of a consumable a quest's plan buys against a room spell on
     * the way, where the realm says using one stops the spell.
     *
     * A waterskin is three uses and its spell lasts 600 ticks, the desert
     * crossing is 64 rooms each way, and the plan cannot know how many times
     * the walk will stop: two is one spare. A thing that is not spent
     * (`WorldItem.uses` absent or unbounded) is fetched once whatever this
     * says.
     */
    hazardSupplyCount: 2,
    /**
     * How many rounds of a lair's blows one pass through the room is priced
     * at. In and out is one round from whatever attacks on sight; two prices
     * every lair as if the character stood a round longer in each.
     */
    passRounds: 1,
    /**
     * How many times nearer than every other row sharing its name a monster
     * has to spawn before the room is taken to have resolved which row it is
     * (`WorldGraph.resolveMobRow`).
     *
     * The wire carries a name and the realm holds several rows under it —
     * `gnoll scout` is a 100-HP row 224 and an 830-HP row 2204 — so the card
     * folded them and answered `100–830 hp`. Where the room's own lair names
     * one, that is the answer and nothing here applies. Where it does not,
     * nearest-wins on its own would resolve a room one step nearer 224 than
     * 2204, which is evidence of nothing: monsters wander and are dragged.
     * Eight means five steps beats forty-one and does not beat thirty-nine.
     * One would make any tie-break a resolution; a very large figure resolves
     * nothing but the rows the realm places on one map only.
     */
    mobRowMargin: 8,
    /**
     * How many rooms that search may reach before it gives the question up.
     *
     * It stops on its own as soon as no room left could change the answer, so
     * this is only ever reached by a name whose rows all spawn a long way off
     * — where the honest answer is *this room says nothing* and walking the
     * remaining fifty thousand rooms would not change it. Bounded because the
     * question is asked from a status line.
     */
    mobRowRooms: 20_000,
    /**
     * How enclosed a place has to be before the client will say what the way
     * into it wants (`WorldGraph.approachItems`).
     *
     * The sweep runs backwards from a room over every way in that demands no
     * item, so what it collects is a region with **no ungated entrance at
     * all** — and every item-gated edge into that region is therefore a
     * genuine way in. That reasoning holds only while the region stays a
     * pocket: let it out into the open realm and the gates it then meets are
     * other pockets' doors, which this room's way in has nothing to do with.
     * So the sweep gives the question up the moment it has walked this many
     * rooms, and the answer is silence rather than a list of every key in the
     * realm. Three hundred is an order of magnitude above the largest pocket
     * either shipped world holds behind a gate (the Catacombs, at 98 rooms
     * across two of them) and two orders below the open component.
     */
    approachRooms: 300,
    /**
     * How many of a quest step's items the errand solver will put in order
     * (`WorldGraph.errand`).
     *
     * The order is exact rather than greedy — every permutation, over every
     * place each item can be got — so the work is exponential in this figure
     * and the bound is what keeps it honest rather than approximate. Eight is
     * twice the largest step either shipped world holds (four, on
     * PhoenixQuest and Conquest1) and still solves in well under a
     * millisecond; a step above it gets no order at all and says so, which is
     * this project's refusal rather than a walk somebody guessed at.
     */
    errandItems: 8,
    /**
     * How many of the places one item can be got the solver will weigh.
     *
     * A quest component is usually handed over in exactly one room, but a
     * monster that drops one spawns in up to sixteen and a shop that stocks
     * one may be in fourteen — and every one of them is a sweep. The nearest
     * few to where the character is standing are kept, because a place further
     * off than three others is not the one the shortest walk goes to unless
     * the walk was going that way anyway, and the places kept are re-weighed
     * against the *whole* walk rather than picked by distance alone.
     */
    errandPlaces: 3,
    /**
     * How many rooms one of the errand solver's sweeps may settle before it
     * gives that origin up (`WorldGraph.sweepTo`).
     *
     * `scatterSweepRooms`' bound, one solve across, and for its reason: the
     * sweep stops on its own the moment every room it was asked about is
     * settled, so this is only ever reached by an errand whose places cannot
     * be walked to — where exhausting the component is exactly what the
     * answer *no way there* costs. Measured on Paradigm at 33,000 rooms
     * settled for the worst of the shipped errands.
     */
    errandSweepRooms: 60_000,
    /**
     * How many rooms one backward sweep of the scatter solve may settle before
     * it gives that figure up (`WorldGraph.sweepBack`).
     *
     * The sweep stops on its own the moment every room it was asked about is
     * settled, and a scatter's landings sit inside the maze the scatter
     * closes, so on both shipped realms the asylum's four sweeps settle 54 to
     * 68 rooms and stop. This is the bound for a realm this client has never
     * seen — a landing nothing can leave would otherwise walk the whole
     * fifty-seven thousand. Over it the scatter is left unpriced and the
     * router does not offer it, which refuses an option rather than inventing
     * a way through one.
     */
    scatterSweepRooms: 60_000,
    /**
     * How many rounds the scatter expectation is iterated before it is taken
     * as settled, and how small a round's movement has to be to stop early.
     *
     * The iteration contracts by `(landings − 1) / landings` a round — a
     * ninth of the way for the padded cells, a twenty-fourth for the asylum
     * itself — so the shipped realm stops moving by this much in about 120
     * rounds, and the ceiling is headroom for a wider draw. What is left at
     * that point is the tolerance over one minus the contraction: about two
     * thousandths of a move on the asylum, against a figure the reader is
     * shown as a whole number.
     */
    scatterRounds: 2_000,
    scatterTolerance: 0.0001,
    /**
     * How many destinations' *move* figures are kept before the lot is thrown
     * away (`WorldGraph.scatterMoves`).
     *
     * The figure a reader is shown depends on the destination alone, never on
     * the character, so it is worth keeping across a session — and a
     * destination is a room, of which a realm has tens of thousands. A handful
     * covers walking into a maze, being scattered, and re-planning to the same
     * place a dozen times over, which is the shape of every walk this is for.
     */
    scatterMovesKept: 32
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
   * Serving the window over HTTP (`MUDENGINE_WEB=1`; see `main/host/web/`).
   */
  web: {
    /**
     * The largest message a browser tab may send on the socket. A settings
     * draft or a loop handed over whole is tens of kilobytes; anything near
     * this is not a call the window makes, and reading it would be holding a
     * megabyte on behalf of whoever sent it.
     */
    maxMessageBytes: 1_048_576,
    /**
     * How much may be queued for a tab that has stopped reading before it is
     * closed. The game stream keeps arriving whether or not a tab takes it,
     * and a stalled one would otherwise hold it all in memory until the ping
     * sweep noticed. Several seconds of a busy fight, at most.
     */
    maxBufferedBytes: 8_388_608,
    /**
     * How long a wrong password waits for its answer. A guess a second is
     * what the delay costs an attacker; nothing at all is what it costs
     * somebody who mistyped once.
     */
    loginDelayMs: 1000,
    /**
     * How often the client pings each tab. A proxy closes an idle socket and
     * a tab that vanished never says goodbye; a ping unanswered by the next
     * one is how either is found, and the interval is what it costs.
     */
    pingIntervalMs: 20000
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
    /**
     * How often a browser tab that lost its socket tries the client again
     * before reloading itself. Web mode only; the desktop window has no socket
     * to lose.
     */
    webReconnectMs: 1500,
    /** Framed lines kept for the Stream card. */
    lineLogLimit: 200,
    /**
     * Remembered conversation. Generous, because the point of keeping it is
     * that somebody can come back to what they missed.
     */
    talkLimit: 500,
    /**
     * How long the Talk card waits, after the reader's last scroll, before it
     * goes back to following the newest line.
     *
     * Scrolling up is a question being asked of the backlog, and a log that
     * yanks itself back down mid-sentence answers it by taking it away. But a
     * log that stops following *for good* is worse: the reader has gone back
     * to playing and the card is quietly frozen on a conversation from five
     * minutes ago, which is the failure this card exists to prevent. So the
     * hold is a hold, not a mode, and it expires.
     *
     * **Forty-five seconds** (todo 10, asked for): fifteen was measured
     * against a reader glancing back a line or two, and the thing people
     * actually do is read a paragraph of what somebody said while the fight
     * carries on underneath. Measured from the *last* scroll, so reading up
     * through a backlog keeps extending it; landing back at the live edge
     * resumes at once and does not wait, and the *jump to latest* button is
     * there for the whole of the hold.
     */
    talkFollowResumeMs: 45_000,
    /**
     * How long the quest run banner stays over the console saying how the run
     * ended, before it takes itself down. The ending is also in the stream
     * and on the Quest card, so the banner is a notice and not the record —
     * and while it stands it covers the console's top rows and takes their
     * clicks. Long enough to read a reason; the × on it is for sooner.
     */
    questRunLingerMs: 30_000,
    /**
     * Lines the Talk composer remembers for its Up arrow.
     *
     * A short list on purpose. This is the shell's history, not the card's
     * backlog: what it is for is saying the same thing again, or fixing a typo
     * in what was just said, and nobody arrows back forty lines to do either.
     */
    talkHistoryLimit: 40,
    /** Remembered notices. Same reasoning, same generosity. */
    noticeLimit: 400,
    /**
     * The least time between two desktop notifications of the *same kind*
     * about the same character.
     *
     * Without it the client raises one per flush that carries a new alert, and
     * a player being attacked is a fresh `user-hits` several times a round —
     * an evening away would leave a notification centre with hundreds of
     * entries in it, which is the state everybody's first act is to turn the
     * feature off from. Four blows from the same person is one thing that
     * happened.
     *
     * Per kind rather than per character, so a floor on being attacked cannot
     * swallow the notice that the character then died. A minute: long enough
     * for a fight to be one notification, short enough that somebody who did
     * not look the first time is asked again.
     */
    desktopAlertGapMs: 60_000,
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
    /**
     * Rows the debug window keeps on screen.
     *
     * Its own key rather than main's `session.debugLogLimit`, because the two
     * bound different costs: main's ring is memory behind a bug report, and
     * this is DOM in a window that is scrolled through. Somebody who wants a
     * deeper report is not necessarily asking the window to hold more rows,
     * and the window is the half that gets slow first.
     */
    debugRows: 4000,
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
    /**
     * How near a card in hand must come to one already over the console
     * before releasing snaps it to that edge — and, across the edge, how much
     * of the two must face each other for *beside* to mean beside rather than
     * past the corner. One number for both: they are the same gesture, and a
     * second would be a second thing to tune to make one feel right.
     */
    snapDistance: 24,
    /** Between a popover and its anchor, and between a popover and the edge. */
    popoverGap: 8,
    popoverMargin: 8,
    /**
     * How wide a slide-out panel is allowed to be, and how small it may be
     * dragged.
     *
     * It was a flat 300px in the stylesheet, and a panel that narrow turns a
     * monster's `0 hp a round against you` into a column one word wide and
     * twenty lines tall — the panel then scrolls, so the answer somebody asked
     * for is below the fold on a screen with room for it three times over. The
     * width is chosen from the room actually beside the anchor now, between
     * these two: the floor is what the readout's two columns need to read as
     * columns, and the ceiling is where a line stops being comfortable to read
     * and starts being a paragraph the eye has to track back across.
     */
    popoverWidthMin: 300,
    popoverWidthMax: 560,
    /** The smallest a panel may be dragged to and still be worth reading. */
    popoverMinHeight: 120,
    /** How close a popup menu may come to the edge of the window. */
    menuMargin: 4,
    /** Room radius on the map, and the margin that keeps one in the viewBox. */
    mapRoomRadius: 3,
    /**
     * How far out the local map walks, as the bounds a *measured* radius is
     * clamped into.
     *
     * The view asks for the radius its window can show — `radiusForView`:
     * what the window reaches from the centre room at its zoom and pan,
     * measured from the laid-out box, plus half a cell — rather than always
     * asking for five, which is what it did until 2026-08-31: a map dragged
     * twice as tall drew the same six rooms twice as large, because the
     * viewBox scaled the picture and nothing ever fetched more of it.
     *
     * The floor is what a rail card can show and the ceiling is what stops a
     * full-screen float walking the whole realm — the breadth-first search is
     * exponential in the radius, and `world.mapCells` alone bounds the
     * *result* rather than the work. The ceiling is also the smallest a room
     * may be drawn: a window wider than the widest fetch would show blank
     * space, so `zoomFloor` stops the wheel where the fetch spans the box.
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
     * How much one notch of the wheel zooms a map, as a percentage of the
     * room's size — in towards the reader, out away — about the point under
     * the pointer, between the two ends above. A whole number because a
     * fractional default here would be read as a fraction of one and clamped.
     */
    mapZoomStepPercent: 25,
    /**
     * How many colours the way on a map may use before it stops changing.
     *
     * A lap that comes back the way it went draws one line over another, so
     * the way changes colour each time it starts doubling back over ground it
     * has already covered — which is the whole question somebody building a
     * loop is looking at the map to answer.
     *
     * Capped because the point is to tell a few passes apart, not to give
     * every one its own hue: past three the map is a colour chart and the
     * reader has to consult a legend to read a line. Bands beyond the cap all
     * draw in the last colour, which still says *this has been covered before*
     * without adding a fourth thing to learn.
     */
    mapTrailBands: 3,
    /**
     * How long after the last notch the Map card writes its zoom into its own
     * settings, where the density slider reads it. A wheel reports a dozen
     * events a second and every write re-lays the workspace out; one write
     * once the hand has stopped is the same setting kept for the same price
     * as moving the slider.
     */
    mapZoomSettleMs: 400,
    /**
     * How often a card redraws a running clock — the uptime readout, and how
     * long a loop has been going. A second, because that is the unit shown.
     */
    clockTickMs: 1000,
    /**
     * How much restored backscroll a console is handed per write at launch.
     * xterm parses one write in one go and yields only between writes, so a
     * whole restored backscroll (100,000 lines, 8 MB) was a second-long task
     * per character (todo 02, 2026-09-23); slices this size keep each under a
     * frame.
     */
    restoreSliceChars: 65536,
    /**
     * How long after a plain Enter the shown console must have turned it into
     * input before the console says it did not (todo 00). xterm hands a key
     * over inside its own keydown, so this only has to outlast a busy frame.
     */
    enterTakenMs: 250,
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
     * How many of the realm's own things — monsters, items, spells — a palette
     * query lists beneath the rooms it found.
     *
     * The lookup answers a dozen per kind with the name-prefix matches first,
     * so the cap trims the substring tail rather than the answer somebody
     * typed for; typing one more letter is how the list narrows, not
     * scrolling.
     */
    paletteFoundRows: 12,
    /**
     * How many bars or points the Combat Stats card's rate graph draws across
     * its window, whatever the window is. Two dozen is what its width holds
     * on the rail at the shipped density.
     */
    statsGraphBins: 24,
    /**
     * How long a pointer rests on a room before its quick view opens, and how
     * long the panel stays after the pointer has left both it and the room.
     *
     * The dwell exists so sweeping across the map does not open two hundred
     * panels; the linger exists because the panel is a thing to *read*, and a
     * card that vanished while the hand was travelling the twenty pixels
     * towards it would be unreachable by pointer. A click settles it, and
     * neither number applies to a settled panel.
     */
    roomPeekDelayMs: 250,
    roomPeekLingerMs: 220,
    /**
     * How often the Hunting card asks again because the character moved. The
     * sweep is realm-wide and costs main a few hundred milliseconds, and a
     * lap steps every second and a quarter; the steps column is the only
     * thing a move changes, so it is refreshed on this clock rather than on
     * every room. *Ask again* is immediate.
     */
    huntReaskMs: 10000,
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
    quiet: { enabled: true, commands: ['rm', 'look', 'pro', 'set'] },
    enrich: true
  },
  palette: {
    pinned: {
      character: ['settings'],
      navigate: ['route', 'loop:*', 'move:stop'],
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
      // Keeping the blessings up, on the row: the switch somebody flips for
      // one fight to keep the mana for healing, and back after.
      'autoBless',
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
      'move:toggle',
      // And one room back the way you came, beside the transport: a walk into
      // a room nobody meant to be in is answered by a press, not by working
      // out which direction undoes it.
      'move:back'
    ]
  }
};

/**
 * The durations whose template says `0` switches them off, as `group.key`.
 *
 * Floored at 1 like every other duration, `reconnect.silentForMs: 0` became a
 * one-millisecond deadline: the client called every connection dead a
 * millisecond after its first command and dialled again for ever. Its reader
 * (`LinkWatch.noteSent`) arms no timer at 0, so nothing spins.
 */
const OFF_AT_ZERO: ReadonlySet<string> = new Set(['reconnect.silentForMs']);

/**
 * One number out of the file, bounded by the shape of its default.
 *
 * Two rules, both mechanical so that a key added to `TUNING_DEFAULTS` needs no
 * second edit here:
 *
 * - **A fractional default means a fraction**, clamped to 0–1. Every one of
 *   them is a confidence, a threshold or a tolerance.
 * - **A key ending `Ms` is a duration and floors at 1.** A zero-millisecond
 *   timer spins a core, and this file is one somebody edits by hand — except
 *   a key in `OFF_AT_ZERO`, whose reader tests for 0 and arms nothing.
 *
 * Anything unreadable takes the default rather than throwing, for the reason
 * the whole file works that way: a bad edit must never take the client down.
 */
function tunedNumber(key: string, value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  if (!Number.isInteger(fallback)) return Math.min(1, Math.max(0, n));
  const floor = key.endsWith('Ms') && !OFF_AT_ZERO.has(key) ? 1 : 0;
  return Math.min(1_000_000_000, Math.max(floor, Math.round(n)));
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
      fields[key] = tunedNumber(`${group}.${key}`, stated[key], fields[key] as number);
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
