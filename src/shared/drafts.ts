/**
 * What a settings screen may ask the client to write down.
 *
 * These are the payloads that turn into **files on disk holding credentials**,
 * so they are parsed at the boundary and never merely checked — `asProfileDraft`
 * and `asServerDraft` return the typed value or `null`, so a caller cannot carry
 * on with something that only looked right. Same reasoning as `asRoute` and
 * `asConnectionTarget`: a malformed payload here is a character that dials
 * somewhere nobody chose, which is the failure mode a profile with no server is
 * refused for in the first place.
 *
 * Dependency-free, like the rest of `src/shared`.
 */
import {
  DEFAULT_CONFIG,
  ENGAGE_POLICIES,
  RETREAT_STRATEGIES,
  type BlessingTarget,
  type DensityPreference,
  type EngagePolicy,
  type RetreatStrategy,
  type PotionVerb,
  type PvpAction,
  type EncumbranceGate,
  type TabsPreference
} from './config';
import { DENOMINATIONS, type Denomination } from './character';
import { asLoops, type Loop } from './loops';

/**
 * A load gate as the draft carries it: a closed union, so an unrecognised word
 * from a hand-edited file becomes `never` rather than being passed through to
 * a comparison that would silently never match.
 */
const GATES: readonly EncumbranceGate[] = ['never', 'medium', 'heavy'];
const asGate = (value: unknown): EncumbranceGate =>
  GATES.find(
    (known) =>
      known ===
      String(value ?? '')
        .trim()
        .toLowerCase()
  ) ?? 'never';
import { PROFILE_ACCENTS, type ProfileAccent } from './profiles';
import { isThemePreference, type ThemePreference } from './themes';
import type { StreamEncoding } from './types';
import { isRecord } from './values';
import { isRemoteName, type RemoteGrant, type RemoteName } from './remotes';

const ENCODINGS: readonly StreamEncoding[] = ['cp437', 'utf8', 'latin1'];

/** See `ProfileDraft.loops`: a ceiling on a payload, not a limit on a loop. */
const LOOP_LIMITS = { loops: 200, stops: 500 } as const;

/**
 * One loop, from a payload that crossed the IPC boundary.
 *
 * The Loops modal sends a loop main is about to write into a file the user
 * owns, so it is **parsed, not checked** — through `asLoops`, which is the one
 * place the client decides what a loop is, and under the same ceiling every
 * other loop payload passes: a window bug must not become an unbounded file on
 * disk. Null for anything that is not one, which the caller refuses out loud.
 */
export function asLoop(value: unknown): Loop | null {
  return asLoops([value], LOOP_LIMITS)[0] ?? null;
}

/** One menu this BBS asks, and the answer to give it. */
export interface LoginStepDraft {
  when: string;
  send: string;
}

/** A saved place, and how to get through its menus. */
export interface ServerDraft {
  name: string;
  host: string;
  port: number;
  encoding: StreamEncoding;
  /**
   * The menu script, in the order the menus arrive.
   *
   * On the server because that is what it belongs to: every character on one
   * BBS meets the same menus. See `Server.login`.
   */
  login: LoginStepDraft[];
  /**
   * The loops every character on this server may walk.
   *
   * On the server for the same reason the menus are: a loop names *rooms in a
   * realm*, so it is a fact about the place rather than about whoever is
   * walking it, and one recorded for a realm is worth having on every
   * character that plays there. Written as files under
   * `servers/<id>/loops/`, like every other loop — see `LoopStore`.
   */
  loops: Loop[];
  /**
   * The realm database every character here plays against. Empty is the shipped
   * one.
   *
   * On the realm for the same reason the menus and the loops are: a map is a
   * fact about the place. It used to sit on the character, which made it the
   * same answer written out once per character on that realm — and a character
   * added afterwards silently got a different map from the ones beside it. See
   * `Server.database`.
   */
  database: string;
}

/**
 * Everything the options file holds that a form can state — `global/default.yaml`.
 *
 * The client's own settings, which every character inherits and any of them may
 * override in its own file. Deliberately **not** the whole file: `automation.
 * rules` and `automation.events` are lists of expressions with comments
 * explaining why, which is what YAML is genuinely good at and what this screen
 * has never covered. The rule is the one `SettingsScreen` states: a section
 * exists when there is a typed block behind it, not because the nouns sort
 * cleanly — and a form field for a rule would be a second representation of
 * something the template already says better.
 *
 * `servers:` is absent because a server is a directory of its own now, with its
 * own page.
 */
