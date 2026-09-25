/**
 * The character form as a value: what each field holds while it is typed, how
 * a profile becomes one (`formOf`, `copyOf`, `emptyForm`) and how one becomes
 * the draft the file wants (`draftOf`). Pure, so the component that draws it
 * (`CharacterForm`) and the screen that owns its history share one reading.
 * The why is in `mudengine-settings`.
 */
import { asShippedWorld } from '@shared/worlds';
import type { GearSet } from '@shared/gear';
import type { AlertRule } from '@shared/notifications';
import {
  DEFAULT_CONFIG,
  DEFAULT_REALM_NAME,
  RETREAT_STRATEGIES,
  type BankingConfig,
  type DropConfig,
  type EngagePolicy,
  type LootConfig,
  type PotionRule,
  type PvpAction,
  type RetreatStrategy,
  type RewritesUiConfig,
  type SearchConfig
} from '@shared/config';
import type { MobRule } from '@shared/mobRules';
import type { ProfileAccent } from '@shared/profiles';
import type { LocateWord } from '@shared/locate';
import type { ThemePreference } from '@shared/themes';
import type {
  BlessingDraft,
  CuresDraft,
  GlobalDraft,
  LoginStepDraft,
  ProfileDraft
} from '@shared/drafts';
import type { Loop } from '@shared/loops';
import type { ProfileEditable, SettingsSnapshot } from '@shared/ipc';
import type { StreamEncoding } from '@shared/types';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from '@shared/training';
import type { RemoteGrant, RemoteName } from '@shared/remotes';
import { fractionOf, percentOf } from './form';
import { sameJson } from './history';

/**
 * Whether a realm's `database` walks something other than the world the
 * shipped loops were recorded in. Blank follows the realm's own word, which the
 * settings screen cannot know, and is read as Paradigm's — the default.
 */
export function walksAnotherWorld(database: string): boolean {
  const stated = database.trim();
  return stated.length > 0 && asShippedWorld(stated) !== 'paradigm';
}

/** The shipped combat defaults, so a new character and the file agree. */
const DEFAULT_COMBAT = DEFAULT_CONFIG.automation.combat;
const DEFAULT_HEALTH = DEFAULT_CONFIG.automation.health;
const DEFAULT_MOVEMENT = DEFAULT_CONFIG.automation.movement;
const DEFAULT_SPELLS = DEFAULT_CONFIG.automation.spells;

/** The six wanted figures as the form holds them: strings, so a half-typed one is not a 0. */
function wantedStrings(
  wanted: Record<TrainedAttribute, string | number>
): Record<TrainedAttribute, string> {
  const out = {} as Record<TrainedAttribute, string>;
  for (const attribute of TRAINED_ATTRIBUTES) out[attribute] = String(wanted[attribute]);
  return out;
}
function wantedNumbers(wanted: Record<TrainedAttribute, string>): Record<TrainedAttribute, number> {
  const out = {} as Record<TrainedAttribute, number>;
  for (const attribute of TRAINED_ATTRIBUTES)
    out[attribute] = Number.parseInt(wanted[attribute], 10) || 0;
  return out;
}
const DEFAULT_ALERTS = DEFAULT_CONFIG.ui.alerts;

/**
 * Every section a character's own form is broken into, in the order shown.
 *
 * **MegaMUD's own tabs**, which is the point: `Options → Settings` there is
 * Combat, Health, Spells and Movement, and somebody configuring a MajorMUD
 * client has been reading those five words for twenty years. See
 * docs/terminology.md §2.2 — the realm's own vocabulary wins, then MegaMUD's,
 * then ours, and this is the middle rung.
 *
 * `Character` and `Login` are ours because MegaMUD had nothing to name: it ran
 * behind a terminal somebody else had already logged in with.
 */
export const CHARACTER_SECTIONS = [
  'profile',
  'login',
  'combat',
  'health',
  'spells',
  'party',
  'movement',
  'gear',
  'train',
  'quests',
  'remotes',
  'talk',
  'alerts',
  'rewrites'
] as const;
export type CharacterSection = (typeof CHARACTER_SECTIONS)[number];

