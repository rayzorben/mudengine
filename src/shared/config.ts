/**
 * The user-facing configuration schema.
 *
 * Like `types.ts` this module must stay dependency-free: main parses YAML into
 * it, preload ships it across the bridge, and the renderer reads it directly.
 *
 * Two rules shape everything below.
 *
 * 1. **A bad config file must never take the app down.** Every field is
 *    optional in YAML and every value is coerced through `normalizeConfig`,
 *    which falls back to the default rather than throwing. The engine keeps
 *    running on the last good values while the user fixes their typo.
 * 2. **The console is monospace, always.** Font stacks are lists rather than a
 *    raw CSS string so the terminal stack can be *repaired* on load — see
 *    `resolveTerminalFonts`. A proportional font in the terminal corrupts
 *    every ASCII map, box-drawn frame and column-aligned stat block the game
 *    emits, so it is not a matter of taste.
 */
import { PRIORITY } from './automation';
import { bool, int, isRecord, str } from './values';
import { asEvents, type ScheduledEvent } from './events';
import { asLoops, mergeNamed, type Loop } from './loops';
/*
 * `DENOMINATIONS` is the one *value* this module takes from `character.ts`, and
 * it is safe: nothing under `character.ts` imports `config.ts` back, so the
 * edge is one-way and the module-cycle rule is untouched. See
 * `src/shared/__tests__/module-cycle.test.ts`.
 */
import { DENOMINATIONS, type Denomination, type VitalThresholds } from './character';
import { DEFAULT_THEME, isThemePreference, type ThemePreference } from './themes';
import type { Comparison, Guard, GuardField, Rule, RuleAction, Trigger } from './rules';
import { SEVERITIES, type Severity } from './notifications';
import { isRemoteName, type RemoteGrant, type RemoteName } from './remotes';
import type { ConnectionTarget, StreamEncoding } from './types';
import { mobKey } from './world';
// A value import, and safe: `commands.ts` imports nothing from `shared/`, so
// there is no cycle for a bundler to resolve the wrong way round.
import { REREAD_ROOM } from './commands';

/** Chrome density, mirroring the `useDensity` preference. */
export type DensityPreference = 'auto' | 'comfortable' | 'compact';

/** Which edge the character tabs sit on. */
export type TabsPreference = 'top' | 'left';

/** One realm-specific prompt the block vocabulary does not cover. */
export interface LoginStep {
  /** Substring of the prompt line. */
  when: string;
  /** What to send. May be empty, for a bare Enter. */
  send: string;
}

/**
 * Answers to the login sequence.
 *
 * On a resolved character this is whole: `resolveProfile` fills `username`,
 * `password` and `enabled` from the character's own file and the steps from its
 * realm. The options file states only `steps` — what a new realm starts with —
 * and the identity half is never read from it. Credentials are stored as
 * written in the character's file, which is local and gitignored; never put
 * real ones in `default.yaml`, which is committed.
 */
export interface LoginConfig {
  enabled: boolean;
  username: string;
  password: string;
  /**
   * The whole menu sequence, as prompt → answer.
   *
   * This used to be four named fields — `selection`, `realm`, `character`,
   * `enterRealm` — plus an `extra` list for anything they did not cover. Those
   * four are *Paradigm's* menus, and naming them in the schema made one BBS's
   * layout part of the client's vocabulary. MajorMUD, GreaterMUD, Paradigm and
   * Shift all differ, and MajorMUD behind WorldGroup can put arbitrary ANSI and
   * arbitrary menus in between; a client with four slots cannot describe that
   * at all.
   *
   * A list of `{ when, send }` describes every one of them, in any number, and
   * needs no new schema when a realm adds a menu.
   *
   * **Enter is always assumed.** Every answer is sent as a command, and a
   * command is a line; `send: ''` is therefore a bare Enter, which several
   * menus want.
   */
  steps: LoginStep[];
}

export interface ConnectionConfig {
  host: string;
  port: number;
  encoding: StreamEncoding;
  /**
   * The menu steps a new realm starts with. In the options file only the
   * `steps` are stated: the account and whether to connect on launch belong to
   * a character (`profiles.ts`), which is what fills the rest of this in when a
   * profile is resolved. The anonymous session that once read them from here
   * was retired 2026-08-29.
   */
  login: LoginConfig;
}

/**
 * A saved server: a place, not a character.
 *
 * This block was called `profiles:` until multiple characters arrived and the
 * word was needed for what a player means by it. Both keys are read, so an
 * existing options file keeps working; see `findMissingSettings`, which says so
 * once rather than rewriting a file full of the user's own comments.
 *
 * Servers exist so the common case — several realms, revisited constantly —
 * does not mean retyping a host and port. They are addressed by name from the
 * command palette and by a profile's `server:` field; `connection` remains the
 * ad-hoc target and the launch default.
 */
export interface Server {
  name: string;
  host: string;
  port: number;
  encoding: StreamEncoding;
  /**
   * How to get through this BBS's menus.
   *
   * **On the server, because that is what it is a property of.** Every
   * character on one BBS meets the same menus, and every character on a
   * different one meets different menus — so a script stored per character is
   * the same answer written out four times, and four places for it to drift.
   * What is genuinely per character is the *account* — kept on the character's
   * own file, never shared — and the character slot, which is one step of the
   * script.
   *
   * A character may still state its own `connection.login.steps` and override
   * this, which is what a second character in a different slot on the same BBS
   * needs.
   */
  login: LoginStep[];
  /**
   * Path to a realm database — `.mdb`, `.accdb`, `.sqlite` or `.db`.
   *
   * **On the realm, because that is what it is a property of.** The client
   * ships one realm — the GreaterMUD database it was built from — and that is
   * right for the common case and wrong for anybody on a derivative. Paradigm,
   * and every private realm, have their own `.mdb`, and a route planned against
   * the wrong one sends a character somewhere that does not exist.
   *
   * It used to be stated per character (`world.database`), which was the same
   * answer written out once per character on that realm and as many places for
   * it to drift: two characters on one realm cannot be playing two different
   * maps, and a third one added later silently got the shipped world.
   *
   * Empty means the realm the client ships. A file named here is **converted
   * once** into the same normalised form the shipped one has, and cached; it is
   * never queried while anything is being played. That is the rule the whole
   * world knowledge base exists to enforce (docs/legacy-assessment.md §5
   * consequence 4).
   */
  database: string;
}

export interface FontConfig {
  /**
   * Preference-ordered family names. Written as a YAML list so the fallback
   * chain reads as one, and so it can be validated per entry.
   */
  family: string[];
  size: number;
}

export interface TerminalConfig {
  font: FontConfig;
  /** Lines retained in the virtualised backscroll buffer. */
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
}

export interface UiConfig {
  /**
   * Font for the chrome around the terminal. Defaults to the same monospace
   * stack as the console: see `docs/ui-design.md` §5. Set it to a proportional
   * stack here if you prefer — this is the one surface where that is allowed.
   */
  font: FontConfig;
  density: DensityPreference;
  /** A registered theme id, or `system` to follow the OS. See `./themes.ts`. */
  theme: ThemePreference;
  /**
   * Where the character tabs live when more than one is loaded.
   *
   * Not one control at two angles. `left` costs horizontal space, which is the
   * expensive axis — the console needs 80 columns and cannot be told otherwise
   * — and buys room for vitals in numbers, the room name and what the character
   * is doing. `top` costs rows, which are cheap, and collapses to a name, a
   * state dot and a bar. See docs/ui-design.md §3.8.
   */
  tabs: TabsPreference;
  /**
   * Show the Vitals and Room cards once in the realm.
   *
   * Separate from the diagnostics cards on purpose: the HUD is what the player
   * reads while playing, and it was originally rendered only inside the
   * diagnostics rail — so it never appeared unless you already knew to open a
   * panel named after something else. The diagnostics have no setting at all
   * now; they are session-only, shown from the palette for the run of the
   * client.
   */
  showHud: boolean;
  /** Where the HUD meters turn yellow and red. */
  vitals: VitalsUiConfig;
  /** What reaches the Alerts card. */
  alerts: AlertsUiConfig;
}

/**
 * What is worth raising an alert about, for this character.
 *
 * Two settings, because there are two questions and they are not the same one:
 * *how loud does it have to be* and *what is it about*. The ranking itself —
 * which line is critical and which is the record — is not configuration:
 * `shared/notifications.ts` decides it once, from what the fact costs, and a
 * per-character table of severities would be four places for it to drift.
 *
 * Per character rather than per client, like everything in a profile: a healer
 * watching a party wants the party channel and a soloing thief does not.
 */
export interface AlertsUiConfig {
  /**
   * The quietest alert worth keeping. `info` keeps everything.
   *
   * `warning` is the useful setting and is not the default, because starting
   * somebody off with things already hidden is how a feature goes unfound.
   */
  minimum: Severity;
  /**
   * Channels that raise nothing at all, by name: `combat`, `command`,
   * `movement`, `room`, `realm`, `party`, `presence`, `items`, `stealth`,
   * `vitals`, `session`.
   *
   * A mute list rather than an allow list, so a channel added later arrives
   * switched on. A card nobody can find is a card that was never built, and the
   * same is true of an alert.
   */
  mute: string[];
}

/**
 * When a vital reads as trouble.
 *
 * Health and mana are configured separately because they are not the same kind
 * of trouble: 20% health is a decision about whether to run, 20% mana is a
 * decision about whether to cast. `megamind-client` split them the same way,
 * with the same defaults for both.
 *
 * Both are *fractions of maximum*, so a threshold means the same thing at every
 * level — which is the whole point, and the part the reference client got wrong
 * when it hard-coded `health < 25`.
 */
export interface VitalsUiConfig {
  hp: VitalThresholds;
  mana: VitalThresholds;
}

export interface LoggingConfig {
  /** Append the decoded session to a file. */
  enabled: boolean;
  /**
   * Write down every fight: what it cost, and the conditions it was fought
   * under.
   *
   * Nothing reads these yet, which is the point of collecting them — every
   * question worth asking about how a character fights needs a record that
   * predates the question. One small compressed file per character beside the
   * options file, appended and never revised. See `shared/fights.ts`.
   *
   * On, unlike the capture: a fight record is a few hundred bytes, holds no
   * text the server sent and therefore cannot hold a password, and the whole
   * value of it is that it was already being collected.
   */
  fights: boolean;
  /**
   * Also record a full machine-readable capture: raw bytes, decoded text with
   * escape sequences intact, framed lines and outbound commands, timestamped.
   *
   * This is the development loop for pattern work — play manually with it on,
   * then `npm run capture:analyse`.
   *
   * **On by default**, and it was not always. It was off because it is verbose,
   * which was the wrong trade: the first real disagreement about *what the
   * server actually sent and in what order* had no file to settle it from, and
   * the argument was conducted over a pasted terminal excerpt instead — twice,
   * wrongly. A recording that exists only once somebody thinks to turn it on is
   * one that is never on when it is needed, because the moment you need it has
   * already happened. Disk is cheap; a bug argued from memory is not.
   */
  capture: boolean;
  /**
   * Keep the Talk card's conversation history on disk, so quitting and
   * restarting restores it rather than starting the card empty.
   *
   * One plain JSONL file per character (`talk/<id>.jsonl`), appended as each
   * conversation line arrives and read back when the session is opened. On,
   * like the fights beside it: what somebody said is exactly the record whose
   * value is that it was already being collected — and unlike the capture it
   * holds only the conversation channels, never a prompt, so it cannot hold a
   * password.
   */
  conversations: boolean;
  /**
   * How much conversation to keep, in days. Entries older than this are
   * dropped when the log is opened — the cleanup, so a year of talk does not
   * become ten. Bounded below at one day; the default is a year.
   */
  conversationDays: number;
  /**
   * Where logs go. Empty means the per-user data directory, which is the only
   * reliably writable location on all three platforms.
   */
  directory: string;
  /** Stop appending past this size, rather than filling a disk unattended. */
  maxBytes: number;
}

/**
 * How the client paces itself.
 *
 * The numbers come from measurement, not taste. The server accepts about twenty
 * commands in flight and then **silently discards** the rest — twenty-five sent,
 * two answered — with no complaint and no disconnect. Since the loss is
 * undetectable, the only safe posture is to stay far below the cliff and let
 * the game's own prompt release the next send.
 */
/**
 * How long the walker waits for a room before giving up on a step.
 *
 * This is *client-side patience*, not a claim about the server: some commands
 * produce nothing at all, and a walk with no deadline sits reporting progress
 * it is not making, which is a worse lie than stopping. Nothing here is a
 * pacing constant -- pacing comes from the prompt, in `PacingConfig`.
 */
export interface WalkConfig {
  stepTimeoutMs: number;
  /**
   * How long a finished walk stays on screen before the card clears itself.
   *
   * A walk that has arrived is news for a moment and clutter after it, and the
   * card sits above the rest of the rail, so leaving it there moves everything
   * below it for as long as it stays. Zero keeps it until something else
   * happens, for anyone who would rather dismiss it themselves.
   */
  clearAfterSeconds: number;
}

export interface PacingConfig {
  /** Commands allowed on the wire without an acknowledging prompt. */
  window: number;
  /** Floor between sends, whatever the acknowledgements say. */
  minGapMs: number;
  /** Give up waiting for a prompt after this and release the credit. */
  ackTimeoutMs: number;
}

export interface IdleConfig {
  enabled: boolean;
  /** Quiet seconds before the idle command is sent. */
  afterSeconds: number;
  /**
   * What to send. Empty is a bare Enter, which re-reads the room silently and
   * is also a keep-alive — see `REREAD_ROOM` in `shared/commands.ts`.
   *
   * It used to be `l`, which prints the same block and *also* tells everybody
   * standing there that this character is looking around the room. Every
   * forty-five seconds, for as long as the client is connected, that is a
   * beacon: spam in company, and on a PvP realm a standing announcement of
   * where a character is and that something is watching. A look the player
   * asks for is still a look; this one is the client's own housekeeping.
   */
  command: string;
}

/**
 * Hanging up to save a character, and why it is not the simple option.
 *
 * Every MegaMUD-era client offers "disconnect when health is low". On this
 * server family that is one of the more reliable ways to *die*: an unclean
 * disconnect costs a percentage of **maximum** HP — fatal at low health, and
 * recorded as `DisconnectPenalty` — or drops random items. Five conditions make
 * it unclean, and they are precisely the ones that co-occur with wanting to
 * press the button. See docs/greatermud/combat.md.
 *
 * So this exists, and it defaults to refusing. Walking out is the escape that
 * works; hanging up is the escape that works *afterwards*.
 */
export interface HangUpConfig {
  /** Off unless somebody asks for it, and it says what it will and will not do. */
  enabled: boolean;
  /** Fraction of maximum health below which hanging up is considered. */
  belowHealth: number;
  /**
   * Refuse while the client can see a reason the disconnect would be penalised.
   *
   * **On by default, and turning it off is a decision about a character.** The
   * client can see four of the five conditions; with this off it will hang up
   * anyway, into a penalty it can often predict. Off is for a realm where PvP
   * is disabled or the penalty is not configured, which the client cannot
   * detect and the player can know.
   */
  onlyWhenClean: boolean;
  /**
   * Also hang up when a player is in the room, at any health.
   *
   * Off by default. It is the PvP panic button, and it is also the one most
   * likely to fire during the five-minute window — so it is the setting that
   * most needs `onlyWhenClean` left on.
   */
  onPlayerInRoom: boolean;
}