export interface GlobalDraft {
  /**
   * What a new realm starts with: an address and the menu steps. No account and
   * no autoconnect — those belong to a character, and the anonymous session
   * that once spent them from here was retired 2026-08-29.
   */
  connection: {
    host: string;
    port: number;
    encoding: StreamEncoding;
    login: {
      steps: LoginStepDraft[];
    };
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    cursorBlink: boolean;
    cursorStyle: 'block' | 'underline' | 'bar';
  };
  ui: {
    fontFamily: string;
    theme: ThemePreference;
    density: DensityPreference;
    tabs: TabsPreference;
    showHud: boolean;
    vitals: { hp: VitalDraft; mana: VitalDraft };
    alerts: ProfileDraft['alerts'];
  };
  logging: {
    enabled: boolean;
    directory: string;
    capture: boolean;
    fights: boolean;
    conversations: boolean;
    conversationDays: number;
    maxBytes: number;
  };
  automation: {
    enabled: boolean;
    onEnterRealm: string[];
    onPartyChange: string;
    idle: { enabled: boolean; afterSeconds: number; command: string };
    pacing: { window: number; minGapMs: number; ackTimeoutMs: number };
    walk: { stepTimeoutMs: number; clearAfterSeconds: number };
    hangUp: ProfileDraft['hangUp'];
    retreat: ProfileDraft['retreat'];
    pvp: ProfileDraft['pvp'];
    combat: ProfileDraft['combat'];
    party: ProfileDraft['party'];
    health: ProfileDraft['health'];
    movement: ProfileDraft['movement'];
    spells: {
      attack: string;
      areaAttack: string;
      areaMinMobs: number;
      areaMinMana: number;
      heal: string;
      healPartyWith: string;
      healBelow: number;
      healBelowInCombat: number;
      healTo: number;
      healParty: boolean;
      minMana: number;
      cures: CuresDraft;
      blessings: BlessingDraft[];
      notifyPartyOnWearOff: boolean;
    };
    loot: {
      coins: boolean;
      coinKinds: Denomination[];
      items: string[];
      minPrice: number;
      maxEncumbrance: number;
      stopAtGrade: EncumbranceGate;
      convertWith: string;
      convertAt: EncumbranceGate;
    };
    drop: { enabled: boolean; items: string[]; whenEncumbered: boolean; worthless: boolean };
    /** Looking for what a room did not print. See `SearchConfig`. */
    search: { enabled: boolean; tries: number };
    banking: { autoDeposit: boolean; depositThresholdCopper: number; keepCopper: number };
    remotes: ProfileDraft['remotes'];
    talk: ProfileDraft['talk'];
  };
  /** The loops every character may walk: `global/loops/`. */
  loops: Loop[];
}

/** One vital's two thresholds, as fractions of maximum. */
export interface VitalDraft {
  caution: number;
  critical: number;
}

/**
 * Where a character plays: a name from `servers:`, or an address spelled out.
 *
 * Both are allowed because both are in the file format already, and a screen
 * that only offered saved servers would make the first character impossible to
 * create.
 */
export type ServerChoice =
  | { kind: 'saved'; name: string }
  | { kind: 'inline'; host: string; port: number; encoding: StreamEncoding };

/**
 * What a person fills in about a character.
 *
 * Deliberately *not* the whole profile file. A profile is a sparse overlay and
 * may carry an `automation:` or `ui:` block that this screen knows nothing
 * about; writing a draft must leave those alone rather than replacing the file
 * with the fields a form happened to have. Editing YAML is what YAML is good
 * at, and the screen exists for the parts it is not.
 */
/** One curative spell per affliction the client can see; blank casts nothing. */
export interface CuresDraft {
  blindness: string;
  poison: string;
  disease: string;
}

/** A blessing kept up by events with a clock behind it; see `BlessingConfig`. */
export interface BlessingDraft {
  /** The row's identity as well as what is cast; see `BlessingConfig.spell`. */
  spell: string;
  target: BlessingTarget;
  minMana: number;
  prioritizeOverHeal: boolean;
  inCombat: boolean;
  /** Party rows only, as in the config; a self row carries none. */
  fallbackSeconds?: number;
}