export interface CharacterFields {
  id: string;
  name: string;
  accent: ProfileAccent;
  theme: ThemePreference | '';
  autoConnect: boolean;
  autoReconnect: boolean;
  serverName: string | null;
  host: string;
  port: string;
  encoding: StreamEncoding;
  username: string;
  password: string;
  changePassword: boolean;
  /**
   * This character's own menu script, empty when it uses the server's.
   *
   * Empty is the ordinary case — the script belongs to the realm. A character
   * states one only to differ from the others on that realm, which in practice
   * means a different character slot.
   */
  login: LoginStepDraft[];
  /** This character's own locate word, null where it follows its realm (todo 811). */
  locate: LocateWord | null;
  hangUp: boolean;
  hangUpBelow: string;
  /** This character's own answer, null where it is left to the realm (todo 01). */
  hangUpPenalties: boolean | null;
  hangUpOnPlayer: boolean;
  pvpNotifyGang: boolean;
  pvpAction: PvpAction;
  retreat: boolean;
  retreatBelow: string;
  /** MegaMUD's `ManaRun%`, as a percentage string like `retreatBelow`. */
  retreatBelowMana: string;
  retreatOutnumbered: string;
  retreatStrategy: string;
  retreatHaven: string;
  /** The teleport below the retreat (todo 813); an empty command follows the realm. */
  fleeGoto: boolean;
  fleeGotoBelow: string;
  fleeGotoCommand: string;
  /**
   * Auto-combat, as the form holds it.
   *
   * The three lists are one comma-separated text field each rather than a row
   * editor like the login menus. A login step is two fields that have to stay
   * paired; these are just names, and a `+`-and-`×` list for typing three words
   * into is more chrome than the thing it holds.
   */
  combat: boolean;
  combatAttack: string;
  combatOpener: string;
  /** Hide (or sneak, while moving) between fights so the opener lands again. */
  combatHideForOpener: boolean;
  combatEngage: EngagePolicy;
  combatRetaliate: boolean;
  combatDefendAfterRounds: string;
  /** Leave alone a monster a stranger is already fighting — MegaMUD's PoliteAttacks. */
  combatPoliteAttacks: boolean;
  combatMaxMobs: string;
  /** Share of current health a fight may be expected to cost, as a percentage string. */
  /** Following somebody — `automation.party`. */
  partyAssist: boolean;
  partyDefend: boolean;
  partyRest: boolean;
  /** `party.askForHealBelow`, as a percentage string. */
  partyAskHeal: string;
  combatRefresh: string;
  /** The player's own rules for the realm's monsters. See `MobRuleList`. */
  combatMobRules: MobRule[];
  combatMaxTargetHealth: string;
  combatMinMobs: string;
  combatMaxMonsterExp: string;
  /** Health — resting and meditating. Percentages on screen, fractions on disk. */
  restBelow: string;
  restTo: string;
  restBeforeTraps: string;
  /** Rest next door to a lair rather than in it. */
  restNextDoor: boolean;
  meditateBelow: string;
  /** And where a running loop holds still and walks on again. */
  /** The player's own *use this when that* rules. See `PotionList`. */
  potionRules: PotionRule[];
  /** The realm's own half of those rules — `automation.health.useWards`. */
  useWards: boolean;
  /** Spells — the one cast a rule cannot time. */
  spellAttack: string;
  spellAreaAttack: string;
  /** Derive the round spell and the cures from the book. */
  spellAutoChoose: boolean;
  spellAreaMinMobs: string;
  spellAreaMinMana: string;
  /** The fallback once the round spell has no effect, and the per-target cast caps (0 is no limit). */
  spellAttackFallback: string;
  spellAttackCasts: string;
  spellAreaCasts: string;
  /**
   * The heal, per character: a spell cast on this character, a spell cast on a
   * member, and the pair of figures that start and stop the casting.
   *
   * Two spells because the realm marks which may be cast on whom, and per
   * character because a healer and a warrior on the same machine want
   * different answers — which the Global-only version of this could not give.
   */
  spellHeal: string;
  spellHealPartyWith: string;
  spellHealBelow: string;
  spellHealBelowInCombat: string;
  spellHealTo: string;
  spellHealParty: boolean;
  spellMinMana: string;
  /** Cures by affliction, and the blessings kept up by events. */
  spellCures: CuresDraft;
  spellBlessings: BlessingDraft[];
  spellNotifyWearOff: boolean;
  spellAutoBless: boolean;
  spellInvokeItems: boolean;
  /** Movement — what a route may do on the way. */
  openDoors: boolean;
  openTries: string;
  pickLocks: boolean;
  pickTries: string;
  bashDoors: boolean;
  bashTries: string;
  sneak: boolean;
  provideLight: boolean;
  /** Go back for the kit after a death. */
  recoverGear: boolean;
  recoverGearTries: string;
  recoverGearFloor: string;
  lightDimRooms: boolean;
  extinguishInLight: boolean;
  /** Conditions as waits, inverted: off waits blindness / poison / confusion out. */
  walkWhileBlind: boolean;
  walkWhilePoisoned: boolean;
  walkWhileConfused: boolean;
  fightOnArrival: boolean;
  /** Ways and places routes keep out of. See `MovementConfig`. */
  keepOutOf: string[];
  /** Bend down for a key an exit of this room needs. */
  collectKeys: boolean;
  /** Going hunting on its own — `automation.hunting`. */
  huntAuto: boolean;
  /** How far to look for a lair, as text; '' is everywhere the exits reach. */
  huntRadius: string;
  /** Spending character points on the stat screen — `automation.train`. */
  trainStats: boolean;
  trainLevels: boolean;
  /** The chosen trainer's shop row, as text, or '' for the cheapest. */
  trainTrainer: string;
  trainWanted: Record<TrainedAttribute, string>;
  /** Running a quest's plan — `automation.quests`. */
  questsEnabled: boolean;
  /** Which kit to be in, and when — `automation.gear`. */
  gearEnabled: boolean;
  gearSets: GearSet[];
  gearOffRoundItem: string;
  /** As text, so a half-typed figure is not read as 0. */
  gearOffRoundEvery: string;
  /*
   * Held whole, like `rewrites`, rather than flattened into eighteen fields.
   * They are the *same four blocks the Global page edits*, and the controls
   * below are that page's controls unchanged — a flattened copy here would be
   * a second spelling of each field for a form to forget one of. The numbers
   * inside are numbers rather than the strings the flat fields use, which is
   * what Global already does with them: a half-typed price reads as the value
   * so far, and the clamp is the same one on both pages.
   */
  loot: LootConfig;
  drop: DropConfig;
  search: SearchConfig;
  banking: BankingConfig;
  /**
   * The loops this character walks — `automation.loops`.
   *
   * Held whole rather than as a list of names, because a loop *is* its stops:
   * a name with nothing behind it would have to be looked back up in the
   * catalogue at save time, and a character may perfectly well walk a loop
   * that was never in it — one written by hand in its own file.
   */
  loops: Loop[];
  /**
   * Alerts — what this character is worth interrupting you for.
   *
   * One list and two switches. The severity floor, the per-channel mute list
   * and the find watch went with the old surface (todo 02): every question they
   * answered is a row, and two vocabularies for one question is how somebody
   * comes to believe one of them is broken. See `AlertList`.
   */
  alertRules: AlertRule[];
  /** `automation.afk` — answering for an absent player. */
  afkEnabled: boolean;
  afkAfterMinutes: string;
  afkReply: string;
  /** Whether this character answers another player's `@` commands. */
  answerRemotes: boolean;
  lookAtPlayers: boolean;
  /** Whether the client sets the prompt's shape on the way in — `automation.statline`. */
  statlineControl: boolean;
  /** The status line and listings this player designed — `ui.rewrites`. */
  rewrites: RewritesUiConfig;
  /** Whether the gang's own channel is one of the channels it answers on. */
  remoteGangpath: boolean;
  /** What anybody in this character's gang may ask for. */
  remoteGang: RemoteName[];
  /** Remotes anybody who has joined this character's party may ask for. */
  remoteParty: RemoteName[];
  /**
   * What each named player may and may not ask for, keyed lower-case.
   *
   * In the form even though the Player flyout is the surface most people use:
   * a profile save writes the whole `automation.remotes` block, so a form that
   * did not carry this would delete every per-player permission the moment
   * somebody pressed Save on an unrelated field.
   */
  remotePlayers: Record<string, RemoteGrant>;
}