/**
 * Running away, which is the escape that actually works.
 *
 * **It walks. There is no command for running away** — see `NOT_COMMANDS` in
 * `src/shared/commands.ts` for the eleven refusals that settled that — so
 * every escape this client makes is a **direction**, chosen from what it knows
 * about the room it is standing in, and it is never sent unless there is one.
 * Moving out carries none of the penalty an unclean disconnect does, which is
 * why `HangUpConfig` tells you to do this instead.
 *
 * Off by default like everything automated: a client that starts running away
 * on its own the first time somebody opens it is a client that decides when a
 * fight is lost, and that is the player's call until they say otherwise.
 */
export interface RetreatConfig {
  enabled: boolean;
  /** Fraction of maximum health below which the character runs. */
  belowHealth: number;
  /**
   * Also run when this many things are hitting it at once.
   *
   * Zero disables it. Being fought by three things is the situation a health
   * threshold notices too late — by the time the bar is low the next round has
   * already been rolled.
   */
  whenOutnumbered: number;
  /**
   * The shortest gap between attempts.
   *
   * An escape can fail — the exit is blocked, the move is refused — and
   * retrying every status line would fill the queue with them. This is a floor
   * on retrying, not a rate limit: the emergency band is not paced.
   */
  cooldownMs: number;
  /**
   * How far to go, **not** how to choose the exit.
   *
   * Choosing the exit is `SessionManager.escape`'s ladder and is not
   * configurable, because every rung of it is strictly better than the one
   * below and nobody would knowingly pick a worse one: retrace the trail
   * first, then an exit the realm data says leads back onto it, then any exit
   * the realm can place, then any exit the server just printed. Only the last
   * rung is a room the character has never seen, and all four beat standing
   * still.
   *
   * `step-back` is that one move and then nothing more. `safe-haven` takes the
   * same move and then, once the fight is over and the character is placed,
   * plans a route to `safeHavenRoom` — the walker refuses to walk into a
   * fight, so a route can never be the escape itself.
   */
  strategy: RetreatStrategy;
  /**
   * Where `safe-haven` runs to, as a loop stop names a room: `Newhaven, Town
   * Gates 1/2150`. A bare name shared by several rooms is refused, with the
   * candidates, exactly as a loop stop is. Empty is none.
   */
  safeHavenRoom: string;
}

/**
 * Two, where there were three.
 *
 * The third was `flee`, and it did not describe a way out — it described
 * sending the word `flee` and letting the realm pick the exit, which the realm
 * never did because the word is not a command. `reverse-step` was the same
 * thing with one attempt in front of it, and its documented fallback was that
 * word again. Both are gone: what is left is *one move* against *one move and
 * then walk home*, which is the only axis a person was ever choosing on.
 */
export const RETREAT_STRATEGIES = ['step-back', 'safe-haven'] as const;
export type RetreatStrategy = (typeof RETREAT_STRATEGIES)[number];

/**
 * Which monsters auto-combat will open a fight with.
 *
 * `hostile` is the one this exists for, and it means what the realm data says
 * rather than what a name looks like: `Monsters.Align` and `Monsters.Type`
 * decide it, read out of `Mob.ShouldMobAttackTarget` (see `shared/mobs.ts`).
 * A monster that was going to attack anyway costs nothing to hit first, and
 * that is the whole argument for doing it unasked.
 *
 * `likely` adds the names the realm data **disagrees with itself about**, which
 * is 21 of the shipped realm's 1,451 — and `giant rat` is one of them, so this
 * is not a corner. Two rows of that name are ChaoticEvil and one is Good, and a
 * name cannot tell you which one is standing in front of you. The cost of
 * guessing wrong is not the fight: `Mob.GetEPCostForAttacking` charges **ten
 * evil points** for hitting a Good or LawfulGood monster, which is cumulative,
 * moves a Neutral character towards Outlaw, and changes who attacks them
 * afterwards. That is why it is a setting rather than the default.
 *
 * `all` includes the ones that would have left you alone — a shopkeeper, a
 * guard dog, the town priest. It is what MegaMUD calls *attack all monsters*
 * and it is a decision about how a character is being played, not a default.
 *
 * Two things no setting includes:
 *
 * - **A player.** On a PvP realm the first blow starts a five-minute window
 *   that makes a disconnect fatal (docs/greatermud/combat.md), and the person
 *   on the other end is somebody's evening. Type it, or write a rule saying so
 *   in as many words.
 * - **A monster the realm calls good**, because attacking one spends the
 *   character's standing rather than its health, permanently and cumulatively.
 *   Naming one under `prefer` is how somebody asks for it anyway, which is a
 *   deliberate instruction rather than a blanket one.
 */
export type EngagePolicy = 'none' | 'hostile' | 'likely' | 'all';

/**
 * In order of how much they will start, so a form can offer them as a scale.
 *
 * Derived from here rather than restated in the parser and the settings screen,
 * which is the two-halves trap the guard-field list already fell into once.
 */
export const ENGAGE_POLICIES: readonly EngagePolicy[] = ['none', 'hostile', 'likely', 'all'];

/**
 * Fighting on the character's behalf: what to swing with, and what at.
 *
 * The thing MegaMUD was actually for, and the reason it is *here* rather than
 * in `automation.rules`: a rule is a sentence about one situation, and this is
 * a standing policy with a target-selection question in the middle of it that
 * no guard expression can ask. `hp.percent < 0.3` is a rule; *"is the thing in
 * front of me going to attack me, and is it a person"* is not.
 *
 * Off by default, like everything automated. A client that starts swinging at
 * things the first time somebody opens it is a client picking their fights.
 *
 * Ordering against the two safety nets is settled and not configurable:
 * **running away outranks fighting.** The retreat is proposed in the
 * `emergency` band and this in `combat`, and nothing here opens a fight while
 * an escape is in
 * flight — a client that ran from a room and swung on the way out would have
 * spent the escape and stayed in the fight.
 */
export interface CombatConfig {
  /** Off unless somebody asks for it. */
  enabled: boolean;
  /**
   * The verb that opens a fight. `a` — `Attack` in the command table.
   *
   * Configurable because the vocabulary is the *realm's*, not this client's
   * (docs/greatermud/commands.md: every abbreviation is listed by hand, and a
   * derivative may accept different ones), and because a warrior who wants
   * every fight opened all-out spells that `bash` here rather than in a rule.
   */
  attack: string;
  /**
   * Sent instead of `attack` for the first blow only. Empty for none.
   *
   * The opener a class gets one of per fight: `bs` for a thief, `ju` for a
   * mystic. Separate from `attack` because it is *not* repeatable — spending
   * it is the point of having it.
   *
   * There is no list of verbs beside these two. A `rounds` list, cycled one
   * verb per round on the mid-round tick, was carried here for four phases on
   * the belief that some classes have to ask for their attack every round; the
   * wire says otherwise (captures/032, a mystic's `bs ha` answered by dozens of
   * unprompted jumpkicks over 94 lines), and so does MegaMUD's own help, whose
   * single *Attack Command* is what `pu`, `kic` and `ju` go in. Removed
   * 2026-09-02.
   */
  opener: string;
  /** Which monsters to start on. See {@link EngagePolicy}. */
  engage: EngagePolicy;
  /**
   * Hit back at whatever hits this character, whatever `engage` says.
   *
   * On by default *within* auto-combat, because it is the one part of this that
   * cannot start a fight: something is already hitting the character, and the
   * alternative is standing there. The CoffeeScript engine did exactly and only
   * this (`user.coffee`, `onMobAttacking`).
   */
  retaliate: boolean;
  /**
   * Do not open a fight when this many monsters are in the room. 0 never
   * refuses.
   *
   * MegaMUD's *Max Monsters*. Being fought by four things is the situation the
   * retreat threshold notices too late, and the cheapest place to decline it is
   * before the first swing.
   */
  maxMobs: number;
  /**
   * Do not open a fight below this fraction of maximum health. 0 disables.
   *
   * A fraction, like every other threshold here, so one number holds at every
   * level. An unknown maximum never trips it — the stat sheet may not have
   * arrived — for the same reason an unknown maximum never paints a meter red.
   */
  minHealth: number;
  /**
   * Whether to open fights while walking a planned route.
   *
   * Off, and the reason changed on 2026-09-02 when a route learned to wait a
   * fight out and walk on (`Walker.holdForFight`). It used to be that a walk
   * *ended* the moment combat started, so attacking every rat between here and
   * the bank turned one route into a dozen — a cost this setting existed to
   * avoid, and one that no longer exists.
   *
   * What is left is the argument the whole of `AutoCombat` keeps: opening a
   * fight nobody asked for is the client deciding to spend the character's
   * health, and a route is the player having said where they want to be rather
   * than what they want to fight. That is a preference, not a hazard, which is
   * why turning it on is now a reasonable thing to do and a lap is what it
   * makes the journey into.
   *
   * Retaliation is unaffected either way: something already hitting the
   * character holds the walk whether or not this client swings first.
   */
  whileWalking: boolean;
  /**
   * Re-read the room every this many rounds of a fight. 0 never does.
   *
   * MegaMUD's *rescan room*. A fight is the one situation where the room list
   * goes stale fastest and matters most: monsters die out of it, monsters walk
   * into it, and the list is what decides whether to keep swinging, what to
   * swing at next, and whether the room has become too crowded to stay in.
   *
   * The server volunteers most of that — an arrival is a sentence, a death is
   * an experience line — so this is the correction rather than the source, and
   * three rounds is roughly a second and a half of a fight. It goes out in the
   * `probe` band, below walking and below the player: a look that arrives a
   * round late has lost nothing, and one that displaced an attack would have.
   */
  refreshRounds: number;
  /**
   * Monsters never attacked automatically, by name.
   *
   * Matched the way the wire spells them: lowercased, leading article stripped.
   * The place for the thing that is technically hostile and reliably fatal.
   */
  avoid: string[];
  /**
   * Never open on anything the realm marks **undead**.
   *
   * `Monsters.Undead`, and the first refusal this client could express about a
   * *kind* of monster rather than about a name — before the room's occupants
   * carried their realm rows, the only way to say "not the skeletons" was to
   * list every skeleton in the realm by name.
   *
   * Retaliation is unaffected, like every other gate here: something already
   * swinging is a fight that has started, and declining to hit back is how a
   * character dies politely.
   */
  avoidUndead: boolean;
  /**
   * Never open on anything the realm says casts a spell **when it dies**.
   *
   * `Monsters.DeathSpell` — 146 of the shipped realm's monsters carry one, and
   * nothing in the stream says so until it already has. It is the one fact
   * about a monster that cannot be learned by fighting it carefully.
   */
  avoidDeathSpell: boolean;
  /**
   * Do not open on anything the realm says has more health than this.
   * 0 never refuses.
   *
   * The cheap approximation of *is this out of my league*, from the one number
   * the realm states about every monster. **An unknown health is not refused**,
   * which is deliberate and worth stating: `engage: hostile` already declines
   * a monster the realm cannot place, so the unknown case is covered by a gate
   * that exists — and refusing here as well would make `engage: all` do
   * nothing at all on a derivative realm.
   */
  maxTargetHealth: number;
  /**
   * Do not open a fight unless at least this many monsters are here.
   * 0 never refuses.
   *
   * MegaMUD's `MinMstrs`, and the mirror of `maxMobs`. The use is a character
   * whose whole value is an area spell: opening on one monster spends the
   * round and the mana for a fraction of what the spell is for.
   */
  minMobs: number;
  /**
   * Do not open on a monster the realm says is worth more than this in
   * experience. 0 never refuses.
   *
   * MegaMUD's `MaxMstrExp` — its difficulty cap, and the one it actually
   * ships. `maxTargetHealth` is the same idea off a different column, and the
   * two are kept apart because the realm states them separately and they
   * disagree: a high-experience monster is not always a high-health one.
   *
   * An experience the realm does not state is **not** refused, for
   * `maxTargetHealth`'s reason: the disposition gate already declines a monster
   * the realm cannot place, and refusing here as well would make `engage: all`
   * do nothing on a derivative realm.
   */
  maxMonsterExperience: number;
  /**
   * Monsters attacked first, in this order, whatever `engage` says.
   *
   * MegaMUD's per-monster attack priority, as a list rather than a flag on
   * 1,800 rows. A name here is attacked even where the realm data calls it
   * passive — which is a deliberate instruction, unlike `all`, which is a
   * blanket one. Players are still never attacked; see {@link EngagePolicy}.
   */
  prefer: string[];
}

/**
 * What to pick up, unasked.
 *
 * MegaMUD's *auto-get cash* and its item list, the two things every script in
 * the capture corpus did first after a kill (`.@get-all`). Coins are the safe
 * half: they land on the floor only when something dies (`18 gold drop to the
 * ground.`) and weigh nothing worth refusing. Items are named, and matched by
 * the prefix the server itself uses, because `get` is answered by prefix.
 */
/**
 * Answering the `@` commands another player's client sends this one.
 *
 * MegaMUD's remote-control vocabulary — `/Vaelor @health` telepaths a question
 * and the client on the other end answers `{HP=62/62,MA=10/10}` — which is what
 * makes running several characters at once workable. The vocabulary and the two
 * reply shapes captures actually show are in `src/shared/remotes.ts`.
 *
 * **Off by default, and this one is not merely convention.** What it turns on
 * is a channel by which somebody else's typing moves this character: `@do` runs
 * a command as though it were typed. `@kill` and `@hangup` are refused outright
 * and always will be, but the switch is what somebody chooses when they decide
 * to be reachable at all.
 *
 * **`enabled` is the switch; the two lists are the gate.** Until 2026-08-28
 * there was only the switch, so turning it on answered *everybody*; until
 * 2026-08-29 the gate was three *grounds* — `named`, `party`, `gang` — and a
 * ground allowed somebody **every** command. Both shapes could not express the
 * thing people actually want, which is per command: *"my gang may ask where I
 * am; nobody runs a command on me"*.
 *
 * So permission is stated per remote, per player, with one list behind it for
 * the gang. The switch and the gate stay separate questions because they are:
 * turning the feature off entirely and being reachable by nobody in particular
 * are different states, and a client that conflated them could not tell
 * somebody why their gang was being refused.
 *
 * The decision itself is `judgeRemote` in `src/shared/remotes.ts` — one pure
 * function, so the card showing somebody as allowed and the engine answering
 * them read the same rule rather than two copies of it.
 */
/**
 * What this character learns about the other people in the room.
 *
 * One option today and its own block rather than a loose key, because the
 * question it answers — how much this character finds out about somebody
 * standing next to it — is a category with more than one member waiting
 * (whether to greet, whether to record a conversation) and a flat key would
 * have to move when the second arrives.
 */
export interface TalkConfig {
  /**
   * Look at a player the first time this character sees them, to learn what
   * they are wearing.
   *
   * **Off by default, and it must stay that way.** A look is a command from
   * the same budget walking and fighting spend from, and it is *visible*: the
   * server tells the person they were looked at. A client that automatically
   * inspected every stranger would announce this character to every player it
   * passed, which on a PvP realm is a way to be noticed by exactly the people
   * worth not being noticed by.
   *
   * Once per person rather than per sighting: what somebody is wearing changes
   * rarely, and the Player card stamps the answer with when it was true.
   */
  lookAtPlayers: boolean;
}