export interface ProfileDraft {
  /** Display name. The file name is the id and is passed separately. */
  name: string;
  server: ServerChoice;
  username: string;
  /**
   * Only meaningful when `changePassword` is true.
   *
   * A settings screen is never *told* the current password — one that has
   * crossed to a renderer can reach a devtools snapshot, a crash report or a
   * screenshot — so a blank field cannot mean "no password", only "I did not
   * touch this". The flag is what separates the two, rather than leaving the
   * client to guess which a blank field meant.
   */
  password: string;
  changePassword: boolean;
  autoConnect: boolean;
  /**
   * Dial this character again when a connection is **lost**.
   *
   * On unless the file says otherwise, unlike every other boolean here and
   * unlike `autoConnect` above it: that one opens a connection nobody asked
   * for, this one puts back the one somebody had. See `Profile.autoReconnect`.
   */
  autoReconnect: boolean;
  accent: ProfileAccent;
  /**
   * This character's own theme, or '' to follow the options file.
   *
   * Written as `ui.theme` in the profile, which is the same sparse overlay
   * every other per-character setting uses — so nothing new is resolved,
   * only stated somewhere a form can reach.
   */
  theme: ThemePreference | '';
  /**
   * This character's own menu script, when it needs one.
   *
   * Empty means "use the server's", which is the ordinary case — the script is
   * a property of the BBS. A character states its own only to differ from the
   * others on that BBS, which in practice means a different character slot.
   */
  login: LoginStepDraft[];
  /**
   * Hanging up to escape — see `HangUpConfig`, and read it before turning this
   * on. On this server family a panic disconnect is one of the more reliable
   * ways to die.
   */
  hangUp: {
    enabled: boolean;
    belowHealth: number;
    onlyWhenClean: boolean;
    onPlayerInRoom: boolean;
  };
  /** Running away — the escape that works, and the one to offer first. */
  retreat: {
    enabled: boolean;
    belowHealth: number;
    whenOutnumbered: number;
    strategy: RetreatStrategy;
    safeHavenRoom: string;
  };
  /** What to do the moment a player opens on this character — `automation.safety.pvp`. */
  pvp: { notifyGang: boolean; action: PvpAction };
  /**
   * Fighting on the character's behalf — see `CombatConfig`.
   *
   * Here rather than in `automation.rules` for the reason stated there: the
   * question in the middle of it, *is the thing in front of me going to attack
   * me and is it a person*, is not one a guard expression can ask. What is left
   * is a handful of switches, two thresholds and three word lists — which is
   * exactly the shape this screen exists for and exactly what YAML is worst at.
   *
   * The lists are one text field each in the form and arrive here already
   * split; `normalizeCombat` keys them the way the wire spells a monster.
   */
  combat: {
    enabled: boolean;
    attack: string;
    opener: string;
    engage: EngagePolicy;
    retaliate: boolean;
    maxMobs: number;
    minHealth: number;
    whileWalking: boolean;
    refreshRounds: number;
    avoid: string[];
    /** Refusals about a *kind* of monster, from the realm's own columns. */
    avoidUndead: boolean;
    avoidDeathSpell: boolean;
    maxTargetHealth: number;
    minMobs: number;
    maxMonsterExperience: number;
    prefer: string[];
  };
  /**
   * The three blocks a rule cannot hold, in MegaMUD's own tabs.
   *
   * Shaped exactly like the config they patch, because they *are* what gets
   * written: `SettingsEditor` sets the block whole when it differs from the
   * shipped default and deletes it when it does not, so a character that has
   * never been near this screen keeps a file with none of them in it.
   */
  /** Following somebody — `automation.party`. Off, and why, in `PartyConfig`. */
  party: {
    assistLeader: boolean;
    defendParty: boolean;
    restWithLeader: boolean;
  };
  health: {
    restBelow: number;
    restTo: number;
    meditateBelow: number;
    drinkHealingPotionBelow: number;
    drinkManaPotionBelow: number;
    potionVerb: PotionVerb;
    healingPotionName: string;
    manaPotionName: string;
  };
  movement: {
    openDoors: boolean;
    openTries: number;
    pickLocks: boolean;
    pickTries: number;
    bashDoors: boolean;
    bashTries: number;
    sneak: boolean;
    provideLight: boolean;
    lightDimRooms: boolean;
    extinguishInLight: boolean;
  };
  /**
   * The loops this character walks — `automation.loops`.
   *
   * On the form because a loop is a *list of places* and nothing else: a name
   * and some rooms, with no guard expression and no timing, which is exactly
   * the shape a picker can offer and YAML is only adequate at. The client
   * ships 420 of MegaMUD's own in `resources/loops/megamud.yaml`, and the
   * whole point of the Movement tab holding this is that choosing one should
   * not mean copying forty lines of YAML by hand.
   *
   * **Whole, never a delta.** `overlay` replaces lists rather than merging
   * them, so a profile that states this means *these loops* — which is why
   * `SettingsEditor` writes the key only when the list differs from the one
   * the character would inherit, and deletes it when it does not.
   */
  loops: Loop[];
  spells: {
    attack: string;
    areaAttack: string;
    areaMinMobs: number;
    areaMinMana: number;
    /**
     * The heal, per character.
     *
     * These were on the Global page alone until 2026-09-02, which made the one
     * setting a healer most wants to differ between characters the one that
     * could not: every character on the machine shared a heal spell and a
     * threshold, and the character form had no field to override them with. A
     * setting nobody can reach is one that was never built.
     */
    heal: string;
    healPartyWith: string;
    healBelow: number;
    healBelowInCombat: number;
    healTo: number;
    healParty: boolean;
    minMana: number;
    cures: CuresDraft;
    blessings: BlessingDraft[];
    notifyPartyOnWearOff: boolean;
  };
  /**
   * Which alerts this character raises — `ui.alerts`, not `automation.*`.
   *
   * In the character form because it is a fact about *this player watching this
   * character*: a healer wants the party channel and a soloing thief does not,
   * and the rail already remembers which cards each of them keeps.
   */
  alerts: { minimum: string; mute: string[] };
  /**
   * Whether this character answers another player's `@` commands —
   * `automation.remotes`.
   *
   * Per character rather than only globally, because *which* character is
   * reachable is the decision somebody actually makes: a pair run together
   * answering each other, and the one being played by hand left alone. A single
   * global switch would make that impossible to express.
   */
  remotes: RemotesDraft;
  /** `automation.talk` — what this character learns about other people. */
  talk: TalkDraft;
}

/** The `automation.talk` block as a form edits it. */
export interface TalkDraft {
  lookAtPlayers: boolean;
}

/**
 * The `automation.remotes` block as a form edits it.
 *
 * `enabled` is the switch — be reachable at all — `gangpath` is whether the
 * gang's own channel is one of them, and the three below are the gate: what the
 * gang may ask for, what the party may, and what each named person may and may
 * not.
 *
 * **`players` is in the draft even though no settings form edits it.** The
 * Player flyout writes it through its own narrow channel, and `SettingsEditor`
 * replaces the whole `automation.remotes` block on a profile save — so a draft
 * without it would silently delete every per-player permission the moment
 * somebody pressed Save on an unrelated field. That is the shape of bug this
 * codebase already wrote down for a card saving a stale copy of a form it never
 * showed, in the other direction.
 */