export function formOf(entry: ProfileEditable): CharacterFields {
  return {
    id: entry.id,
    name: entry.name,
    accent: entry.accent,
    theme: entry.theme,
    autoConnect: entry.autoConnect,
    autoReconnect: entry.autoReconnect,
    serverName: entry.serverName,
    host: entry.target.host,
    port: String(entry.target.port),
    encoding: entry.target.encoding,
    username: entry.username,
    // Never populated from disk: a password that has crossed to a renderer can
    // reach a devtools snapshot, a crash report or a screenshot. Blank means
    // "leave it alone", and `changePassword` is what says otherwise.
    password: '',
    changePassword: false,
    login: entry.login,
    locate: entry.locate,
    retreat: entry.retreat.enabled,
    retreatBelow: String(Math.round(entry.retreat.belowHealth * 100)),
    retreatBelowMana: String(Math.round(entry.retreat.belowMana * 100)),
    retreatOutnumbered: String(entry.retreat.whenOutnumbered),
    retreatStrategy: entry.retreat.strategy,
    retreatHaven: entry.retreat.safeHavenRoom,
    fleeGoto: entry.fleeGoto.enabled,
    fleeGotoBelow: percent(entry.fleeGoto.belowHealth),
    fleeGotoCommand: entry.fleeGoto.command,
    hangUp: entry.hangUp.enabled,
    // As a percentage, because that is how somebody thinks about health. The
    // file keeps a fraction, so the whole client holds one representation.
    hangUpBelow: String(Math.round(entry.hangUp.belowHealth * 100)),
    hangUpPenalties: entry.hangUp.penalties,
    hangUpOnPlayer: entry.hangUp.onPlayerInRoom,
    pvpNotifyGang: entry.pvp.notifyGang,
    pvpAction: entry.pvp.action,
    combat: entry.combat.enabled,
    combatAttack: entry.combat.attack,
    combatOpener: entry.combat.opener,
    combatHideForOpener: entry.combat.hideForOpener,
    combatEngage: entry.combat.engage,
    combatRetaliate: entry.combat.retaliate,
    combatDefendAfterRounds: String(entry.combat.defendAfterRounds),
    combatPoliteAttacks: entry.combat.politeAttacks,
    combatMaxMobs: String(entry.combat.maxMobs),
    partyAssist: entry.party.assistLeader,
    partyDefend: entry.party.defendParty,
    partyRest: entry.party.restWithLeader,
    partyAskHeal: percent(entry.party.askForHealBelow),
    // A percentage on screen and a fraction in the file, like every other
    // threshold here: one representation on disk, the one people think in on
    // the form.
    combatRefresh: String(entry.combat.refreshRounds),
    combatMobRules: entry.combat.mobRules.map((row) => ({ ...row })),
    combatMaxTargetHealth: String(entry.combat.maxTargetHealth),
    combatMinMobs: String(entry.combat.minMobs),
    combatMaxMonsterExp: String(entry.combat.maxMonsterExperience),
    restBelow: percent(entry.health.restBelow),
    restTo: percent(entry.health.restTo),
    restBeforeTraps: percent(entry.health.restBeforeTraps),
    meditateBelow: percent(entry.health.meditateBelow),
    restNextDoor: entry.health.restNextDoor,
    potionRules: entry.health.potions.map((rule) => ({ ...rule })),
    useWards: entry.health.useWards,
    spellAttack: entry.spells.attack,
    spellAutoChoose: entry.spells.autoChoose,
    spellAreaAttack: entry.spells.areaAttack,
    spellAreaMinMobs: String(entry.spells.areaMinMobs),
    spellAreaMinMana: percent(entry.spells.areaMinMana),
    spellAttackFallback: entry.spells.attackFallback,
    spellAttackCasts: String(entry.spells.attackCasts),
    spellAreaCasts: String(entry.spells.areaCasts),
    spellHeal: entry.spells.heal,
    spellHealPartyWith: entry.spells.healPartyWith,
    spellHealBelow: percent(entry.spells.healBelow),
    spellHealBelowInCombat: percent(entry.spells.healBelowInCombat),
    spellHealTo: percent(entry.spells.healTo),
    spellHealParty: entry.spells.healParty,
    spellMinMana: percent(entry.spells.minMana),
    spellCures: { ...entry.spells.cures },
    spellBlessings: entry.spells.blessings.map((blessing) => ({ ...blessing })),
    spellNotifyWearOff: entry.spells.notifyPartyOnWearOff,
    spellAutoBless: entry.spells.autoBless,
    spellInvokeItems: entry.spells.invokeItems,
    openDoors: entry.movement.openDoors,
    openTries: String(entry.movement.openTries),
    pickLocks: entry.movement.pickLocks,
    pickTries: String(entry.movement.pickTries),
    bashDoors: entry.movement.bashDoors,
    bashTries: String(entry.movement.bashTries),
    sneak: entry.movement.sneak,
    provideLight: entry.movement.provideLight,
    recoverGear: entry.movement.recoverGear,
    recoverGearTries: String(entry.movement.recoverGearTries),
    recoverGearFloor: String(entry.movement.recoverGearFloor),
    lightDimRooms: entry.movement.lightDimRooms,
    extinguishInLight: entry.movement.extinguishInLight,
    walkWhileBlind: entry.movement.walkWhileBlind,
    walkWhilePoisoned: entry.movement.walkWhilePoisoned,
    walkWhileConfused: entry.movement.walkWhileConfused,
    fightOnArrival: entry.movement.fightOnArrival,
    keepOutOf: [...entry.movement.keepOutOf],
    collectKeys: entry.movement.collectKeys,
    huntAuto: entry.hunting.enabled,
    huntRadius: entry.hunting.radius > 0 ? String(entry.hunting.radius) : '',
    trainStats: entry.train.stats,
    trainLevels: entry.train.levels,
    trainTrainer: entry.train.trainer > 0 ? String(entry.train.trainer) : '',
    trainWanted: wantedStrings(entry.train.wanted),
    questsEnabled: entry.quests.enabled,
    gearEnabled: entry.gear.enabled,
    gearSets: entry.gear.sets.map((set) => ({ ...set, wear: [...set.wear] })),
    gearOffRoundItem: entry.gear.offRound.item,
    gearOffRoundEvery:
      entry.gear.offRound.everyRounds > 0 ? String(entry.gear.offRound.everyRounds) : '',
    loot: structuredClone(entry.loot),
    drop: structuredClone(entry.drop),
    search: { ...entry.search },
    banking: { ...entry.banking },
    // This character's *own* loops. What it inherits is shown beside them and
    // is not editable from here -- see `LoopSection`.
    loops: entry.loops,
    alertRules: entry.alerts.rules.map((rule) => ({ ...rule })),
    afkEnabled: entry.afk.enabled,
    afkAfterMinutes: String(entry.afk.afterMinutes),
    afkReply: entry.afk.reply,
    answerRemotes: entry.remotes.enabled,
    remoteGangpath: entry.remotes.gangpath,
    remoteGang: [...entry.remotes.gang],
    remoteParty: [...entry.remotes.party],
    remotePlayers: entry.remotes.players,
    lookAtPlayers: entry.talk.lookAtPlayers,
    statlineControl: entry.statline.control,
    rewrites: entry.rewrites
  };
}