export interface RemotesConfig {
  /** Answer `@` commands from other players at all. */
  enabled: boolean;
  /**
   * Also read and answer `@` commands on the **gangpath**.
   *
   * Its own switch rather than a channel in the list above, because a gangpath
   * answer is spoken to the whole gang: `gb @exp` from anybody in it is
   * answered `gb {Made: …}` where every member sees both halves. Telepath, say
   * and directed all address one person and are answered the same way; this is
   * the one channel where answering is also publishing, so it is chosen
   * separately. Off, and a gangpath `@` command is read and never answered.
   */
  gangpath: boolean;
  /**
   * Remotes anybody in **this character's gang** may use.
   *
   * One list, not a map keyed by gang: a character is in one gang at a time.
   * The consequence — leaving one gang for another hands the new one the same
   * list — is stated on the Gang card, which names the gang the list currently
   * applies to.
   */
  gang: RemoteName[];
  /**
   * Remotes anybody who has **joined this character's party** may use.
   *
   * The one grant that ships non-empty, and the two names on it are the two
   * that survive the test: **they say nothing the party listing does not
   * already say, and they do nothing to this character.**
   *
   * - `@health` is the absolute figures behind the percentage the listing
   *   already shows — the same fact, to more decimal places, and the one
   *   `automation.spells.healParty` needs to decide whether a cast will cover
   *   the gap.
   * - `@bless-expired` is a member telling this character their blessing ran
   *   out. It sends nothing; what to do about it is `Blessings`' decision,
   *   made against this character's own configuration.
   *
   * **Four more were on this list and were taken off** (2026-09-02, review),
   * because the sentence that justified them was false:
   *
   * - `@where` answers with the room **and its exits**, and `PartyMember`
   *   carries no location at all. On a realm with PvP that is *where to find
   *   me*, granted to whoever is following.
   * - `@status` answers with the walk's destination or the loop's stop **and
   *   the stealth flag**, neither of which the listing carries.
   * - `@wait` is not a fact, it is a **stop**: it pauses a running loop
   *   (`SessionManager`'s `pace`) with no deadline, released only by `@ok` or
   *   a reconnect — so a follower who says it and then logs off leaves the lap
   *   standing still for the rest of the evening.
   * - `@ok` went with it, because releasing a hold nothing can place is a
   *   grant that cannot take effect, which is what `isActionable` refuses.
   *
   * All four are still one click away on the Party page, by name, on a screen
   * that says whose typing this lets move the character. Widening is the
   * player's to do; shipping it is not.
   *
   * ## Membership is the realm's word, and it is weaker than it looks
   *
   * Gated on having joined and never on an invitation — an offer nobody
   * accepted is not a party, and reading it as one would let anybody hand
   * themselves this list by typing `invite`. That much is closed
   * (`joinedTheParty`).
   *
   * What is **not** closed is the other end: `withJoined` puts a full member on
   * the roster for `<name> started to follow you.` without asking whether this
   * character ever invited them, and on this realm following somebody is how a
   * party is joined. So if the server honours an uninvited `follow`, that verb
   * is the gesture the retired `party` *ground* was retired for, one word
   * along. **Nobody has asked the wire** — the corpus has one capture with an
   * `invite` before every join and one that starts mid-session — and
   * `npm run probe:party -- --pair soul,yang` is where to ask. Until it
   * answers, the defence is the list above being two facts about this
   * character's own body, rather than the membership test.
   */
  party: RemoteName[];
  /**
   * What each named player may and may not ask for, keyed by the **lower-cased**
   * name, as `PlayerRegistry` keys it. Absent is an empty grant: nothing.
   */
  players: Record<string, RemoteGrant>;
}

/**
 * How loaded the character has to be before a coin setting acts —
 * MegaMUD's *Don't collect if it will make you medium / heavy*, as one choice
 * rather than two boxes that can both be ticked.
 *
 * The words are the **server's own grading** (`Encumbrance: 840/2400 - Medium
 * [35%]`), and only two of them have ever been seen: `None` in four captures
 * and `Medium` in one. MegaMUD names `medium` and `heavy`, which is where the
 * second comes from — so this union is the intersection of what the wire has
 * shown and what a MegaMUD-trained player already expects, and nothing beyond
 * it is invented.
 *
 * A grade word this client cannot rank leaves the gate **closed**, which is the
 * rule `drop.whenEncumbered` already follows: unknown is not encumbered, and
 * refusing to loot on a word nobody has sampled would be the client's ignorance
 * stopping an automation that works.
 */
export type EncumbranceGate = 'never' | 'medium' | 'heavy';

export interface LootConfig {
  /** Pick up coins the moment they land, and any a look lists. */
  coins: boolean;
  /**
   * Which denominations are worth bending down for.
   *
   * All five by default, which is what `coins: true` alone has always meant.
   * The setting exists because the cheap ones are most of what drops and least
   * of what they weigh: a lap through a lair fills the purse with copper, and
   * every `get copper` is a command out of the budget the fighting is done
   * from.
   *
   * **Not in MegaMUD**, which has one *Auto-Get Cash* switch and no way to say
   * which coins. An empty list with `coins: true` takes nothing, and says so on
   * the settings screen rather than reading as a switch that does not work.
   */
  coinKinds: Denomination[];
  /**
   * Stop collecting coins once the server grades the load this heavily.
   * `never` never refuses.
   *
   * MegaMUD predicts — *don't collect if it **will** make you heavy* — and this
   * reacts, because the prediction needs a weight per coin that the realm data
   * does not state. The cost of the difference is one lot of coins: the grade
   * is re-read from the next listing, and the setting holds from then on.
   */
  stopAtGrade: EncumbranceGate;
  /**
   * An item that turns small coin into large — GreaterMUD's `coin bag`, which
   * Daeron Darksong drops. Blank never converts.
   *
   * **The client cannot tell which item does this**, and does not pretend to.
   * The realm marks the coin bag no differently from the other 454 items that
   * cast a spell; the only thing that distinguishes it is that its spell is
   * *named* `coin bag convert`, which is not a fact any rule should turn on. So
   * the field is the player's to fill, with the pack behind it as suggestions —
   * the same shape the potion fields have, and for the same reason.
   *
   * MajorMUD has no such item, which is why this is blank by default and why
   * nothing goes looking for one.
   */
  convertWith: string;
  /** How loaded to be before using it. `never` never uses it. */
  convertAt: EncumbranceGate;
  /** Item names to pick up whenever a look lists them. Prefixes, as `get` reads them. */
  items: string[];
  /**
   * Also pick up anything the realm prices at or above this, in copper.
   * 0 never does.
   *
   * The named list above is an *instruction* and always wins; this is a
   * standing question — "is this worth bending down for" — that only became
   * askable when a floor item started arriving as an entity with the realm's
   * price on it. Before that the client could not have answered it without a
   * round trip per name.
   *
   * **An item the realm cannot price is never taken by this**, and the naming
   * is deliberate: `minPrice` is a claim about value, and an unknown value is
   * not a high one. Somebody on a derivative realm who wants everything says
   * so with a name on the list, which is the instruction that does not depend
   * on data the realm does not have.
   */
  minPrice: number;
  /**
   * Never pick anything heavier than this up, whatever else says to. 0 never
   * refuses.
   *
   * A ceiling rather than a floor, and it outranks the named list: the failure
   * it exists for is an unattended character looting itself over the
   * encumbrance the walker then stalls under. An item the realm cannot weigh
   * is **not** refused — unknown is not heavy, and refusing on absence would
   * stop a derivative realm looting anything at all.
   */
  maxEncumbrance: number;
}

/**
 * Dropping named junk, unasked — the other half of MegaMUD's drop list, and
 * what keeps auto-loot from hoarding a pack over the encumbrance the walker
 * then stalls under.
 *
 * Only what the player named is ever dropped: the realm data does not mark
 * quest items, so the list is the one authority on what is junk — refusing to
 * guess is what makes acting unasked safe here. An equipped item is never
 * dropped whatever the list says.
 */
/**
 * Searching every room the character arrives in, unasked.
 *
 * The realm hides exits — 249 of them in the shipped data are
 * `Hidden/Searchable` — and `WorldGraph.edgePenalty` already prices one at
 * "costs the search", so a route may be planned through a corridor nobody has
 * looked for yet. `Walker` searches *reactively*, when a step it planned is
 * refused; this is the other half, and it is the half that finds an exit
 * nothing planned a route through in the first place.
 *
 * Off by default like everything automated. It costs one command per room,
 * which is real: a loop of seven stops pays seven of them a lap out of the
 * budget the fighting is done from, and that is the player's trade to make.
 */
export interface SearchConfig {
  enabled: boolean;
  /**
   * How many searches one room is worth.
   *
   * The server may answer a first `search` with nothing and a second with an
   * exit — nothing in the realm data or on the wire says whether one look is
   * enough, and `walk.searchTries` already exists for the same unknown on the
   * walker's side. One by default: a room searched three times is three
   * commands, and the honest answer to "how many does it take" is that nobody
   * has measured it.
   */
  tries: number;
}

export interface DropConfig {
  enabled: boolean;
  /** Item names to drop whenever the pack lists them. Prefixes, as `drop` reads them. */
  items: string[];
  /**
   * Only shed junk while the server itself grades the load as anything but
   * `None` (`Encumbrance: 840/2400 - Medium [35%]`). The server's own word,
   * because the thresholds behind the grades are unsampled — MegaMUD's "67%
   * is Heavy" is folklore this client has never seen on the wire. An unread
   * grade drops nothing: unknown is not encumbered, and a drop is not a thing
   * to do on a guess.
   */
  whenEncumbered: boolean;
  /**
   * Also drop anything the realm prices at **zero**, without naming it.
   *
   * The one entity predicate safe to act on unasked here, and only because it
   * is the realm's own explicit zero rather than an absence: a price the realm
   * does not state leaves the item alone, because "worth nothing" and "nobody
   * has said" are different claims and only one of them is a reason to throw
   * something away.
   *
   * Nothing the realm marks `Not Droppable` is ever dropped by it, nothing
   * equipped is, and the named list above stays the authority on everything
   * else — the realm does not mark quest items, which is why this is bounded
   * to a column it does mark.
   */
  worthless: boolean;
}

/**
 * Banking the purse, unasked — MegaMUD's StashCoin.
 *
 * Coins carried are coins a death can scatter and an encumbrance the walker
 * carries; coins on deposit are neither. The deposit itself follows the
 * Deposit All button's own settled shape: the figure sent is the maintained
 * purse, the sampled verb (`deposit <n>`, in copper — `depo 10000` captured
 * live), and a `bank` behind it so the vault's own figure is established the
 * first time and maintained for free afterwards.
 */
/**
 * One thing the character keeps a stock of — MegaMUD's *Must Have Minimum* /
 * *Minimum To Keep* / *Maximum To Get* on an item, with the shop it is bought
 * from.
 *
 * `name` is the realm's own spelling of the item, matched against the pack the
 * way the server matches a typed name (`nameAnswersTo`). `min` is the count
 * below which the character goes shopping and `max` what it buys back up to.
 * `shop` names the shop and `at` says which room, because a shop's name is not
 * a place (`WorldGraph.shopPlace`): null leaves the name to be settled when
 * the errand is planned, and refused out loud if it cannot be.
 */
export interface SupplyItem {
  name: string;
  min: number;
  max: number;
  shop: string;
  at: { map: number; room: number } | null;
}

/**
 * Keeping the pack stocked — `automation.supplies`.
 *
 * Per character, because what one keeps is a fact about how it plays: a
 * caster's torches are a fighter's healing potions. When a listed item falls
 * below its minimum the client holds whatever it was doing, walks to the
 * shop, buys back up to the maximum one at a time, and lets the loop go on
 * from wherever the shop is. Everything about the trip is said out loud and
 * recorded as a safety decision, refusals included.
 */
export interface SuppliesConfig {
  enabled: boolean;
  items: SupplyItem[];
}

export interface BankingConfig {
  autoDeposit: boolean;
  /**
   * Deposit only once the purse exceeds this, in copper. Walking to a counter
   * for pocket change spends the budget the loop walks on, so the threshold
   * is deliberately well above `keepCopper`.
   */
  depositThresholdCopper: number;
  /** What stays in the purse for tolls and shops, in copper. */
  keepCopper: number;
}

/**
 * Getting a character's numbers back up, which is MegaMUD's **Health** tab.
 *
 * Separate from `SafetyConfig` because they answer different questions with the
 * same input. Safety asks *should this character still be here*; this asks *what
 * should it be doing while nothing is happening*. One of them runs away and the
 * other sits down, and conflating them would put "run" and "rest" behind one
 * threshold — which at 40% health is two opposite instructions.
 *
 * **Two starts and no stops, and the absence is the design.**
 *
 * Resting is not a mode a character has to be let out of. It blocks nothing,
 * and only some commands end it: moving and attacking do, looking and talking
 * and reading the pack do not. So the two things worth getting up *for* break
 * the rest themselves on their way past, and a command sent purely to stand up
 * buys something the next real command was going to give away free.
 *
 * The client held the opposite belief until 2026-08-27 — that *anything* breaks
 * a rest, so a `restUntil` threshold should send `l` on reaching it — and it
 * cost a live session 431 looks in fourteen seconds
 * (`logs/2026-08-27_21-24-03_main.mudcap.jsonl`, 437 looks, `(Resting)` on
 * every prompt through all of them). A look does not end a rest, so the
 * condition that proposed the look stayed true and proposed it again. There is
 * no `restUntil` here now because there is nothing left for it to mean.
 *
 * **`restTo` is not that threshold coming back**, and the difference is which
 * direction it acts in. `restUntil` *stood a character up* and its trigger was
 * the `(Resting)` flag being up, so nothing could silence it; `restTo` sits one
 * back *down* and is silenced by that same flag, which is the guard every
 * proposal here already passes. It cannot repeat while it is working, and what
 * it answers is a break somebody else caused.
 */
export interface HealthConfig {
  /**
   * Rest when health falls below this fraction of maximum. 0 never rests.
   *
   * MegaMUD's *Rest if below*, and a fraction like every other threshold here
   * so one number holds at every level. Only out of combat — resting is broken
   * by being attacked, so proposing it during a fight spends a command to be
   * told so.
   *
   * **A running loop holds still at this figure too** (2026-09-02). It used to
   * be a separate `loopPauseBelow`, on the reasoning that pausing a lap and
   * sitting down are different questions — a tank might rest at 70% standing
   * still and only pause the lap at 35%. That reasoning had a hole in it that
   * was documented beside it and enforced nowhere: *between the two the
   * character is under the floor it is meant to rest at and forbidden to*,
   * because `SessionManager.mayRest` refuses while a loop is marching. So the
   * gap was not a band where two settings did different jobs; it was a band
   * where the character walked while hurt and could not sit down. Captured on
   * festus (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`) for the whole
   * length of a lap.
   *
   * Four numbers doing one job is also four numbers to get wrong: the file
   * that produced this change had `restBelow` 70 and `loopPauseBelow` 70 with
   * `restTo` 75 and `loopResumeAt` 70 — a loop that resumed marching *below*
   * the ceiling the rest was still climbing to, so the lap walked the
   * character straight back out of its own recovery.
   */
  restBelow: number;
  /**
   * Keep sitting the character back down until health reaches this fraction.
   * 0 is the single sit-down at `restBelow`, which is what this module did
   * before the pair existed.
   *
   * The hysteresis pair `healBelow`/`healTo` already uses, and it exists
   * because **the server keeps a
   * character resting long past `restBelow` and the client only ever sat one
   * down under it**. So the first thing to break a rest above the floor left
   * the character standing for good — and on this realm a *cast* is one of
   * those things. Captured 2026-09-02
   * (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`): `[HP=48/KAI=5]:
   * (Resting)` answered with `c swan`, and every prompt after it reads
   * `[HP=48/KAI=4]:` with the flag gone. That is not free — the same capture
   * has the character regenerating 2 HP every 5s sitting and 2 HP every 30s
   * standing — so a heal that mends 6 points bought them at six times the
   * price of waiting, and then paid it for the rest of the recovery.
   *
   * Never below `restBelow`, and clamped up rather than obeyed: a `to` under
   * the `below` is two opposite instructions about one number.
   *
   * The band this widens is a band a *manual* move is also sat back down out
   * of, exactly as `restBelow`'s already is. That is the same trade, made
   * wider, which is why it is 0 by default.
   *
   * **A loop held for health resumes here too** — the ceiling `loopResumeAt`
   * used to state, folded in with the floor for the reason `restBelow` gives.
   * It is the same hysteresis it always was: `restBelow` stops the lap and
   * `restTo` lets it go again, so a heal that nudges past the floor cannot
   * resume a march that dips straight back under it. Where `restTo` is 0 the
   * loop resumes at the floor, which is the single-sit-down behaviour that
   * figure means everywhere else.
   */
  restTo: number;
  /**
   * Meditate when mana falls below this fraction. 0 never meditates.
   *
   * Ignored outright for a class with no mana — a warrior's status line carries
   * no `MA=` at all, and `med` for one is answered `Your command had no
   * effect.`, which is a command spent to be refused in the room.
   */
  meditateBelow: number;
  /**
   * Drink the healing potion when health falls below this fraction. 0 never.
   *
   * MegaMUD's Health tab had a potion row beside *Heal if below*, and a
   * warrior has no other way to mend mid-fight. Only when the pack lists one:
   * a `drink` for a potion that is not carried is a command spent to be told
   * so, in the room. The potion's *sentence* is not read — the corpus has
   * `You drink the red potion, and a healing warmth spreads through your
   * body!` twelve times and the next status line carries the result — so the
   * effect reaches the client the way every vital does.
   */
  drinkHealingPotionBelow: number;
  /** The same for mana. 0 never, and ignored for a class with no mana. */
  drinkManaPotionBelow: number;
  /**
   * `drink` or `use`. Both are in the server's own command table, so neither
   * is ever said out loud; `drink` is the default because it is the one the
   * corpus has actually seen consume a potion (`You drink the red potion…`),
   * where `use` has only been seen on other things.
   */
  potionVerb: PotionVerb;
  /** What to ask for, as the pack lists it. Matched the way the server matches a typed name. */
  healingPotionName: string;
  manaPotionName: string;
}