export interface RemotesDraft {
  enabled: boolean;
  gangpath: boolean;
  /** What anybody in this character's gang may ask for. Validated against `REMOTE_NAMES`. */
  gang: RemoteName[];
  /** What anybody who has joined this character's party may ask for. */
  party: RemoteName[];
  /** Per-player grants, carried through untouched. See above. */
  players: Record<string, RemoteGrant>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A port, or null.
 *
 * Refused rather than coerced: a port outside the range is a typo, and quietly
 * dialling 1 or 70000 wastes the fifteen seconds of the connect deadline before
 * saying anything useful.
 */
function port(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number.parseInt(text(value), 10);
  if (!Number.isInteger(number) || number < 1 || number > 65535) return null;
  return number;
}

function encoding(value: unknown): StreamEncoding | null {
  return ENCODINGS.includes(value as StreamEncoding) ? (value as StreamEncoding) : null;
}

/**
 * A file name a character can safely be stored under.
 *
 * The id is the filename, which is also the session id, the log name, the
 * capture name and the key every remembered UI preference hangs off — so it has
 * to be something a filesystem accepts everywhere and something `grep` finds.
 * Anything that could climb out of the profiles directory is refused outright
 * rather than sanitised, because a sanitised path is one nobody can predict.
 */
export function asProfileId(value: unknown): string | null {
  const id = text(value).toLowerCase();
  if (id.length === 0 || id.length > 48) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null;
  return id;
}

export function asServerDraft(value: unknown): ServerDraft | null {
  if (!isRecord(value)) return null;
  const name = text(value['name']);
  const host = text(value['host']);
  if (name.length === 0 || name.length > 64) return null;
  if (host.length === 0 || host.length > 255) return null;
  const number = port(value['port']);
  const stream = encoding(value['encoding']);
  if (number === null || stream === null) return null;
  return {
    name,
    host,
    port: number,
    encoding: stream,
    login: asLoginSteps(value['login']),
    // Bounded like a character's, and for the same reason: this crossed the
    // IPC boundary, so it is parsed rather than trusted.
    loops: asLoops(value['loops'], LOOP_LIMITS),
    database: text(value['database']).slice(0, 400)
  };
}

/**
 * A menu script from a window.
 *
 * A step with no `when` is dropped rather than refusing the whole save: an
 * editor with a `+` produces a blank row the moment somebody presses it, and
 * refusing the save until every row is filled in would make the button hostile.
 * An empty `send` is kept — it is a bare Enter, which several menus want.
 */
function asLoginSteps(value: unknown): LoginStepDraft[] {
  if (!Array.isArray(value)) return [];
  const steps: LoginStepDraft[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const when = text(entry['when']);
    if (when.length === 0 || when.length > 200) continue;
    steps.push({ when, send: text(entry['send']).slice(0, 200) });
  }
  return steps;
}

function asServerChoice(value: unknown): ServerChoice | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'saved') {
    const name = text(value['name']);
    return name.length > 0 && name.length <= 64 ? { kind: 'saved', name } : null;
  }
  if (value['kind'] === 'inline') {
    const host = text(value['host']);
    const number = port(value['port']);
    const stream = encoding(value['encoding']);
    if (host.length === 0 || host.length > 255 || number === null || stream === null) return null;
    return { kind: 'inline', host, port: number, encoding: stream };
  }
  return null;
}