/**
 * Whether two forms say the same thing.
 *
 * Serialised rather than compared field by field, and that is not laziness:
 * this shape is forty fields of strings, booleans and lists that grows every
 * time the screen learns a setting, and a hand-written comparison would go
 * stale silently — the symptom being an undo step that does nothing, or a save
 * that never fires for one field. The values are all JSON-shaped by
 * construction, because they came out of form controls.
 */
export function sameForm(a: CharacterFields, b: CharacterFields): boolean {
  return sameJson(a, b);
}

/**
 * The form as the file wants it.
 *
 * Lifted out of the submit handler because there are two callers now: the
 * button that creates a character, and the save that happens on its own while
 * one is edited. Two copies of this translation would be two places for a field
 * to be forgotten, and the symptom of forgetting one is a setting that saves
 * from one route and not the other.
 */
export function draftOf(form: CharacterFields): ProfileDraft {
  return {
    name: form.name,
    server:
      form.serverName !== null
        ? { kind: 'saved', name: form.serverName }
        : {
            kind: 'inline',
            host: form.host,
            port: Number.parseInt(form.port, 10),
            encoding: form.encoding
          },
    username: form.username,
    password: form.password,
    changePassword: form.changePassword,
    autoConnect: form.autoConnect,
    autoReconnect: form.autoReconnect,
    accent: form.accent,
    theme: form.theme,
    login: form.login,
    locate: form.locate,
    retreat: {
      enabled: form.retreat,
      belowHealth: (Number.parseInt(form.retreatBelow, 10) || 0) / 100,
      belowMana: (Number.parseInt(form.retreatBelowMana, 10) || 0) / 100,
      whenOutnumbered: Number.parseInt(form.retreatOutnumbered, 10) || 0,
      strategy: RETREAT_STRATEGIES.includes(form.retreatStrategy as RetreatStrategy)
        ? (form.retreatStrategy as RetreatStrategy)
        : 'step-back',
      safeHavenRoom: form.retreatHaven.trim()
    },
    fleeGoto: {
      enabled: form.fleeGoto,
      belowHealth: fractionOf(form.fleeGotoBelow),
      command: form.fleeGotoCommand.trim()
    },
    combat: {
      enabled: form.combat,
      attack: form.combatAttack,
      opener: form.combatOpener,
      hideForOpener: form.combatHideForOpener,
      engage: form.combatEngage,
      retaliate: form.combatRetaliate,
      defendAfterRounds: Number.parseInt(form.combatDefendAfterRounds, 10) || 0,
      politeAttacks: form.combatPoliteAttacks,
      maxMobs: Number.parseInt(form.combatMaxMobs, 10) || 0,
      refreshRounds: Number.parseInt(form.combatRefresh, 10) || 0,
      mobRules: form.combatMobRules,
      maxTargetHealth: Math.max(0, Number.parseInt(form.combatMaxTargetHealth, 10) || 0),
      minMobs: Math.max(0, Number.parseInt(form.combatMinMobs, 10) || 0),
      maxMonsterExperience: Math.max(0, Number.parseInt(form.combatMaxMonsterExp, 10) || 0)
    },
    hangUp: {
      enabled: form.hangUp,
      belowHealth: (Number.parseInt(form.hangUpBelow, 10) || 0) / 100,
      penalties: form.hangUpPenalties,
      onPlayerInRoom: form.hangUpOnPlayer
    },
    pvp: { notifyGang: form.pvpNotifyGang, action: form.pvpAction },
    party: {
      assistLeader: form.partyAssist,
      defendParty: form.partyDefend,
      restWithLeader: form.partyRest,
      askForHealBelow: fractionOf(form.partyAskHeal)
    },
    health: {
      restBelow: fractionOf(form.restBelow),
      restTo: fractionOf(form.restTo),
      restBeforeTraps: fractionOf(form.restBeforeTraps),
      meditateBelow: fractionOf(form.meditateBelow),
      restNextDoor: form.restNextDoor,
      // Kept whole, and a nameless row is dropped by `normalizePotionRules` the
      // way a nameless blessing is: a rule naming nothing fires on nothing.
      potions: form.potionRules.map((rule) => ({ ...rule, name: rule.name.trim() })),
      useWards: form.useWards
    },
    spells: {
      attack: form.spellAttack.trim(),
      autoChoose: form.spellAutoChoose,
      areaAttack: form.spellAreaAttack.trim(),
      areaMinMobs: Math.max(1, Number.parseInt(form.spellAreaMinMobs, 10) || 3),
      areaMinMana: fractionOf(form.spellAreaMinMana),
      attackFallback: form.spellAttackFallback.trim(),
      attackCasts: Math.max(0, Number.parseInt(form.spellAttackCasts, 10) || 0),
      areaCasts: Math.max(0, Number.parseInt(form.spellAreaCasts, 10) || 0),
      heal: form.spellHeal.trim(),
      healPartyWith: form.spellHealPartyWith.trim(),
      healBelow: fractionOf(form.spellHealBelow),
      healBelowInCombat: fractionOf(form.spellHealBelowInCombat),
      healTo: fractionOf(form.spellHealTo),
      healParty: form.spellHealParty,
      minMana: fractionOf(form.spellMinMana),
      cures: {
        blindness: form.spellCures.blindness.trim(),
        poison: form.spellCures.poison.trim(),
        disease: form.spellCures.disease.trim(),
        freedom: form.spellCures.freedom.trim()
      },
      blessings: form.spellBlessings.map((blessing) => ({
        ...blessing,
        spell: blessing.spell.trim()
      })),
      notifyPartyOnWearOff: form.spellNotifyWearOff,
      autoBless: form.spellAutoBless,
      invokeItems: form.spellInvokeItems
    },
    movement: {
      openDoors: form.openDoors,
      openTries: Number.parseInt(form.openTries, 10) || 0,
      pickLocks: form.pickLocks,
      pickTries: Number.parseInt(form.pickTries, 10) || 0,
      bashDoors: form.bashDoors,
      bashTries: Number.parseInt(form.bashTries, 10) || 0,
      sneak: form.sneak,
      provideLight: form.provideLight,
      recoverGear: form.recoverGear,
      recoverGearTries: Number.parseInt(form.recoverGearTries, 10) || 0,
      recoverGearFloor: Number.parseInt(form.recoverGearFloor, 10) || 0,
      lightDimRooms: form.lightDimRooms,
      extinguishInLight: form.extinguishInLight,
      walkWhileBlind: form.walkWhileBlind,
      walkWhilePoisoned: form.walkWhilePoisoned,
      walkWhileConfused: form.walkWhileConfused,
      fightOnArrival: form.fightOnArrival,
      keepOutOf: form.keepOutOf,
      collectKeys: form.collectKeys
    },
    hunting: {
      enabled: form.huntAuto,
      // Blank and 0 are the same answer — *everywhere the exits reach* — which
      // is what the field's own hint says.
      radius: Number.parseInt(form.huntRadius, 10) || 0
    },
    train: {
      stats: form.trainStats,
      wanted: wantedNumbers(form.trainWanted),
      levels: form.trainLevels,
      // 0 is *the cheapest that will take me*, which is what the picker's
      // first entry means and what an unset field says.
      trainer: Number.parseInt(form.trainTrainer, 10) || 0
    },
    quests: { enabled: form.questsEnabled },
    gear: {
      enabled: form.gearEnabled,
      // Rows are kept as typed and dropped at the boundary, so a set being
      // written does not vanish from under the caret on the next save.
      sets: form.gearSets.map((set) => ({
        ...set,
        name: set.name.trim(),
        mob: set.mob.trim(),
        wear: set.wear.map((item) => item.trim()).filter((item) => item.length > 0)
      })),
      offRound: {
        item: form.gearOffRoundItem.trim(),
        everyRounds: Number.parseInt(form.gearOffRoundEvery, 10) || 0
      }
    },
    loot: form.loot,
    drop: form.drop,
    search: form.search,
    banking: form.banking,
    loops: form.loops,
    alerts: {
      // Whole, with the name trimmed as `normalizeAlertRules` trims it: a row
      // naming nothing is inert rather than firing on everything.
      rules: form.alertRules.map((rule) => ({ ...rule, name: rule.name.trim() }))
    },
    afk: {
      enabled: form.afkEnabled,
      afterMinutes: Math.max(1, Number.parseInt(form.afkAfterMinutes, 10) || 5),
      reply: form.afkReply.trim()
    },
    remotes: {
      enabled: form.answerRemotes,
      gangpath: form.remoteGangpath,
      gang: form.remoteGang,
      party: form.remoteParty,
      players: form.remotePlayers
    },
    talk: { lookAtPlayers: form.lookAtPlayers },
    statline: { control: form.statlineControl },
    rewrites: form.rewrites
  };
}