export const POTION_VERBS = ['drink', 'use'] as const;
export type PotionVerb = (typeof POTION_VERBS)[number];

/**
 * Walking, beyond the mechanics of a route — MegaMUD's **Movement**.
 *
 * `WalkConfig` above is the *timing* of a walk and belongs to the walker;
 * this is what the walker is allowed to do on the way.
 */
export interface MovementConfig {
  /**
   * Open a closed door a route step ran into, instead of stopping the route.
   *
   * `Walker`'s own comment is the argument for this being a setting at all:
   * *"a shut door is shut until something opens it"* — and `open` is the thing
   * that opens it. Off by default, because a door somebody shut deliberately is
   * a door somebody shut deliberately, and a locked one costs a command per
   * attempt to be told so.
   *
   * Only for a door or a gate. `There is no exit in that direction!` is a
   * different fact — the realm data was wrong — and no amount of opening helps.
   */
  openDoors: boolean;
  /** How many times, before the route stops anyway. */
  openTries: number;
  /**
   * Bash a *locked* barrier open with brute strength.
   *
   * The step after `openDoors`, and a different fact: `open` answers `The door
   * is locked.` however many times it is sent (captured live, the sewers under
   * Newhaven), so a locked door is where opening stops and forcing begins.
   * `bas <direction>` is the realm's own verb for it — `You bashed the door
   * open.` on success, `Your attempts to bash through fail!` otherwise, and
   * **a bashed door opens by itself**, so nothing has to be opened afterwards.
   *
   * Gated on the realm's own number: a barrier records what strength has to
   * reach (`Door [41 picklocks/strength]`), and this is attempted only when
   * the character's strength is within `BASH_MARGIN` of it. Off by default,
   * like everything automated — bashing costs health (`You take 3 damage for
   * bashing the door!`) and a door somebody locked is a door somebody locked.
   */
  bashDoors: boolean;
  /** How many bashes, before the route gives up on the barrier. */
  bashTries: number;
  /**
   * Pick a *locked* barrier's lock.
   *
   * The other half of forcing one, and the cheaper half: `pi <direction>`
   * costs no health, answers `Your skill fails you this time.` until it works
   * and `You successfully unlocked the door.` when it does — after which the
   * door is unlocked and **still shut**, so an `open` follows. Both sentences
   * and the whole sequence are in `captures/002`.
   *
   * Gated on the realm's picklocks number within `PICK_MARGIN`. Tried before
   * bashing when both are available, because a failed pick costs a command and
   * a failed bash costs a command and some health.
   */
  pickLocks: boolean;
  /** How many picks, before the route gives up on the barrier. */
  pickTries: number;
  /**
   * Sneak before starting a planned route.
   *
   * What decides whether the things in the next room notice the character
   * arrive, which is the whole reason a route through somewhere dangerous is
   * different from a route through town. Off by default: sneaking fails, and a
   * character that believes it is hidden and is not walks into a lair in plain
   * sight — which is why `Stealth` is three-state rather than a boolean.
   */
  sneak: boolean;
  /**
   * Ready a carried light before stepping somewhere the character could not
   * otherwise see, and on arriving somewhere it cannot — MegaMUD's AutoLight.
   *
   * **On by default, and it is the one automated thing that is** (2026-09-03,
   * on instruction). The rule everything else here follows — off until asked
   * — exists because a wrong action costs a character; a torch lit in a dark
   * sewer costs a torch, and a character walked blind into `pitch black` is
   * one whose exits and attackers the client cannot read at all. The decision
   * is the server's own arithmetic (`src/shared/light.ts`): the room's level
   * plus the race's night vision plus what is worn, and a light is readied
   * only where that sum leaves the room unreadable and the light would fix
   * it. `Walker` used to warn and deliberately not act, pointing at
   * `automation.rules`; a rule cannot see the step about to be taken, which
   * is the moment this is worth anything.
   */
  provideLight: boolean;
  /**
   * Widen that to rooms that are merely dim — `dimly lit`, `barely visible` —
   * which the server describes in full anyway. MegaMUD's "provide light in
   * dimly-lit rooms". Off by default: the room can be read without it, so the
   * torch would be spent on a preference rather than a need.
   */
  lightDimRooms: boolean;
  /**
   * Put a burning light out again in a room that does not need it, so a torch
   * lasts the sewer rather than the walk to it. MegaMUD does the same at every
   * step flagged as naturally lit. Only while nothing is walking the
   * character — mid-route the next step may be dark again — and only where
   * the realm records the room's level, because a room whose light the data
   * does not state is one the client cannot promise is lit.
   */
  extinguishInLight: boolean;
}

/**
 * Casting — MegaMUD's **Spells** tab.
 *
 * MegaMUD's spell handling is a table per spell with a condition each, and
 * this client already has a better home for a condition: `automation.rules`,
 * in the options file, with a comment saying why. What lives here instead is
 * what a rule *cannot* express: the mid-round tick — the ~100 ms after the
 * last swing that decides whether an attack spell lands inside the round or
 * after it — a cast chosen by a number (the heal), a cast chosen by a
 * sentence (the cures), and the blessings, whose trigger is a wire *event*
 * (the wear-off) with a clock behind it. Utility casting stays rules.
 */
export interface SpellsConfig {
  /**
   * The spell to attack with. Blank casts nothing.
   *
   * Sent as `c <short> <target>` — the realm's own `Cast` command, which
   * answers to `c`, `ca`, `cas` and `cast`, reads exactly **one word** as the
   * spell, and that word is the listing's short name, not a prefix of the
   * name (measured 2026-09-01: `c pressure points` answers `You do not know
   * how to cast pressure.`). The configured value stays the readable whole
   * name, or an abbreviation; `castWord` resolves it when the cast goes out.
   */
  attack: string;
  /**
   * The spell to attack the whole room with, when the fight is crowded enough
   * — MegaMUD's MultAttack. Blank casts nothing.
   *
   * Cast bare (`c <spell>`, no target): the wire shows an area spell cast
   * with no target answering `You cast poison cloud on the room!`
   * (captures/131, `pclo` typed at the prompt). A named target on a room
   * spell has never been seen on the wire, so it is not sent.
   */
  areaAttack: string;
  /**
   * Threats in the room at or above which the area spell is chosen over
   * `attack` — MegaMUD's MultMstrCnt. Counted as what is in this fight or
   * would join it (`countThreats` plus the attackers), never as bare mobs —
   * a shopkeeper is not a reason to gas the room. And because a room spell
   * hits everything standing there, it is refused outright while a monster
   * the realm is sure is good is present: the ten evil points are a cost to
   * the character, and no setting spends them unasked.
   */
  areaMinMobs: number;
  /**
   * Do not cast the area spell below this fraction of maximum mana. An area
   * spell is the expensive one, so its floor is the higher of this and
   * `minMana`; under it the single-target spell and the round verbs carry
   * the fight. An unknown maximum never blocks it, as everywhere.
   */
  areaMinMana: number;
  /**
   * The spell to heal **this character** with. Blank heals nobody.
   *
   * MegaMUD's *Heal if below* on the Health tab, moved beside the attack
   * spell because it is the same mechanism — one cast, chosen by a number —
   * and the same `minMana` floor applies. Cast bare (`c <short>`), which is
   * how a targetless cast lands on the caster.
   *
   * The picker behind it offers only spells the realm says can be cast on the
   * caster — `Spells.Targets`, read by `spellTargeting`. A self-only spell
   * (`way of the swan`) belongs here and nowhere else.
   */
  heal: string;
  /**
   * The spell to heal a **party member** with. Blank heals nobody but this
   * character, whatever `healParty` says.
   *
   * A second field rather than a second use of `heal`, because the realm
   * distinguishes the two and a great many heals are one or the other: `way of
   * the swan` cannot be cast on somebody else and `minor healing` can. One
   * field for both meant a mystic configuring a self heal silently armed
   * `c swan <name>` once a round, for a refusal the server prints in the room.
   *
   * Cast as `c <short> <name>`, or bare when the realm calls the spell a
   * party-wide one (`healing rain`), which reaches everybody friendly at once
   * and takes no name.
   */
  healPartyWith: string;
  /**
   * The fraction of maximum below which a heal is cast. 0 never heals.
   *
   * A party member's health arrives as a percentage and needs no maximum, so
   * one figure serves both — MegaMUD kept one *Heal if below* too.
   */
  healBelow: number;
  /**
   * The threshold to use **while in combat**, when it differs. 0 uses
   * `healBelow` for both.
   *
   * MegaMUD's `HpHealAtt%`, and its own documentation says why: *"this
   * percentage should normally be set low to help in extreme danger conditions
   * only, so that combat is not normally affected"*. A heal cast at 80% in a
   * fight is a round spent not hitting anything, and the round is what the
   * fight is made of.
   *
   * Deliberately **not** clamped against `healBelow` the way `healTo` is: the
   * two are separate answers to separate situations, and a player who wants to
   * heal *more* readily in a fight than out of one is entitled to say so.
   */
  healBelowInCombat: number;
  /**
   * Keep healing the same target until it is back to this fraction. 0 is a
   * single cast at the threshold.
   *
   * The hysteresis pair `restBelow` / `restTo` already uses, for
   * the same reason: one cast at 50% that lands at 55% leaves a character
   * hovering just under the line, re-casting one spell at a time for as long
   * as the fight lasts and never getting ahead of the damage. Above the pair,
   * healing stops; between them it continues on a target it has already
   * started on. Never below `healBelow` — a `to` under the `below` would be
   * two opposite instructions, and is clamped up rather than obeyed.
   *
   * Unknown is not low, here as everywhere: a target with no figure is neither
   * started on nor continued.
   */
  healTo: number;
  /** Whether party members are healed at all. The toolbar's own toggle. */
  healParty: boolean;
  /**
   * Do not cast below this fraction of maximum mana. 0 always casts.
   *
   * MegaMUD's min-mana on the attack spell, and the setting its own
   * documentation warns about most: set too high, the character silently never
   * casts and reads as broken. An *unknown* maximum never blocks it, for the
   * reason an unknown maximum never starts a retreat.
   */
  minMana: number;
  /**
   * One curative spell per affliction the client can see. Cast bare once per
   * onset (a targetless cast lands on the caster), and again after thirty seconds while the server
   * still says the condition is on — a cure it answers with nothing leaves the
   * flag where it was, and casting once per status line would spend the
   * fight's budget on it. Blank casts nothing. Paralysis is tracked (`held`)
   * and has no cure here: no capture names a spell that ends it.
   */
  cures: { blindness: string; poison: string; disease: string };
  /**
   * The blessings kept up on this character and on the party it travels with,
   * in priority order — index 0 is recast first when several are down.
   *
   * Event-driven where the wire allows: the cast confirmation establishes a
   * buff on `CharacterState.buffs` and the wear-off frames end it, so a
   * recast goes out the moment the server says the spell is gone rather than
   * on a fixed clock. `fallbackSeconds` is the clock behind that — the
   * spell's duration as the player knows it, for the endings the client
   * cannot read — floored at thirty seconds so a typo cannot cast every tick.
   */
  blessings: BlessingConfig[];
  /**
   * Tell the party member who blessed this character when their spell wears
   * off — `/<caster> @bless-expired <spell>`, mudengine's own peer remote —
   * so their client recasts on the event instead of its clock. Opt-in: it
   * speaks on another player's telepath channel unasked.
   */
  notifyPartyOnWearOff: boolean;
}

/** Whom a blessing is cast on: this character, or every listed party member. */
export const BLESSING_TARGETS = ['self', 'party'] as const;

export type BlessingTarget = (typeof BLESSING_TARGETS)[number];

export interface BlessingConfig {
  /**
   * The whole spell name, as `c` wants it — and the row's identity: the key
   * it is coalesced and remembered by. There is deliberately no separate
   * display name. The list first shipped with one, and the first person to
   * use it typed the spell into the name box, left the spell box empty, and
   * lost the row to the silent no-spell filter below — two words for one
   * thing is a form that invites exactly that.
   */
  spell: string;
  target: BlessingTarget;
  /** Fraction of maximum mana below which this blessing waits. 0 never waits. */
  minMana: number;
  /**
   * Recast this before healing when both are due — for the shield a caster
   * dies without. Default off: a heal answers a number that is already bad.
   */
  prioritizeOverHeal: boolean;
  /**
   * Allow the recast mid-fight, in the combat band. Off, it waits for
   * `*Combat Off*`. Defaults on for `self` and off for `party` when absent,
   * because a follower's shield mid-fight is its own business and a cast on
   * somebody else's round is a command the fight paid for.
   */
  inCombat: boolean;
  /**
   * Party rows only: the recast interval, since a member's wear-off lands on
   * *their* screen (the `@bless-expired` notification, where both ends run
   * mudengine, is what upgrades that to event-driven). Absent on a self row
   * and ignored there: the character's own wear-off frames drive the recast,
   * and the watchdog behind unreadable endings is the duration *measured*
   * from earlier cast→wear-off pairs — never the realm's `Dur` column, whose
   * units nothing on hand establishes, and never a number typed here.
   */
  fallbackSeconds?: number;
}

export interface SafetyConfig {
  hangUp: HangUpConfig;
  retreat: RetreatConfig;
  pvp: PvpConfig;
}

/** What a PvP reaction may do about the fight itself. */
export const PVP_ACTIONS = ['none', 'retreat'] as const;

export type PvpAction = (typeof PVP_ACTIONS)[number];

/**
 * What to do the moment a player opens on this character — MegaMUD's
 * NotifyGang, on the wire this client has already read: `<Name> moves to
 * attack you!` and a player's blow both put the attacker in
 * `combat.attackers` and start `HangUpWatch`'s five-minute clock, and this is
 * the reaction to that same evidence.
 *
 * Both halves off, like everything automated — and this one reaches other
 * people twice over: the broadcast speaks to the whole gang, and a retreat is
 * the client deciding a fight is lost.
 */