export function asProfileDraft(value: unknown): ProfileDraft | null {
  if (!isRecord(value)) return null;
  const server = asServerChoice(value['server']);
  // Rule 2 of `profiles.ts`: a profile that cannot name a server is not a
  // profile. Refusing it here is what stops the screen creating one.
  if (server === null) return null;

  const name = text(value['name']);
  if (name.length > 64) return null;

  const accent = value['accent'];

  const hangUp = isRecord(value['hangUp']) ? value['hangUp'] : {};
  const retreat = isRecord(value['retreat']) ? value['retreat'] : {};
  const pvp = isRecord(value['pvp']) ? value['pvp'] : {};
  const combat = isRecord(value['combat']) ? value['combat'] : {};
  const health = isRecord(value['health']) ? value['health'] : {};
  const party = isRecord(value['party']) ? value['party'] : {};
  const movement = isRecord(value['movement']) ? value['movement'] : {};
  const spells = isRecord(value['spells']) ? value['spells'] : {};
  const alerts = isRecord(value['alerts']) ? value['alerts'] : {};
  const remotes = isRecord(value['remotes']) ? value['remotes'] : {};

  return {
    name,
    server,
    // Not trimmed to a maximum: a password is the user's, and truncating one
    // silently is how an account becomes unreachable from the client that did
    // it. Passed through as typed.
    username: text(value['username']),
    password: typeof value['password'] === 'string' ? value['password'] : '',
    changePassword: value['changePassword'] === true,
    autoConnect: value['autoConnect'] === true,
    // `!== false`: on unless it was turned off. See the field.
    autoReconnect: value['autoReconnect'] !== false,
    accent: PROFILE_ACCENTS.includes(accent as ProfileAccent)
      ? (accent as ProfileAccent)
      : PROFILE_ACCENTS[0],
    theme: isThemePreference(value['theme']) ? value['theme'] : '',
    login: asLoginSteps(value['login']),
    hangUp: {
      enabled: hangUp['enabled'] === true,
      // Clamped rather than refused: a fraction outside the range is a slider
      // that got dragged, not a decision, and refusing the whole save over it
      // would lose everything else on the form.
      belowHealth: Math.min(1, Math.max(0, Number(hangUp['belowHealth']) || 0)),
      /*
       * Defaults to *true* when absent, unlike every other boolean here.
       * Everything else defaults cautiously because caution is cheap; this one
       * defaults cautiously because the alternative can cost a character.
       */
      onlyWhenClean: hangUp['onlyWhenClean'] !== false,
      onPlayerInRoom: hangUp['onPlayerInRoom'] === true
    },
    retreat: {
      enabled: retreat['enabled'] === true,
      belowHealth: Math.min(1, Math.max(0, Number(retreat['belowHealth']) || 0)),
      whenOutnumbered: Math.min(
        20,
        Math.max(0, Math.trunc(Number(retreat['whenOutnumbered']) || 0))
      ),
      strategy: RETREAT_STRATEGIES.includes(retreat['strategy'] as RetreatStrategy)
        ? (retreat['strategy'] as RetreatStrategy)
        : 'step-back',
      safeHavenRoom: text(retreat['safeHavenRoom']).slice(0, 80)
    },
    pvp: {
      notifyGang: pvp['notifyGang'] === true,
      action: pvp['action'] === 'retreat' ? 'retreat' : 'none'
    },
    combat: {
      enabled: combat['enabled'] === true,
      /*
       * Defaulted rather than passed through empty, unlike `opener`. A blank
       * attack verb would send a bare newline at whatever is in the room, which
       * on this server re-reads the room — so a cleared field would look like
       * auto-combat doing nothing while it spent a command per status line.
       * Blank *is* meaningful for `opener`: it means the character has none.
       */
      attack: word(combat['attack']) || 'a',
      opener: word(combat['opener']),
      engage: engagePolicy(combat['engage']),
      // The one boolean here that defaults *on*, because it is the one that
      // cannot start a fight: something is already swinging. See `CombatConfig`.
      retaliate: combat['retaliate'] !== false,
      maxMobs: Math.min(20, Math.max(0, Math.trunc(Number(combat['maxMobs']) || 0))),
      minHealth: Math.min(1, Math.max(0, Number(combat['minHealth']) || 0)),
      whileWalking: combat['whileWalking'] === true,
      // Capped low: every round is a fraction of a second, so a client asked to
      // look every round would spend most of a fight looking.
      refreshRounds: Math.min(20, Math.max(0, Math.trunc(Number(combat['refreshRounds']) || 0))),
      avoid: words(combat['avoid'], 64),
      avoidUndead: combat['avoidUndead'] === true,
      avoidDeathSpell: combat['avoidDeathSpell'] === true,
      maxTargetHealth: Math.max(0, Math.round(Number(combat['maxTargetHealth']) || 0)),
      minMobs: Math.max(0, Math.min(99, Math.round(Number(combat['minMobs']) || 0))),
      maxMonsterExperience: Math.max(0, Math.round(Number(combat['maxMonsterExperience']) || 0)),
      prefer: words(combat['prefer'], 64)
    },
    /*
     * Every threshold is a fraction and every one is clamped here as well as in
     * `normalizeConfig`, because this is the *boundary*: a payload that reached
     * the network is parsed, not trusted, and the value on the other end of it
     * is a number a form put in a string.
     */
    party: {
      assistLeader: party['assistLeader'] === true,
      defendParty: party['defendParty'] === true,
      restWithLeader: party['restWithLeader'] === true
    },
    health: {
      /*
       * The shipped pair when a payload omits them, rather than 0.
       *
       * These two carry the loop's health hold since the pairs were folded
       * together, and the rule that made `loopPauseBelow` default this way
       * came with them: a missing key must not turn the hold off, which 0
       * would do, and a form that failed to send a field would silently set a
       * lap marching at any health at all.
       */
      restBelow: unit(health['restBelow'], DEFAULT_CONFIG.automation.health.restBelow),
      restTo: unit(health['restTo'], DEFAULT_CONFIG.automation.health.restTo),
      meditateBelow: unit(health['meditateBelow']),
      drinkHealingPotionBelow: unit(health['drinkHealingPotionBelow']),
      drinkManaPotionBelow: unit(health['drinkManaPotionBelow']),
      potionVerb: health['potionVerb'] === 'use' ? 'use' : 'drink',
      healingPotionName: text(health['healingPotionName']).slice(0, 40),
      manaPotionName: text(health['manaPotionName']).slice(0, 40)
    },
    movement: {
      openDoors: movement['openDoors'] === true,
      openTries: Math.min(3, Math.max(0, Math.trunc(Number(movement['openTries']) || 0))),
      // Ten rather than three: unlike `open`, forcing is a roll rather than an
      // answer — `captures/002` needed three picks and `captures/005` two
      // bashes — so a budget capped at the opener's would refuse the attempts
      // the captures show actually working.
      pickLocks: movement['pickLocks'] === true,
      pickTries: Math.min(10, Math.max(0, Math.trunc(Number(movement['pickTries']) || 0))),
      bashDoors: movement['bashDoors'] === true,
      bashTries: Math.min(10, Math.max(0, Math.trunc(Number(movement['bashTries']) || 0))),
      sneak: movement['sneak'] === true,
      provideLight: movement['provideLight'] === true,
      lightDimRooms: movement['lightDimRooms'] === true,
      extinguishInLight: movement['extinguishInLight'] === true
    },
    /*
     * Parsed by the same function the options file goes through, so a loop
     * chosen on the screen and a loop typed into YAML cannot mean different
     * things — and bounded, because this one crossed the wire. The caps are
     * far above any loop anybody walks (MegaMUD's longest of 420 is under
     * forty stops); they exist so a window bug cannot write an unbounded file.
     */
    loops: asLoops(value['loops'], LOOP_LIMITS),
    spells: {
      // The whole name, unlike a command word: the server matches a spell on a
      // prefix, so `ice` would cast whatever begins with it.
      attack: typeof spells['attack'] === 'string' ? spells['attack'].trim().slice(0, 40) : '',
      areaAttack:
        typeof spells['areaAttack'] === 'string' ? spells['areaAttack'].trim().slice(0, 40) : '',
      areaMinMobs: Math.max(1, Math.min(99, Math.round(Number(spells['areaMinMobs']) || 3))),
      areaMinMana: unit(spells['areaMinMana']),
      heal: typeof spells['heal'] === 'string' ? spells['heal'].trim().slice(0, 40) : '',
      healPartyWith:
        typeof spells['healPartyWith'] === 'string'
          ? spells['healPartyWith'].trim().slice(0, 40)
          : '',
      healBelow: unit(spells['healBelow']),
      healBelowInCombat: unit(spells['healBelowInCombat']),
      healTo: unit(spells['healTo']),
      healParty: spells['healParty'] === true,
      minMana: unit(spells['minMana']),
      cures: asCures(spells['cures']),
      blessings: asBlessings(spells['blessings']),
      notifyPartyOnWearOff: spells['notifyPartyOnWearOff'] === true
    },
    alerts: {
      // Anything else is `info`, which keeps everything: starting somebody off
      // with alerts already hidden is how a feature goes unfound.
      minimum: ['critical', 'warning', 'info'].includes(String(alerts['minimum']))
        ? String(alerts['minimum'])
        : 'info',
      mute: words(alerts['mute'], 24)
    },
    remotes: {
      enabled: remotes['enabled'] === true,
      gangpath: remotes['gangpath'] === true,
      gang: remoteNames(remotes['gang']),
      party: remoteNames(remotes['party']),
      players: playerGrants(remotes['players'])
    },
    talk: { lookAtPlayers: isRecord(value['talk']) && value['talk']['lookAtPlayers'] === true }
  };
}

