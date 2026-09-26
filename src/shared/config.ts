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
import { GEAR_WHENS, type GearSet, type GearWhen } from './gear';
import { asLoops, mergeNamed, type Loop } from './loops';
import { asLocateWord, DEFAULT_LOCATE, type LocateWord } from './locate';
/*
 * `DENOMINATIONS` is the one *value* this module takes from `character.ts`, and
 * it is safe: nothing under `character.ts` imports `config.ts` back, so the
 * edge is one-way and the module-cycle rule is untouched. See
 * `src/shared/__tests__/module-cycle.test.ts`.
 */
import { DENOMINATIONS, type Denomination, type VitalThresholds } from './character';
import {
  DEFAULT_CONSOLE_PALETTE,
  DEFAULT_THEME,
  isConsolePalette,
  isDarkTheme,
  isThemePreference,
  type ConsolePalette,
  type ThemeId,
  type ThemePreference
} from './themes';
import type { Comparison, Guard, GuardField, Rule, RuleAction, Trigger } from './rules';
import {
  ALERT_SIDES,
  DEFAULT_ALERT_DEBOUNCE_SECONDS,
  isAlertEvent,
  SEVERITIES,
  STARTER_ALERTS,
  type AlertRule,
  type Severity
} from './notifications';
import { isRemoteName, type RemoteGrant, type RemoteName } from './remotes';
import type { ConnectionTarget, StreamEncoding } from './types';
import { normalizeMobRules, type MobRule } from './mobRules';
// A value import, and safe: `commands.ts` imports nothing from `shared/`, so
// there is no cycle for a bundler to resolve the wrong way round.
import { REREAD_ROOM } from './commands';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from './training';
import { isAnsiColour, type ColourBand } from './template';
import { DEFAULT_REWRITES, isRewriteEntity, type RewriteDesign, type VitalBands } from './rewrites';

/** Chrome density, as `ui.density` states it and the palette cycles it. */
export type DensityPreference = 'auto' | 'comfortable' | 'compact';
/** What `useDensity` resolves `auto` to for the window it measures. */
export type Density = Exclude<DensityPreference, 'auto'>;

/**
 * Which edge the character tabs sit on.
 *
 * `left` and `right` are the same rail mirrored, and the mirror takes the card
 * rail with it: whichever side the tabs are on, the cards are on the other. It
 * is one setting rather than two because the two side rails cannot share an
 * edge — a client that let both be asked for on the left would have to pick a
 * winner, and the pick would be arbitrary.
 */
export type TabsPreference = 'top' | 'left' | 'right';