export interface PvpConfig {
  /**
   * Say so on the gangpath — `bg`, the realm's own verb — once per attacker
   * per five-minute window: the room and the health ride along, because the
   * gang deciding whether to come needs where and how bad.
   */
  notifyGang: boolean;
  /**
   * `retreat` runs the moment the attack is seen, whatever `retreat.enabled`
   * says — this is its own trigger, not a health threshold. `none` leaves the
   * fight to the player and the other settings.
   */
  action: PvpAction;
}

/**
 * Following somebody: what a character does about the party it travels in.
 *
 * All off, like everything automated, and with one more reason than usual:
 * **whether the server's command window is per connection or per host is
 * unmeasured** (docs/profiles.md §9.2). It was measured with one socket; if it
 * is per host, several automated characters starve each other undetectably.
 * These settings make a second automated character useful, and turning them on
 * is the player choosing to run that experiment. Nothing here sends more than
 * one automated character already could.
 */
export interface PartyConfig {
  /**
   * Swing at what the leader is fighting. The leader is whoever this character
   * follows (`party.following`); their target is what the server last said
   * they hit (`party.engaged`), taken only while that monster is still in the
   * room and the sighting is under a minute old. Never a player, whatever the
   * leader is doing — the three refusals stand — and still under `minHealth`.
   */
  assistLeader: boolean;
  /**
   * Swing at a monster seen attacking any party member — MegaMUD's
   * DefendParty. The sighting is `party.threatened`, kept from the sentences
   * the server volunteers about blows on other people, taken only while that
   * monster is still in the room and the sighting is fresh. Joining a fight
   * the monster brought to the party is not opening one, so `engage: none`
   * does not stop it — but every other gate does, and never a player on
   * either end: a person attacking a member is that member's PvP fight.
   */
  defendParty: boolean;
  /**
   * Sit down when the leader does. The party listing and `stops to rest` say
   * who is resting; a follower that keeps walking while its leader mends is a
   * follower a lair finds alone. Out of combat only, like every rest.
   */
  restWithLeader: boolean;
}

export interface AutomationConfig {
  /**
   * Rules, evaluated over character state. Written against this project's own
   * vocabulary — see `./rules.ts` for why it is not `tproxy`'s DSL.
   */
  rules: Rule[];
  /** Master switch. With this off, only what the player types is ever sent. */
  enabled: boolean;
  /**
   * Sent once on entering the realm, to populate the HUD from an otherwise
   * silent server. `exp` and `st` fill in maxima and progress, `i` the
   * inventory, `who` the roster.
   *
   * `rm` is first and is the one that matters: it answers `Location: 1,2147`,
   * the only exact statement of position this server ever makes, and everything
   * else the client believes about where it is standing is inference.
   *
   * It replaced `pro`, measured rather than reasoned (`npm run probe:tour`):
   * both carry the location, and `pro` spends **thirty lines** of settings,
   * evil points and death records saying it — none of which anything here
   * reads, and all of which lands in the terminal on every connection. `rm`
   * answers in one line.
   */
  onEnterRealm: string[];
  /**
   * Asked when the party changes, so the roster is not empty at the moment it
   * became worth having.
   *
   * The party listing is the only place another character's health is visible.
   * One command on a transition, not periodically — how often to spend one on
   * it is a judgement about how the character is being played, and a rule with
   * `partySize` is where that belongs. Empty never asks.
   */
  onPartyChange: string;
  idle: IdleConfig;
  pacing: PacingConfig;
  walk: WalkConfig;
  /** Actions taken to keep a character alive, rather than to play it. */
  safety: SafetyConfig;
  /** Fighting on the character's behalf, rather than keeping it alive. */
  combat: CombatConfig;
  party: PartyConfig;
  /** Resting and meditating: getting the numbers back up. */
  health: HealthConfig;
  /** Picking things up off the floor — MegaMUD's auto-get. */
  loot: LootConfig;
  /** Dropping named junk back onto it — the other half of MegaMUD's drop list. */
  drop: DropConfig;
  /** Looking for what the room does not print — see `SearchConfig`. */
  search: SearchConfig;
  /** Banking the purse at a counter — MegaMUD's StashCoin. */
  banking: BankingConfig;
  /** Keeping the pack stocked. See `SuppliesConfig`. */
  supplies: SuppliesConfig;
  /** Answering another player's `@` commands — MegaMUD's remote control. */
  remotes: RemotesConfig;
  /** What this character does about other people, short of talking to them. */
  talk: TalkConfig;
  /**
   * The loops a character walks to gain levels — MegaMUD's loops.
   *
   * Named places, never recorded steps: see `src/shared/loops.ts`. Started by
   * name from the palette; `npm run build:loops` converts MegaMUD's own into
   * `resources/loops/megamud.yaml` to copy from.
   */
  loops: Loop[];
  /**
   * Commands on a clock — MegaMUD's Events tab.
   *
   * `routines` reacts to state; this reacts to *time*. Through the arbiter in
   * the `probe` band like everything else, so an event never displaces an escape.
   */
  events: ScheduledEvent[];
  /** What a planned route is allowed to do on the way. */
  movement: MovementConfig;
  /** Casting, at the one moment a rule cannot express. */
  spells: SpellsConfig;
}

export interface AppConfig {
  connection: ConnectionConfig;
  /** Saved servers, offered by name in the command palette and by profiles. */
  servers: Server[];
  terminal: TerminalConfig;
  ui: UiConfig;
  logging: LoggingConfig;
  automation: AutomationConfig;
}

/**
 * The last-resort glyph source. Bundled with the app, so it is appended to
 * every terminal stack regardless of what the user asked for: CSS resolves
 * fonts per glyph, so this only ever supplies the CP437 box-drawing and block
 * characters a modern face happens to be missing.
 */
export const CP437_FALLBACK_FONT = 'Web437 IBM VGA 8x16';

/**
 * Cross-platform monospace fallbacks, appended after the user's choices.
 * Families absent from the host are skipped by the CSS font matcher, so one
 * list can cover Windows, macOS and Linux without branching.
 */
export const MONOSPACE_FALLBACKS: readonly string[] = [
  'Lucida Console', // Windows
  'Consolas', // Windows
  'Menlo', // macOS
  'Monaco', // macOS
  'DejaVu Sans Mono', // Linux
  'Liberation Mono', // Linux
  'Courier New' // everywhere
];

/** The generic keyword. Last in every stack; guarantees a fixed pitch. */
const GENERIC_MONOSPACE = 'monospace';

/**
 * The realm a new character starts on, by **name** — the one thing that says
 * which of the shipped realms is the default rather than leaving it to whichever
 * directory sorts first.
 *
 * `resources/servers/gmud-5x/server.yaml` is the realm and
 * `resources/config/profile.default.yaml` names it too; `shipped.test.ts` holds
 * all three together, because a template and its constant are a closed pair and
 * this repository has watched one drift already (`internal.yaml`, 2026-08-28).
 *
 * Changing the default is therefore editing this line and the template beside
 * it, not renaming a directory to sort earlier — which is what the settings
 * screen used to depend on without saying so.
 *
 * A name no realm on disk answers to falls back to the first realm there is: a
 * player who deleted this one still gets a realm rather than a blank field.
 */
export const DEFAULT_REALM_NAME = 'GMUD (5X)';

export const DEFAULT_CONFIG: AppConfig = {
  connection: {
    /*
     * Paradigm's own address, because Paradigm is what this client ships for:
     * `resources/servers/` seeds its six realms on first run and
     * `resources/world/` is built from the database Paradigm distributes.
     *
     * This is what a NEW realm starts with, not an identity — the client has
     * no pre-character mode and never dials anything without a character
     * naming a realm. It was `gmud-tgs`, which is a private GreaterMUD box on
     * one developer's network: a default nobody else can reach, shipped to
     * everybody.
     */
    host: 'paramud.mudinfo.net',
    port: 2323,
    encoding: 'cp437',
    login: {
      // Off until a character's credentials fill it in: a client that sends an
      // empty username at every connection is worse than one that waits.
      enabled: false,
      username: '',
      password: '',
      /*
       * What Paradigm asks, in the order it asks it. Anything else is a BBS
       * somebody adds rows for — matched rather than sequenced, so a row that
       * never matches costs nothing.
       */
      steps: [
        { when: 'Please enter your selection', send: 'P' },
        { when: 'Please select a realm', send: '1' },
        { when: 'Please select a character', send: '1' },
        { when: '[PARADIGM]', send: 'E' },
        { when: 'Accept these realm rules to continue', send: '1' },
        { when: '(N)onstop, (Q)uit, or (C)ontinue?', send: '' }
      ]
    }
  },
  /*
   * None. A realm is a directory under `realms/`, and the client seeds one
   * from the shipped example on first run — so a built-in list here would be a
   * second, invisible source for the same thing, differing from the file the
   * settings screen writes and winning or losing by merge order.
   */
  servers: [],
  terminal: {
    font: {
      family: ['LucidaProgrammer Nerd Font Mono'],
      size: 16
    },
    scrollback: 100_000,
    cursorBlink: true,
    cursorStyle: 'block'
  },
  ui: {
    font: {
      family: ['LucidaProgrammer Nerd Font Mono'],
      size: 13
    },
    density: 'auto',
    theme: DEFAULT_THEME,
    tabs: 'left',
    showHud: true,
    // Half and a quarter: the same numbers `megamind-client` shipped for
    // `restIfBelow` / `runIfBelow`, and the ones a MajorMUD player already has
    // in their head. Fractions, so they hold at every level.
    vitals: {
      hp: { caution: 0.5, critical: 0.25 },
      mana: { caution: 0.5, critical: 0.25 }
    },
    alerts: { minimum: 'info', mute: [] }
  },
  logging: {
    enabled: true,
    fights: true,
    capture: true,
    conversations: true,
    conversationDays: 365,
    directory: '',
    maxBytes: 64 * 1024 * 1024
  },
  automation: {
    enabled: true,
    // No rules by default. Automation that acts without being asked to is not
    // a sensible default for a game where a wrong action costs a character.
    rules: [],
    // `pro` first, and it is the important one: it answers `Location: 1,2147`,
    // which is the *only* exact statement of where the character is standing.
    // Everything else the client does about position -- unique names, exit
    // signatures, movement -- is inference from evidence, and the pathfinder is
    // only as good as its starting point. The legacy engine asked for this on
    // entering the realm (`user.coffee` `onGameEnter`) and dropping it was an
    // omission, not a decision.
    // `gb` last of the listings: it is the only statement of gang membership
    // that includes the members who are offline, and gang membership is a
    // permission -- `automation.remotes` answers `@` commands for whoever
    // shares this character's gang, so the gate starts the session knowing who
    // that is rather than learning it when somebody first asks. A gangless
    // character gets one line back saying so, which the classifier reads.
    // `bank` before the closing look, because the vault a character logs in
    // standing in is the only one it can read without walking there: `bank`
    // answers for *this* counter and says nothing about the others. The
    // balances are kept between sessions (`Belongings`), so this is a refresh
    // rather than the only way the card is ever filled -- and it costs one
    // command answered with a refusal for a character that logged out
    // somewhere else, which is why it is a list the player owns.
    //
    // It used to end in `l`. The server prints the whole room block on entering
    // the realm anyway -- name, description, the floor, `Also here:`, exits and
    // light -- so the closing look was a second copy of a block already read,
    // bought at the price of announcing to everybody standing there that this
    // character had arrived and was looking about. Measured across the recorded
    // sessions in `logs/`: every one whose entry room had somebody in it printed
    // `Also here:` before the probe sent anything (`2026-08-27_23-07-19`,
    // `2026-08-28_10-18-29`, and eight more).
    //
    // Dropped rather than replaced: `stringList` filters an empty entry out, so
    // a list of command words has no spelling for the bare Enter that replaced
    // `l` everywhere else. Nothing here needs one -- the block already arrived.
    onEnterRealm: ['rm', 'st', 'i', 'exp', 'sc', 'gb', 'bank'],
    onPartyChange: 'party',
    // Off: a look is a spent command and the server tells the person they were
    // looked at. See `TalkConfig.lookAtPlayers`.
    talk: { lookAtPlayers: false },
    // Empty is a bare Enter: the room, re-read without telling the room. See
    // `IdleConfig.command` and `REREAD_ROOM`.
    idle: { enabled: true, afterSeconds: 45, command: REREAD_ROOM },
    // Window of 3 against a measured cliff of ~20: deliberately conservative,
    // because exceeding it loses commands with no way to know.
    pacing: { window: 3, minGapMs: 350, ackTimeoutMs: 3000 },
    // Comfortably longer than the queue's own acknowledgement timeout, so a
    // step is not abandoned while the arbiter is still waiting its turn to
    // send it.
    walk: { clearAfterSeconds: 15, stepTimeoutMs: 8000 },
    safety: {
      // Off, and refusing when on. See `HangUpConfig`: the panic button every
      // MegaMUD-era client offers is, here, a way to die.
      hangUp: {
        enabled: false,
        belowHealth: 0.15,
        onlyWhenClean: true,
        onPlayerInRoom: false
      },
      retreat: {
        enabled: false,
        belowHealth: 0.3,
        whenOutnumbered: 0,
        cooldownMs: 3000,
        strategy: 'step-back',
        safeHavenRoom: ''
      },
      pvp: { notifyGang: false, action: 'none' }
    },
    // Off, like every other thing the client would do without being asked. The
    // shape it defaults to is the minimal one that still works: open on what
    // the realm data says would attack you anyway, hit back at whatever hits
    // you, and let the server roll the rounds.
    combat: {
      enabled: false,
      attack: 'a',
      opener: '',
      engage: 'hostile',
      retaliate: true,
      maxMobs: 0,
      minHealth: 0,
      whileWalking: false,
      refreshRounds: 3,
      avoid: [],
      avoidUndead: false,
      avoidDeathSpell: false,
      maxTargetHealth: 0,
      minMobs: 0,
      maxMonsterExperience: 0,
      prefer: []
    },
    // Off, like everything automated. A client that sits down on its own is one
    // deciding when a fight is over.
    party: { assistLeader: false, defendParty: false, restWithLeader: false },
    health: {
      /*
       * The figures `loopPauseBelow` / `loopResumeAt` shipped with, inherited
       * whole when the two pairs became one (2026-09-02).
       *
       * They are not 0 — the number every other automated threshold here
       * ships at — and the reason is that these two were never off. A loop
       * marching a 6% character through lairs that attack on sight was
       * measured live, and 35/70 is what was chosen to stop it. Resting itself
       * is still off until somebody turns it on: `Recovery` refuses on
       * `automation.enabled` before it reads a threshold at all, so an
       * unconfigured client sits nobody down. What these figures decide
       * unasked is only ever whether a lap the *player started* keeps marching
       * while its character is hurt.
       */
      restBelow: 0.35,
      restTo: 0.7,
      meditateBelow: 0,
      drinkHealingPotionBelow: 0,
      drinkManaPotionBelow: 0,
      potionVerb: 'drink',
      healingPotionName: 'healing potion',
      manaPotionName: 'mana potion'
    },
    loot: {
      coins: false,
      // All five: this is what `coins: true` alone has always meant, so the
      // default changes nothing about how the client behaves.
      coinKinds: [...DENOMINATIONS],
      items: [],
      minPrice: 0,
      maxEncumbrance: 0,
      stopAtGrade: 'never',
      convertWith: '',
      convertAt: 'never'
    },
    drop: { enabled: false, items: [], whenEncumbered: false, worthless: false },
    search: { enabled: false, tries: 1 },
    // 500 gold and 5 gold, on the measured ladder: 100 copper to the gold.
    banking: { autoDeposit: false, depositThresholdCopper: 50_000, keepCopper: 500 },
    // On, with nothing listed: the switch is what the toolbar flips, and the
    // list is what the Self card and the item panel fill. An empty list does
    // nothing, so the default is safe and the first item added starts working.
    supplies: { enabled: true, items: [] },
    remotes: {
      enabled: false,
      gangpath: false,
      gang: [],
      /*
       * The one grant that ships non-empty, and it is two names: see
       * `RemotesConfig.party` for the four that were on it and are not. Both
       * are facts about this character's own body that the party listing
       * already states more coarsely, and neither does anything to it.
       */
      party: ['health', 'bless-expired'],
      players: {}
    },
    loops: [],
    events: [],
    movement: {
      openDoors: false,
      openTries: 1,
      bashDoors: false,
      bashTries: 3,
      pickLocks: false,
      pickTries: 3,
      sneak: false,
      provideLight: true,
      lightDimRooms: false,
      extinguishInLight: true
    },
    spells: {
      attack: '',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0.35,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0.15,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    }
  }
};