/**
 * The options file's own draft, from a window.
 *
 * Parsed rather than checked, like every other payload here: this one becomes
 * `global/default.yaml`, which every character inherits, so a malformed field
 * is not one character dialling somewhere nobody chose but all of them.
 *
 * Nothing is refused for being out of range. Every number is clamped and every
 * union falls back, because there is no field on this form whose being odd is
 * worth losing the rest of the form over — the one thing that *is* refused is
 * a payload that is not a record at all, which is a bug rather than a value.
 */
export function asGlobalDraft(value: unknown): GlobalDraft | null {
  if (!isRecord(value)) return null;

  const connection = isRecord(value['connection']) ? value['connection'] : {};
  const login = isRecord(connection['login']) ? connection['login'] : {};
  const terminal = isRecord(value['terminal']) ? value['terminal'] : {};
  const ui = isRecord(value['ui']) ? value['ui'] : {};
  const vitals = isRecord(ui['vitals']) ? ui['vitals'] : {};
  const alerts = isRecord(ui['alerts']) ? ui['alerts'] : {};
  const logging = isRecord(value['logging']) ? value['logging'] : {};
  const automation = isRecord(value['automation']) ? value['automation'] : {};
  const idle = isRecord(automation['idle']) ? automation['idle'] : {};
  const pacing = isRecord(automation['pacing']) ? automation['pacing'] : {};
  const walk = isRecord(automation['walk']) ? automation['walk'] : {};
  const spells = isRecord(automation['spells']) ? automation['spells'] : {};
  const loot = isRecord(automation['loot']) ? automation['loot'] : {};
  const drop = isRecord(automation['drop']) ? automation['drop'] : {};
  const search = isRecord(automation['search']) ? automation['search'] : {};
  const banking = isRecord(automation['banking']) ? automation['banking'] : {};
  const remotes = isRecord(automation['remotes']) ? automation['remotes'] : {};

  /*
   * The character blocks, read by the function that already knows how. It
   * needs a server to return anything at all -- rule 2 of `profiles.ts` -- and
   * the options file names no server of its own, so one is supplied and
   * thrown away. Better than a second copy of eight blocks' worth of clamping
   * that could drift from the first.
   */
  const asIf = asProfileDraft({
    ...automation,
    server: { kind: 'inline', host: 'x', port: 1, encoding: 'cp437' },
    alerts
  });
  if (asIf === null) return null;

  return {
    connection: {
      host: text(connection['host']).slice(0, 255),
      port: port(connection['port']) ?? 23,
      encoding: encoding(connection['encoding']) ?? 'cp437',
      login: { steps: asLoginSteps(login['steps']) }
    },
    terminal: {
      fontFamily: text(terminal['fontFamily']).slice(0, 200),
      fontSize: clamp(terminal['fontSize'], 8, 48, 16),
      // A scrollback of nothing is a console you cannot read back, and one of
      // millions is memory nobody asked for.
      scrollback: clamp(terminal['scrollback'], 100, 1_000_000, 100_000),
      cursorBlink: terminal['cursorBlink'] === true,
      cursorStyle: oneOf(terminal['cursorStyle'], ['block', 'underline', 'bar'] as const, 'block')
    },
    ui: {
      fontFamily: text(ui['fontFamily']).slice(0, 200),
      theme: isThemePreference(ui['theme']) ? ui['theme'] : 'system',
      density: oneOf(ui['density'], ['auto', 'comfortable', 'compact'] as const, 'auto'),
      tabs: oneOf(ui['tabs'], ['top', 'left'] as const, 'left'),
      showHud: ui['showHud'] !== false,
      vitals: { hp: asVital(vitals['hp']), mana: asVital(vitals['mana']) },
      alerts: asIf.alerts
    },
    logging: {
      enabled: logging['enabled'] === true,
      directory: text(logging['directory']).slice(0, 400),
      capture: logging['capture'] === true,
      fights: logging['fights'] === true,
      conversations: logging['conversations'] === true,
      conversationDays: clamp(logging['conversationDays'], 1, 36500, 365),
      maxBytes: clamp(logging['maxBytes'], 0, 1_000_000_000, 50_000_000)
    },
    automation: {
      enabled: automation['enabled'] === true,
      onEnterRealm: words(automation['onEnterRealm'], 16),
      onPartyChange: word(automation['onPartyChange']),
      idle: {
        enabled: idle['enabled'] === true,
        // Never under five seconds: the server acknowledges one command per
        // status line, and anything faster starves the queue.
        afterSeconds: clamp(idle['afterSeconds'], 5, 3600, 45),
        command: word(idle['command'])
      },
      pacing: {
        window: clamp(pacing['window'], 1, 50, 8),
        minGapMs: clamp(pacing['minGapMs'], 0, 10_000, 120),
        ackTimeoutMs: clamp(pacing['ackTimeoutMs'], 100, 60_000, 4000)
      },
      walk: {
        stepTimeoutMs: clamp(walk['stepTimeoutMs'], 200, 60_000, 4000),
        clearAfterSeconds: clamp(walk['clearAfterSeconds'], 0, 3600, 20)
      },
      hangUp: asIf.hangUp,
      retreat: asIf.retreat,
      pvp: asIf.pvp,
      combat: asIf.combat,
      party: asIf.party,
      health: asIf.health,
      movement: asIf.movement,
      spells: {
        attack: text(spells['attack']).slice(0, 40),
        areaAttack: text(spells['areaAttack']).slice(0, 40),
        areaMinMobs: Math.max(1, Math.min(99, Math.round(Number(spells['areaMinMobs']) || 3))),
        areaMinMana: unit(spells['areaMinMana']),
        heal: text(spells['heal']).slice(0, 40),
        healPartyWith: text(spells['healPartyWith']).slice(0, 40),
        healBelow: unit(spells['healBelow']),
        healBelowInCombat: unit(spells['healBelowInCombat']),
        healTo: unit(spells['healTo']),
        healParty: spells['healParty'] === true,
        minMana: unit(spells['minMana']),
        cures: asCures(spells['cures']),
        blessings: asBlessings(spells['blessings']),
        notifyPartyOnWearOff: spells['notifyPartyOnWearOff'] === true
      },
      loot: {
        coins: loot['coins'] === true,
        coinKinds: Array.isArray(loot['coinKinds'])
          ? DENOMINATIONS.filter((name) => (loot['coinKinds'] as unknown[]).includes(name))
          : [...DENOMINATIONS],
        stopAtGrade: asGate(loot['stopAtGrade']),
        convertWith: text(loot['convertWith']).slice(0, 40),
        convertAt: asGate(loot['convertAt']),
        items: words(loot['items'], 32),
        minPrice: Math.max(0, Math.round(Number(loot['minPrice']) || 0)),
        maxEncumbrance: Math.max(0, Math.round(Number(loot['maxEncumbrance']) || 0))
      },
      drop: {
        enabled: drop['enabled'] === true,
        items: words(drop['items'], 32),
        whenEncumbered: drop['whenEncumbered'] === true,
        worthless: drop['worthless'] === true
      },
      search: {
        enabled: search['enabled'] === true,
        // Floored at one for the reason `normalizeSearch` states: `enabled` is
        // what turns it off, and "on, zero searches" is a switch somebody flips
        // and then waits to see work.
        tries: clamp(search['tries'], 1, 5, 1)
      },
      banking: {
        autoDeposit: banking['autoDeposit'] === true,
        depositThresholdCopper: Math.max(
          0,
          Math.min(1_000_000_000, Math.round(Number(banking['depositThresholdCopper']) || 0))
        ),
        keepCopper: Math.max(
          0,
          Math.min(1_000_000_000, Math.round(Number(banking['keepCopper']) || 0))
        )
      },
      remotes: {
        enabled: remotes['enabled'] === true,
        gangpath: remotes['gangpath'] === true,
        gang: remoteNames(remotes['gang']),
        party: remoteNames(remotes['party']),
        players: playerGrants(remotes['players'])
      },
      talk: {
        lookAtPlayers: isRecord(automation['talk']) && automation['talk']['lookAtPlayers'] === true
      }
    },
    loops: asLoops(value['loops'], LOOP_LIMITS)
  };
}