/**
 * A new character that starts where an existing one does.
 *
 * Making the second character on a realm otherwise means retyping a server, a
 * login script, four combat verbs and every threshold — all of which the first
 * one already states, and all of which somebody typed once and can get subtly
 * wrong the second time.
 *
 * Three things it does **not** carry, and each is the point rather than a
 * limitation:
 *
 * - **The identity.** The file name and the display name are what make it a
 *   different character; two characters under one name is not what anybody
 *   means by "copy", and the id names the session, the log and the tab.
 * - **The password.** It cannot: the screen was never told it. The username is
 *   carried because a second character is usually on the same account, and
 *   the form says the password still has to be typed — there is no shared
 *   account to name instead, so it has to be retyped by hand.
 * - **Anything afterwards.** This is a starting point, not a link. A change to
 *   the character it was copied from does not follow, which is the same thing
 *   `overlay` means everywhere else: what a file states, it states.
 */
export function copyOf(entry: ProfileEditable): CharacterFields {
  return {
    ...formOf(entry),
    id: '',
    name: '',
    /*
     * Never on by default, whatever the source said. A character that dialled
     * on the next launch because the one it was copied from does is a
     * connection nobody asked for — and on this realm a connection is not free.
     */
    autoConnect: false,
    password: '',
    changePassword: true
  };
}