/**
 * The automation switches that can be flipped without opening a form.
 *
 * Every one is a **boolean already in the options file** — this adds no
 * setting and invents no runtime state beside the config. There is one source
 * of truth for whether this character fights on its own, and it is the
 * character's own YAML; the toolbar writes it (comments intact, through
 * `SettingsEditor`) and the store's poll brings it back half a second later,
 * exactly as the Gang card's permission grid already does.
 *
 * The alternative — a session-scoped override the file does not know about —
 * was rejected for the reason `ui.showDiagnostics` was retired: two places
 * that can answer the same question eventually disagree, and the one somebody
 * reads is whichever is wrong.
 *
 * **One table, so the union and the path cannot drift.** The name is the type
 * and the array is where the value lives under `automation:`; a switch added
 * to one and not the other does not compile. `src/shared/__tests__` walks
 * every path against `DEFAULT_CONFIG` and fails for one that leads nowhere or
 * to something that is not a boolean, which is the failure `GUARD_FIELDS`
 * already records: a field in the type and not the list type-checks, then
 * silently does nothing.
 *
 * Only booleans, and only ones worth flipping mid-play. A threshold is a
 * number and belongs on the settings screen; a list is a list.
 */
export const AUTOMATION_SWITCHES = {
  /** The master switch. Off, only what the player types is ever sent. */
  automation: ['enabled'],
  combat: ['combat', 'enabled'],
  retaliate: ['combat', 'retaliate'],
  engageWhileWalking: ['combat', 'whileWalking'],
  retreat: ['safety', 'retreat', 'enabled'],
  hangUp: ['safety', 'hangUp', 'enabled'],
  loot: ['loot', 'coins'],
  drop: ['drop', 'enabled'],
  search: ['search', 'enabled'],
  autoDeposit: ['banking', 'autoDeposit'],
  supplies: ['supplies', 'enabled'],
  openDoors: ['movement', 'openDoors'],
  pickLocks: ['movement', 'pickLocks'],
  bashDoors: ['movement', 'bashDoors'],
  sneak: ['movement', 'sneak'],
  provideLight: ['movement', 'provideLight'],
  healParty: ['spells', 'healParty'],
  assistLeader: ['party', 'assistLeader'],
  defendParty: ['party', 'defendParty'],
  restWithLeader: ['party', 'restWithLeader'],
  remotes: ['remotes', 'enabled'],
  gangpath: ['remotes', 'gangpath'],
  lookAtPlayers: ['talk', 'lookAtPlayers']
} as const satisfies Record<string, readonly string[]>;

export type AutomationSwitch = keyof typeof AUTOMATION_SWITCHES;

export const AUTOMATION_SWITCH_NAMES = Object.keys(AUTOMATION_SWITCHES) as AutomationSwitch[];

/** Every switch's current answer for one character. */
export type AutomationSwitches = Record<AutomationSwitch, boolean>;

/**
 * A name off the wire, or null. Parse, do not validate.
 *
 * `Object.hasOwn`, not `in`: every object inherits `toString`, `constructor`
 * and the rest, so `in` accepts a payload naming one of them and hands the
 * caller a path off `Object.prototype`. The test caught it on the first run.
 */
export function asAutomationSwitch(value: unknown): AutomationSwitch | null {
  return typeof value === 'string' && Object.hasOwn(AUTOMATION_SWITCHES, value)
    ? (value as AutomationSwitch)
    : null;
}

/**
 * What one switch currently says, walked out of a resolved configuration.
 *
 * Anything that is not a boolean at the end of the path reads as `false`
 * rather than throwing: this is the *resolved* config, so a path that leads
 * nowhere is a bug the test catches, and a client that would not draw its
 * toolbar because of one is worse than a switch drawn off.
 */
export function readAutomationSwitch(
  automation: AutomationConfig,
  name: AutomationSwitch
): boolean {
  let node: unknown = automation;
  for (const key of AUTOMATION_SWITCHES[name]) {
    if (!isRecord(node)) return false;
    node = node[key];
  }
  return node === true;
}

/** Every switch for one character, as the toolbar draws them. */
export function automationSwitches(automation: AutomationConfig): AutomationSwitches {
  const out = {} as AutomationSwitches;
  for (const name of AUTOMATION_SWITCH_NAMES) {
    out[name] = readAutomationSwitch(automation, name);
  }
  return out;
}

/** What the main process publishes after every load or reload. */
export interface ConfigSnapshot {
  config: AppConfig;
  /** Absolute path of the file being watched. */
  path: string;
  /**
   * Why the most recent read was rejected, or null. When set, `config` still
   * holds the last values that parsed cleanly.
   */
  error: string | null;
  /** Epoch ms of the last successful load. */
  loadedAt: number;
}

/** CSS family names that are keywords rather than names, so must not be quoted. */
const GENERIC_FAMILIES = new Set([
  'monospace',
  'serif',
  'sans-serif',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'ui-rounded'
]);

/** True for a bare CSS identifier that survives without quotes. */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Renders a family list as a CSS `font-family` value.
 *
 * Anything that is not a generic keyword or a single bare identifier is
 * quoted, which covers the names that actually matter here — every DOS bitmap
 * face and every Nerd Font variant contains spaces.
 */
export function toCssFontStack(families: readonly string[]): string {
  return families
    .map((family) => {
      if (GENERIC_FAMILIES.has(family)) return family;
      if (BARE_IDENTIFIER.test(family)) return family;
      return `'${family.replace(/'/g, "\\'")}'`;
    })
    .join(', ');
}

/** Removes duplicates while keeping first-seen order. */
function dedupe(families: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const family of families) {
    const key = family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(family);
  }
  return out;
}

/**
 * Completes a terminal font stack.
 *
 * The user's families come first, then the cross-platform monospace ladder,
 * then the bundled CP437 face, then the generic `monospace` keyword. The tail
 * is not optional and is not configurable: it is what makes it impossible to
 * end up with a proportional console.
 */
export function resolveTerminalFonts(families: readonly string[]): string[] {
  return dedupe([...families, ...MONOSPACE_FALLBACKS, CP437_FALLBACK_FONT, GENERIC_MONOSPACE]);
}

/**
 * Completes a chrome font stack.
 *
 * The same ladder, minus the CP437 bitmap face: chrome never renders box art,
 * and an 8x16 bitmap standing in for a missing glyph at 13px looks like a bug.
 * The user's own families still come first — chrome is the one surface allowed
 * to be enriched.
 */
export function resolveUiFonts(families: readonly string[]): string[] {
  return dedupe([...families, ...MONOSPACE_FALLBACKS, GENERIC_MONOSPACE]);
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/** A YAML document, before we have proven anything about its shape. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Accepts either a YAML list or a single string, so both of these work:
 *
 *     family: LucidaProgrammer Nerd Font Mono
 *     family:
 *       - LucidaProgrammer Nerd Font Mono
 *       - Consolas
 */
function familyList(value: unknown, fallback: string[]): string[] {
  if (typeof value === 'string') {
    const one = value.trim();
    return one.length > 0 ? [one] : fallback;
  }
  if (!Array.isArray(value)) return fallback;
  const families = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return families.length > 0 ? families : fallback;
}

function normalizeFont(value: unknown, fallback: FontConfig): FontConfig {
  const raw = isRecord(value) ? value : {};
  return {
    family: familyList(raw['family'], fallback.family),
    size: int(raw['size'], fallback.size, 6, 72)
  };
}

/**
 * Coerces an arbitrary parsed YAML document into a complete `AppConfig`.
 *
 * Every unknown, missing or malformed value falls back to `DEFAULT_CONFIG`
 * rather than raising, so a half-finished edit — which a file watcher *will*
 * observe, since editors save partial buffers — degrades to defaults for the
 * affected keys instead of dropping the session.
 */
export function normalizeConfig(input: unknown): AppConfig {
  const raw = isRecord(input) ? input : {};
  const connection = isRecord(raw['connection']) ? raw['connection'] : {};
  const terminal = isRecord(raw['terminal']) ? raw['terminal'] : {};
  const ui = isRecord(raw['ui']) ? raw['ui'] : {};

  return {
    connection: {
      host: str(connection['host'], DEFAULT_CONFIG.connection.host),
      port: int(connection['port'], DEFAULT_CONFIG.connection.port, 1, 65535),
      encoding: oneOf<StreamEncoding>(
        connection['encoding'],
        ['cp437', 'utf8', 'latin1'],
        DEFAULT_CONFIG.connection.encoding
      ),
      login: normalizeLogin(connection['login'])
    },
    // Both keys, oldest last: `profiles:` was this block's name before a
    // profile came to mean a character.
    /*
     * Assembled from the directories under `realms/` by `ConfigStore`, which
     * injects the list before this runs. The options file itself no longer
     * states realms at all: a realm is a file with its own menus and its own
     * loops, and a list of them inside the global file could hold neither.
     */
    servers: normalizeServers(raw['servers']),
    terminal: {
      font: normalizeFont(terminal['font'], DEFAULT_CONFIG.terminal.font),
      scrollback: int(terminal['scrollback'], DEFAULT_CONFIG.terminal.scrollback, 0, 1_000_000),
      cursorBlink: bool(terminal['cursorBlink'], DEFAULT_CONFIG.terminal.cursorBlink),
      cursorStyle: oneOf(
        terminal['cursorStyle'],
        ['block', 'underline', 'bar'] as const,
        DEFAULT_CONFIG.terminal.cursorStyle
      )
    },
    ui: {
      font: normalizeFont(ui['font'], DEFAULT_CONFIG.ui.font),
      tabs: oneOf(ui['tabs'], ['top', 'left'] as const, DEFAULT_CONFIG.ui.tabs),
      density: oneOf(
        ui['density'],
        ['auto', 'comfortable', 'compact'] as const,
        DEFAULT_CONFIG.ui.density
      ),
      // Validated against the registry rather than a literal list, so a theme
      // added to `themes.ts` becomes selectable without touching this file.
      theme: isThemePreference(ui['theme']) ? ui['theme'] : DEFAULT_CONFIG.ui.theme,
      showHud: bool(ui['showHud'], DEFAULT_CONFIG.ui.showHud),
      vitals: normalizeVitals(ui['vitals']),
      alerts: normalizeAlerts(ui['alerts'])
    },
    logging: normalizeLogging(raw['logging']),
    automation: normalizeAutomation(raw['automation'])
  };
}

/**
 * A 0–1 fraction, read forgivingly.
 *
 * The rule engine's `hp.percent` guard is a fraction, so the options file uses
 * fractions too rather than holding two representations of the same idea — the
 * mistake that let exit-signature room resolution silently never match.
 *
 * But "percent" invites `50`, and clamping that to `1` would paint the bar red
 * permanently: a plausible misreading must not be the most dangerous one. So a
 * value above 1 is taken as a percentage. There is no ambiguity to resolve —
 * a threshold above 100% of maximum is not a thing anyone means.
 */
function fraction(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n < 0) return fallback;
  const asFraction = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, asFraction));
}

function normalizeThresholds(value: unknown, fallback: VitalThresholds): VitalThresholds {
  const raw = isRecord(value) ? value : {};
  const caution = fraction(raw['caution'], fallback.caution);
  // Red never sits above yellow. Inverting them is a typo, not an intent, and
  // the safe reading of a typo is the more cautious one: a meter that warns
  // early is noise, one that alarms late is a dead character.
  return { caution, critical: Math.min(caution, fraction(raw['critical'], fallback.critical)) };
}

function normalizeAlerts(raw: unknown): AlertsUiConfig {
  const d = DEFAULT_CONFIG.ui.alerts;
  if (!isRecord(raw)) return { ...d, mute: [...d.mute] };
  return {
    minimum: oneOf(raw['minimum'], SEVERITIES, d.minimum),
    // Lowercased and de-duplicated: a channel name is what the notice carries,
    // and `Combat` in the file matching nothing would be a setting that reads
    // as though it worked.
    mute: Array.from(
      new Set(
        (Array.isArray(raw['mute']) ? raw['mute'] : [])
          .map((entry) => String(entry).trim().toLowerCase())
          .filter((entry) => entry.length > 0)
      )
    )
  };
}

function normalizeVitals(value: unknown): VitalsUiConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.ui.vitals;
  return {
    hp: normalizeThresholds(raw['hp'], d.hp),
    mana: normalizeThresholds(raw['mana'], d.mana)
  };
}

/** A `{ when, send }` list, or null when the key was absent altogether. */
function readLoginSteps(value: unknown): LoginStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: LoginStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const when = str(entry['when'], '');
    if (when.length === 0) continue;
    // `send` may legitimately be empty: several menus want a bare Enter.
    steps.push({ when, send: typeof entry['send'] === 'string' ? entry['send'] : '' });
  }
  return steps;
}

function loginStepsFrom(raw: Record<string, unknown>, fallback: LoginStep[]): LoginStep[] {
  return readLoginSteps(raw['steps']) ?? fallback;
}

function normalizeLogin(value: unknown): LoginConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.connection.login;
  const username = str(raw['username'], d.username);
  const password = typeof raw['password'] === 'string' ? raw['password'] : d.password;

  return {
    // Enabling without credentials would send empty answers at a live service.
    enabled: bool(raw['enabled'], d.enabled) && username.length > 0 && password.length > 0,
    username,
    password,
    steps: loginStepsFrom(raw, d.steps)
  };
}

/** The connection target a saved server describes. */
export function targetFromServer(server: Server): ConnectionTarget {
  return { host: server.host, port: server.port, encoding: server.encoding };
}

/**
 * Coerces one entry of the `servers:` list.
 *
 * Returns null rather than a defaulted entry: one too malformed to name a host
 * is better dropped than silently turned into a connection to the default
 * host that the user never asked for.
 */
function normalizeServer(value: unknown): Server | null {
  if (!isRecord(value)) return null;

  const host = str(value['host'], '');
  if (host.length === 0) return null;

  return {
    name: str(value['name'], `${host}:${int(value['port'], 23, 1, 65535)}`),
    host,
    port: int(value['port'], DEFAULT_CONFIG.connection.port, 1, 65535),
    encoding: oneOf<StreamEncoding>(
      value['encoding'],
      ['cp437', 'utf8', 'latin1'],
      DEFAULT_CONFIG.connection.encoding
    ),
    // Empty is a real answer: a server with no menus at all, which is every
    // MUD reached directly rather than through a BBS front end.
    login: readLoginSteps(value['login']) ?? [],
    /*
     * Empty is a real answer here too: the realm the client ships.
     *
     * Not checked for existence — this runs on every config load, and a network
     * path that is briefly unreachable must not silently become "the shipped
     * realm". Whether it can be read is answered where it is opened, once, and
     * reported.
     */
    database: str(value['database'], '')
  };
}