function asVital(value: unknown): VitalDraft {
  const record = isRecord(value) ? value : {};
  return { caution: unit(record['caution']), critical: unit(record['critical']) };
}

/** A whole number inside a range, defaulted rather than refused. */
function clamp(value: unknown, low: number, high: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, Math.trunc(number)));
}

/** One of a closed set, or the default. A guess is never passed through. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** One command word. A field somebody typed a sentence into is not one. */
/**
 * A 0-1 fraction from a payload that crossed the wire.
 *
 * Every threshold this client holds is a fraction of maximum rather than a
 * number of points, so one setting holds at every level — and every one of them
 * is clamped twice: here, because this is the boundary and a payload that
 * reached the network is parsed rather than trusted, and again in
 * `normalizeConfig`, because a file somebody edited by hand never came through
 * here at all.
 */
function unit(value: unknown, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function word(value: unknown): string {
  return text(value).split(/\s+/)[0] ?? '';
}

/**
 * A list of names or verbs from the form.
 *
 * Kept as whole entries rather than split on whitespace, because a monster is
 * called `giant rat` and splitting would make it two. The command lists are
 * clamped to a single word by `normalizeCombat`, which is where the difference
 * belongs — this is the boundary parser and its job is to refuse nonsense, not
 * to decide what a round verb is.
 */
/**
 * The remotes a form states, keeping only ones the union has.
 *
 * The runtime half of the closed union, in the draft layer as well as the
 * config layer — a form is a place a value arrives from outside just as much as
 * a YAML file is, and a name that got past here would be written to the user's
 * own options file and dropped on the way back in, which reads as a permission
 * that will not stick.
 */
function remoteNames(value: unknown): RemoteName[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter(isRemoteName);
  return [...new Set(names)];
}

/** The per-player grants, keyed lower-case and bounded like every other list here. */
function playerGrants(value: unknown): Record<string, RemoteGrant> {
  if (!isRecord(value)) return {};
  const out: Record<string, RemoteGrant> = {};
  for (const [name, grant] of Object.entries(value).slice(0, 256)) {
    const key = text(name).toLowerCase().slice(0, 64);
    if (key.length === 0 || !isRecord(grant)) continue;
    out[key] = { allow: remoteNames(grant['allow']), deny: remoteNames(grant['deny']) };
  }
  return out;
}

function words(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const one = text(entry).slice(0, 64);
    if (one.length > 0) out.push(one);
    if (out.length >= limit) break;
  }
  return out;
}