/**
 * A fraction on disk, a percentage on screen.
 *
 * One representation in the file, the one people think in on the form — the
 * same split every other threshold here uses, and the reason the file keeps
 * fractions at all: a threshold means the same thing at every level only if it
 * is a fraction of maximum.
 *
 * This form keeps every field as the string in its box, so the percent is one too.
 */
const percent = (fraction: number): string => String(percentOf(fraction));

/**
 * A character that does not exist yet, started from the Global defaults.
 *
 * "Global" is exactly that and nothing else: a set of starting values for the
 * next realm and the next character. A new character takes a **copy** of them
 * here and states them in its own file, so from that moment it owns them —
 * changing a default afterwards is a change to what the *next* character
 * starts with, not a change that reaches back into the ones already made.
 *
 * `DEFAULT_CONFIG` is the fallback rather than the source, for the case where
 * the screen is drawing a form before the snapshot has arrived. The two agree
 * whenever the options file has not been edited, which is what makes falling
 * back to it safe.
 *
 * `loops` is the one field that starts **empty** whatever the defaults say, and
 * the difference is load-bearing: a character's loops are the files in its own
 * `loops/` directory rather than a list, and a character with none walks
 * everything its realm and the global directory lend it. Copying them in would
 * duplicate files rather than settings.
 */