/**
 * One server, from a file that holds nothing else.
 *
 * `servers/<id>/server.yaml` is the only place a server is written now, and
 * this is what reads one. The directory's own name stands in when the file
 * does not say what to call it, so a server put there by hand is offered
 * rather than dropped for want of a key — the same forgiveness a loop file
 * gets, and for the same reason: a file in that directory was put there on
 * purpose.
 */
export function asServer(value: unknown, fallbackName: string): Server | null {
  if (!isRecord(value)) return null;
  const named = str(value['name'], '').length > 0 ? value : { ...value, name: fallbackName };
  return normalizeServer(named);
}

/**
 * One list of servers from several, with the later ones winning by name.
 *
 * A name is how a character addresses a server — `server: GreaterMUD (local)`
 * in its own file — so two servers called the same thing are one server with
 * two definitions. The file on disk under `servers/` is the later list and
 * therefore the one that wins: it is what the settings screen writes, and what
 * somebody edited last.
 */
export function mergeServers(...lists: readonly (readonly Server[])[]): Server[] {
  return mergeNamed(...lists);
}

/**
 * Servers, de-duplicated by name.
 *
 * A repeated name would make the palette ambiguous — two identical rows, one of
 * which silently never wins — and would make a profile's `server:` reference
 * ambiguous too. The first wins and the rest are dropped.
 */
function normalizeServers(value: unknown): Server[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.servers;

  const seen = new Set<string>();
  const servers: Server[] = [];

  for (const entry of value) {
    const server = normalizeServer(entry);
    if (!server) continue;
    const key = server.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    servers.push(server);
  }

  return servers;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : fallback;
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // An explicitly empty list is a choice -- "probe nothing" -- so it is kept.
  return Array.isArray(value) ? items : fallback;
}

/**
 * Every field a guard may name.
 *
 * **This is one half of a pair and both halves have to move together.** The
 * other is `readField` in `RuleEngine`. A field added to the `GuardField` union
 * and to the reader but not to this list is a field the type system accepts and
 * the *parser* refuses — so a rule using it fails to load, silently, and the
 * documented example in `default.yaml` does not work. That is exactly what
 * happened to `target`, `attackers`, `players`, `hostiles` and `hangUpClean`
 * when they were added.
 *
 * Ordered as the field union is, so the two read alongside each other.
 */
export const GUARD_FIELDS: readonly GuardField[] = [
  'hp.percent',
  'hp',
  'mana.percent',
  'mana',
  'level',
  'inCombat',
  'resting',
  'meditating',
  'occupants',
  'threats',
  'mobs',
  'players',
  'hostiles',
  'hangUpClean',
  'target',
  'attackers',
  'partySize',
  'stealth',
  'wealth',
  'phase',
  'realm',
  'shopHere',
  'lairHere',
  'undeadHere',
  'toughestHere',
  'deathSpellHere',
  'dark',
  'light'
];

const COMPARISONS: readonly Comparison[] = ['<', '<=', '>', '>=', '==', '!='];

/** Derived, not restated: a band added to `PRIORITY` is accepted here at once. */
const PRIORITIES = Object.keys(PRIORITY) as readonly RuleAction['priority'][];

/**
 * `"hp.percent < 0.5"` -> a guard.
 *
 * Written as one string because that is how a person thinks about a condition,
 * but validated field by field: an unknown field or operator is *dropped and
 * reported*, never silently accepted. A guard that quietly never matches is a
 * rule that quietly never fires, which is the failure mode of a stringly-typed
 * DSL.
 */
export function parseGuard(text: string): Guard | null {
  const match = /^\s*([\w.]+)\s*(<=|>=|==|!=|<|>)\s*(.+?)\s*$/.exec(text);
  if (!match) return null;

  const field = match[1] as GuardField;
  const op = match[2] as Comparison;
  if (!GUARD_FIELDS.includes(field)) return null;
  if (!COMPARISONS.includes(op)) return null;

  /*
   * Surrounding quotes are stripped.
   *
   * A guard is one string in the options file — `- target == 'orc rogue'` — so
   * YAML hands the inner quotes straight through. Without this, that guard
   * compares against the four-quote-and-space *literal* and can never match,
   * and there is no way at all to name anything with a space in it.
   */
  let raw = match[3] ?? '';
  const quoted = /^(['"])(.*)\1$/.exec(raw);
  if (quoted) raw = quoted[2] ?? '';

  let value: number | string | boolean = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  // Quoted digits stay a string: `target == '1'` is a name, not a number.
  else if (!quoted && raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);

  return { field, op, value };
}

function parseTrigger(value: unknown): Trigger | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();

  if (text === 'state') return { kind: 'state' };
  if (text === 'mid-round') return { kind: 'mid-round' };

  const timer = /^every\s+(\d+)(ms|s)?$/.exec(text);
  if (timer) {
    const amount = Number(timer[1]);
    return { kind: 'timer', everyMs: timer[2] === 'ms' ? amount : amount * 1000 };
  }

  // Anything else is a block type. Not checked against the vocabulary here:
  // `shared/config.ts` must stay free of the parser, and a rule naming a block
  // that never occurs simply never fires, which is visible in the trace.
  return { kind: 'block', type: text };
}

function parseAction(value: unknown): RuleAction | null {
  if (typeof value === 'string') {
    return value.trim() ? { command: value.trim(), priority: 'combat' } : null;
  }
  if (!isRecord(value)) return null;

  const command = str(value['command'], '');
  if (command.length === 0) return null;

  const priority = PRIORITIES.includes(value['priority'] as RuleAction['priority'])
    ? (value['priority'] as RuleAction['priority'])
    : 'combat';

  const action: RuleAction = { command, priority };
  const coalesce = str(value['coalesce'], '');
  if (coalesce) action.coalesce = coalesce;
  if (value['expiresMs'] !== undefined) {
    action.expiresMs = int(value['expiresMs'], 5000, 100, 600_000);
  }
  return action;
}

/**
 * Coerces the `rules:` list.
 *
 * A malformed rule is dropped rather than defaulted: a half-understood rule
 * that fires is far worse than one that does not exist, because it acts on the
 * character's behalf.
 */
export function normalizeRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];

  const rules: Rule[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) continue;

    const name = str(entry['name'], `rule ${index + 1}`);
    if (seen.has(name.toLowerCase())) continue;

    const when = parseTrigger(entry['when']);
    if (!when) continue;

    const rawThen = Array.isArray(entry['then']) ? entry['then'] : [entry['then']];
    const then = rawThen.map(parseAction).filter((action): action is RuleAction => action !== null);
    if (then.length === 0) continue;

    const rawIf = Array.isArray(entry['if']) ? entry['if'] : entry['if'] ? [entry['if']] : [];
    const guards = rawIf
      .map((guard) => (typeof guard === 'string' ? parseGuard(guard) : null))
      .filter((guard): guard is Guard => guard !== null);
    // A guard that failed to parse is dropped, and dropping a guard *widens*
    // the rule. Refuse the whole rule instead.
    if (guards.length !== rawIf.length) continue;

    seen.add(name.toLowerCase());
    rules.push({
      name,
      enabled: bool(entry['enabled'], true),
      when,
      if: guards,
      then,
      cooldownMs: int(entry['cooldownMs'], 1000, 0, 3_600_000)
    });
  }

  return rules;
}

function normalizeAutomation(value: unknown): AutomationConfig {
  const raw = isRecord(value) ? value : {};
  const idle = isRecord(raw['idle']) ? raw['idle'] : {};
  const pacing = isRecord(raw['pacing']) ? raw['pacing'] : {};
  const walk = isRecord(raw['walk']) ? raw['walk'] : {};
  const d = DEFAULT_CONFIG.automation;

  return {
    enabled: bool(raw['enabled'], d.enabled),
    rules: normalizeRules(raw['rules']),
    onEnterRealm: stringList(raw['onEnterRealm'], d.onEnterRealm),
    // Trimmed rather than defaulted when empty: `onPartyChange: ''` is somebody
    // saying "never ask", which is a legitimate answer.
    onPartyChange:
      typeof raw['onPartyChange'] === 'string' ? raw['onPartyChange'].trim() : d.onPartyChange,
    idle: {
      enabled: bool(idle['enabled'], d.idle.enabled),
      afterSeconds: int(idle['afterSeconds'], d.idle.afterSeconds, 5, 3600),
      command: str(idle['command'], d.idle.command)
    },
    pacing: {
      // Capped at 10 against a measured cliff of ~20. A config cannot opt into
      // silently losing commands.
      window: int(pacing['window'], d.pacing.window, 1, 10),
      minGapMs: int(pacing['minGapMs'], d.pacing.minGapMs, 0, 10_000),
      ackTimeoutMs: int(pacing['ackTimeoutMs'], d.pacing.ackTimeoutMs, 250, 30_000)
    },
    walk: {
      // Floored at a second: anything shorter abandons steps the server was
      // about to answer, which looks exactly like a broken route.
      stepTimeoutMs: int(walk['stepTimeoutMs'], d.walk.stepTimeoutMs, 1000, 120_000),
      // Zero is meaningful: keep it until something else happens.
      clearAfterSeconds: int(walk['clearAfterSeconds'], d.walk.clearAfterSeconds, 0, 3600)
    },
    safety: normalizeSafety(raw['safety']),
    combat: normalizeCombat(raw['combat']),
    party: normalizeParty(raw['party']),
    health: normalizeHealth(raw['health']),
    loot: normalizeLoot(raw['loot']),
    drop: normalizeDrop(raw['drop']),
    search: normalizeSearch(raw['search']),
    banking: normalizeBanking(raw['banking']),
    supplies: normalizeSupplies(raw['supplies']),
    remotes: normalizeRemotes(raw['remotes'], d.remotes),
    talk: {
      lookAtPlayers: bool(
        isRecord(raw['talk']) ? raw['talk']['lookAtPlayers'] : undefined,
        d.talk.lookAtPlayers
      )
    },
    loops: asLoops(raw['loops']),
    events: asEvents(raw['events']),
    movement: normalizeMovement(raw['movement']),
    spells: normalizeSpells(raw['spells'])
  };
}

/**
 * Resting and meditating: two floors to go down at, and nothing to come up for.
 *
 * There were four numbers here until 2026-08-27, and the two that said when to
 * stand up are gone with the command that did it — see `HealthConfig`. A file
 * still carrying `restUntil` loads fine and the key is dropped from it on the
 * next launch (`Migration.dropStandUpThresholds`); unknown keys have never been
 * an error here, and one left behind would be a setting the screen cannot show.
 * `restTo` (2026-09-02) is a *ceiling on sitting down*, not the stand-up
 * threshold under another name — `HealthConfig` says why they are opposites.
 *
 * `loopPauseBelow` and `loopResumeAt` went the same way later the same day,
 * folded into this pair rather than dropped: a loop holds still at `restBelow`
 * and walks on again at `restTo`. `Migration.restIsOnePair` carries a stated
 * figure across and takes the retired keys out of the user's own files, so
 * a file that set them keeps the numbers it chose.
 */
function normalizeHealth(value: unknown): HealthConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.health;
  const restBelow = fraction(raw['restBelow'], d.restBelow);
  return {
    restBelow,
    /*
     * Clamped up to `restBelow` rather than accepted as stated, exactly as
     * `healTo` is: a `to` under the `below` asks the client to sit down at 50%
     * and stand up at 40%. 0 stays 0 — that is the single sit-down, not a
     * lower bound.
     */
    restTo: (() => {
      const to = fraction(raw['restTo'], d.restTo);
      return to === 0 ? 0 : Math.max(to, restBelow);
    })(),
    meditateBelow: fraction(raw['meditateBelow'], d.meditateBelow),
    drinkHealingPotionBelow: fraction(raw['drinkHealingPotionBelow'], d.drinkHealingPotionBelow),
    drinkManaPotionBelow: fraction(raw['drinkManaPotionBelow'], d.drinkManaPotionBelow),
    potionVerb: oneOf<PotionVerb>(raw['potionVerb'], POTION_VERBS, d.potionVerb),
    healingPotionName: str(raw['healingPotionName'], d.healingPotionName).trim(),
    manaPotionName: str(raw['manaPotionName'], d.manaPotionName).trim()
  };
}

/**
 * The gate half of `RemotesConfig`.
 *
 * **Both halves of the union move together.** `REMOTE_NAMES` is the runtime
 * list and `RemoteName` is the type; a remote spelled in an options file that
 * is not in the list is dropped here rather than reaching `judgeRemote` as a
 * string nothing matches — which is the failure mode `guard-fields.test.ts`
 * exists for, and `remotes-access.test.ts` asserts the same way for these.
 *
 * A misspelled remote is **dropped, not defaulted to**, and that direction is
 * deliberate: falling back to the shipped default would silently *widen* who
 * can drive this character, and a typo must never be the thing that lets
 * somebody in. Dropping narrows, which is the safe direction for a permission.
 *
 * The player keys are lower-cased here, once, so `Soul:` and `soul:` in the
 * same file are one person rather than two grants that each look configured
 * and only one of which is ever consulted. Where they collide the *deny* lists
 * union and so do the allows, then deny wins at judgement — narrowing again.
 */
function normalizeRemotes(value: unknown, d: RemotesConfig): RemotesConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: bool(raw['enabled'], d.enabled),
    gangpath: bool(raw['gangpath'], d.gangpath),
    gang: remoteNames(raw['gang'], d.gang),
    party: remoteNames(raw['party'], d.party),
    players: playerGrants(raw['players'], d.players)
  };
}

/** Accepts a YAML list or a single word, like every other list in this file. */
function remoteNames(value: unknown, fallback: RemoteName[]): RemoteName[] {
  if (value === undefined) return fallback;
  const words = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (words === null) return fallback;
  const names = words
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter(isRemoteName);
  // Deduplicated: a remote stated twice is one remote, and the set is what is read.
  return [...new Set(names)];
}

function playerGrants(
  value: unknown,
  fallback: Record<string, RemoteGrant>
): Record<string, RemoteGrant> {
  if (value === undefined) return fallback;
  if (!isRecord(value)) return {};
  const out: Record<string, RemoteGrant> = {};
  for (const [name, grant] of Object.entries(value)) {
    const key = name.trim().toLowerCase();
    if (key.length === 0 || !isRecord(grant)) continue;
    const held = out[key] ?? { allow: [], deny: [] };
    out[key] = {
      allow: [...new Set([...held.allow, ...remoteNames(grant['allow'], [])])],
      deny: [...new Set([...held.deny, ...remoteNames(grant['deny'], [])])]
    };
  }
  return out;
}

function normalizeLoot(value: unknown): LootConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.loot;
  const items = Array.isArray(raw['items'])
    ? raw['items']
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : d.items;
  /*
   * An unrecognised denomination is dropped rather than defaulting the list:
   * a typo that silently meant "all five" would be a setting that reads as
   * broken, and one that silently meant "none" would stop the looting.
   */
  const coinKinds = Array.isArray(raw['coinKinds'])
    ? DENOMINATIONS.filter((name) => (raw['coinKinds'] as unknown[]).includes(name))
    : d.coinKinds;
  return {
    coins: bool(raw['coins'], d.coins),
    coinKinds,
    stopAtGrade: gate(raw['stopAtGrade'], d.stopAtGrade),
    convertWith: str(raw['convertWith'], d.convertWith).trim(),
    convertAt: gate(raw['convertAt'], d.convertAt),
    items,
    // Capped well above any price the shipped realm states, so a typo cannot
    // make the field mean "never", and floored at 0, which is what off means.
    minPrice: int(raw['minPrice'], d.minPrice, 0, 100_000_000),
    maxEncumbrance: int(raw['maxEncumbrance'], d.maxEncumbrance, 0, 1_000_000)
  };
}

/** A closed union, so an unrecognised word is the safe answer rather than passed through. */
const GATES: readonly EncumbranceGate[] = ['never', 'medium', 'heavy'];