/** One realm-specific prompt the block vocabulary does not cover. */
export interface LoginStep {
  /** Substring of the prompt line. */
  when: string;
  /** What to send. May be empty, for a bare Enter. */
  send: string;
  /**
   * Whether this row answers its prompt every time it arrives.
   *
   * Off by default, because *once per connection* is what a menu wants: a menu
   * that comes back means the answer was refused, and answering again loops.
   *
   * A **pager** is the other kind of prompt, and the rule above reads it
   * wrongly. `(N)onstop, (Q)uit, or (C)ontinue?` is asked once per screenful,
   * so a BBS printing three screens asks three times and every answer works;
   * `Q` stopped the pager the first time and the sequence then sat at the
   * second one for ever, because the row was spent. The two are not
   * distinguishable from the prompt's own text -- both are a line ending in a
   * question -- so the realm's script is where it is said.
   *
   * **Never on a row that sends a credential.** The account's *once per
   * connection* is what stops an automated client retrying a password into a
   * lockout, and it is keyed on the credential rather than on the row for
   * exactly that reason. `LoginAutomator` ignores this flag there.
   */
  repeat?: boolean;
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
   * The world every character on this realm walks: empty, a bundled world's
   * name, or a path to a realm database — `.mdb`, `.accdb`, `.sqlite` or
   * `.db`, or a `.zip` holding exactly one of those, which is how a realm is
   * distributed and how this repository keeps its own.
   *
   * **On the realm, because that is what it is a property of.** Two characters
   * on one realm cannot be playing two different maps. It used to be stated
   * per character (`world.database`), which was the same answer written out
   * once per character and as many places for it to drift.
   *
   * **Empty follows the realm's own word.** The client ships two worlds —
   * stock MajorMUD v1.11p and Paradigm's — and a realm says which it runs at
   * its menu (`[MAJORMUD]:`, `[PARADIGM]:`); what it said is remembered by
   * address and used from the next session, and until it has said, the
   * default world is walked, announced (`shared/worlds.ts`, `RealmLibrary`).
   * `majormud` or `paradigm` pins one. A file is for a realm whose rooms
   * differ from both: **converted once** into the same normalised form the
   * bundled worlds have, and cached; never queried while anything is being
   * played (docs/legacy-assessment.md §5 consequence 4). A file that is the
   * very archive a bundled world was built from is that world.
   */
  database: string;
  /**
   * The realm's own rules for its monsters, merged under every character's.
   *
   * **On the realm, because a monster is.** A rule names a monster by the name
   * this realm's data spells it, so a list written for one realm means nothing
   * on another — and every character playing here wants the same answer to
   * *which of these do I leave alone, and which first*. Stating it per
   * character would be the same list written out once per character, which is
   * what `login` and `database` above are on the realm to avoid.
   *
   * Merged rather than replaced: see `mergeMobRules`. A character's own row
   * for a monster wins, and a monster only the realm names still counts.
   */
  mobRules: MobRule[];
  /**
   * Whether a hang-up here is charged, for every character playing here that
   * does not say for itself; null leaves it to the options file. See
   * `HangUpConfig.penalties`.
   */
  hangPenalties: boolean | null;
  /**
   * How this realm is asked where a character stands: `rm`, or `none` for a
   * realm with no such word. A character may state its own. See `shared/locate.ts`.
   */
  locate: LocateWord;
  /**
   * This realm's teleport for the last-ditch escape, literally (`sys go 1
   * 297`); empty states none. A character's own replaces it. See `FleeGotoConfig`.
   */
  fleeGoto: string;
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

/**
 * The console's own ground, when the chrome's is not the one it wants.
 *
 * A light theme is a legitimate thing to want for the *chrome* — a rail of
 * cards, a settings form and a table read well on paper. The console is not
 * that. What it shows is forty years of ANSI art drawn against black: a light
 * palette has to make colour 0 *be* the paper (see `TerminalPalette`), which
 * means every `ESC[30m` the realm sends comes back as the page, and a room
 * description written in dark grey on black arrives as dark grey on white.
 * "The terminal is not a design surface" is the rule this serves; this is the
 * setting that lets somebody keep it that way while everything around it is
 * light.
 *
 * `palette` is the third question and the one that outranks both: which of the
 * seven console palettes the player named outright (`TERMINAL_THEMES`).
 * `theme`, the default, means they named none and the two keys below decide.
 *
 * Two keys rather than one for the rest, because they answer two questions.
 * `keepDark` is
 * *whether* the console parts company with the chrome, and it only ever applies
 * under a light theme — under a dark one there is nothing to part from and the
 * console wears the theme's own palette, which is the whole reason the editor
 * themes ship a palette each. `darkTheme` is *which* dark palette it wears when
 * it does, and it always has an answer, so switching `keepDark` on can never
 * land on nothing.
 */
export interface ConsoleUiConfig {
  /**
   * Which sixteen the console paints the realm's colour codes with.
   *
   * `theme` is the shipped answer and changes nothing: the console wears the
   * palette of the theme it resolved to, `keepDark` included. Naming one of
   * `TERMINAL_THEMES` states the console's colours outright and wins over both
   * keys below — a player who picked a palette is not in the situation
   * `keepDark` exists to answer.
   */
  palette: ConsolePalette;
  /**
   * Keep the console dark while the rest of the client is light.
   *
   * On by default, which is the one direction this can be wrong cheaply: the
   * console under a light theme is the complaint, and somebody who genuinely
   * wants a light console turns this off and gets exactly the behaviour that
   * was here before. A dark theme never consults it.
   */
  keepDark: boolean;
  /**
   * Which dark theme's palette the console wears when it parts company.
   *
   * Coerced to a *dark* theme: naming a light one here would be asking to keep
   * the console dark and then handing it a light palette, which is not a
   * preference but a contradiction, and `DEFAULT_THEME` answers it.
   */
  darkTheme: ThemeId;
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
   *
   * `right` is `left` mirrored, and mirrors the whole workspace: the tabs take
   * the right edge and the card rail takes the left. It costs exactly what
   * `left` costs — which side of the console each rail is on is the player's
   * hand and their monitor, not a trade.
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
  /**
   * The client's own mark and version, at the head of the card rail.
   *
   * On by default: this is the one place the client says what it is, and a
   * brand nobody ever sees is the same as none. Off is offered for taste, not
   * room: it shares the band the put-away chip already takes.
   */
  showLogo: boolean;
  /** How the console is painted when the chrome is light. See `ConsoleUiConfig`. */
  console: ConsoleUiConfig;
  /** Where the HUD meters turn yellow and red. */
  vitals: VitalsUiConfig;
  /** What reaches the Alerts card. */
  alerts: AlertsUiConfig;
  /**
   * What the console draws in place of what the realm printed: the designs
   * this player keeps, each naming the prompt row or a listing and the
   * template it is drawn by. Presentation only, every shipped one off. See
   * `src/shared/rewrites.ts`.
   */
  rewrites: RewritesUiConfig;
}

/** The designs the console may draw, and the colours a vital wears on every one. */
export interface RewritesUiConfig {
  /** `{hp}` and `{mana}` by their share of maximum, wherever they are drawn. */
  bands: VitalBands;
  /** In order; the first enabled design for an entity is the one that draws it. */
  designs: RewriteDesign[];
}

/**
 * What is worth raising an alert about, for this character.
 *
 * **One list, and it is the only thing that decides** (todo 02, 2026-09-12).
 * A severity floor and a per-channel mute list stood beside the rows until
 * now, and every question they answered — *never tell me about movement*,
 * *only the loud ones* — is a row with `alert` off or a row naming a level.
 * Two vocabularies for one question, on two parts of one page, is how a player
 * comes to believe one of them is broken, which is what happened.
 *
 * The ranking itself is still not configuration: `shared/notifications.ts`
 * decides what a line costs, once, and a row's `level` is the player
 * overruling that for one kind of line rather than a per-character severity
 * table replacing it.
 *
 * Per character rather than per client, like everything in a profile: a healer
 * watching a party wants the party channel and a soloing thief does not.
 */
export interface AlertsUiConfig {
  /**
   * The player's own rows, in order.
   *
   * The first enabled row that claims a notice decides it outright: shown or
   * not, at which level, and whether it also raises a desktop notification.
   * **A notice no row claims is still shown**, at the level the ranking gave
   * it — the list is not an allow list, so a channel the client gains later
   * arrives visible, and a player who has deleted every row sees what the
   * client would have shown them anyway rather than nothing.
   *
   * Shipped with a starter list rather than empty (`STARTER_ALERTS`). Empty was
   * right while the floor and the mute list stood behind it; with those gone,
   * an empty list is a settings page with nothing on it and no way to learn
   * what a row can say.
   */
  rules: AlertRule[];
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
/**
 * Away from keyboard — MegaMUD's `AutoAfk`, `AfkTimeout` and `AfkReply`.
 *
 * The whole point of running a character unattended is that nobody is there,
 * and the one thing the realm's other players cannot see is that. A telepath
 * to a character that never answers reads as rude, or as a bot to report; a
 * reply saying the player is away is what a person would leave. `Afk`
 * (`src/main/automation/Afk.ts`) answers an incoming telepath with `reply`
 * once nothing has been typed into this session for `afterMinutes`, once per
 * sender per `tuning.afk.replyEveryMs`, and never for an `@` command, which
 * `Remotes` answers. Off by default, unlike MegaMUD's (`AutoAfk=1`,
 * `AfkTimeout=5`, `AfkReply={AFK}`): a client that telepaths strangers unasked
 * is a behaviour to opt into. The reply defaults to MegaMUD's own frame, which
 * other MegaMUD clients recognise.
 */
export interface AfkConfig {
  enabled: boolean;
  /** Minutes without a keystroke into this session before the player is away. */
  afterMinutes: number;
  /** What an incoming telepath is answered with while away. Blank answers nothing. */
  reply: string;
}

export interface WalkConfig {
  stepTimeoutMs: number;
  /**
   * Experience per hour below which a running loop is stopped — MegaMUD's
   * `MinExpRate` with `LogoffLowExp`, both `0` (off) in its own defaults and
   * off here. A lap that has stopped working — the lair empty tonight, a door
   * shut, a monster that no longer dies — looks exactly like a lap that is
   * working, for as long as nobody is watching, which for a character grinding
   * unattended is all night. The rate is measured over the lap since it
   * started (or resumed, or came back online) and judged only after
   * `tuning.loop.expRateGraceMs`, because the first minutes of any lap are
   * walking to the first lair. Stopped out loud with the two figures, and the
   * tab reads `stopped`; MegaMUD logs off, which this client does not do on
   * its own (`automation.safety.hangUp` says why). 0 never stops.
   */
  minExpPerHour: number;
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
   * Whether this realm charges for a hang-up at all (todo 01).
   *
   * Where it does, hanging up is refused while the client can see a reason it
   * would be charged; where it does not, it hangs up below `belowHealth`.
   * **Off by default**: a PvE realm charges nothing. Paradigm's realm menu
   * states it (`Hang Penalties 25%`), and what it said outranks this; a
   * realm's own `server.yaml` (`hangPenalties`) outranks the options file,
   * and a character's own file outranks its realm.
   */
  penalties: boolean;
  /**
   * Also hang up when a player is in the room, at any health.
   *
   * Off by default. It is the PvP panic button, and it is also the one most
   * likely to fire during the five-minute window, which is where a realm's
   * penalty bites.
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
   * Also run below this fraction of maximum mana — MegaMUD's `ManaRun%`. A
   * caster out of mana is losing whatever the health bar says: its next round
   * lands nothing, and the round after that is the monster's. 0 (MegaMUD's own
   * default) never runs for mana; a class with no pool has a null maximum and
   * is never judged by it, as everywhere.
   */
  belowMana: number;
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
   * Choosing the exit is `Travel.escape`'s ladder and is not
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
 * The last-ditch escape below `retreat` (todo 813): the realm's own teleport,
 * sent mid-fight in the emergency band, written out **literally** because each
 * realm implementation spells it differently — GreaterMUD `sys go 1 297`,
 * MajorMUD `sys goto silvermere` — and it is never derived. The realm's
 * `server.yaml` (`fleeGoto:`) states the command; a character's own `command`
 * replaces it, and this file's is used only where neither states one.
 *
 * Off by default. On GreaterMUD `sys` is a sysop's tool (`SysCommand.cs:196`);
 * a player is answered `Your command had no effect.`, read as a refusal.
 * Never above `retreat.belowHealth` while the retreat is on: the walked escape
 * has the first word. See `FleeGoto`.
 */
export interface FleeGotoConfig {
  enabled: boolean;
  /** Fraction of maximum health at or below which the teleport is sent. */
  belowHealth: number;
  /** The literal command; empty follows the realm, and none anywhere sends nothing. */
  command: string;
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
  /**
   * Get back into the shadows between fights, so the opener lands again.
   *
   * A backstab is granted by `sn` and `hide` alone, both refused while a
   * monster is in the room, and spent by the first blow — so a character
   * hunting in a lair opens every fight after the first in plain sight
   * (measured 2026-09-12: 4.1× the ordinary swing thrown away each time). On,
   * `AutoStealth` sends `hide` when the character is seen in an empty room
   * standing still, and `sn` when a lap or route has it — the walker's own
   * verb, since the step ahead is what the stealth is for. Only for an
   * opener the command table calls `BackStab`; `ju` has nothing to hide for.
   */
  hideForOpener: boolean;
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
   * Lend auto-combat to a character hit for this many rounds without moving,
   * while it is off or the journey declined it. 0 never does.
   *
   * *Off* means do not open fights; it never meant stand there and be killed.
   * `CombatLease` turns the switch on in the character's file and hands it
   * back on the next arrival in another room (todo 00, 2026-09-23).
   */
  defendAfterRounds: number;
  /**
   * Leave alone a monster somebody **outside the party** is already fighting.
   *
   * MegaMUD's *PoliteAttacks*, in MegaMUD's own direction and under its own
   * name (todo 00): on, a monster `combat.claimed` holds (a stranger seen
   * swinging at it within `tuning.combat.assistFreshMs`) is refused with the
   * stranger's name in the trace, because opening on it is stealing a kill and
   * on a PvP realm it is an invitation. A party member's fight is never a
   * claim — joining that is assisting, and has its own switch. Hitting back
   * ignores this, as it ignores every other limit here.
   *
   * Ships off, which is the behaviour this client had before the field
   * existed and MegaMUD's own `PoliteAttacks=0`.
   */
  politeAttacks: boolean;
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
   * How named monsters are treated, one row each — MegaMUD's *Attack Priority
   * List* and its *avoid* list, as one list rather than two.
   *
   * **This replaces the weighing rather than ranking against it.** Where the
   * room holds a listed monster, the band decides and `src/shared/menace.ts`
   * is not consulted: somebody who writes *shamans first* means first, not
   * first unless the arithmetic disagrees, and a ranking that the realm's own
   * numbers could overturn is one nobody can predict from reading it. Within
   * one band the room's own listing order decides, which is the order that
   * was there before any weighing existed.
   *
   * A monster no row names is in `default`, so the list is somewhere to add
   * the one monster that matters and never a ranking of the whole realm.
   * Every refusal — `never`, the evil-point cost, the health and experience
   * caps, the disposition gate — still applies **first**: a band says which of
   * the monsters worth attacking to attack, never that one is worth attacking.
   *
   * **`never` is the one treatment that is not a band.** It is the refusal the
   * flat `avoid` list used to be, moved onto the row so that leaving a monster
   * alone and saying where it comes in the order are one question asked once,
   * in one place, about one monster — and so that it inherits the same
   * narrowest-wins merge the bands do, which a replaced-wholesale list could
   * not give it.
   *
   * Merged across the three scopes by monster, narrowest winning, unlike
   * every other list here — see `mergeMobRules`.
   */
  mobRules: MobRule[];
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
   * The one grant that ships non-empty, and the first two names on it survive
   * the test: **they say nothing the party listing does not already say, and
   * they do nothing to this character.**
   *
   * - `@health` is the absolute figures behind the percentage the listing
   *   already shows — the same fact, to more decimal places, and the one
   *   `automation.spells.healParty` needs to decide whether a cast will cover
   *   the gap.
   * - `@bless-expired` is a member telling this character their blessing ran
   *   out. It sends nothing; what to do about it is `Blessings`' decision,
   *   made against this character's own configuration.
   * - `@heal` (2026-09-19) does do something: one party heal, for a member the
   *   thresholds had not reached. Nothing while `healParty` or `healBelow` is
   *   off; while on, what it adds is that a member — the uninvited follower
   *   below included — can spend this character's mana down to `minMana`, one
   *   cast per `healCooldownMs`, by asking. A `deny` by name takes it back.
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
   * character's own body and one heal bounded by the heal's own limits,
   * rather than the membership test.
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
   * Which denominations to put back on the floor whenever any are carried.
   *
   * The other end of `coinKinds`, and the two are **exclusive**: a
   * denomination on both lists would be picked up and dropped for ever, one
   * command each way. Stated here rather than in `automation.drop` so the rule
   * between them is visible in one block — and enforced by `normalizeLoot`,
   * where a file naming a coin on both loses it from *this* one, because
   * dropping is the destructive reading of an ambiguous file.
   *
   * **A coin on neither list is kept.** That is the third answer the pair
   * exists to express: copper is not worth bending down for and is not worth
   * a command to shed, so the twelve of it already in the purse stay there.
   *
   * Empty by default, and nothing about the shipped configuration ever throws
   * money away. **Not in MegaMUD**, whose cash page collects and converts and
   * never sheds.
   */
  discardKinds: Denomination[];
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
 * `Hidden/Searchable` — and `Router.edgePenalty` already prices one at
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
   * enough, which is also why the walker's own search for a *named* hidden
   * exit is paced rather than counted (`walk.searchRetryMs`). One by default:
   * a room searched three times is three
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
  /**
   * The bank this character banks at — a `Shops` row id, or 0 for *whichever
   * counter it is standing at* (todo 00).
   *
   * The threshold has always fired at any counter the realm grades `bank`,
   * which is right for a character that passes several and wrong for one
   * whose vault is somewhere particular: a balance spread across four vaults
   * is four figures nobody can add up, and the realm states each separately.
   *
   * Keyed by the row, not the shop's name, for `trainersTaking`'s reason: two
   * rows can share a name and be different counters. A row the realm no
   * longer places, or one on another realm, deposits nowhere and says so —
   * never silently at the nearest one instead, which would be the client
   * choosing a vault the player did not.
   *
   * **It does not walk anywhere.** Which bank is the question this answers;
   * going to one is `automation.loops` and the player's own route.
   */
  bank: number;
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
   * Rest next door to a lair rather than in it (todo 08, 2026-09-12).
   *
   * A lair is dangerous for what it is *about* to contain: measured twice, a
   * character sat down at 20% in a room whose clock makes three wererats
   * every twenty seconds and met them at 2%. On, a rest proposed in a room
   * the realm marks as a lair with a clock under `tuning.rest.lairClockMaxSeconds`
   * is refused there, out loud with the figure; a neighbour the realm holds
   * no lair in is peeked (`l <direction>`), entered only if empty, rested in,
   * and stepped back from when nothing else has the character. Where no
   * neighbour is safe the rest goes ahead where it is, said once. On by
   * default: it acts only when resting was going to act, and the other
   * default is the one that killed the character.
   */
  restNextDoor: boolean;
  /**
   * Rest before stepping through a trap until health covers the trap and
   * still leaves this fraction of maximum after it. 0 walks into any trap at
   * any health.
   *
   * A sliding scale rather than a threshold (2026-09-10, todo 01): a 36-damage
   * trap in front of a 165-HP character is fine at 110 and a 75-damage one
   * wants 150, and both of those are *this share of the bar left over once
   * the trap has fired* — 45% in the two figures the player gave. Where the
   * router priced the room beyond the trap as a lair (`RouteStep.danger`),
   * the larger of the two shares is kept, so a character does not step
   * through a trap into a fight on the health the trap left it. Capped at the
   * maximum: a trap that takes more than the bar holds is walked at full
   * health, which is the most anything here can do about it. Read by
   * `Holds.holdForTrap`; `Recovery` sits the character down to the figure
   * the walk names, on this switch alone — `restBelow: 0` does not turn it
   * off, since the two are two decisions.
   */
  restBeforeTraps: number;
  /**
   * Meditate when mana falls below this fraction. 0 never meditates.
   *
   * Ignored outright for a class with no mana — a warrior's status line carries
   * no `MA=` at all, and `med` for one is answered `Your command had no
   * effect.`, which is a command spent to be refused in the room.
   */
  meditateBelow: number;
  /**
   * Keep meditating to this fraction of mana: `restTo` for mana (todo 825).
   * `meditateBelow` starts a stretch and this carries it on through whatever
   * breaks it, and a route or a loop held for mana walks on here. 0 is the
   * single sit-down; never below `meditateBelow`, clamped up as `restTo` is.
   */
  meditateTo: number;
  /**
   * What to use, and when — *use an item of this name when that is true*
   * (todo 19, 2026-09-12; the only potion setting since todo 00).
   *
   * There were two named slots beside this, health and mana, carrying a name,
   * a threshold and a shared verb each — MegaMUD's own Health tab. They went
   * (todo 00) because this list says everything they said and four things
   * they could not: a second healing potion at a second depth, an antidote
   * the moment the character is poisoned, a scroll that is read rather than
   * drunk, and any of it on an item the realm names something else entirely.
   * Two vocabularies for one question is how somebody sets one and wonders
   * why the other still decides.
   *
   * Empty by default, like `supplies.items`, and for the same reason:
   * spending a player's consumables unasked is its own failure. What this
   * changes is that a player who wants it can now say it.
   */
  potions: PotionRule[];
  /**
   * Use what the pack carries against a room's own spell — the realm's half
   * of the list above (todo 105; moved here and turned on, todo 02).
   *
   * Every row of `potions` is *use this item when that is true*, and this is
   * the same sentence written by the realm instead of by the player: it says
   * which spell stops a room's effect (`avoidedBySpell`) and which item's use
   * casts it, so before a step into such a room, and again whenever the spell
   * lapses while standing in one, the item is used. One rule in each shipped
   * realm — the waterskin against the desert spell, 945 rooms of it.
   *
   * **On by default, which is `AutoLight`'s argument and not a new one**: a
   * rule cannot see the step ahead, the desert takes 13 a tick from a
   * character who has the answer in the pack, and the charge it spends costs
   * 25 copper. It was off and under Movement until a player crossed the
   * desert drinking by hand.
   */
  useWards: boolean;
}

/**
 * One *use this when that* rule — `automation.health.potions`.
 *
 * The name is matched against the pack the way the server matches a typed name
 * (`nameAnswersTo`), so `healing potion` finds `minor healing potion`, and an
 * item the pack does not list is never asked for.
 */
export interface PotionRule {
  /** The item, as the pack lists it. */
  name: string;
  /** What makes it worth using. See `PotionWhen`. */
  when: PotionWhen;
  /**
   * The share of maximum below which `hp` and `mana` fire. Ignored by the
   * condition rules, which have no threshold — being poisoned is not a
   * percentage.
   */
  below: number;
  /** `drink` or `use`, per item: a scroll is read where a potion is drunk. */
  verb: PotionVerb;
}

/**
 * When a `PotionRule` fires.
 *
 * The four conditions are the four the wire states (`CharacterState.afflictions`),
 * and they are three-state there: **only a stated `yes` fires**, because
 * unknown is not afflicted — the rule every threshold in this client follows.
 */
export const POTION_WHENS = ['hp', 'mana', 'poisoned', 'blind', 'diseased', 'held'] as const;
export type PotionWhen = (typeof POTION_WHENS)[number];

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
   * that opens it.
   *
   * **On by default** (2026-09-07). It was off, on the reasoning that a door
   * somebody shut deliberately is a door somebody shut deliberately — which is
   * true of a player's door and false of the realm's, and the realm's is what a
   * route runs into. A shut door on a planned way is the ordinary state of a
   * corridor here, and a walk that stops at one is a walk that stops for no
   * reason a player would recognise. `openTries` is 1, so a locked door costs
   * exactly one command to find out, and forcing is a separate decision below.
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
   * the character's strength is within `BASH_MARGIN` of it.
   *
   * **On by default** (2026-09-07), which is the one automated thing here that
   * costs health — `You take 3 damage for bashing the door!` — and is on
   * anyway for the same reason `openDoors` is: the gate is the realm's own
   * number, so this is never attempted against a barrier the character cannot
   * beat, `bashTries` caps it at three, and the alternative is a route that
   * stops dead at a lock the character was strong enough to walk through.
   * `pickLocks` stays **off**: it is the same decision made with a skill this
   * client cannot check the character has.
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
   * a failed bash costs a command and some health. The router reads this and
   * `bashDoors` too (`Traveller.forcing`): a lock only a switched-off skill
   * opens is planned round, never into.
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
   * Go back for the kit after a death (todo 07, 2026-09-12).
   *
   * A death drops everything where the character stood; `GearRecovery`
   * notices the strip (the loadout remembers items the pack read since no
   * longer holds, and the armour class has fallen to zero), walks back to the
   * room it died in as a leg — holding when hurt, fighting nothing on the way
   * — takes what is still lying there and the coins, and puts the kit back
   * on. Off, like everything that walks a character somewhere unasked; every
   * refusal is said out loud, since a recovery that quietly gave up is a
   * character believing it is dressed.
   */
  recoverGear: boolean;
  /**
   * How many deaths in a row the recovery may answer before it stops trying
   * (todo 21, 2026-09-12). 0 is *no limit*.
   *
   * **The bound is the point.** A recovery walks a freshly dead, stripped
   * character back to the room that killed it; where that room is still
   * dangerous the attempt is itself a way to die, and the client would walk
   * back again, and again — each trip costing a life. Measured on a soak run:
   * two deaths on one journey, fifty minutes, zero laps.
   *
   * Counted in a **row**: a recovery that reached the kit resets it, because a
   * run of failures is what says the trip is not working, where one failure
   * among successes says only that something went wrong once.
   */
  recoverGearTries: number;
  /**
   * Stop recovering once this many lives are left. 0 never stops.
   *
   * The other half of the bound, and the one a player actually reasons in:
   * lives are finite and unrecoverable, and *do not spend my last two getting
   * a cloak back* is the sentence somebody wants to write. Above the try
   * count, since it holds whatever the counter says.
   */
  recoverGearFloor: number;
  /**
   * Put a burning light out again in a room that does not need it, so a torch
   * lasts the sewer rather than the walk to it. MegaMUD does the same at every
   * step flagged as naturally lit. Only while nothing is walking the
   * character — mid-route the next step may be dark again — and only where
   * the realm records the room's level, because a room whose light the data
   * does not state is one the client cannot promise is lit.
   */
  extinguishInLight: boolean;
  /**
   * Walk on while the server says this character is blind. Off, a route or a
   * loop stands still until sight returns — MegaMUD's `IgnoreBlind`, whose
   * default (`0`) waits, and inverted here so that off means wait. A blind
   * character cannot read the room it walks into and misses every swing, so
   * a step taken blind is a step into a lair it will not see. `held`
   * (paralysis) always holds and has no switch: a step while held is a
   * command spent to be refused. See `afflictionHolding` in `walk.ts`.
   */
  walkWhileBlind: boolean;
  /**
   * Turn auto-combat back on when a route the player asked for arrives (todo
   * 11). The ordinary reason to walk with it off is to get somewhere without
   * fighting on the way; on arrival the reason is gone. Only a route the
   * player asked for — a loop's leg and an errand are not journeys with an
   * arrival in them. The switch flips the character's own file, so the
   * toolbar shows it.
   */
  fightOnArrival: boolean;
  /**
   * Ways and places routes keep out of, in the realm's own words (todo 806):
   * a word a way's script phrase says (`go vortex`), or a room's name does
   * (the Negative Power Plane). Configuration, not code: which places a
   * player shuns is theirs, and a realm's name for one is data. The route
   * panel offers a way that crosses one beside the way round it and the
   * player picks; a walk nobody is watching is planned round them
   * (`Traveller.keepOut`) unless it starts or ends inside one.
   */
  keepOutOf: string[];
  /**
   * Walk on while poisoned. Off, the walk waits the poison out — MegaMUD's
   * `IgnorePoison` default. A cure under `spells.cures` ends the wait sooner.
   * Disease is not a movement matter and has no switch.
   */
  walkWhilePoisoned: boolean;
  /**
   * Walk on while confused. Off, the walk waits the confusion out — MegaMUD's
   * `IgnoreConfusion` default. A confused character's commands are thrown
   * away at random before the server reads them (`CheckConfusion`), so every
   * step is a gamble the walk would otherwise spend and re-send.
   */
  walkWhileConfused: boolean;
  /**
   * Pick up a key an exit of this room needs, when it is lying on the floor of
   * it — and only then.
   *
   * **On by default**, which `provideLight` is the precedent for and the same
   * argument makes: the rule everything else here follows — off until asked —
   * exists because a wrong action costs a character, and the wrong action here
   * costs one `get` and the weight of a key. Refusing costs the corridor. It
   * was reported as a client standing on sixty-six bone keys being told the
   * door beside it needed a bone key (2026-09-06).
   *
   * The conjunction is narrow and is the whole of the setting: the realm names
   * the item the exit demands, no listing has shown it in the pack, and the
   * floor holds a name that can only be that row. See `AutoKeys` for why this
   * cannot be the walker's barrier ladder — a keyed edge is pruned before any
   * step exists to be refused at.
   */
  collectKeys: boolean;
}

/**
 * Hunting on its own: pick the best lair the survey knows, walk there and run
 * it (todo 05, 2026-09-13).
 *
 * Its own block rather than a field of `automation.walk`, because walking is
 * how this gets there and not what it is: what it decides is *where a
 * character should be*, which is the Hunting card's question, and todo 06
 * hangs the keeping-it-honest half off the same block.
 *
 * **The survey's own exclusions are the safety** — a lair whose worst spawn
 * would take more than `maxDamageShare` of the bar, or one too trivial to pay
 * — and `automation.walk.minExpPerHour` is the floor below which nothing is
 * worth walking to. Neither is restated here: two vocabularies for one
 * question is how somebody sets one and wonders why the other still decides.
 */
export interface HuntingAutomationConfig {
  /** Walk to the best hunting ground and run it, unasked. Off. */
  enabled: boolean;
  /**
   * How far to look, in steps; 0 is everywhere the exits reach.
   *
   * The sweep is bounded by the realm rather than by a clock, and an unbounded
   * one on a big realm is the whole map — which is the right answer for *where
   * should this character be tonight* and the wrong one for a character that
   * should not leave its area. A number here is that player's answer.
   */
  radius: number;
}

/**
 * Spending character points on the `train stats` screen — `StatScreen`.
 *
 * Off by default, and inert while every wanted figure is at or under the
 * sheet's: the reviewer's rule (todo 10). `wanted` is where each stat should
 * end up; 0 leaves it alone. The screen replaces the whole terminal and
 * anything typed lands in a field, which is why the queue stands down for it
 * and only this one driver, which reads the screen, is let through.
 */
export interface TrainConfig {
  /** Auto Train Stats. */
  stats: boolean;
  wanted: Record<TrainedAttribute, number>;
  /**
   * Go and collect a level when the experience is there (todo 18).
   *
   * Off, because a player banking levels for a reroll exists and a client
   * that levelled them anyway would have spent their money and their choice.
   *
   * Experience past the threshold does nothing at all until a trainer is
   * paid: no hit points, no skills, no character points. So a client left to
   * play overnight without this comes back with a night's experience and the
   * same character it started with — which is the one thing it is for.
   */
  levels: boolean;
  /**
   * Where to go and level: the trainer's own shop row, or 0 for *the cheapest
   * that will take me*.
   *
   * **A row, not a room name.** Two rows may share a name and they are
   * different trainers with different bands; and a row placed in several
   * rooms is one choice, not several.
   *
   * The settings screen offers only the rows the realm says will take this
   * character at this level (`trainersTaking`), because a trainer that
   * refuses is a walk across two maps to be told so. A stated row that stops
   * taking this character — every class room does at level 10, every band
   * does at its ceiling — is **not** silently replaced: the errand refuses
   * and says so, which is the reviewer's rule and the standing one about
   * never guessing a location.
   */
  trainer: number;
}

/**
 * The cures the client automates, one per condition the tracker keeps a flag
 * for and a spell can end — MegaMUD's `BlindCmd`, `PoisonCmd`, `DiseaseCmd`
 * and `FreedomCmd`. `freedom` answers `held` (todo 810).
 */
export const CURES = ['blindness', 'poison', 'disease', 'freedom'] as const;
export type Cure = (typeof CURES)[number];

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
   * *Auto Choose Best Spell* (todo 09, 2026-09-12). On, the round spell is
   * derived every round from the spellbook the client has read and the
   * realm's own figures — a spell the target resists is not cast, the
   * cheapest whose least roll finishes what is left of the monster is, and
   * otherwise the hardest hitter the pool can pay for — and the cures come
   * from the book the same way where their boxes are blank. `attack` and
   * `attackFallback` are what is cast with it off. Off, because it spends
   * mana on a reading the player did not type; the choice is said out loud
   * each time it changes.
   */
  autoChoose: boolean;
  /**
   * The spell to attack with. Blank casts nothing.
   *
   * Sent as `<short> <target>` — the listing's short name is itself the
   * command (`swan`, `mihe giant rat` on the wire: captures/083, 092) and
   * never goes behind `c`, since a mystic's kai powers have no `c` form
   * (2026-09-17). Nor is it a prefix of the name (measured 2026-09-01:
   * `c pressure points` answers `You do not know how to cast pressure.`).
   * The configured value stays the readable whole name, or an
   * abbreviation; `castWord` resolves it when the cast goes out.
   *
   * It opens the fight in place of `combat.attack`, and the server casts it
   * every round from then on by itself, so a round sends only a change of
   * action (todo 816, `AttackSpells`).
   */
  attack: string;
  /**
   * The spell to attack the whole room with, when the fight is crowded enough
   * — MegaMUD's MultAttack. Blank casts nothing.
   *
   * Cast bare (`<spell>`, no target): the wire shows an area spell cast
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
   * The spell cast instead of `attack` for the rest of a fight once the server
   * has said `attack` has no effect on the target — MegaMUD's `AttackSpl2`
   * with `FailoverSpellAttacks`. Blank means none: the round attacks carry
   * the fight, and the refusal is said once.
   *
   * `Your spell has no effect on <name>.` is the server saying the monster is
   * immune (`spell-ineffective`), and without this a caster on a loop paid
   * for the same spell every round of every fight with that monster, all
   * night, for nothing. The whole name, as `attack` is.
   */
  attackFallback: string;
  /**
   * How many times the round spell (or its fallback) is cast per target —
   * MegaMUD's `MaxCastCnt`, whose own default is **1**: open with the spell,
   * then let the melee round carry it. **0 is no limit here**, which is what
   * this client did before the field existed; MegaMUD reads 0 as none, and
   * that reading is not carried because a blank field must not silently
   * stop a caster casting. Counted on the server's confirmation, so a cast
   * that fizzled is not one of them; a new target starts the count again.
   */
  attackCasts: number;
  /**
   * The same cap for the area spell — MegaMUD's `MultCastCnt`. 0 is no limit.
   * The area spell is the expensive one, and a room that took three of them
   * and is still standing is one the single-target spell and the melee round
   * finish more cheaply.
   */
  areaCasts: number;
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
   * Ask a carried item for the blessing it can cast, when that blessing is not
   * up — MegaMUD's `AutoBless`, for the half of it this client had no answer
   * to: a *weapon* that blesses.
   *
   * The realm states the whole of it. An item's `CastsSp` names a spell, and
   * where `UseCount` is `-1` the server lets it be used for ever — nine
   * weapons in the shipped realm cast a sixty-tick bless that way, costing no
   * mana and no charge, and nothing in this client ever asked for one.
   *
   * Off by default, like everything automated. **Only unlimited items**: one
   * with three charges spent on a buff is three charges somebody was saving,
   * and the realm has to say `-1` — silence is not unlimited. See
   * `AutoInvoke`.
   */
  invokeItems: boolean;
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
   * fight's budget on it. Blank casts nothing. `freedom` is cast while the
   * character is held (paralysis, a net, a knockdown: every `HoldPerson`).
   */
  cures: Record<Cure, string>;
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
  /**
   * Whether the blessings below are cast unasked at all.
   *
   * The toolbar's *Auto-Bless* switch (todo 04): somebody who wants the
   * mana for healing turns it off for the fight and back on after, without
   * emptying the list. Off, `Blessings` proposes nothing; the list, the
   * cures and the heal are untouched.
   */
  autoBless: boolean;
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
  fleeGoto: FleeGotoConfig;
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
   * leader is doing — the three refusals stand.
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
  /**
   * Say `@heal` in the room below this share of maximum health, while in a
   * party — MegaMUD's *Ask For Healing* (`PartyAskHeal%`). 0 never asks. Said
   * once on the crossing and again every `tuning.remotes.healAskAgainMs` while
   * still under it; a party member running either client answers with a heal.
   */
  askForHealBelow: number;
}

/**
 * Whether the client owns the prompt's shape.
 *
 * `set statline full custom <template>` puts the maximum health and mana, the
 * experience, what the next level still costs and the purse on every prompt,
 * on both families (`src/shared/statline.ts` composes it; measured live,
 * 2026-09-09). Off by default: the line is a setting on the character, kept
 * server-side, and the client does not change one unasked. Whatever the line
 * is, the client reads it — `pro` says which, and the matcher is built from
 * that rather than from what was sent.
 */
export interface StatlineConfig {
  control: boolean;
}

export interface AutomationConfig {
  /**
   * Rules, evaluated over character state. Written against this project's own
   * vocabulary — see `./rules.ts` for why it is not `tproxy`'s DSL.
   */
  rules: Rule[];
  /**
   * Master switch. With this off, only what the player types is ever sent, bar
   * the keep-alive (`idle`), which keeps the connection rather than acting.
   */
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
  /** Answering for a player who is not at the keyboard — MegaMUD's AutoAfk. */
  afk: AfkConfig;
  /** Keeping the pack stocked. See `SuppliesConfig`. */
  supplies: SuppliesConfig;
  /** Answering another player's `@` commands — MegaMUD's remote control. */
  remotes: RemotesConfig;
  /** What this character does about other people, short of talking to them. */
  talk: TalkConfig;
  /** Whether the client sets the prompt's shape on the way in. See `StatlineConfig`. */
  statline: StatlineConfig;
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
  /** Spending character points on the stat screen. */
  hunting: HuntingAutomationConfig;
  train: TrainConfig;
  /** Carrying a quest's plan through the arbiter. See `QuestsConfig`. */
  quests: QuestsConfig;
  /** Which kit to be in, and when. See `GearConfig`. */
  gear: GearConfig;
}

/**
 * Running a quest's plan — the Quest card's *Run it* (todo 102).
 *
 * Off, like everything automated: a run walks across the realm, buys, hunts
 * and fights for as long as the chain takes, and a character left overnight
 * should do that only where somebody said so. The card's press refuses out
 * loud while this is off and names the switch.
 */
export interface QuestsConfig {
  enabled: boolean;
}

/**
 * The equipment manager — which kit to be in, and when (todo 00).
 *
 * The gear buttons this sits beside are presses: *put back what was on*,
 * *wear everything*. What they cannot say is *these boots while walking and
 * those while fighting*, which is a decision rather than an action, and one
 * the client is in a position to make because it already knows which of the
 * two is happening.
 *
 * Off, like everything automated: a set the player has not finished writing
 * would otherwise start swapping kit mid-fight. Empty by default for the
 * same reason `health.potions` is — nothing is worn unasked.
 */
export interface GearConfig {
  enabled: boolean;
  /** The kits, most general first. See `GearSet`. */
  sets: GearSet[];
  /** The off-round weapon invocation. See `OffRoundConfig`. */
  offRound: OffRoundConfig;
}

/**
 * `use <item> <target>` between rounds — todo 00's nexus spear.
 *
 * **It costs the round.** The item has to be in hand before `use` will take
 * it (`UseCommand` answers *You do not have <item> equipped.*), so a
 * two-handed one is six commands — off-hand off, spear on, use, weapon
 * back, off-hand back — against a window of three. `everyRounds` is the
 * floor under that, and 0 is off, which is where it ships.
 */
export interface OffRoundConfig {
  /** The item to invoke. Blank is off, whatever `everyRounds` says. */
  item: string;
  /** At most one invocation this many rounds. 0 never invokes. */
  everyRounds: number;
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
 * `resources/servers/paradigm-game-1-pve/server.yaml` is the realm and
 * `resources/config/profile.default.yaml` names it too; `shipped.test.ts` holds
 * all three together, because a template and its constant are a closed pair and
 * this repository has watched one drift already (`internal.yaml`, 2026-08-28).
 *
 * **Paradigm, and it is the realm the default bundled world is built from.**
 * It was `GMUD (5X)` for two days (2026-09-03 to 2026-09-05), which meant a
 * new character's realm and the map shipped beside it were two different
 * games: that realm had to carry a 2.4 MB database of its own into every
 * installer, and every claim about a room, a route or a monster was answered
 * from the wrong realm the moment either half was got wrong.
 * `resources/world/paradigm.jsonl.gz` is built from Paradigm's own database
 * (`mdb/pmud.zip`, see `scripts/build-world.mjs`), so this default and
 * `DEFAULT_SHIPPED_WORLD` are one realm.
 *
 * Changing the default is therefore editing this line and the template beside
 * it, not renaming a directory to sort earlier — which is what the settings
 * screen used to depend on without saying so.
 *
 * A name no realm on disk answers to falls back to the first realm there is: a
 * player who deleted this one still gets a realm rather than a blank field.
 */
export const DEFAULT_REALM_NAME = 'Paradigm Game 1 PVE';

export const DEFAULT_CONFIG: AppConfig = {
  connection: {
    /*
     * Paradigm's own address, because Paradigm is what this client ships for:
     * `resources/servers/` seeds its six realms on first run and the default
     * bundled world is built from the database Paradigm distributes.
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
       *
       * The account is two rows like any other, filled in from the character's
       * own file (`src/shared/login.ts`). Every BBS asks for it and every BBS
       * words the question differently, which is the whole reason it is here
       * rather than keyed on a block type the classifier has to recognise.
       */
      steps: [
        { when: 'Please enter your username', send: '{user}' },
        { when: 'Please enter your password', send: '{password}' },
        { when: 'Please enter your selection', send: 'P' },
        { when: 'Please select a realm', send: '1' },
        { when: 'Please select a character', send: '1' },
        { when: '[PARADIGM]', send: 'E' },
        { when: 'Accept these realm rules to continue', send: '1' },
        // A pager, asked once per screenful: see `LoginStep.repeat`. Without
        // the flag the first one is answered and the login sits at the second.
        { when: '(N)onstop, (Q)uit, or (C)ontinue?', send: '', repeat: true }
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
    showLogo: true,
    console: { palette: DEFAULT_CONSOLE_PALETTE, keepDark: true, darkTheme: DEFAULT_THEME },
    // Half and a quarter: the same numbers `megamind-client` shipped for
    // `restIfBelow` / `runIfBelow`, and the ones a MajorMUD player already has
    // in their head. Fractions, so they hold at every level.
    vitals: {
      hp: { caution: 0.5, critical: 0.25 },
      mana: { caution: 0.5, critical: 0.25 }
    },
    alerts: { rules: STARTER_ALERTS.map((rule) => ({ ...rule })) },
    // Every design off; each is what a player starts designing from. The
    // bands are the HUD's own shape -- a colour from a share of maximum up.
    rewrites: {
      bands: {
        hp: [
          { atLeast: 0.75, colour: 'brightGreen' },
          { atLeast: 0.45, colour: 'yellow' },
          { atLeast: 0, colour: 'brightRed' }
        ],
        mana: [
          { atLeast: 0.5, colour: 'brightCyan' },
          { atLeast: 0.25, colour: 'yellow' },
          { atLeast: 0, colour: 'brightRed' }
        ]
      },
      designs: structuredClone(DEFAULT_REWRITES) as RewriteDesign[]
    }
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
    // Off: the status line is a setting kept on the character server-side,
    // and the client does not change one unasked. See `StatlineConfig`.
    statline: { control: false },
    // Empty is a bare Enter: the room, re-read without telling the room. See
    // `IdleConfig.command` and `REREAD_ROOM`.
    idle: { enabled: true, afterSeconds: 45, command: REREAD_ROOM },
    // Window of 3 against a measured cliff of ~20: deliberately conservative,
    // because exceeding it loses commands with no way to know.
    pacing: { window: 3, minGapMs: 350, ackTimeoutMs: 3000 },
    // Comfortably longer than the queue's own acknowledgement timeout, so a
    // step is not abandoned while the arbiter is still waiting its turn to
    // send it.
    walk: { clearAfterSeconds: 15, stepTimeoutMs: 8000, minExpPerHour: 0 },
    safety: {
      // Off, and refusing when on. See `HangUpConfig`: the panic button every
      // MegaMUD-era client offers is, here, a way to die.
      hangUp: {
        enabled: false,
        belowHealth: 0.15,
        penalties: false,
        onPlayerInRoom: false
      },
      retreat: {
        enabled: false,
        belowHealth: 0.3,
        belowMana: 0,
        whenOutnumbered: 0,
        cooldownMs: 3000,
        strategy: 'step-back',
        safeHavenRoom: ''
      },
      // Off, and between the retreat's floor and the hang-up's, so the
      // teleport has its turn before the panic button. See `FleeGotoConfig`.
      fleeGoto: { enabled: false, belowHealth: 0.2, command: '' },
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
      hideForOpener: false,
      engage: 'hostile',
      retaliate: true,
      defendAfterRounds: 2,
      politeAttacks: false,
      maxMobs: 0,
      refreshRounds: 3,
      mobRules: [],
      maxTargetHealth: 0,
      minMobs: 0,
      maxMonsterExperience: 0
    },
    // Off, like everything automated. A client that sits down on its own is one
    // deciding when a fight is over.
    party: { assistLeader: false, defendParty: false, restWithLeader: false, askForHealBelow: 0 },
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
      restNextDoor: true,
      restBeforeTraps: 0.45,
      meditateBelow: 0,
      meditateTo: 0,
      potions: [],
      useWards: true
    },
    loot: {
      coins: false,
      // All five: this is what `coins: true` alone has always meant, so the
      // default changes nothing about how the client behaves.
      coinKinds: [...DENOMINATIONS],
      discardKinds: [],
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
    banking: { autoDeposit: false, depositThresholdCopper: 50_000, keepCopper: 500, bank: 0 },
    // On, with nothing listed: the switch is what the toolbar flips, and the
    // list is what the Self card and the item panel fill. An empty list does
    // nothing, so the default is safe and the first item added starts working.
    supplies: { enabled: true, items: [] },
    remotes: {
      enabled: false,
      gangpath: false,
      gang: [],
      /*
       * The one grant that ships non-empty, and it is three names: see
       * `RemotesConfig.party` for why these and for the four that were on it
       * and are not.
       */
      party: ['health', 'bless-expired', 'heal'],
      players: {}
    },
    loops: [],
    events: [],
    afk: { enabled: false, afterMinutes: 5, reply: '{AFK}' },
    movement: {
      openDoors: true,
      openTries: 1,
      bashDoors: true,
      bashTries: 3,
      pickLocks: false,
      pickTries: 3,
      sneak: false,
      provideLight: true,
      lightDimRooms: false,
      extinguishInLight: true,
      recoverGear: false,
      recoverGearTries: 2,
      recoverGearFloor: 2,
      walkWhileBlind: false,
      walkWhilePoisoned: false,
      walkWhileConfused: false,
      fightOnArrival: true,
      keepOutOf: ['vortex', 'Negative Power Plane'],
      collectKeys: true
    },
    hunting: {
      enabled: false,
      radius: 0
    },
    train: {
      stats: false,
      wanted: { strength: 0, intellect: 0, willpower: 0, agility: 0, health: 0, charm: 0 },
      levels: false,
      trainer: 0
    },
    quests: { enabled: false },
    gear: { enabled: false, sets: [], offRound: { item: '', everyRounds: 0 } },
    spells: {
      autoChoose: false,
      attack: '',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0.35,
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
      minMana: 0.15,
      cures: { blindness: '', poison: '', disease: '', freedom: '' },
      blessings: [],
      notifyPartyOnWearOff: false,
      autoBless: true
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
  /** The master switch. Off, only what the player types is sent, bar the keep-alive. */
  automation: ['enabled'],
  combat: ['combat', 'enabled'],
  retaliate: ['combat', 'retaliate'],
  autoBless: ['spells', 'autoBless'],
  retreat: ['safety', 'retreat', 'enabled'],
  fleeGoto: ['safety', 'fleeGoto', 'enabled'],
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
  invokeItems: ['spells', 'invokeItems'],
  assistLeader: ['party', 'assistLeader'],
  defendParty: ['party', 'defendParty'],
  restWithLeader: ['party', 'restWithLeader'],
  remotes: ['remotes', 'enabled'],
  gangpath: ['remotes', 'gangpath'],
  lookAtPlayers: ['talk', 'lookAtPlayers'],
  quests: ['quests', 'enabled'],
  gear: ['gear', 'enabled']
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
      tabs: oneOf(ui['tabs'], ['top', 'left', 'right'] as const, DEFAULT_CONFIG.ui.tabs),
      density: oneOf(
        ui['density'],
        ['auto', 'comfortable', 'compact'] as const,
        DEFAULT_CONFIG.ui.density
      ),
      // Validated against the registry rather than a literal list, so a theme
      // added to `themes.ts` becomes selectable without touching this file.
      theme: isThemePreference(ui['theme']) ? ui['theme'] : DEFAULT_CONFIG.ui.theme,
      showHud: bool(ui['showHud'], DEFAULT_CONFIG.ui.showHud),
      showLogo: bool(ui['showLogo'], DEFAULT_CONFIG.ui.showLogo),
      console: normalizeConsoleUi(ui['console']),
      vitals: normalizeVitals(ui['vitals']),
      alerts: normalizeAlerts(ui['alerts']),
      rewrites: normalizeRewrites(ui['rewrites'])
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

/**
 * The `to` of a start-and-carry-on pair (`restTo`, `meditateTo`, `healTo`):
 * clamped up to its `below`, since a line under the floor is two opposite
 * instructions about one number, and 0 kept as 0, the single sit-down or cast.
 */
function ceilingOver(to: number, below: number): number {
  return to === 0 ? 0 : Math.max(to, below);
}

function normalizeThresholds(value: unknown, fallback: VitalThresholds): VitalThresholds {
  const raw = isRecord(value) ? value : {};
  const caution = fraction(raw['caution'], fallback.caution);
  // Red never sits above yellow. Inverting them is a typo, not an intent, and
  // the safe reading of a typo is the more cautious one: a meter that warns
  // early is noise, one that alarms late is a dead character.
  return { caution, critical: Math.min(caution, fraction(raw['critical'], fallback.critical)) };
}

/**
 * The console's own ground.
 *
 * `darkTheme` is coerced against `isDarkTheme` rather than `isThemeId`: a light
 * theme named here would be a file asking to keep the console dark and handing
 * it a light palette. There is no reading of that which is a preference.
 */
function normalizeConsoleUi(value: unknown): ConsoleUiConfig {
  const raw = isRecord(value) ? value : {};
  const wanted = raw['darkTheme'];
  const palette = raw['palette'];
  return {
    // An unknown palette name falls back to `theme` rather than to one of the
    // seven: a typo should leave the console as the client would have drawn it,
    // not pick a look nobody asked for.
    palette: isConsolePalette(palette) ? palette : DEFAULT_CONFIG.ui.console.palette,
    keepDark: bool(raw['keepDark'], DEFAULT_CONFIG.ui.console.keepDark),
    darkTheme: isDarkTheme(wanted) ? wanted : DEFAULT_CONFIG.ui.console.darkTheme
  };
}

/**
 * The player's alert rows — `ui.alerts.rules` (todo 29).
 *
 * A row whose `on` the client does not know is **dropped**, never defaulted:
 * it is the runtime half of a closed union, and defaulting it would turn a
 * misspelling into a row acting on something the player did not name. A row
 * that names a figure keeps it; one that names a person or an item keeps the
 * name trimmed, and an empty name leaves the row inert rather than firing on
 * everything.
 */
function normalizeAlertRules(value: unknown): AlertRule[] {
  const rules: AlertRule[] = [];
  if (!Array.isArray(value)) return rules;
  for (const entry of value.slice(0, 64)) {
    if (!isRecord(entry)) continue;
    const on = str(entry['on'], '').trim().toLowerCase();
    // An event this client does not know, which after todo 03 includes every
    // channel word a file written before it named. The migration carries those
    // across; anything left here is a misspelling, and dropped.
    if (!isAlertEvent(on)) continue;
    const notify = bool(entry['notify'], false);
    rules.push({
      on: on as AlertRule['on'],
      enabled: bool(entry['enabled'], true),
      // `null` is *keep what the client decided*, which is the default and
      // the thing an unreadable word means too.
      level: SEVERITIES.includes(str(entry['level'], '') as Severity)
        ? (str(entry['level'], '') as Severity)
        : null,
      alert: bool(entry['alert'], true),
      notify,
      // Meaningless with `notify` off, and stored false there rather than
      // kept: a flag nothing reads is one that surprises somebody later.
      whileFocused: notify && bool(entry['whileFocused'], false),
      side: oneOf(entry['side'], ALERT_SIDES, 'below'),
      // A share when `percent`, a figure otherwise; both are the player's own
      // number and neither is clamped to the other's range.
      value: Math.max(0, Number(entry['value']) || 0),
      percent: bool(entry['percent'], true),
      name: str(entry['name'], '').trim().slice(0, 60),
      // How long the row stays quiet after firing. Absent means the shipped
      // thirty seconds rather than 0: a file written before this existed gets
      // the behaviour the setting was added for, not the one it replaced.
      quietSeconds: Math.max(
        0,
        Math.round(Number(entry['quietSeconds'] ?? DEFAULT_ALERT_DEBOUNCE_SECONDS) || 0)
      )
    });
  }
  return rules;
}

function normalizeAlerts(raw: unknown): AlertsUiConfig {
  const d = DEFAULT_CONFIG.ui.alerts;
  if (!isRecord(raw)) {
    /*
     * No `alerts:` block at all is a file that has never said anything about
     * alerts, so it gets the shipped rows. A block that states `rules: []` is
     * a player who has deleted every row, and that is honoured — an empty list
     * is not silence now, it is *whatever the ranking says*, which is exactly
     * what a client with no rows should do.
     */
    return { rules: d.rules.map((rule) => ({ ...rule })) };
  }
  return {
    rules: Array.isArray(raw['rules'])
      ? normalizeAlertRules(raw['rules'])
      : d.rules.map((rule) => ({ ...rule }))
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

/** The most a template may run to; a listing is a screen, not a file. */
export const TEMPLATE_MAX_CHARS = 4000;

/**
 * The vitals' bands, read forgivingly: a band naming a colour the palette
 * lacks, or a floor that is not a number, is dropped rather than failing the
 * block; the floors are fractions, spelled as the vitals thresholds are. A
 * stated empty list is empty — no colour is a legitimate design.
 */
export function normalizeBands(value: unknown): VitalBands {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.ui.rewrites.bands;
  const bands = (list: unknown, fallback: readonly ColourBand[]): ColourBand[] => {
    if (!Array.isArray(list)) return fallback.map((band) => ({ ...band }));
    const out: ColourBand[] = [];
    for (const entry of list.slice(0, 8)) {
      if (!isRecord(entry) || !isAnsiColour(entry['colour'])) continue;
      out.push({ atLeast: fraction(entry['atLeast'], 0), colour: entry['colour'] });
    }
    return out.sort((a, b) => b.atLeast - a.atLeast);
  };
  return { hp: bands(raw['hp'], d.hp), mana: bands(raw['mana'], d.mana) };
}

/**
 * One design, or null for an entry that names no entity the console can
 * draw — dropped rather than guessed at, since a design drawing the wrong
 * listing would be worse than one missing. A blank name is kept blank; the
 * list draws the entity's word for it. The template is not trimmed: a space
 * before the caret is part of a prompt row's design.
 */
export function normalizeRewriteDesign(value: unknown): RewriteDesign | null {
  if (!isRecord(value) || !isRewriteEntity(value['entity'])) return null;
  const template = value['template'];
  return {
    name: typeof value['name'] === 'string' ? value['name'].trim().slice(0, 60) : '',
    entity: value['entity'],
    enabled: bool(value['enabled'], false),
    template: typeof template === 'string' ? template.slice(0, TEMPLATE_MAX_CHARS) : ''
  };
}

/**
 * The whole `ui.rewrites` block. A stated `designs` list is the list, empty
 * included — a player who deleted every design has none, and the shipped
 * six return only where the key is absent altogether.
 */
export function normalizeRewrites(value: unknown): RewritesUiConfig {
  const raw = isRecord(value) ? value : {};
  const designs = Array.isArray(raw['designs'])
    ? raw['designs']
        .slice(0, 64)
        .map(normalizeRewriteDesign)
        .filter((design): design is RewriteDesign => design !== null)
    : structuredClone(DEFAULT_CONFIG.ui.rewrites.designs);
  return { bands: normalizeBands(raw['bands']), designs };
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
    // `repeat` is written only when stated, so an ordinary row stays two keys.
    steps.push({
      when,
      send: typeof entry['send'] === 'string' ? entry['send'] : '',
      ...(entry['repeat'] === true ? { repeat: true } : {})
    });
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
    database: str(value['database'], ''),
    mobRules: normalizeMobRules(value['mobRules']),
    hangPenalties: typeof value['hangPenalties'] === 'boolean' ? value['hangPenalties'] : null,
    locate: asLocateWord(value['locate']) ?? DEFAULT_LOCATE,
    fleeGoto: str(value['fleeGoto'], '').trim()
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

/** A list with case-insensitive repeats dropped, the first spelling kept. */
function uniqueWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      clearAfterSeconds: int(walk['clearAfterSeconds'], d.walk.clearAfterSeconds, 0, 3600),
      // Zero is off. Capped where no realm's experience curve reaches in an hour.
      minExpPerHour: int(walk['minExpPerHour'], d.walk.minExpPerHour, 0, 100_000_000)
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
    afk: {
      enabled: bool(isRecord(raw['afk']) ? raw['afk']['enabled'] : undefined, d.afk.enabled),
      // A minute at least: a shorter absence is a pause for thought, and a day
      // at most, because past that it is off by another name.
      afterMinutes: int(
        isRecord(raw['afk']) ? raw['afk']['afterMinutes'] : undefined,
        d.afk.afterMinutes,
        1,
        1440
      ),
      reply: str(isRecord(raw['afk']) ? raw['afk']['reply'] : undefined, d.afk.reply)
        .trim()
        .slice(0, 120)
    },
    talk: {
      lookAtPlayers: bool(
        isRecord(raw['talk']) ? raw['talk']['lookAtPlayers'] : undefined,
        d.talk.lookAtPlayers
      )
    },
    statline: {
      control: bool(
        isRecord(raw['statline']) ? raw['statline']['control'] : undefined,
        d.statline.control
      )
    },
    loops: asLoops(raw['loops']),
    events: asEvents(raw['events']),
    movement: normalizeMovement(raw['movement']),
    spells: normalizeSpells(raw['spells']),
    hunting: normalizeHuntingAutomation(raw['hunting']),
    train: normalizeTrain(raw['train']),
    quests: normalizeQuests(raw['quests']),
    gear: normalizeGear(raw['gear'])
  };
}

/**
 * The kits, parsed at the boundary like every other list here: a set with no
 * name or nothing to wear is dropped (a kit naming nothing dresses nobody), a
 * `when` the table does not know is dropped — the closed union's runtime
 * half — and a blank `mob` is *any monster* rather than a refusal.
 */
export function normalizeGear(value: unknown): GearConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.gear;
  const offRound = isRecord(raw['offRound']) ? raw['offRound'] : {};
  return {
    enabled: bool(raw['enabled'], d.enabled),
    sets: (Array.isArray(raw['sets']) ? raw['sets'] : []).flatMap((entry): GearSet[] => {
      if (!isRecord(entry)) return [];
      const name = str(entry['name'], '');
      const when = str(entry['when'], '') as GearWhen;
      if (name.length === 0 || !GEAR_WHENS.includes(when)) return [];
      const wear = (Array.isArray(entry['wear']) ? entry['wear'] : [])
        .map((each) => str(each, ''))
        .filter((each) => each.length > 0);
      if (wear.length === 0) return [];
      return [{ name, when, mob: str(entry['mob'], ''), wear }];
    }),
    offRound: {
      item: str(offRound['item'], ''),
      // Bounded low: a floor of twenty rounds is a fight that has ended.
      everyRounds: int(offRound['everyRounds'], d.offRound.everyRounds, 0, 20)
    }
  };
}

/** One switch, off unless the file says on. */
export function normalizeQuests(value: unknown): QuestsConfig {
  const raw = isRecord(value) ? value : {};
  return { enabled: bool(raw['enabled'], DEFAULT_CONFIG.automation.quests.enabled) };
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
  const meditateBelow = fraction(raw['meditateBelow'], d.meditateBelow);
  return {
    restBelow,
    /*
     * Clamped up to `restBelow` rather than accepted as stated, exactly as
     * `healTo` is: a `to` under the `below` asks the client to sit down at 50%
     * and stand up at 40%. 0 stays 0 — that is the single sit-down, not a
     * lower bound.
     */
    restTo: ceilingOver(fraction(raw['restTo'], d.restTo), restBelow),
    restNextDoor: bool(raw['restNextDoor'], d.restNextDoor),
    restBeforeTraps: fraction(raw['restBeforeTraps'], d.restBeforeTraps),
    meditateBelow,
    meditateTo: ceilingOver(fraction(raw['meditateTo'], d.meditateTo), meditateBelow),
    potions: normalizePotionRules(raw['potions']),
    useWards: bool(raw['useWards'], d.useWards)
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
  /*
   * Exclusive with the list above, and **this** is the one that loses a
   * disagreement. A file naming gold on both is a file whose author meant one
   * of two things, and only one of the readings is destructive: collecting a
   * coin that is then dropped costs two commands a lap, while dropping a coin
   * the player meant to keep is money on the floor of a room they have left.
   * So the ambiguity resolves towards keeping.
   */
  const discardKinds = Array.isArray(raw['discardKinds'])
    ? DENOMINATIONS.filter(
        (name) => (raw['discardKinds'] as unknown[]).includes(name) && !coinKinds.includes(name)
      )
    : d.discardKinds.filter((name) => !coinKinds.includes(name));
  return {
    coins: bool(raw['coins'], d.coins),
    coinKinds,
    discardKinds,
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
    keepCopper: int(raw['keepCopper'], d.keepCopper, 0, 1_000_000_000),
    // A shop row id. 0 is *whichever counter it is standing at*, which is what
    // a file predating the setting was doing.
    bank: int(raw['bank'], d.bank, 0, 1_000_000)
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
    extinguishInLight: bool(raw['extinguishInLight'], d.extinguishInLight),
    recoverGear: bool(raw['recoverGear'], d.recoverGear),
    // Bounded low: a recovery that has failed five times is not going to work
    // on the sixth, and the figures are lives on the other end of it.
    recoverGearTries: int(raw['recoverGearTries'], d.recoverGearTries, 0, 20),
    recoverGearFloor: int(raw['recoverGearFloor'], d.recoverGearFloor, 0, 99),
    walkWhileBlind: bool(raw['walkWhileBlind'], d.walkWhileBlind),
    walkWhilePoisoned: bool(raw['walkWhilePoisoned'], d.walkWhilePoisoned),
    walkWhileConfused: bool(raw['walkWhileConfused'], d.walkWhileConfused),
    fightOnArrival: bool(raw['fightOnArrival'], d.fightOnArrival),
    // One word once, however it was spelt: two spellings of one word are one
    // place kept out of.
    keepOutOf: uniqueWords(stringList(raw['keepOutOf'], d.keepOutOf)),
    collectKeys: bool(raw['collectKeys'], d.collectKeys)
  };
}

/** Steps are whole and never negative; 0 means *everywhere the exits reach*. */
export function normalizeHuntingAutomation(value: unknown): HuntingAutomationConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.hunting;
  return {
    enabled: bool(raw['enabled'], d.enabled),
    radius: int(raw['radius'], d.radius, 0, 9_999)
  };
}

/** A wanted figure is a whole number; the race's ceiling is applied at the screen, not here. */
export function normalizeTrain(value: unknown): TrainConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_CONFIG.automation.train;
  const wanted = isRecord(raw['wanted']) ? raw['wanted'] : {};
  const figures = {} as Record<TrainedAttribute, number>;
  for (const attribute of TRAINED_ATTRIBUTES) {
    figures[attribute] = int(wanted[attribute], d.wanted[attribute], 0, 999);
  }
  return {
    stats: bool(raw['stats'], d.stats),
    wanted: figures,
    levels: bool(raw['levels'], d.levels),
    // A shop row number. 0 is *the cheapest that will take me*, which is also
    // what a negative or unreadable figure means: never a guess at a room.
    trainer: int(raw['trainer'], d.trainer, 0, 999_999)
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
/**
 * The *use this when that* list — `automation.health.potions`.
 *
 * A row with no name is dropped rather than defaulted, as a supply row and a
 * buff row are: a rule naming nothing could only ever fire on nothing, and
 * defaulting the name would invent an item the player never asked for. A
 * `when` the table does not know is dropped for the same reason — a closed
 * union's runtime half — and a `verb` that is not one of the two normalises
 * to `drink`, which is what an unreadable verb means.
 */
function normalizePotionRules(value: unknown): PotionRule[] {
  const rules: PotionRule[] = [];
  if (!Array.isArray(value)) return rules;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = str(entry['name'], '').trim();
    if (name.length === 0) continue;
    const when = str(entry['when'], 'hp').trim() as PotionWhen;
    if (!POTION_WHENS.includes(when)) continue;
    const verb = str(entry['verb'], 'drink').trim() as PotionVerb;
    rules.push({
      name,
      when,
      below: fraction(entry['below'], 0),
      verb: POTION_VERBS.includes(verb) ? verb : 'drink'
    });
  }
  return rules;
}

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
    autoChoose: bool(raw['autoChoose'], d.autoChoose),
    attack: str(raw['attack'], d.attack).trim(),
    areaAttack: str(raw['areaAttack'], d.areaAttack).trim(),
    areaMinMobs: int(raw['areaMinMobs'], d.areaMinMobs, 1, 99),
    areaMinMana: fraction(raw['areaMinMana'], d.areaMinMana),
    attackFallback: str(raw['attackFallback'], d.attackFallback).trim(),
    attackCasts: int(raw['attackCasts'], d.attackCasts, 0, 99),
    areaCasts: int(raw['areaCasts'], d.areaCasts, 0, 99),
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
    healTo: ceilingOver(fraction(raw['healTo'], d.healTo), fraction(raw['healBelow'], d.healBelow)),
    healParty: bool(raw['healParty'], d.healParty),
    invokeItems: bool(raw['invokeItems'], d.invokeItems),
    minMana: fraction(raw['minMana'], d.minMana),
    cures: normalizeCures(raw['cures']),
    blessings: normalizeBlessings(raw['blessings']),
    notifyPartyOnWearOff: bool(raw['notifyPartyOnWearOff'], d.notifyPartyOnWearOff),
    autoBless: bool(raw['autoBless'], d.autoBless)
  };
}

function normalizeCures(value: unknown): SpellsConfig['cures'] {
  const raw = isRecord(value) ? value : {};
  return {
    blindness: str(raw['blindness'], '').trim(),
    poison: str(raw['poison'], '').trim(),
    disease: str(raw['disease'], '').trim(),
    freedom: str(raw['freedom'], '').trim()
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
    restWithLeader: bool(raw['restWithLeader'], d.restWithLeader),
    askForHealBelow: fraction(raw['askForHealBelow'], d.askForHealBelow)
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
    hideForOpener: bool(raw['hideForOpener'], d.hideForOpener),
    engage: ENGAGE_POLICIES.includes(engage as EngagePolicy) ? (engage as EngagePolicy) : d.engage,
    retaliate: bool(raw['retaliate'], d.retaliate),
    defendAfterRounds: int(raw['defendAfterRounds'], d.defendAfterRounds, 0, 20),
    politeAttacks: bool(raw['politeAttacks'], d.politeAttacks),
    // Capped where the retreat guard is, for the same reason: a room holding more
    // than twenty things is not a number anybody is tuning against.
    maxMobs: int(raw['maxMobs'], d.maxMobs, 0, 20),
    // Capped low on purpose: every round is a fraction of a second, so a client
    // asked to look every round would spend most of a fight looking.
    refreshRounds: int(raw['refreshRounds'], d.refreshRounds, 0, 20),
    mobRules: normalizeMobRules(raw['mobRules']),
    minMobs: int(raw['minMobs'], d.minMobs, 0, 99),
    maxMonsterExperience: int(raw['maxMonsterExperience'], d.maxMonsterExperience, 0, 100_000_000),
    // Capped far above any health the shipped realm states, so a typo cannot
    // silently mean "never fight anything".
    maxTargetHealth: int(raw['maxTargetHealth'], d.maxTargetHealth, 0, 1_000_000)
  };
}

function normalizeSafety(value: unknown): SafetyConfig {
  const raw = isRecord(value) ? value : {};
  const hangUp = isRecord(raw['hangUp']) ? raw['hangUp'] : {};
  const retreat = isRecord(raw['retreat']) ? raw['retreat'] : {};
  const pvp = isRecord(raw['pvp']) ? raw['pvp'] : {};
  const fleeGoto = isRecord(raw['fleeGoto']) ? raw['fleeGoto'] : {};
  const f = DEFAULT_CONFIG.automation.safety.retreat;
  const g = DEFAULT_CONFIG.automation.safety.fleeGoto;
  const d = DEFAULT_CONFIG.automation.safety.hangUp;
  const p = DEFAULT_CONFIG.automation.safety.pvp;
  return {
    retreat: {
      enabled: bool(retreat['enabled'], f.enabled),
      belowHealth: fraction(retreat['belowHealth'], f.belowHealth),
      belowMana: fraction(retreat['belowMana'], f.belowMana),
      // Zero is meaningful: never run merely because there are several.
      whenOutnumbered: int(retreat['whenOutnumbered'], f.whenOutnumbered, 0, 20),
      // Floored at a second. Anything shorter retries before the server has
      // had a chance to answer the first attempt.
      cooldownMs: int(retreat['cooldownMs'], f.cooldownMs, 1000, 60_000),
      strategy: oneOf<RetreatStrategy>(retreat['strategy'], RETREAT_STRATEGIES, f.strategy),
      safeHavenRoom: str(retreat['safeHavenRoom'], f.safeHavenRoom).trim()
    },
    fleeGoto: {
      enabled: bool(fleeGoto['enabled'], g.enabled),
      belowHealth: fraction(fleeGoto['belowHealth'], g.belowHealth),
      command: str(fleeGoto['command'], g.command).trim()
    },
    hangUp: {
      enabled: bool(hangUp['enabled'], d.enabled),
      belowHealth: fraction(hangUp['belowHealth'], d.belowHealth),
      penalties: bool(hangUp['penalties'], d.penalties),
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
  return resumeAt(health.restBelow, health.restTo, marginWhenUncapped);
}

/** The mana a journey held for mana walks on again at: the same pair, `meditateBelow`/`meditateTo`. */
export function resumeAtMana(health: HealthConfig, marginWhenUncapped: number): number {
  return resumeAt(health.meditateBelow, health.meditateTo, marginWhenUncapped);
}

/**
 * Whether a journey stays held for a vital (todo 825): under `below` to stop,
 * and once `held`, under `resume` to stay stopped. An unknown figure or
 * maximum never holds, and lets a held journey go.
 */
export function holdsForVital(
  value: number | null,
  max: number | null,
  below: number,
  resume: number,
  held: boolean
): boolean {
  if (below <= 0 || value === null || max === null || max <= 0) return false;
  return value / max < (held ? resume : below);
}

function resumeAt(below: number, to: number, marginWhenUncapped: number): number {
  if (to > 0) return to;
  return Math.min(1, below + marginWhenUncapped);
}

/** The connection target implied by the config, for the command strip. */
export function targetFromConfig(config: AppConfig): ConnectionTarget {
  return {
    host: config.connection.host,
    port: config.connection.port,
    encoding: config.connection.encoding
  };
}