function engagePolicy(value: unknown): EngagePolicy {
  return ENGAGE_POLICIES.includes(value as EngagePolicy) ? (value as EngagePolicy) : 'hostile';
}

/** The three cure names, trimmed and bounded like every other spell name here. */
function asCures(value: unknown): CuresDraft {
  const raw = isRecord(value) ? value : {};
  return {
    blindness: text(raw['blindness']).slice(0, 40),
    poison: text(raw['poison']).slice(0, 40),
    disease: text(raw['disease']).slice(0, 40)
  };
}

/**
 * The blessing list, parsed rather than trusted. A row with no spell is
 * dropped — the spell is both what is sent and the row's identity, and has
 * no value that means anything absent — and two rows naming one spell *and
 * one target* are one, the first winning, since the order is the priority
 * (the same spell on self and on party is two legitimate rows). The party clock
 * is floored at thirty seconds so a typo cannot cast every tick; a self row
 * carries no clock at all, its watchdog being measured rather than typed.
 * `inCombat` defaults by target, the same reading `normalizeBlessings`
 * gives the options file.
 */
function asBlessings(value: unknown): BlessingDraft[] {
  if (!Array.isArray(value)) return [];
  const rows: BlessingDraft[] = [];
  for (const row of value.filter(isRecord).slice(0, 16)) {
    const spell = text(row['spell']).slice(0, 40);
    if (spell.length === 0) continue;
    const target: BlessingTarget = row['target'] === 'party' ? 'party' : 'self';
    if (
      rows.some(
        (seen) => seen.spell.toLowerCase() === spell.toLowerCase() && seen.target === target
      )
    )
      continue;
    rows.push({
      spell,
      target,
      minMana: unit(row['minMana']),
      prioritizeOverHeal: row['prioritizeOverHeal'] === true,
      inCombat: typeof row['inCombat'] === 'boolean' ? row['inCombat'] : target === 'self',
      ...(target === 'party'
        ? {
            fallbackSeconds: Math.min(
              86_400,
              Math.max(30, Math.trunc(Number(row['fallbackSeconds']) || 300))
            )
          }
        : {})
    });
  }
  return rows;
}