function gate(value: unknown, fallback: EncumbranceGate): EncumbranceGate {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return GATES.find((known) => known === word) ?? fallback;
}

function normalizeDrop(value: unknown): DropConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.drop;
  const items = Array.isArray(raw['items'])
    ? raw['items']
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : d.items;
  return {
    enabled: bool(raw['enabled'], d.enabled),
    items,
    whenEncumbered: bool(raw['whenEncumbered'], d.whenEncumbered),
    worthless: bool(raw['worthless'], d.worthless)
  };
}

/**
 * Auto-search. One search a room by default, and a ceiling on the count.
 *
 * Floored at one rather than zero: `enabled` is what turns it off, and a
 * configuration reading "on, zero searches" is a switch somebody flips and then
 * waits to see work. Capped because each try is a command out of the same
 * budget the fighting is done from, and a room is not worth ten of them.
 */
function normalizeSearch(value: unknown): SearchConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.search;
  return {
    enabled: bool(raw['enabled'], d.enabled),
    tries: int(raw['tries'], d.tries, 1, 5)
  };
}

function normalizeBanking(value: unknown): BankingConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.banking;
  return {
    autoDeposit: bool(raw['autoDeposit'], d.autoDeposit),
    depositThresholdCopper: int(
      raw['depositThresholdCopper'],
      d.depositThresholdCopper,
      0,
      1_000_000_000
    ),
    keepCopper: int(raw['keepCopper'], d.keepCopper, 0, 1_000_000_000)
  };
}

function normalizeMovement(value: unknown): MovementConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.movement;
  return {
    openDoors: bool(raw['openDoors'], d.openDoors),
    // Capped low: a door that did not open on the third try is locked, and
    // every further attempt is a command spent to be told so again.
    openTries: int(raw['openTries'], d.openTries, 0, 3),
    /*
     * Forcing is capped higher than opening, because unlike `open` it is a
     * roll rather than an answer: `captures/002` shows three `pi w` before the
     * lock gave, and `captures/005` two `bas n`. A door that will not open is
     * telling you something; a pick that failed is telling you nothing.
     *
     * Still bounded — each attempt is a command out of the same budget the
     * fight in the next room will be fought with, and a bash is paid for in
     * health as well.
     */
    bashDoors: bool(raw['bashDoors'], d.bashDoors),
    bashTries: int(raw['bashTries'], d.bashTries, 0, 10),
    pickLocks: bool(raw['pickLocks'], d.pickLocks),
    pickTries: int(raw['pickTries'], d.pickTries, 0, 10),
    sneak: bool(raw['sneak'], d.sneak),
    provideLight: bool(raw['provideLight'], d.provideLight),
    lightDimRooms: bool(raw['lightDimRooms'], d.lightDimRooms),
    extinguishInLight: bool(raw['extinguishInLight'], d.extinguishInLight)
  };
}

/**
 * The supplies list, bounded because it crossed a file somebody edits by hand.
 *
 * A row with no name is dropped rather than defaulted, as a buff with no name
 * is. `min` and `max` are whole counts; a `max` below `min` reads as `min`, so
 * "keep at least three" with no ceiling stated buys back to three. `shop` is
 * the shop's name as the realm's item index spells it and `at` the room the
 * name was settled to, kept beside it for the reason a loop stop carries
 * coordinates: six rooms are called General Store.
 */
function normalizeSupplies(value: unknown): SuppliesConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.supplies;
  const items: SupplyItem[] = [];
  if (Array.isArray(raw['items'])) {
    for (const entry of raw['items']) {
      if (!isRecord(entry)) continue;
      const name = str(entry['name'], '').trim();
      if (name.length === 0) continue;
      const min = int(entry['min'], 0, 0, 1000);
      const max = Math.max(min, int(entry['max'], 0, 0, 1000));
      const shop = str(entry['shop'], '').trim();
      const at = isRecord(entry['at']) ? entry['at'] : null;
      const map = at === null ? null : int(at['map'], -1, 0, 999);
      const room = at === null ? null : int(at['room'], -1, 0, 999_999);
      items.push({
        name,
        min,
        max,
        shop,
        at: map !== null && room !== null && map >= 0 && room >= 0 ? { map, room } : null
      });
    }
  }
  return { enabled: bool(raw['enabled'], d.enabled), items };
}

function normalizeSpells(value: unknown): SpellsConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.spells;
  return {
    /*
     * The whole name, unlike a command word: `c ice blade` is two words after
     * the verb and splitting it would cast `ice` — or, since the server matches
     * on a prefix, whatever spell happens to begin with it.
     */
    attack: str(raw['attack'], d.attack).trim(),
    areaAttack: str(raw['areaAttack'], d.areaAttack).trim(),
    areaMinMobs: int(raw['areaMinMobs'], d.areaMinMobs, 1, 99),
    areaMinMana: fraction(raw['areaMinMana'], d.areaMinMana),
    heal: str(raw['heal'], d.heal).trim(),
    healPartyWith: str(raw['healPartyWith'], d.healPartyWith).trim(),
    healBelow: fraction(raw['healBelow'], d.healBelow),
    healBelowInCombat: fraction(raw['healBelowInCombat'], d.healBelowInCombat),
    /*
     * Clamped up to `healBelow` rather than accepted as stated: a `to` under
     * the `below` asks the client to start at 50% and stop at 40%, which is
     * two opposite instructions about the same number. 0 stays 0 — that is
     * the single-cast answer, not a lower bound.
     */
    healTo: (() => {
      const to = fraction(raw['healTo'], d.healTo);
      const below = fraction(raw['healBelow'], d.healBelow);
      return to === 0 ? 0 : Math.max(to, below);
    })(),
    healParty: bool(raw['healParty'], d.healParty),
    minMana: fraction(raw['minMana'], d.minMana),
    cures: normalizeCures(raw['cures']),
    blessings: normalizeBlessings(raw['blessings']),
    notifyPartyOnWearOff: bool(raw['notifyPartyOnWearOff'], d.notifyPartyOnWearOff)
  };
}

function normalizeCures(value: unknown): SpellsConfig['cures'] {
  const raw = isRecord(value) ? value : {};
  return {
    blindness: str(raw['blindness'], '').trim(),
    poison: str(raw['poison'], '').trim(),
    disease: str(raw['disease'], '').trim()
  };
}

/** The floor on a blessing's fallback clock: a typo must not cast every tick. */
export const BLESSING_FALLBACK_MIN_S = 30;
/** More blessings than this is a list nobody typed. */
const MAX_BLESSINGS = 16;

function normalizeParty(value: unknown): PartyConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.party;
  return {
    assistLeader: bool(raw['assistLeader'], d.assistLeader),
    defendParty: bool(raw['defendParty'], d.defendParty),
    restWithLeader: bool(raw['restWithLeader'], d.restWithLeader)
  };
}

/**
 * A blessing without a spell is dropped rather than defaulted: the spell is
 * both what is sent and the key the row is coalesced and remembered by, and
 * it has no value that means anything when absent. Two rows naming one spell
 * **and one target** are one row — the first wins, since the order is the
 * priority. The same spell on `self` and on `party` is two legitimate rows:
 * they recast on different mechanisms (the wear-off frame against the
 * member's clock), and folding them would silently drop whichever was typed
 * second. `inCombat` defaults by target — a self-shield mid-fight is the
 * point, a cast on somebody else's round is a command the fight paid for —
 * and the fallback clock exists only on party rows: a self row's watchdog is
 * measured, not configured.
 */
export function normalizeBlessings(value: unknown): BlessingConfig[] {
  if (!Array.isArray(value)) return [];
  const blessings: BlessingConfig[] = [];
  for (const entry of value) {
    if (blessings.length >= MAX_BLESSINGS) break;
    if (!isRecord(entry)) continue;
    const spell = str(entry['spell'], '').trim();
    if (spell.length === 0) continue;
    const target: BlessingTarget = entry['target'] === 'party' ? 'party' : 'self';
    if (
      blessings.some(
        (row) => row.spell.toLowerCase() === spell.toLowerCase() && row.target === target
      )
    )
      continue;
    blessings.push({
      spell,
      target,
      minMana: fraction(entry['minMana'], 0),
      prioritizeOverHeal: bool(entry['prioritizeOverHeal'], false),
      inCombat: bool(entry['inCombat'], target === 'self'),
      ...(target === 'party'
        ? { fallbackSeconds: int(entry['fallbackSeconds'], 300, BLESSING_FALLBACK_MIN_S, 86_400) }
        : {})
    });
  }
  return blessings;
}

/**
 * Fighting on the character's behalf.
 *
 * Every field is coerced towards *doing less*, which is the direction a
 * misread value has to fail in here: a command list that turns into nonsense
 * must produce a client that swings less often, never one that swings at
 * something it was told to leave alone.
 */
function normalizeCombat(value: unknown): CombatConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.combat;
  const engage = String(raw['engage'] ?? d.engage);
  return {
    enabled: bool(raw['enabled'], d.enabled),
    // A blank attack verb would send a bare newline at everything in the room,
    // which on this server re-reads the room; the default is put back instead.
    attack: str(raw['attack'], d.attack).split(/\s+/)[0] ?? d.attack,
    // Blank is meaningful here and means "no opener", so it is *not* defaulted.
    opener: typeof raw['opener'] === 'string' ? raw['opener'].trim().split(/\s+/)[0] || '' : '',
    engage: ENGAGE_POLICIES.includes(engage as EngagePolicy) ? (engage as EngagePolicy) : d.engage,
    retaliate: bool(raw['retaliate'], d.retaliate),
    // Capped where the retreat guard is, for the same reason: a room holding more
    // than twenty things is not a number anybody is tuning against.
    maxMobs: int(raw['maxMobs'], d.maxMobs, 0, 20),
    minHealth: fraction(raw['minHealth'], d.minHealth),
    whileWalking: bool(raw['whileWalking'], d.whileWalking),
    // Capped low on purpose: every round is a fraction of a second, so a client
    // asked to look every round would spend most of a fight looking.
    refreshRounds: int(raw['refreshRounds'], d.refreshRounds, 0, 20),
    avoid: mobNames(raw['avoid']),
    avoidUndead: bool(raw['avoidUndead'], d.avoidUndead),
    minMobs: int(raw['minMobs'], d.minMobs, 0, 99),
    maxMonsterExperience: int(raw['maxMonsterExperience'], d.maxMonsterExperience, 0, 100_000_000),
    avoidDeathSpell: bool(raw['avoidDeathSpell'], d.avoidDeathSpell),
    // Capped far above any health the shipped realm states, so a typo cannot
    // silently mean "never fight anything".
    maxTargetHealth: int(raw['maxTargetHealth'], d.maxTargetHealth, 0, 1_000_000),
    prefer: mobNames(raw['prefer'])
  };
}

/**
 * Monster names, keyed the way the wire spells them.
 *
 * Normalised here rather than at every comparison, so `Giant Rat`, `giant rat`
 * and `the giant rat` in a config file are one entry and match the one thing
 * the stream ever calls it. Bounded, because a list this long is a rule file
 * written in the wrong place.
 */
function mobNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const name = mobKey(String(entry));
    if (name.length > 0) seen.add(name);
    if (seen.size >= 64) break;
  }
  return [...seen];
}

function normalizeSafety(value: unknown): SafetyConfig {
  const raw = isRecord(value) ? value : {};
  const hangUp = isRecord(raw['hangUp']) ? raw['hangUp'] : {};
  const retreat = isRecord(raw['retreat']) ? raw['retreat'] : {};
  const pvp = isRecord(raw['pvp']) ? raw['pvp'] : {};
  const f = DEFAULT_CONFIG.automation.safety.retreat;
  const d = DEFAULT_CONFIG.automation.safety.hangUp;
  const p = DEFAULT_CONFIG.automation.safety.pvp;
  return {
    retreat: {
      enabled: bool(retreat['enabled'], f.enabled),
      belowHealth: fraction(retreat['belowHealth'], f.belowHealth),
      // Zero is meaningful: never run merely because there are several.
      whenOutnumbered: int(retreat['whenOutnumbered'], f.whenOutnumbered, 0, 20),
      // Floored at a second. Anything shorter retries before the server has
      // had a chance to answer the first attempt.
      cooldownMs: int(retreat['cooldownMs'], f.cooldownMs, 1000, 60_000),
      strategy: oneOf<RetreatStrategy>(retreat['strategy'], RETREAT_STRATEGIES, f.strategy),
      safeHavenRoom: str(retreat['safeHavenRoom'], f.safeHavenRoom).trim()
    },
    hangUp: {
      enabled: bool(hangUp['enabled'], d.enabled),
      belowHealth: fraction(hangUp['belowHealth'], d.belowHealth),
      /*
       * Defaults to *true* whatever the file says is missing, and that
       * asymmetry is deliberate: every other boolean here defaults to the
       * cautious value because caution is cheap, and this one defaults to the
       * cautious value because the alternative can cost a character.
       */
      onlyWhenClean: bool(hangUp['onlyWhenClean'], d.onlyWhenClean),
      onPlayerInRoom: bool(hangUp['onPlayerInRoom'], d.onPlayerInRoom)
    },
    pvp: {
      notifyGang: bool(pvp['notifyGang'], p.notifyGang),
      action: oneOf<PvpAction>(pvp['action'], PVP_ACTIONS, p.action)
    }
  };
}

function normalizeLogging(value: unknown): LoggingConfig {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: bool(raw['enabled'], DEFAULT_CONFIG.logging.enabled),
    fights: bool(raw['fights'], DEFAULT_CONFIG.logging.fights),
    capture: bool(raw['capture'], DEFAULT_CONFIG.logging.capture),
    conversations: bool(raw['conversations'], DEFAULT_CONFIG.logging.conversations),
    // Floor of one day: zero would be a log that erases itself on every
    // launch, which is `conversations: false` wearing a number.
    conversationDays: int(
      raw['conversationDays'],
      DEFAULT_CONFIG.logging.conversationDays,
      1,
      36500
    ),
    directory: str(raw['directory'], DEFAULT_CONFIG.logging.directory),
    // Floor of 64 KiB: a cap smaller than one screenful of combat is a
    // misconfiguration rather than a preference.
    maxBytes: int(raw['maxBytes'], DEFAULT_CONFIG.logging.maxBytes, 64 * 1024, 4 * 1024 ** 3)
  };
}

/**
 * The health a held journey walks on again at.
 *
 * One statement of it, because **two things travel** — a loop between its
 * stops and a plain route the player asked for — and both stop for the same
 * pair of thresholds. Two copies of this arithmetic in two files is the shape
 * `AutoCombat.quarry` was pulled together to stop: they agree until one of
 * them is edited.
 *
 * `restTo` is the ceiling where the player set one. Where they did not, `0`
 * means *the single sit-down* to `Recovery` — and read literally by something
 * that travels it is a **zero-width band**: the journey resumes at exactly the
 * health it stopped at, the next blow puts it back, at status-line cadence.
 * So an uncapped rest resumes a margin above the floor instead. Absolute
 * rather than proportional, because a proportional margin vanishes under a low
 * floor, which is the character that most needs the gap; clamped to 1 so a
 * floor at 95% still lets the journey go again.
 *
 * The margin is passed in rather than read here: `src/shared/` is
 * dependency-free by rule, so nothing in it can reach `tuning()`.
 */
export function resumeAtHealth(health: HealthConfig, marginWhenUncapped: number): number {
  if (health.restTo > 0) return health.restTo;
  return Math.min(1, health.restBelow + marginWhenUncapped);
}

/** The connection target implied by the config, for the command strip. */
export function targetFromConfig(config: AppConfig): ConnectionTarget {
  return {
    host: config.connection.host,
    port: config.connection.port,
    encoding: config.connection.encoding
  };
}