export function emptyForm(
  servers: SettingsSnapshot['servers'],
  defaults: GlobalDraft | null
): CharacterFields {
  const combat = defaults?.automation.combat ?? DEFAULT_COMBAT;
  const health = defaults?.automation.health ?? DEFAULT_HEALTH;
  const party = defaults?.automation.party ?? DEFAULT_CONFIG.automation.party;
  const movement = defaults?.automation.movement ?? DEFAULT_MOVEMENT;
  const hunting = defaults?.automation.hunting ?? DEFAULT_CONFIG.automation.hunting;
  const train = defaults?.automation.train ?? DEFAULT_CONFIG.automation.train;
  const quests = defaults?.automation.quests ?? DEFAULT_CONFIG.automation.quests;
  const gear = defaults?.automation.gear ?? DEFAULT_CONFIG.automation.gear;
  const spells = defaults?.automation.spells ?? DEFAULT_SPELLS;
  const alerts = defaults?.ui.alerts ?? DEFAULT_ALERTS;
  const remotes = defaults?.automation.remotes ?? DEFAULT_CONFIG.automation.remotes;
  const afk = defaults?.automation.afk ?? DEFAULT_CONFIG.automation.afk;
  const talk = defaults?.automation.talk ?? DEFAULT_CONFIG.automation.talk;
  const statline = defaults?.automation.statline ?? DEFAULT_CONFIG.automation.statline;
  const rewrites = defaults?.ui.rewrites ?? DEFAULT_CONFIG.ui.rewrites;
  const retreat = defaults?.automation.retreat ?? DEFAULT_CONFIG.automation.safety.retreat;
  const fleeGoto = defaults?.automation.fleeGoto ?? DEFAULT_CONFIG.automation.safety.fleeGoto;
  const hangUp = defaults?.automation.hangUp ?? DEFAULT_CONFIG.automation.safety.hangUp;
  const pvp = defaults?.automation.pvp ?? DEFAULT_CONFIG.automation.safety.pvp;
  const loot = defaults?.automation.loot ?? DEFAULT_CONFIG.automation.loot;
  const drop = defaults?.automation.drop ?? DEFAULT_CONFIG.automation.drop;
  const search = defaults?.automation.search ?? DEFAULT_CONFIG.automation.search;
  const banking = defaults?.automation.banking ?? DEFAULT_CONFIG.automation.banking;

  return {
    id: '',
    name: '',
    accent: 'cyan',
    theme: '',
    /*
     * Never on, whatever the default says. A character that dialled on the next
     * launch because of a setting somebody made for a different one is a
     * connection nobody asked for, and on this realm a connection is not free.
     */
    autoConnect: false,
    /*
     * On, unlike the line above it. Dialling a character nobody asked to dial
     * is a connection they did not choose; putting back one the network took
     * away is the connection they did — and on this realm a character left
     * standing while its client sits at a closed socket is one being killed.
     */
    autoReconnect: true,
    /*
     * The realm the client ships as its default, by name — and the first realm
     * on disk only if that one is not there.
     *
     * It used to be `servers[0]` outright, which made the default whichever
     * realm's *directory* sorted first: a choice nobody had stated, that moved
     * when a realm was added, and that could only be changed by renaming a
     * directory. `DEFAULT_REALM_NAME` states it in one place instead, beside
     * the `server:` line in `profile.default.yaml` that says the same thing to
     * anybody writing a character by hand.
     */
    serverName:
      servers.find((entry) => entry.name.toLowerCase() === DEFAULT_REALM_NAME.toLowerCase())
        ?.name ??
      servers[0]?.name ??
      null,
    host: '',
    port: '23',
    encoding: 'cp437',
    username: '',
    password: '',
    changePassword: true,
    login: [],
    // A new character follows its realm, as its empty script does.
    locate: null,
    retreat: retreat.enabled,
    retreatBelow: percent(retreat.belowHealth),
    retreatBelowMana: percent(retreat.belowMana),
    retreatOutnumbered: String(retreat.whenOutnumbered),
    retreatStrategy: retreat.strategy,
    retreatHaven: retreat.safeHavenRoom,
    fleeGoto: fleeGoto.enabled,
    fleeGotoBelow: percent(fleeGoto.belowHealth),
    // Not the options file's command copied down: it would outrank the realm's.
    fleeGotoCommand: '',
    hangUp: hangUp.enabled,
    hangUpBelow: percent(hangUp.belowHealth),
    // Not the options file's answer copied down: a copy would outrank the
    // realm's own, and whether a realm charges is a fact about the realm.
    hangUpPenalties: null,
    hangUpOnPlayer: hangUp.onPlayerInRoom,
    pvpNotifyGang: pvp.notifyGang,
    pvpAction: pvp.action,
    combat: combat.enabled,
    combatAttack: combat.attack,
    combatOpener: combat.opener,
    combatHideForOpener: combat.hideForOpener,
    combatEngage: combat.engage,
    combatRetaliate: combat.retaliate,
    combatDefendAfterRounds: String(combat.defendAfterRounds),
    combatPoliteAttacks: combat.politeAttacks,
    combatMaxMobs: String(combat.maxMobs),
    partyAssist: party.assistLeader,
    partyDefend: party.defendParty,
    partyRest: party.restWithLeader,
    partyAskHeal: percent(party.askForHealBelow),
    combatRefresh: String(combat.refreshRounds),
    combatMobRules: combat.mobRules.map((row) => ({ ...row })),
    combatMaxTargetHealth: String(combat.maxTargetHealth),
    combatMinMobs: String(combat.minMobs),
    combatMaxMonsterExp: String(combat.maxMonsterExperience),
    restBelow: percent(health.restBelow),
    restTo: percent(health.restTo),
    restBeforeTraps: percent(health.restBeforeTraps),
    meditateBelow: percent(health.meditateBelow),
    restNextDoor: health.restNextDoor,
    potionRules: health.potions.map((rule) => ({ ...rule })),
    useWards: health.useWards,
    spellAttack: spells.attack,
    spellAutoChoose: spells.autoChoose,
    spellAreaAttack: spells.areaAttack,
    spellAreaMinMobs: String(spells.areaMinMobs),
    spellAreaMinMana: percent(spells.areaMinMana),
    spellAttackFallback: spells.attackFallback,
    spellAttackCasts: String(spells.attackCasts),
    spellAreaCasts: String(spells.areaCasts),
    spellHeal: spells.heal,
    spellHealPartyWith: spells.healPartyWith,
    spellHealBelow: percent(spells.healBelow),
    spellHealBelowInCombat: percent(spells.healBelowInCombat),
    spellHealTo: percent(spells.healTo),
    spellHealParty: spells.healParty,
    spellMinMana: percent(spells.minMana),
    spellCures: { ...spells.cures },
    spellBlessings: spells.blessings.map((blessing) => ({ ...blessing })),
    spellNotifyWearOff: spells.notifyPartyOnWearOff,
    spellAutoBless: spells.autoBless,
    spellInvokeItems: spells.invokeItems,
    openDoors: movement.openDoors,
    openTries: String(movement.openTries),
    pickLocks: movement.pickLocks,
    pickTries: String(movement.pickTries),
    bashDoors: movement.bashDoors,
    bashTries: String(movement.bashTries),
    sneak: movement.sneak,
    provideLight: movement.provideLight,
    recoverGear: movement.recoverGear,
    recoverGearTries: String(movement.recoverGearTries),
    recoverGearFloor: String(movement.recoverGearFloor),
    lightDimRooms: movement.lightDimRooms,
    extinguishInLight: movement.extinguishInLight,
    walkWhileBlind: movement.walkWhileBlind,
    walkWhilePoisoned: movement.walkWhilePoisoned,
    walkWhileConfused: movement.walkWhileConfused,
    fightOnArrival: movement.fightOnArrival,
    keepOutOf: [...movement.keepOutOf],
    collectKeys: movement.collectKeys,
    huntAuto: hunting.enabled,
    huntRadius: hunting.radius > 0 ? String(hunting.radius) : '',
    trainStats: train.stats,
    trainLevels: train.levels,
    trainTrainer: train.trainer > 0 ? String(train.trainer) : '',
    trainWanted: wantedStrings(train.wanted),
    questsEnabled: quests.enabled,
    gearEnabled: gear.enabled,
    gearSets: gear.sets.map((set) => ({ ...set, wear: [...set.wear] })),
    gearOffRoundItem: gear.offRound.item,
    gearOffRoundEvery: gear.offRound.everyRounds > 0 ? String(gear.offRound.everyRounds) : '',
    loot: structuredClone(loot),
    drop: structuredClone(drop),
    search: { ...search },
    banking: { ...banking },
    loops: [],
    alertRules: (alerts.rules ?? []).map((rule) => ({ ...rule })),
    afkEnabled: afk.enabled,
    afkAfterMinutes: String(afk.afterMinutes),
    afkReply: afk.reply,
    answerRemotes: remotes.enabled,
    remoteGangpath: remotes.gangpath,
    remoteGang: [...remotes.gang],
    remoteParty: [...remotes.party],
    remotePlayers: remotes.players,
    lookAtPlayers: talk.lookAtPlayers,
    statlineControl: statline.control,
    rewrites
  };
}
