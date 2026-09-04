import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Icon from './Icon';
import FormField, {
  CheckField,
  NumberField,
  PasswordField,
  SelectField,
  TextField
} from './FormField';
import { Hint } from './Hint';
import Advanced from './Advanced';
import BlessingList from './BlessingList';
import CureFields from './CureFields';
import SpellField, { castableOn, refusesTarget } from './SpellPicker';
import { castsOnOthers, castsOnSelf } from '@shared/spellcraft';
import FormActions from './FormActions';
import GlobalSettings from './GlobalSettings';
import LoopSection from './LoopSection';
import RemoteList from './RemoteList';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { figureOf, fractionOf, joinNames, percentOf, splitNames } from '../lib/form';
import {
  begin,
  canRedo,
  canUndo,
  historyIntent,
  record,
  redo,
  replace,
  targetOf,
  undo,
  type History
} from '../lib/history';
import { useAutoSave } from '../hooks/useAutoSave';
import { PROFILE_ACCENTS, type ProfileAccent } from '@shared/profiles';
import { isThemePreference, THEME_IDS, THEMES, type ThemePreference } from '@shared/themes';
import type {
  GlobalDraft,
  LoginStepDraft,
  ProfileDraft,
  ServerDraft,
  BlessingDraft,
  CuresDraft
} from '@shared/drafts';
import type { Loop, ScopedLoop } from '@shared/loops';
import type { ProfileEditable, SessionId, SettingsSnapshot } from '@shared/ipc';
import type { StreamEncoding } from '@shared/types';
import {
  DEFAULT_CONFIG,
  DEFAULT_REALM_NAME,
  RETREAT_STRATEGIES,
  POTION_VERBS,
  PVP_ACTIONS,
  type EngagePolicy,
  type RetreatStrategy,
  type PvpAction
} from '@shared/config';
import { ACTIONABLE_REMOTES, type RemoteGrant, type RemoteName } from '@shared/remotes';
import { NOTICE_CHANNELS, type NoticeChannel, type Severity } from '@shared/notifications';
import { errorMessage } from '@shared/values';

/** The shipped combat defaults, so a new character and the file agree. */
const DEFAULT_COMBAT = DEFAULT_CONFIG.automation.combat;
const DEFAULT_HEALTH = DEFAULT_CONFIG.automation.health;
const DEFAULT_MOVEMENT = DEFAULT_CONFIG.automation.movement;
const DEFAULT_SPELLS = DEFAULT_CONFIG.automation.spells;
const DEFAULT_ALERTS = DEFAULT_CONFIG.ui.alerts;

/**
 * The word beside each mute checkbox, keyed by the shared closed union: a
 * channel added to `NOTICE_CHANNELS` fails to compile here until it has a
 * label, where the local copy this replaced could silently fall behind.
 */
const CHANNEL_LABEL: Record<NoticeChannel, string> = {
  combat: t('settings.alerts.channel.combat'),
  vitals: t('settings.alerts.channel.vitals'),
  room: t('settings.alerts.channel.room'),
  realm: t('settings.alerts.channel.realm'),
  party: t('settings.alerts.channel.party'),
  command: t('settings.alerts.channel.command'),
  movement: t('settings.alerts.channel.movement'),
  items: t('settings.alerts.channel.items'),
  stealth: t('settings.alerts.channel.stealth'),
  presence: t('settings.alerts.channel.presence'),
  session: t('settings.alerts.channel.session')
};

/**
 * The per-player half of `automation.remotes`, edited from a form.
 *
 * The Player flyout is the surface most people use, and it can only be opened
 * on somebody the client has **seen** — a name in a room, on a `who`, in a
 * telepath. That is the wrong constraint for setting a pair of characters up
 * before either has logged in, which is the ordinary case for the person
 * running four of them. So the same grid is here, addressed by a typed name.
 *
 * **One person at a time.** A form showing every named player's fifty-seven
 * rows at once would be a wall nobody reads; the names are chips, and choosing
 * one opens that person's grid. Somebody with nothing granted is not kept — an
 * empty grant is the absence of a decision, and a list that accumulated a name
 * per click would read as a list of people with permissions when it holds
 * people with none.
 */
function PlayerGrants({
  grants,
  onChange
}: {
  grants: Record<string, RemoteGrant>;
  onChange(next: Record<string, RemoteGrant>): void;
}) {
  const names = Object.keys(grants).sort();
  const [chosen, setChosen] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const who = chosen !== null && chosen in grants ? chosen : (names[0] ?? null);
  const grant = who === null ? null : grants[who]!;

  const write = (key: string, next: RemoteGrant): void => {
    const rest = { ...grants };
    // An emptied grant is removed, exactly as `SettingsEditor` removes it from
    // the file: two places that disagreed about what "nothing" looks like would
    // leave a name in the form that vanished on the next load.
    if (next.allow.length === 0 && next.deny.length === 0) delete rest[key];
    else rest[key] = next;
    onChange(rest);
  };

  return (
    <div className="remote-players">
      <TextField
        hint={t('settings.remotes.addPlayerHint')}
        label={t('settings.remotes.addPlayerLabel')}
        name="remotes-add-player"
        onChange={setTyped}
        onSubmit={() => {
          const key = typed.trim().toLowerCase();
          if (key.length === 0) return;
          setTyped('');
          setChosen(key);
          // Created empty and kept only once something is granted, so a name
          // typed by mistake leaves nothing behind.
          if (!(key in grants)) onChange({ ...grants, [key]: { allow: [], deny: [] } });
        }}
        placeholder={t('settings.remotes.addPlayerPlaceholder')}
        spellCheck={false}
        value={typed}
      />

      {names.length === 0 ? null : (
        <div className="settings-chips" role="group">
          {names.map((name) => (
            <button
              aria-pressed={name === who}
              className="chip toggle"
              data-on={name === who ? 'true' : 'false'}
              key={name}
              onClick={() => setChosen(name)}
              onMouseDown={keepFocus}
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {who === null || grant === null ? null : (
        <>
          <h4 className="settings-subhead">
            {t('settings.remotes.playerLegend', { name: who })}
            <button
              className="chip toggle"
              data-level="critical"
              onClick={() => write(who, { allow: [], deny: [] })}
              onMouseDown={keepFocus}
              title={t('settings.remotes.removePlayerTitle', { name: who })}
              type="button"
            >
              {t('settings.remotes.removePlayer')}
            </button>
          </h4>
          <RemoteList
            allow={grant.allow}
            deny={grant.deny}
            mode="player"
            onSet={(remote, stance) =>
              write(who, {
                allow:
                  stance === 'allow'
                    ? [...grant.allow, remote]
                    : grant.allow.filter((entry) => entry !== remote),
                deny:
                  stance === 'deny'
                    ? [...grant.deny, remote]
                    : grant.deny.filter((entry) => entry !== remote)
              })
            }
            onSetAll={(stance) =>
              write(
                who,
                stance === 'allow'
                  ? { allow: [...ACTIONABLE_REMOTES], deny: [] }
                  : { allow: [], deny: [] }
              )
            }
            subject={who}
          />
        </>
      )}
    </div>
  );
}

export interface SettingsScreenProps {
  open: boolean;
  /**
   * Which character to open on: a profile id, {@link SETTINGS_NEW_CHARACTER},
   * or `null` for wherever it was left.
   *
   * A string rather than an object on purpose. This drives the effect that runs
   * when the dialog opens, and an object literal from a caller would be a new
   * value every render — which is the trap that made a refused save flash and
   * vanish before anybody could read it.
   */
  openAt?: string | null;
  /**
   * What a character's percentage thresholds are percentages *of*.
   *
   * A function rather than a value: the screen edits one character at a time
   * but is opened from anywhere, and the figures belong to the character being
   * edited rather than to whichever one is on screen. Both halves are null for
   * a character not in the realm, and `figureOf` draws that as nothing — an
   * unknown maximum has never been a number in this client.
   */
  maximaFor(session: SessionId): { hpMax: number | null; manaMax: number | null };
  onClose(): void;
  load(): Promise<SettingsSnapshot>;
  saveProfile(id: string, draft: ProfileDraft): Promise<string | null>;
  deleteProfile(id: string): Promise<string | null>;
  saveServer(previousName: string | null, draft: ServerDraft): Promise<string | null>;
  deleteServer(name: string): Promise<string | null>;
  /** Writes the options file everything is inherited from. */
  saveGlobal(draft: GlobalDraft): Promise<string | null>;
  revealConfig(): void;
  revealProfiles(): void;
  /** Native picker for a realm database. Resolves to null if dismissed. */
  chooseRealm(): Promise<string | null>;
  /**
   * The loops the client ships, for the Movement tab to offer.
   *
   * Asked for when the shelf is opened rather than with the settings snapshot:
   * it is four hundred loops, and most visits to this screen are about a
   * password. Resolves to an empty list rather than throwing — an empty shelf
   * is a package missing its data, and a hand-written loop still works.
   */
  loadLoops(): Promise<Loop[]>;
}

const ENCODINGS: readonly StreamEncoding[] = ['cp437', 'utf8', 'latin1'];

/**
 * A character that has not been created yet.
 *
 * Exported so the `+` at the head of the tab rail can ask for it by name rather
 * than opening the screen and hoping it lands somewhere useful. The NUL keeps
 * it out of the space of real profile ids, which are filenames.
 */
export const SETTINGS_NEW_CHARACTER = '\u0000new';
const NEW_CHARACTER = SETTINGS_NEW_CHARACTER;
const NEW_SERVER = '\u0000new-server';

/**
 * Open straight to the realms list, rather than to a character.
 *
 * A realm is not a character's own setting — it has a directory of its own
 * because more than one character plays on the same one — so a command wanting
 * to add or edit one has no character id to name. Exported for the same reason
 * {@link SETTINGS_NEW_CHARACTER} is: a caller asks for this screen by what it
 * wants to land on, not by opening it and hoping.
 */
export const SETTINGS_MANAGE_SERVERS = '\u0000servers';

/**
 * Open on the client's own settings — the MudEngine page.
 *
 * How the client itself behaves: the console, the theme, the tabs, the records
 * it keeps. Reached from the gear at the head of the tab rail, from the
 * palette, and by the crumb here; a sentinel like the two above, for the same
 * reason.
 */
export const SETTINGS_GLOBAL = '\u0000global';

/**
 * Open on the Global page — what a new realm and a new character start with.
 *
 * A separate door from {@link SETTINGS_GLOBAL} because they are separate
 * questions: "make the console bigger" and "stop every new character resting
 * at 60%" have nothing to do with each other, and one page holding both is the
 * reason neither could be found.
 */
export const SETTINGS_DEFAULTS = '\u0000defaults';

/**
 * The two pages that draw `global/default.yaml`.
 *
 * One file, two audiences: `client` is MudEngine — how the client itself
 * behaves — and `defaults` is Global, the values a new realm and a new
 * character start from. They share a draft and a save, because a page that
 * wrote half a file would be a second writer for it.
 */
type GlobalTab = 'client' | 'defaults';

/** Whether this page is one of the two drawing the options file. */
function showsGlobal(tab: string): tab is GlobalTab {
  return tab === 'client' || tab === 'defaults';
}

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
const SECTIONS = [
  'profile',
  'login',
  'combat',
  'health',
  'spells',
  'party',
  'movement',
  'remotes',
  'talk',
  'alerts'
] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, string> = {
  profile: t('settings.sections.character'),
  login: t('settings.sections.login'),
  combat: t('settings.tabs.combat'),
  health: t('settings.tabs.health'),
  spells: t('settings.tabs.spells'),
  party: t('settings.tabs.party'),
  movement: t('settings.tabs.movement'),
  remotes: t('settings.tabs.remotes'),
  talk: t('settings.tabs.talk'),
  alerts: t('settings.tabs.alerts')
};

interface CharacterForm {
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
  hangUp: boolean;
  hangUpBelow: string;
  hangUpOnlyWhenClean: boolean;
  hangUpOnPlayer: boolean;
  pvpNotifyGang: boolean;
  pvpAction: PvpAction;
  retreat: boolean;
  retreatBelow: string;
  retreatOutnumbered: string;
  retreatStrategy: string;
  retreatHaven: string;
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
  combatEngage: EngagePolicy;
  combatRetaliate: boolean;
  combatMaxMobs: string;
  /** Following somebody — `automation.party`. */
  partyAssist: boolean;
  partyDefend: boolean;
  partyRest: boolean;
  combatMinHealth: string;
  combatWhileWalking: boolean;
  combatRefresh: string;
  combatAvoid: string;
  /** Refusals about a *kind* of monster, from the realm's own columns. */
  combatAvoidUndead: boolean;
  combatAvoidDeathSpell: boolean;
  combatMaxTargetHealth: string;
  combatMinMobs: string;
  combatMaxMonsterExp: string;
  combatPrefer: string;
  /** Health — resting and meditating. Percentages on screen, fractions on disk. */
  restBelow: string;
  restTo: string;
  meditateBelow: string;
  /** And where a running loop holds still and walks on again. */
  /** Potions: what to drink, and below what. */
  potionVerb: string;
  healingPotionName: string;
  drinkHealingPotionBelow: string;
  manaPotionName: string;
  drinkManaPotionBelow: string;
  /** Spells — the one cast a rule cannot time. */
  spellAttack: string;
  spellAreaAttack: string;
  spellAreaMinMobs: string;
  spellAreaMinMana: string;
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
  /** Movement — what a route may do on the way. */
  openDoors: boolean;
  openTries: string;
  pickLocks: boolean;
  pickTries: string;
  bashDoors: boolean;
  bashTries: string;
  sneak: boolean;
  provideLight: boolean;
  lightDimRooms: boolean;
  extinguishInLight: boolean;
  /**
   * The loops this character walks — `automation.loops`.
   *
   * Held whole rather than as a list of names, because a loop *is* its stops:
   * a name with nothing behind it would have to be looked back up in the
   * catalogue at save time, and a character may perfectly well walk a loop
   * that was never in it — one written by hand in its own file.
   */
  loops: Loop[];
  /** Alerts — what this character is worth interrupting you for. */
  alertMinimum: Severity;
  alertMuted: string[];
  /** Whether this character answers another player's `@` commands. */
  answerRemotes: boolean;
  lookAtPlayers: boolean;
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

function formOf(entry: ProfileEditable): CharacterForm {
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
    retreat: entry.retreat.enabled,
    retreatBelow: String(Math.round(entry.retreat.belowHealth * 100)),
    retreatOutnumbered: String(entry.retreat.whenOutnumbered),
    retreatStrategy: entry.retreat.strategy,
    retreatHaven: entry.retreat.safeHavenRoom,
    hangUp: entry.hangUp.enabled,
    // As a percentage, because that is how somebody thinks about health. The
    // file keeps a fraction, so the whole client holds one representation.
    hangUpBelow: String(Math.round(entry.hangUp.belowHealth * 100)),
    hangUpOnlyWhenClean: entry.hangUp.onlyWhenClean,
    hangUpOnPlayer: entry.hangUp.onPlayerInRoom,
    pvpNotifyGang: entry.pvp.notifyGang,
    pvpAction: entry.pvp.action,
    combat: entry.combat.enabled,
    combatAttack: entry.combat.attack,
    combatOpener: entry.combat.opener,
    combatEngage: entry.combat.engage,
    combatRetaliate: entry.combat.retaliate,
    combatMaxMobs: String(entry.combat.maxMobs),
    partyAssist: entry.party.assistLeader,
    partyDefend: entry.party.defendParty,
    partyRest: entry.party.restWithLeader,
    // A percentage on screen and a fraction in the file, like every other
    // threshold here: one representation on disk, the one people think in on
    // the form.
    combatMinHealth: String(Math.round(entry.combat.minHealth * 100)),
    combatWhileWalking: entry.combat.whileWalking,
    combatRefresh: String(entry.combat.refreshRounds),
    combatAvoid: joinNames(entry.combat.avoid),
    combatAvoidUndead: entry.combat.avoidUndead,
    combatAvoidDeathSpell: entry.combat.avoidDeathSpell,
    combatMaxTargetHealth: String(entry.combat.maxTargetHealth),
    combatMinMobs: String(entry.combat.minMobs),
    combatMaxMonsterExp: String(entry.combat.maxMonsterExperience),
    combatPrefer: joinNames(entry.combat.prefer),
    restBelow: percent(entry.health.restBelow),
    restTo: percent(entry.health.restTo),
    meditateBelow: percent(entry.health.meditateBelow),
    potionVerb: entry.health.potionVerb,
    healingPotionName: entry.health.healingPotionName,
    drinkHealingPotionBelow: percent(entry.health.drinkHealingPotionBelow),
    manaPotionName: entry.health.manaPotionName,
    drinkManaPotionBelow: percent(entry.health.drinkManaPotionBelow),
    spellAttack: entry.spells.attack,
    spellAreaAttack: entry.spells.areaAttack,
    spellAreaMinMobs: String(entry.spells.areaMinMobs),
    spellAreaMinMana: percent(entry.spells.areaMinMana),
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
    openDoors: entry.movement.openDoors,
    openTries: String(entry.movement.openTries),
    pickLocks: entry.movement.pickLocks,
    pickTries: String(entry.movement.pickTries),
    bashDoors: entry.movement.bashDoors,
    bashTries: String(entry.movement.bashTries),
    sneak: entry.movement.sneak,
    provideLight: entry.movement.provideLight,
    lightDimRooms: entry.movement.lightDimRooms,
    extinguishInLight: entry.movement.extinguishInLight,
    // This character's *own* loops. What it inherits is shown beside them and
    // is not editable from here -- see `LoopSection`.
    loops: entry.loops,
    alertMinimum: entry.alerts.minimum,
    alertMuted: entry.alerts.mute,
    answerRemotes: entry.remotes.enabled,
    remoteGangpath: entry.remotes.gangpath,
    remoteGang: [...entry.remotes.gang],
    remoteParty: [...entry.remotes.party],
    remotePlayers: entry.remotes.players,
    lookAtPlayers: entry.talk.lookAtPlayers
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
function sameForm(a: CharacterForm, b: CharacterForm): boolean {
  return sameJson(a, b);
}

/** The same test for the server and client forms, which are plain drafts. */
function sameJson<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Puts a loop on a form, or takes it off — matched by name.
 *
 * By name because that is how a loop is addressed everywhere else: the palette
 * starts one by name and `loopNamed` finds it by name, so two called the same
 * thing are already one to everything that runs them. One helper for all three
 * forms that hold loops, so a fix to the matching has one place to land.
 */
function withLoopToggled<T extends { loops: Loop[] }>(
  current: History<T> | null,
  loop: Loop,
  same: (a: T, b: T) => boolean
): History<T> | null {
  if (current === null) return current;
  const has = current.present.loops.some((entry) => entry.name === loop.name);
  return record(
    current,
    {
      ...current.present,
      loops: has
        ? current.present.loops.filter((entry) => entry.name !== loop.name)
        : [...current.present.loops, loop]
    },
    same
  );
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
function draftOf(form: CharacterForm): ProfileDraft {
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
    retreat: {
      enabled: form.retreat,
      belowHealth: (Number.parseInt(form.retreatBelow, 10) || 0) / 100,
      whenOutnumbered: Number.parseInt(form.retreatOutnumbered, 10) || 0,
      strategy: RETREAT_STRATEGIES.includes(form.retreatStrategy as RetreatStrategy)
        ? (form.retreatStrategy as RetreatStrategy)
        : 'step-back',
      safeHavenRoom: form.retreatHaven.trim()
    },
    combat: {
      enabled: form.combat,
      attack: form.combatAttack,
      opener: form.combatOpener,
      engage: form.combatEngage,
      retaliate: form.combatRetaliate,
      maxMobs: Number.parseInt(form.combatMaxMobs, 10) || 0,
      minHealth: (Number.parseInt(form.combatMinHealth, 10) || 0) / 100,
      whileWalking: form.combatWhileWalking,
      refreshRounds: Number.parseInt(form.combatRefresh, 10) || 0,
      avoid: splitNames(form.combatAvoid),
      avoidUndead: form.combatAvoidUndead,
      avoidDeathSpell: form.combatAvoidDeathSpell,
      maxTargetHealth: Math.max(0, Number.parseInt(form.combatMaxTargetHealth, 10) || 0),
      minMobs: Math.max(0, Number.parseInt(form.combatMinMobs, 10) || 0),
      maxMonsterExperience: Math.max(0, Number.parseInt(form.combatMaxMonsterExp, 10) || 0),
      prefer: splitNames(form.combatPrefer)
    },
    hangUp: {
      enabled: form.hangUp,
      belowHealth: (Number.parseInt(form.hangUpBelow, 10) || 0) / 100,
      onlyWhenClean: form.hangUpOnlyWhenClean,
      onPlayerInRoom: form.hangUpOnPlayer
    },
    pvp: { notifyGang: form.pvpNotifyGang, action: form.pvpAction },
    party: {
      assistLeader: form.partyAssist,
      defendParty: form.partyDefend,
      restWithLeader: form.partyRest
    },
    health: {
      restBelow: fractionOf(form.restBelow),
      restTo: fractionOf(form.restTo),
      meditateBelow: fractionOf(form.meditateBelow),
      drinkHealingPotionBelow: fractionOf(form.drinkHealingPotionBelow),
      drinkManaPotionBelow: fractionOf(form.drinkManaPotionBelow),
      potionVerb: form.potionVerb === 'use' ? 'use' : 'drink',
      healingPotionName: form.healingPotionName.trim(),
      manaPotionName: form.manaPotionName.trim()
    },
    spells: {
      attack: form.spellAttack.trim(),
      areaAttack: form.spellAreaAttack.trim(),
      areaMinMobs: Math.max(1, Number.parseInt(form.spellAreaMinMobs, 10) || 3),
      areaMinMana: fractionOf(form.spellAreaMinMana),
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
        disease: form.spellCures.disease.trim()
      },
      blessings: form.spellBlessings.map((blessing) => ({
        ...blessing,
        spell: blessing.spell.trim()
      })),
      notifyPartyOnWearOff: form.spellNotifyWearOff
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
      lightDimRooms: form.lightDimRooms,
      extinguishInLight: form.extinguishInLight
    },
    loops: form.loops,
    alerts: { minimum: form.alertMinimum, mute: form.alertMuted },
    remotes: {
      enabled: form.answerRemotes,
      gangpath: form.remoteGangpath,
      gang: form.remoteGang,
      party: form.remoteParty,
      players: form.remotePlayers
    },
    talk: { lookAtPlayers: form.lookAtPlayers }
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
function copyOf(entry: ProfileEditable): CharacterForm {
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
 */
/**
 * A realm that does not exist yet, started from the Global defaults.
 *
 * Same rule as `emptyForm`: the second realm on one BBS is otherwise the same
 * port, the same encoding and the same five menus typed a second time, and
 * every one of them can be got subtly wrong. The copy is taken here and
 * written into the realm's own file, so changing the defaults afterwards
 * changes what the *next* realm starts with.
 *
 * The host and the name are not carried, and that is the point rather than an
 * omission: they are what make it a different realm.
 */
/** This form keeps every field as the string in its box, so the percent is one too. */
const percent = (fraction: number): string => String(percentOf(fraction));

function emptyServerForm(defaults: GlobalDraft | null): ServerDraft {
  return {
    name: '',
    host: '',
    port: defaults?.connection.port || 23,
    encoding: defaults?.connection.encoding ?? 'cp437',
    login: (defaults?.connection.login.steps ?? []).map((step) => ({ ...step })),
    loops: [],
    // Empty is the world the client ships, which is right for a new realm until
    // somebody says otherwise. There is no Global default to copy: a map is a
    // fact about one place, so there is no sensible "next realm" value for it.
    database: ''
  };
}

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
function emptyForm(
  servers: SettingsSnapshot['servers'],
  defaults: GlobalDraft | null
): CharacterForm {
  const combat = defaults?.automation.combat ?? DEFAULT_COMBAT;
  const health = defaults?.automation.health ?? DEFAULT_HEALTH;
  const party = defaults?.automation.party ?? DEFAULT_CONFIG.automation.party;
  const movement = defaults?.automation.movement ?? DEFAULT_MOVEMENT;
  const spells = defaults?.automation.spells ?? DEFAULT_SPELLS;
  const alerts = defaults?.ui.alerts ?? DEFAULT_ALERTS;
  const remotes = defaults?.automation.remotes ?? DEFAULT_CONFIG.automation.remotes;
  const talk = defaults?.automation.talk ?? DEFAULT_CONFIG.automation.talk;
  const retreat = defaults?.automation.retreat ?? DEFAULT_CONFIG.automation.safety.retreat;
  const hangUp = defaults?.automation.hangUp ?? DEFAULT_CONFIG.automation.safety.hangUp;
  const pvp = defaults?.automation.pvp ?? DEFAULT_CONFIG.automation.safety.pvp;

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
    retreat: retreat.enabled,
    retreatBelow: percent(retreat.belowHealth),
    retreatOutnumbered: String(retreat.whenOutnumbered),
    retreatStrategy: retreat.strategy,
    retreatHaven: retreat.safeHavenRoom,
    hangUp: hangUp.enabled,
    hangUpBelow: percent(hangUp.belowHealth),
    hangUpOnlyWhenClean: hangUp.onlyWhenClean,
    hangUpOnPlayer: hangUp.onPlayerInRoom,
    pvpNotifyGang: pvp.notifyGang,
    pvpAction: pvp.action,
    combat: combat.enabled,
    combatAttack: combat.attack,
    combatOpener: combat.opener,
    combatEngage: combat.engage,
    combatRetaliate: combat.retaliate,
    combatMaxMobs: String(combat.maxMobs),
    partyAssist: party.assistLeader,
    partyDefend: party.defendParty,
    partyRest: party.restWithLeader,
    combatMinHealth: percent(combat.minHealth),
    combatWhileWalking: combat.whileWalking,
    combatRefresh: String(combat.refreshRounds),
    combatAvoid: joinNames(combat.avoid),
    combatAvoidUndead: combat.avoidUndead,
    combatAvoidDeathSpell: combat.avoidDeathSpell,
    combatMaxTargetHealth: String(combat.maxTargetHealth),
    combatMinMobs: String(combat.minMobs),
    combatMaxMonsterExp: String(combat.maxMonsterExperience),
    combatPrefer: joinNames(combat.prefer),
    restBelow: percent(health.restBelow),
    restTo: percent(health.restTo),
    meditateBelow: percent(health.meditateBelow),
    potionVerb: health.potionVerb,
    healingPotionName: health.healingPotionName,
    drinkHealingPotionBelow: percent(health.drinkHealingPotionBelow),
    manaPotionName: health.manaPotionName,
    drinkManaPotionBelow: percent(health.drinkManaPotionBelow),
    spellAttack: spells.attack,
    spellAreaAttack: spells.areaAttack,
    spellAreaMinMobs: String(spells.areaMinMobs),
    spellAreaMinMana: percent(spells.areaMinMana),
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
    openDoors: movement.openDoors,
    openTries: String(movement.openTries),
    pickLocks: movement.pickLocks,
    pickTries: String(movement.pickTries),
    bashDoors: movement.bashDoors,
    bashTries: String(movement.bashTries),
    sneak: movement.sneak,
    provideLight: movement.provideLight,
    lightDimRooms: movement.lightDimRooms,
    extinguishInLight: movement.extinguishInLight,
    loops: [],
    // `ProfileDraft` types this as a plain string, since a draft is a payload
    // parsed at the boundary; the form holds the closed union.
    alertMinimum: (alerts.minimum as Severity) ?? DEFAULT_ALERTS.minimum,
    alertMuted: [...alerts.mute],
    answerRemotes: remotes.enabled,
    remoteGangpath: remotes.gangpath,
    remoteGang: [...remotes.gang],
    remoteParty: [...remotes.party],
    remotePlayers: remotes.players,
    lookAtPlayers: talk.lookAtPlayers
  };
}

/**
 * Creating and editing characters and servers, without opening a text editor.
 *
 * The command strip was removed because a host and a port describe a
 * *character* and not the client, and that information moved into
 * `profiles/*.yaml` — which is fine for somebody who edits YAML and is not fine
 * as the only way in. This is the way in.
 *
 * Deliberately **not** an editor for the whole options file. A profile is a
 * sparse overlay that may carry `automation:` and `ui:` blocks, and YAML is
 * genuinely good at those: they are lists of rules with comments explaining
 * why. What YAML is bad at is a password, a port and a menu answer, and that is
 * what this covers. The screen says where the files are so the rest stays one
 * click away.
 *
 * ## Two rules, and both have been broken here before
 *
 * **A section exists when there is a typed config block behind it, and not
 * because the nouns sort cleanly.** That is why there was no Combat section for
 * four phases: attack *rules* are `automation.rules`, and a form field for one
 * is a second representation of something the YAML already states precisely,
 * with its own comments explaining why.
 *
 * The sections are now **MegaMUD's own tabs** — Combat, Health, Spells,
 * Movement — and that is a change to the *labels*, not to the test. Each one
 * has a typed block behind it that a rule could not hold:
 *
 * - `automation.combat` — the question in the middle of it, *is the thing in
 *   front of me going to attack me, and is it a person*, is not one a guard
 *   expression can ask.
 * - `automation.health` — resting is not a condition, it is a *state the
 *   character is in* that the status line reports, that blocks nothing, and
 *   that moving or attacking ends by itself.
 * - `automation.spells` — one cast, at the mid-round tick, which is the one
 *   thing about a spell a rule genuinely cannot express: ~100 ms after the last
 *   swing, inside the round rather than after it.
 * - `automation.movement` — what a route may do on the way, which belongs to
 *   the walker's state machine rather than to a condition over character state.
 *
 * Everything else a caster or a healer wants — buffs, heals, when to loot, when
 * to give up — is still `automation.rules`, and the Spells section says so in
 * one line rather than not existing.
 *
 * **And a control is a label, a value and at most one sentence.** See
 * docs/terminology.md, which exists because this screen grew into a help
 * system one true paragraph at a time. The explanation moved to
 * `default.yaml`, where somebody editing YAML is actually asking for it; what
 * is left here is `Hint` — a mark that opens one sentence on hover, on focus
 * and on click. Two things stay in the open, both because they can cost a
 * character: opening fights unasked, and hanging up.
 *
 * A dialog that takes typed input, so it honours the focus policy: it holds the
 * caret while open and hands it back to the terminal on any exit.
 */
export default function SettingsScreen({
  open,
  openAt = null,
  maximaFor,
  onClose,
  load,
  saveProfile,
  deleteProfile,
  saveServer,
  deleteServer,
  saveGlobal,
  revealConfig,
  revealProfiles,
  chooseRealm,
  loadLoops
}: SettingsScreenProps) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  /**
   * Which of the four pages is showing.
   *
   * `client` is MudEngine and `defaults` is Global: two views of one file, so
   * they share a draft, a form and a save. See `GlobalSettings`.
   */
  const [tab, setTab] = useState<GlobalTab | 'characters' | 'servers'>('characters');
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The character form, and every step back from it.
   *
   * A `History` rather than a bare value because the Save button is gone: what
   * somebody typed is saved on its own, so the way back has to be a control
   * rather than "close without saving". `form` is the present; `loadForm`
   * starts a fresh history (opening a character is not something to undo into)
   * and `edit` records a step.
   */
  const [history, setHistory] = useState<History<CharacterForm> | null>(null);
  const form = history?.present ?? null;
  /**
   * Which part of a character's own form is showing.
   *
   * The character form outgrew one scroll: a name and a server share nothing
   * with a hang-up threshold, and finding either meant scrolling past fields
   * that were not it. Split along what the fields actually are — identity and
   * connection, the login menus, auto-combat and the two safety nets — rather
   * than inventing sections for settings this screen does not hold. Attack
   * *rules* and spells stay in `automation.rules`, on purpose: see the class
   * comment above for the test a section has to pass.
   */
  const [section, setSection] = useState<Section>('profile');
  /**
   * Whether the shelf of shipped loops is open, and what is on it.
   *
   * The catalogue is read once per visit to this screen and kept: it is four
   * hundred loops out of a file inside the application, so it cannot change
   * while the screen is open, and re-asking on every keystroke in the search
   * field would be a query per character typed.
   */
  /**
   * Which character a new one is being started from, if any.
   *
   * Held rather than left as a write-once select, so the control keeps saying
   * what it did. A select that snapped back to "start empty" the moment it was
   * used would read as one that had not worked.
   */
  const [copyFrom, setCopyFrom] = useState('');
  const [picking, setPicking] = useState(false);
  const [catalogue, setCatalogue] = useState<Loop[] | null>(null);
  const [serverPick, setServerPick] = useState<string | null>(null);
  /** The server form, with the same way back the character form has. */
  const [serverHistory, setServerHistory] = useState<History<ServerDraft> | null>(null);
  const serverForm = serverHistory?.present ?? null;
  /**
   * The options file, as a form holds it.
   *
   * Kept beside the character and server forms rather than inside
   * `GlobalSettings`, so a refused save can put the error where the other two
   * put theirs and a reload after saving can hand back what is now on disk.
   */
  const [globalHistory, setGlobalHistory] = useState<History<GlobalDraft> | null>(null);
  const globalForm = globalHistory?.present ?? null;
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  /**
   * Puts a form on screen without making it a step.
   *
   * Opening a character, starting a blank one, copying from one: none of those
   * is an edit, and a history that recorded them would let an undo pull another
   * character's fields onto the screen under this one's name.
   */
  const loadForm = useCallback((value: CharacterForm | null): void => {
    setHistory(value === null ? null : begin(value));
  }, []);

  /*
   * The same pair for the other two forms. `set*` records a step, `load*`
   * starts a fresh history -- and every call site below reads as it did, which
   * is the point: what changed is what the setter *means*, not who calls it.
   */
  const setServerForm = useCallback((next: ServerDraft): void => {
    setServerHistory((current) => (current ? record(current, next, sameJson) : begin(next)));
    setSaved(null);
  }, []);

  const loadServerForm = useCallback((value: ServerDraft | null): void => {
    setServerHistory(value === null ? null : begin(value));
  }, []);

  const setGlobalForm = useCallback((next: GlobalDraft): void => {
    setGlobalHistory((current) => (current ? record(current, next, sameJson) : begin(next)));
    setSaved(null);
  }, []);

  const loadGlobalForm = useCallback((value: GlobalDraft | null): void => {
    setGlobalHistory(value === null ? null : begin(value));
  }, []);

  const refresh = useCallback(async (): Promise<SettingsSnapshot> => {
    const next = await load();
    setSnapshot(next);
    return next;
  }, [load]);

  /*
   * Runs when the dialog *opens*, and only then.
   *
   * Keyed on `open` alone. It used to depend on `refresh`, which depends on the
   * `load` prop — and a caller passing an inline arrow makes that a new function
   * every render, so this ran on every render and cleared the message it had
   * just been given. A refused save flashed and vanished, which reads exactly
   * like a save that silently did nothing.
   */
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setSaved(null);
    setConfirming(null);
    const opened = refresh().then((next) => {
      /*
       * Asked for by name — a tab's own menu, or the `+` beside the tabs.
       *
       * The form is set here rather than left to the effect below, which stands
       * down while one is already loaded. Arriving from a tab menu with the
       * previous character's fields still in state would put that character's
       * username and server under this one's heading, and the first thing
       * anybody would do is save it.
       */
      // Every branch below lands on a character's Profile section, if it
      // lands on a character at all -- the last section viewed belongs to the
      // character it was viewed on, not to whichever one opens next.
      setSection('profile');

      /*
       * The client's own settings, which are neither a character nor a server.
       * Loaded here rather than left to an effect, for the reason above: what
       * is on the form has to be what the heading says it is.
       */
      if (openAt === SETTINGS_GLOBAL || openAt === SETTINGS_DEFAULTS) {
        setTab(openAt === SETTINGS_GLOBAL ? 'client' : 'defaults');
        loadGlobalForm(next.global);
        return;
      }

      // A realm, not a character: the realms page has no id space to search, so
      // it is checked by its own sentinel rather than falling through to the
      // character lookup below.
      if (openAt === SETTINGS_MANAGE_SERVERS) {
        setTab('servers');
        setServerPick(next.servers[0]?.name ?? NEW_SERVER);
        loadServerForm(
          next.servers[0]
            ? { ...next.servers[0], loops: next.loops.servers[next.servers[0].name] ?? [] }
            : emptyServerForm(next.global)
        );
        return;
      }

      if (openAt === NEW_CHARACTER) {
        setTab('characters');
        setSelected(NEW_CHARACTER);
        setCopyFrom('');
        loadForm(emptyForm(next.servers, next.global));
        return;
      }
      const asked = openAt === null ? undefined : next.characters.find((e) => e.id === openAt);
      if (asked) {
        setTab('characters');
        setSelected(asked.id);
        loadForm(formOf(asked));
        return;
      }

      /*
       * Open on something.
       *
       * A settings screen that opens to an empty pane is a dead end — there is
       * nothing to read and nowhere for the caret to go, which also means the
       * dialog holds no focus and the focus policy has nothing to hand back.
       * The first character is the useful default; with none, the new-character
       * form is.
       *
       * This is also where a character asked for by name but *deleted* between
       * the click and the open lands: opening normally beats opening a blank
       * form wearing a name that no longer exists.
       */
      setSelected((current) => current ?? next.characters[0]?.id ?? NEW_CHARACTER);
    });
    // A failed load lands in the slot every other refusal uses, rather than
    // leaving the dialog on its loading state with nothing to read.
    void opened.catch((error) => setProblem(errorMessage(error)));
  }, [open, openAt]);

  // Follows `selected` once the snapshot has arrived, including the automatic
  // choice above.
  useEffect(() => {
    if (!open || selected === null || form !== null) return;
    if (selected === NEW_CHARACTER) {
      return loadForm(emptyForm(snapshot?.servers ?? [], snapshot?.global ?? null));
    }
    const found = snapshot?.characters.find((entry) => entry.id === selected);
    if (found) loadForm(formOf(found));
  }, [open, selected, form, snapshot]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, selected, tab]);

  // Follows the snapshot the same way the character form does, and stands down
  // once a form is loaded so it cannot discard what somebody is typing.
  useEffect(() => {
    if (!open || !showsGlobal(tab) || globalForm !== null || snapshot === null) return;
    loadGlobalForm(snapshot.global);
  }, [open, tab, globalForm, snapshot, loadGlobalForm]);

  const characters = snapshot?.characters ?? [];
  /**
   * What the character form's spell pickers offer: the shown character's own
   * book, read by `sp`/`pow` and persisted with its belongings. Null is
   * *never read* — the form says so and gates nothing on it.
   */
  const shownBook = useMemo(() => {
    const entry = characters.find((candidate) => candidate.id === selected);
    const spells = entry?.spellbook ?? [];
    return {
      spells,
      unread: (entry?.spellbook ?? null) === null,
      gates: entry?.cureGates ?? null,
      /*
       * The two heal fields offer different halves of the book, because the
       * realm marks who each spell may be cast on: `way of the swan` reaches
       * the caster alone, so offering it for the party heal would arm
       * `c swan <name>` once a round for a refusal printed in the room. Both
       * predicates say yes to a spell whose targeting this build cannot read,
       * so a derivative realm loses no options.
       */
      selfHeals: castableOn(spells, castsOnSelf),
      partyHeals: castableOn(spells, castsOnOthers)
    };
  }, [characters, selected]);
  const servers = useMemo(() => snapshot?.servers ?? [], [snapshot]);
  /** The loops each server lends its characters, keyed by the name they use. */
  const serverLoops = useMemo(() => snapshot?.loops.servers ?? {}, [snapshot]);
  /**
   * What the character on screen walks without asking: its server's loops, then
   * the global ones.
   *
   * Off the character rather than off the snapshot, because it depends on which
   * server this one plays on — and shown rather than edited here, since scope
   * is the directory a loop file sits in and a tick box on a character's page
   * cannot move one.
   */
  const inheritedLoops = useMemo<ScopedLoop[]>(
    () =>
      selected === null || selected === NEW_CHARACTER
        ? (snapshot?.loops.global.map((loop) => ({ loop, scope: 'global' as const })) ?? [])
        : (snapshot?.characters.find((entry) => entry.id === selected)?.inherited ?? []),
    [snapshot, selected]
  );

  /*
   * Saving, without anybody having to say so.
   *
   * The Save button was the last thing on this screen that could be forgotten,
   * and forgetting it is silent: the form goes on showing what was typed, so a
   * change somebody meant to make and one they made look identical until the
   * next launch.
   *
   * **Only while editing something that already exists.** Creating still takes
   * a press, and that is not a compromise: a half-typed name is a *different*
   * file, so an auto-saved new character would write `profiles/f/`,
   * `profiles/fr/`, `profiles/fre/` -- a directory per keystroke, none of them
   * what anybody meant.
   */
  const editingCharacter = selected !== null && selected !== NEW_CHARACTER;
  const characterSave = useAutoSave<CharacterForm>({
    value: form,
    identity: selected,
    enabled: open && tab === 'characters' && editingCharacter,
    same: sameForm,
    save: async (value) => {
      const refusal = await saveProfile(selected ?? '', draftOf(value));
      // Only on success: a refused save leaves the list describing what is
      // still on disk, which is the truth.
      if (refusal === null) await refresh();
      return refusal;
    }
  });

  const editingServer = serverPick !== null && serverPick !== NEW_SERVER;
  const serverSave = useAutoSave<ServerDraft>({
    value: serverForm,
    identity: serverPick,
    enabled: open && tab === 'servers' && editingServer,
    same: sameJson,
    save: async (value) => {
      const refusal = await saveServer(serverPick, value);
      if (refusal !== null) return refusal;
      /*
       * The selection follows the name as it is typed.
       *
       * `saveServer` matches on the *previous* name to find the directory, and
       * without this the second keystroke of a rename would look up a name
       * that no longer exists on disk and make a second server beside the
       * first -- one per keystroke, which is the same failure creating has.
       *
       * Only while that realm is still the one on screen. `chooseServer`
       * flushes this save on its way to another realm, and the answer lands
       * after the switch; following the name then would drag the selection
       * back to the realm somebody just left.
       */
      setServerPick((current) => (current === serverPick ? value.name : current));
      await refresh();
      return null;
    }
  });

  const globalSave = useAutoSave<GlobalDraft>({
    value: globalForm,
    // There is exactly one options file, so the identity never changes.
    identity: 'global',
    // Always, once it is loaded: there is exactly one options file and it
    // always exists, so there is no creating case to keep out of.
    enabled: open && showsGlobal(tab) && globalForm !== null,
    same: sameJson,
    save: async (value) => {
      const refusal = await saveGlobal(value);
      if (refusal === null) await refresh();
      return refusal;
    }
  });

  /** Opening a character loads its fields; opening "new" starts an empty one. */
  const choose = useCallback(
    (id: string | null) => {
      /*
       * Whatever is still waiting out the debounce is this character's, and
       * the switch below would otherwise discard it: the timer is cleared
       * when the identity changes, and an edit younger than the delay was
       * silently lost, exactly as it would have been saved. Before
       * `setSelected`, so the save still knows whose file it is.
       */
      characterSave.flush();
      setSelected(id);
      setProblem(null);
      setSaved(null);
      setConfirming(null);
      // Every character opens on Profile. Landing wherever the last one was
      // left would show, say, the hang-up threshold under a name that has
      // nothing to do with it -- the same trap `openAt` exists to avoid one
      // level up.
      setSection('profile');
      // Putting the shelf away with the character it was opened over: a picker
      // still showing when a different name arrives is a picker whose "added"
      // ticks describe somebody else.
      setPicking(false);
      setCopyFrom('');
      if (id === null) return loadForm(null);
      if (id === NEW_CHARACTER) return loadForm(emptyForm(servers, snapshot?.global ?? null));
      const found = characters.find((entry) => entry.id === id);
      loadForm(found ? formOf(found) : null);
    },
    [characters, servers, snapshot, characterSave.flush]
  );

  /**
   * Opens the shelf, reading the catalogue the first time it is asked for.
   *
   * Lazily and once. A settings visit is usually about a password, and four
   * hundred loops are not worth carrying across the boundary for one; a file
   * inside the application cannot change while the screen is open, so once is
   * also enough.
   */
  const openPicker = useCallback(() => {
    setPicking(true);
    if (catalogue !== null) return;
    void loadLoops().then(
      (loops) => setCatalogue(loops),
      // An empty shelf, said by the picker itself. A catalogue that could not be
      // read is not a reason to refuse the save the person came here to make.
      () => setCatalogue([])
    );
  }, [catalogue, loadLoops]);

  /** Puts a loop on this character, or takes it off — see `withLoopToggled`. */
  const toggleLoop = useCallback((loop: Loop) => {
    // An edit like any other, so it steps back like one.
    setHistory((current) => withLoopToggled(current, loop, sameForm));
    setSaved(null);
  }, []);

  /** And on the client's own page: the loops every character walks. */
  const toggleGlobalLoop = useCallback((loop: Loop) => {
    setGlobalHistory((current) => withLoopToggled(current, loop, sameJson));
    setSaved(null);
  }, []);

  /** The same gesture on a server's page: its loops, everyone who plays there. */
  const toggleServerLoop = useCallback((loop: Loop) => {
    setServerHistory((current) => withLoopToggled(current, loop, sameJson));
    setSaved(null);
  }, []);

  const chooseServer = useCallback(
    (name: string | null) => {
      // The same as `choose`: the last second of typing goes to the realm it
      // was typed into, not into the bin.
      serverSave.flush();
      setServerPick(name);
      setProblem(null);
      setSaved(null);
      setConfirming(null);
      // The shelf goes with the server it was opened over: a picker still
      // showing when a different name arrives is one whose ticks describe
      // somebody else.
      setPicking(false);
      if (name === null) return loadServerForm(null);
      if (name === NEW_SERVER) return loadServerForm(emptyServerForm(snapshot?.global ?? null));
      const found = servers.find((entry) => entry.name === name);
      // The loops come from the tree rather than from the realm entry: they
      // are files beside it, and the entry is only what its own file says.
      loadServerForm(found ? { ...found, loops: serverLoops[name] ?? [] } : null);
    },
    [servers, serverLoops, snapshot, serverSave.flush]
  );

  /**
   * Jump to the servers list from wherever the dialog currently is.
   *
   * Lands on the first server rather than an empty list: the same "open on
   * something" rule the character tab follows, and for the same reason -- a
   * pane with nothing selected holds no focusable field, which is a dead end
   * for a dialog that is supposed to hand the caret straight to a field. With
   * none at all it lands on the add-a-server form instead, which does.
   */
  const goToServers = useCallback(() => {
    setTab('servers');
    chooseServer(servers[0]?.name ?? NEW_SERVER);
  }, [servers, chooseServer]);

  /**
   * Open MudEngine or Global, both of which draw the options file.
   *
   * The form is loaded here rather than left to the effect that follows `tab`:
   * that effect stands down while one is already loaded, which is what keeps
   * it from discarding what somebody is typing — so arriving with a stale
   * draft would show the *previous* values under this heading, and the first
   * thing anybody would do is save them.
   */
  const openGlobal = useCallback(
    (which: GlobalTab) => {
      setTab(which);
      setProblem(null);
      setSaved(null);
      setPicking(false);
      if (snapshot !== null) loadGlobalForm(snapshot.global);
    },
    [snapshot, loadGlobalForm]
  );

  /** Whichever form is on screen: its way back, and how its saving is going. */
  const active = useMemo(() => {
    if (showsGlobal(tab)) {
      return {
        save: globalSave,
        can: {
          undo: globalHistory !== null && canUndo(globalHistory),
          redo: globalHistory !== null && canRedo(globalHistory)
        },
        undo: () => setGlobalHistory((current) => (current ? undo(current) : current)),
        redo: () => setGlobalHistory((current) => (current ? redo(current) : current))
      };
    }
    if (tab === 'servers') {
      return {
        save: serverSave,
        can: {
          undo: serverHistory !== null && canUndo(serverHistory),
          redo: serverHistory !== null && canRedo(serverHistory)
        },
        undo: () => setServerHistory((current) => (current ? undo(current) : current)),
        redo: () => setServerHistory((current) => (current ? redo(current) : current))
      };
    }
    return {
      save: characterSave,
      can: {
        undo: history !== null && canUndo(history),
        redo: history !== null && canRedo(history)
      },
      undo: () => setHistory((current) => (current ? undo(current) : current)),
      redo: () => setHistory((current) => (current ? redo(current) : current))
    };
  }, [tab, globalSave, serverSave, characterSave, globalHistory, serverHistory, history]);

  /**
   * Closing does not lose the last second of typing.
   *
   * The write is debounced, so there is always a moment where what is on screen
   * is newer than what is on disk — and closing the dialog is exactly when
   * somebody stops typing. Flushed rather than left to the timer, which is gone
   * the moment this unmounts.
   */
  const close = (): void => {
    active.save.flush();
    onClose();
  };

  if (!open) return null;

  /*
   * What this character's thresholds are percentages of.
   *
   * `NEW_CHARACTER` has no session and therefore no maxima, which is right
   * rather than merely tolerated: a character that has never been in the realm
   * has no hit points to state, and `figureOf` draws that as nothing.
   */
  const maxima =
    selected !== null && selected !== NEW_CHARACTER
      ? maximaFor(selected)
      : { hpMax: null, manaMax: null };
  /*
   * A threshold field holds the percent as typed, so the figure is composed
   * from the string rather than from the stored fraction: what somebody wants
   * to see beside a half-typed `7` is what `7` would mean, not what the last
   * saved value meant.
   */
  const ofHealth = (typed: string): string | null =>
    figureOf(Number.parseInt(typed, 10) || 0, maxima.hpMax);
  const ofMana = (typed: string): string | null =>
    figureOf(Number.parseInt(typed, 10) || 0, maxima.manaMax);

  const patch = (change: Partial<CharacterForm>): void => {
    setHistory((current) =>
      current === null ? current : record(current, { ...current.present, ...change }, sameForm)
    );
    setSaved(null);
  };

  const submitCharacter = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form) return;
    setProblem(null);
    setSaved(null);

    const id = (selected === NEW_CHARACTER ? form.id : selected) ?? '';
    const draft = draftOf(form);

    const error = await saveProfile(id, draft);
    if (error !== null) return setProblem(error);
    const next = await refresh();
    setSaved(t('settings.characters.saved', { characterName: form.name || id }));
    // A character just created is the one you want open.
    setSelected(id);
    const found = next.characters.find((entry) => entry.id === id);
    // What came back from disk, not a step: recording it would put a move in
    // the history that nobody made.
    if (found)
      setHistory((current) => (current ? replace(current, formOf(found)) : begin(formOf(found))));
  };

  const submitServer = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!serverForm) return;
    setProblem(null);
    setSaved(null);
    const previous = serverPick === NEW_SERVER ? null : serverPick;
    const error = await saveServer(previous, serverForm);
    if (error !== null) return setProblem(error);
    await refresh();
    setSaved(t('settings.realms.saved', { realmName: serverForm.name }));
    setServerPick(serverForm.name);
  };

  const submitGlobal = async (): Promise<void> => {
    if (!globalForm) return;
    setProblem(null);
    setSaved(null);
    const error = await saveGlobal(globalForm);
    if (error !== null) return setProblem(error);
    const next = await refresh();
    /*
     * What came back from disk, and not a step: the password fields are
     * cleared by the round trip, which is what stops a second save re-sending
     * one nobody retyped — but nothing here is a move somebody made, so the
     * way back is left as it was.
     */
    setGlobalHistory((current) => (current ? replace(current, next.global) : begin(next.global)));
    setSaved(t('settings.global.saved'));
  };

  const remove = async (): Promise<void> => {
    if (selected === null || selected === NEW_CHARACTER) return;
    const error = await deleteProfile(selected);
    if (error !== null) return setProblem(error);
    await refresh();
    choose(null);
    setSaved(t('settings.characters.removed'));
  };

  const removeServer = async (): Promise<void> => {
    if (serverPick === null || serverPick === NEW_SERVER) return;
    const error = await deleteServer(serverPick);
    if (error !== null) return setProblem(error);
    await refresh();
    chooseServer(null);
    setSaved(t('settings.realms.removed'));
  };

  return (
    <div className="settings-scrim" onMouseDown={close} role="presentation">
      <div
        aria-label={t('settings.dialog.ariaLabel')}
        aria-modal="true"
        className="surface settings"
        onKeyDown={(event) => {
          /*
           * The dialog owns its own Escape.
           *
           * A window-level hotkey cannot serve this: `useHotkeys` listens in
           * capture and stands down for an unmodified key while the caret is in
           * a chrome text field — which is exactly the state this dialog is
           * normally in, because it is a form. A surface that holds the caret
           * owns its keys, and Escape most of all: this one holds the keyboard
           * while a character is standing somewhere.
           */
          /*
           * Undo and redo, on whichever chord the hands know.
           *
           * `Cmd Shift Z` is the macOS redo, `Ctrl Y` the Windows one, and
           * `Ctrl Shift Z` is understood everywhere — all three are accepted,
           * because somebody arriving from another application presses theirs
           * and a chord that silently does nothing reads as a feature that is
           * not there. It stands down while the caret is in a text field,
           * where `Ctrl Z` is the field's own undo and works a character at a
           * time; the buttons stay reachable there. See `historyIntent`.
           */
          const intent = historyIntent(event, targetOf(event.target));
          if (intent !== null) {
            event.preventDefault();
            if (intent === 'undo') active.undo();
            else active.redo();
            return;
          }

          if (event.key !== 'Escape') return;
          event.preventDefault();
          // One Escape, one step, innermost first, so the key never does
          // something bigger than expected. The loop shelf is not in this
          // list: it holds the caret while it is open and stops the event
          // before it reaches here, which is the same rule stated from the
          // other side — a bare key belongs to whatever holds the caret.
          if (confirming !== null) return setConfirming(null);
          close();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-head">
          {/*
            General to particular, left to right: the client, then what a new
            realm and a new character start from, then the realms, then the
            characters. Somebody arriving to change a password walks the whole
            row to get there, which is right -- the row is also the sentence
            that explains how the four relate.

            No separator between them. A pill already has an edge, and a glyph
            between two of them doubles the seam instead of marking it --
            CLAUDE.md, "A card's faces live in its heading". This heading is
            the same control as a card's faces and had kept its `›`.
          */}
          <h2>
            <button
              className="crumb"
              data-active={tab === 'client' ? 'true' : 'false'}
              onClick={() => openGlobal('client')}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.crumbs.mudEngine')}
            </button>
            <button
              className="crumb"
              data-active={tab === 'defaults' ? 'true' : 'false'}
              onClick={() => openGlobal('defaults')}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.crumbs.global')}
            </button>
            <button
              className="crumb"
              data-active={tab === 'servers' ? 'true' : 'false'}
              /*
               * `goToServers`, not `setTab`. There are two doors onto this list
               * -- this crumb and the palette's `Settings: add or edit a
               * realm...` -- and only one of them was landing on a realm. The
               * other showed "Choose a realm, or add one." over a list of one,
               * which is a dead screen with no focusable field in it.
               */
              onClick={goToServers}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.crumbs.realms')}
            </button>
            <button
              className="crumb"
              data-active={tab === 'characters' ? 'true' : 'false'}
              onClick={() => setTab('characters')}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.crumbs.characters')}
            </button>
          </h2>
          <button
            aria-label={t('settings.dialog.closeAria')}
            className="quiet"
            onClick={close}
            type="button"
          >
            ✕
          </button>
        </header>

        <div className="settings-body" data-tab={tab}>
          {showsGlobal(tab) ? (
            globalForm === null ? (
              <div className="settings-form empty">{t('settings.global.loading')}</div>
            ) : (
              <GlobalSettings
                catalogue={catalogue}
                draft={globalForm}
                scope={tab}
                firstFieldRef={firstFieldRef}
                realmSpells={snapshot?.realmSpells ?? []}
                onChange={(next) => {
                  setGlobalForm(next);
                  setSaved(null);
                }}
                onDonePicking={() => setPicking(false)}
                onOpenPicker={openPicker}
                actions={
                  <FormActions
                    can={active.can}
                    error={active.save.error}
                    onRedo={active.redo}
                    onUndo={active.undo}
                    state={active.save.state}
                  />
                }
                onSubmit={() => void submitGlobal()}
                onToggleLoop={toggleGlobalLoop}
                picking={picking}
              />
            )
          ) : tab === 'characters' ? (
            <>
              <ul className="settings-list">
                {characters.map((entry) => (
                  <li key={entry.id}>
                    <button
                      data-active={selected === entry.id ? 'true' : 'false'}
                      data-broken={entry.error ? 'true' : undefined}
                      onClick={() => choose(entry.id)}
                      onMouseDown={keepFocus}
                      type="button"
                    >
                      <span className="dot" data-accent={entry.accent} />
                      {/*
                        Two rows, name over realm.

                        Side by side they competed for one line: a character
                        called Vaelor beside "GreaterMUD (local)" left the name
                        -- the only part that tells one row from another --
                        clipped to "Vael...", and the realm is the same word on
                        every row, so the clipping fell on exactly the half
                        that was doing the work. Stacking gives each its own
                        line and lets the name have the whole width.
                      */}
                      <span className="settings-entry">
                        <span className="settings-name">{entry.name}</span>
                        <span className="hint">
                          {entry.error
                            ? t('settings.characters.cannotLoad')
                            : (entry.serverName ?? entry.target.host)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    className="settings-add"
                    data-active={selected === NEW_CHARACTER ? 'true' : 'false'}
                    onClick={() => choose(NEW_CHARACTER)}
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    {t('settings.characters.new')}
                  </button>
                </li>
              </ul>

              {form === null ? (
                <div className="settings-form empty">
                  {characters.length === 0
                    ? t('settings.characters.emptyNone')
                    : t('settings.characters.emptyChoose')}
                </div>
              ) : (
                <form className="settings-form" onSubmit={(event) => void submitCharacter(event)}>
                  {/*
                    The same pill each face of a card wears (§ "card faces"),
                    reused rather than reinvented: one navigable-heading grammar
                    for the whole app instead of two that happen to look alike.
                  */}
                  <div className="crumbs settings-sections" role="tablist">
                    {SECTIONS.map((id) => (
                      <button
                        aria-selected={section === id}
                        className="crumb"
                        data-active={section === id ? 'true' : 'false'}
                        key={id}
                        onClick={() => setSection(id)}
                        onMouseDown={keepFocus}
                        role="tab"
                        type="button"
                      >
                        {SECTION_LABEL[id]}
                      </button>
                    ))}
                  </div>

                  {section === 'profile' && (
                    <>
                      {/*
                        Start from a character that already works.

                        The second character on a realm otherwise means
                        retyping a realm, a login script, four combat verbs
                        and every threshold — all of which the first one
                        already states, and all of which can be got subtly
                        wrong the second time. A select rather than a
                        duplicate-this-character button on each row, because
                        the question is asked while making one, and this is
                        where somebody already is.
                      */}
                      {selected === NEW_CHARACTER && characters.length > 0 && (
                        <SelectField
                          hint={t('settings.profile.copyFromHint')}
                          label={t('settings.profile.copyFromLabel')}
                          name="copy-from"
                          onChange={(value) => {
                            setCopyFrom(value);
                            setProblem(null);
                            setSaved(null);
                            const found = characters.find((entry) => entry.id === value);
                            // Back to empty is a real answer, and it has to
                            // undo what choosing did or the control is
                            // one-way.
                            loadForm(
                              found ? copyOf(found) : emptyForm(servers, snapshot?.global ?? null)
                            );
                          }}
                          options={[
                            { value: '', label: t('settings.profile.copyFromNone') },
                            ...characters
                              .filter((entry) => entry.error === undefined)
                              .map((entry) => ({ value: entry.id, label: entry.name }))
                          ]}
                          value={copyFrom}
                        />
                      )}

                      {selected === NEW_CHARACTER && (
                        // The id is the session id, the log name, the capture
                        // name and the key every remembered preference hangs
                        // off — so it is worth saying it is not the display
                        // name, once, where somebody is choosing it.
                        <TextField
                          hint={t('settings.profile.idHint')}
                          inputRef={firstFieldRef}
                          label={t('settings.profile.idLabel')}
                          name="id"
                          onChange={(value) => patch({ id: value })}
                          placeholder={t('settings.profile.idPlaceholder')}
                          spellCheck={false}
                          value={form.id}
                        />
                      )}

                      <TextField
                        inputRef={selected === NEW_CHARACTER ? undefined : firstFieldRef}
                        label={t('settings.realms.nameLabel')}
                        name="name"
                        onChange={(value) => patch({ name: value })}
                        placeholder={form.id || t('settings.profile.namePlaceholder')}
                        value={form.name}
                      />

                      <FormField label={t('settings.profile.playsOnLabel')} name="plays-on" wide>
                        {() => (
                          <div className="settings-file">
                            <select
                              onChange={(event) =>
                                patch({
                                  serverName: event.target.value === '' ? null : event.target.value
                                })
                              }
                              value={form.serverName ?? ''}
                            >
                              {servers.map((server) => (
                                <option key={server.name} value={server.name}>
                                  {server.name}
                                </option>
                              ))}
                              <option value="">{t('settings.profile.playsOnElsewhere')}</option>
                            </select>
                            {/*
                              The other way to a realm, beside the field that
                              names one -- not only from the command palette. A
                              realm edited here is one that every character
                              referring to it by name plays on next connection.
                            */}
                            <button
                              className="quiet"
                              onClick={goToServers}
                              onMouseDown={keepFocus}
                              type="button"
                            >
                              {t('settings.profile.manageRealms')}
                            </button>
                          </div>
                        )}
                      </FormField>

                      {form.serverName === null && (
                        <div className="settings-inline">
                          <TextField
                            label={t('settings.profile.hostLabel')}
                            name="host"
                            onChange={(value) => patch({ host: value })}
                            placeholder={t('settings.profile.hostPlaceholder')}
                            spellCheck={false}
                            value={form.host}
                          />
                          <NumberField
                            label={t('settings.profile.portLabel')}
                            name="port"
                            onChange={(value) => patch({ port: value })}
                            value={form.port}
                          />
                        </div>
                      )}

                      {/*
                        The encoding is the right answer already, and it is one
                        nobody can choose well without knowing what CP437 is --
                        so it sits behind a press rather than beside the
                        username on the form somebody opened to type a
                        password. Only for a character that spells its address
                        out: one playing on a saved realm takes the realm's.
                      */}
                      {form.serverName === null && (
                        <Advanced label={t('settings.advancedWire')}>
                          <SelectField
                            hint={t('settings.profile.encodingHint')}
                            label={t('settings.profile.encodingLabel')}
                            name="character-encoding"
                            onChange={(value) => patch({ encoding: value as StreamEncoding })}
                            options={ENCODINGS.map((encoding) => ({
                              value: encoding,
                              label: encoding
                            }))}
                            value={form.encoding}
                          />
                        </Advanced>
                      )}

                      <TextField
                        autoComplete="off"
                        label={t('settings.profile.usernameLabel')}
                        name="username"
                        onChange={(value) => patch({ username: value })}
                        spellCheck={false}
                        value={form.username}
                      />

                      {/* Never read back out of the file: a password that has
                          crossed to a window can end up in a devtools
                          snapshot, a crash report or a screenshot. */}
                      <PasswordField
                        hint={t('settings.profile.passwordHint')}
                        label={t('settings.profile.passwordLabel')}
                        name="password"
                        onChange={(value) => patch({ password: value, changePassword: true })}
                        placeholder={
                          form.changePassword
                            ? ''
                            : characters.find((entry) => entry.id === selected)?.hasPassword
                              ? t('settings.profile.passwordPlaceholderSet')
                              : t('settings.profile.passwordPlaceholderUnset')
                        }
                        value={form.password}
                      />

                      <CheckField
                        checked={form.autoConnect}
                        label={t('settings.profile.autoConnectLabel')}
                        name="auto-connect"
                        onChange={(value) => patch({ autoConnect: value })}
                      />

                      <CheckField
                        checked={form.autoReconnect}
                        hint={t('settings.profile.autoReconnectHint')}
                        label={t('settings.profile.autoReconnectLabel')}
                        name="auto-reconnect"
                        onChange={(value) => patch({ autoReconnect: value })}
                      />

                      <FormField label={t('settings.profile.accentLabel')} name="accent">
                        {() => (
                          <div className="settings-accents">
                            {PROFILE_ACCENTS.map((accent) => (
                              <button
                                aria-label={accent}
                                className="accent-swatch"
                                data-accent={accent}
                                data-active={form.accent === accent ? 'true' : 'false'}
                                key={accent}
                                onClick={() => patch({ accent })}
                                onMouseDown={keepFocus}
                                type="button"
                              />
                            ))}
                          </div>
                        )}
                      </FormField>

                      {/* Named for the page it is set on, not for the file
                          behind it: somebody who wants to change it needs to
                          know where to go, and "the options file" is a path
                          rather than a place in the client. */}
                      <SelectField
                        label={t('settings.profile.themeLabel')}
                        name="theme"
                        onChange={(value) =>
                          patch({ theme: isThemePreference(value) ? value : '' })
                        }
                        options={[
                          { value: '', label: t('settings.profile.themeInherit') },
                          { value: 'system', label: t('settings.profile.themeSystem') },
                          ...THEME_IDS.map((id) => ({ value: id, label: THEMES[id].label }))
                        ]}
                        value={form.theme}
                      />
                    </>
                  )}

                  {section === 'login' && (
                    <fieldset className="settings-menus">
                      <legend>{t('settings.login.legend')}</legend>
                      {/*
                        Empty is the ordinary case and says so, rather than
                        being an empty box somebody feels obliged to fill in.
                        The script belongs to the realm -- every character on
                        one meets the same menus -- and a character states its
                        own only to differ, which in practice means a different
                        character slot.
                      */}
                      <p className="settings-note">
                        {t('settings.login.note', {
                          realmOrAddress:
                            form.serverName === null
                              ? t('settings.login.noteFallbackAddress')
                              : form.serverName
                        })}
                      </p>

                      {form.login.length > 0 && (
                        <ul className="settings-steps">
                          {form.login.map((step, index) => (
                            <li key={index}>
                              <input
                                aria-label={t('settings.login.stepWhenAria', {
                                  stepNumber: index + 1
                                })}
                                onChange={(event) =>
                                  patch({
                                    login: form.login.map((entry, at) =>
                                      at === index ? { ...entry, when: event.target.value } : entry
                                    )
                                  })
                                }
                                placeholder={t('settings.login.stepWhenPlaceholder')}
                                value={step.when}
                              />
                              <span aria-hidden="true" className="arrow">
                                →
                              </span>
                              <input
                                aria-label={t('settings.login.stepSendAria', {
                                  stepNumber: index + 1
                                })}
                                className="answer"
                                onChange={(event) =>
                                  patch({
                                    login: form.login.map((entry, at) =>
                                      at === index ? { ...entry, send: event.target.value } : entry
                                    )
                                  })
                                }
                                placeholder={t('settings.login.stepSendPlaceholder')}
                                value={step.send}
                              />
                              <button
                                aria-label={t('settings.login.removeStepAria', {
                                  stepNumber: index + 1
                                })}
                                className="quiet"
                                onClick={() =>
                                  patch({ login: form.login.filter((_, at) => at !== index) })
                                }
                                title={t('settings.login.removeStepTitle')}
                                type="button"
                              >
                                <Icon name="close" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      <button
                        className="quiet add-step"
                        onClick={() => patch({ login: [...form.login, { when: '', send: '' }] })}
                        type="button"
                      >
                        <Icon name="plus" />
                        <span>{t('settings.login.addStep')}</span>
                      </button>
                    </fieldset>
                  )}

                  {section === 'combat' && (
                    <>
                      {/*
                        The one warning left in the open on this screen, and the
                        rule for why: a sentence stays out of a tooltip when the
                        thing it warns about can cost a character. One sentence.
                        docs/terminology.md §1.
                      */}
                      <fieldset className="settings-menus">
                        <legend>{t('settings.combat.attackLegend')}</legend>
                        <p className="settings-warn">{t('settings.combat.openWarning')}</p>
                        <CheckField
                          checked={form.combat}
                          label={t('settings.combat.attackForMe')}
                          name="combat"
                          onChange={(value) => patch({ combat: value })}
                        />
                        {form.combat && (
                          <>
                            <CheckField
                              checked={form.combatRetaliate}
                              hint={t('settings.combat.hitBackHint')}
                              label={t('settings.combat.hitBack')}
                              name="retaliate"
                              onChange={(value) => patch({ combatRetaliate: value })}
                            />
                            <SelectField
                              hint={t('settings.combat.engageHint')}
                              label={t('settings.combat.engageLabel')}
                              name="engage"
                              onChange={(value) => patch({ combatEngage: value as EngagePolicy })}
                              options={[
                                { value: 'none', label: t('settings.combat.engageNone') },
                                { value: 'hostile', label: t('settings.combat.engageHostile') },
                                { value: 'likely', label: t('settings.combat.engageLikely') },
                                { value: 'all', label: t('settings.combat.engageAll') }
                              ]}
                              value={form.combatEngage}
                            />
                            <div className="settings-inline">
                              <NumberField
                                hint={t('settings.combat.minHealthHint')}
                                label={t('settings.combat.minHealthLabel')}
                                name="min-health"
                                onChange={(value) => patch({ combatMinHealth: value })}
                                value={form.combatMinHealth}
                              />
                              <NumberField
                                hint={t('settings.combat.maxMobsHint')}
                                label={t('settings.combat.maxMobsLabel')}
                                name="max-mobs"
                                onChange={(value) => patch({ combatMaxMobs: value })}
                                value={form.combatMaxMobs}
                              />
                              <NumberField
                                hint={t('settings.combat.minMobsHint')}
                                label={t('settings.combat.minMobsLabel')}
                                name="min-mobs"
                                onChange={(value) => patch({ combatMinMobs: value })}
                                value={form.combatMinMobs}
                              />
                            </div>
                            <CheckField
                              checked={form.combatWhileWalking}
                              hint={t('settings.combat.whileWalkingHint')}
                              label={t('settings.combat.whileWalking')}
                              name="while-walking"
                              onChange={(value) => patch({ combatWhileWalking: value })}
                            />
                          </>
                        )}
                      </fieldset>

                      {form.combat && (
                        <>
                          <fieldset className="settings-menus">
                            <legend>{t('settings.combat.attacksLegend')}</legend>
                            <div className="settings-inline">
                              <TextField
                                hint={t('settings.combat.attackVerbHint')}
                                label={t('settings.combat.attackVerbLabel')}
                                name="attack"
                                onChange={(value) => patch({ combatAttack: value })}
                                placeholder={t('settings.combat.attackVerbPlaceholder')}
                                spellCheck={false}
                                value={form.combatAttack}
                              />
                              <TextField
                                hint={t('settings.combat.openerHint')}
                                label={t('settings.combat.openerLabel')}
                                name="opener"
                                onChange={(value) => patch({ combatOpener: value })}
                                placeholder={t('settings.combat.openerPlaceholder')}
                                spellCheck={false}
                                value={form.combatOpener}
                              />
                            </div>
                            <NumberField
                              hint={t('settings.combat.refreshHint')}
                              label={t('settings.combat.refreshLabel')}
                              name="refresh"
                              onChange={(value) => patch({ combatRefresh: value })}
                              value={form.combatRefresh}
                            />
                          </fieldset>

                          <fieldset className="settings-menus">
                            <legend>{t('settings.combat.monstersLegend')}</legend>
                            <TextField
                              hint={t('settings.combat.avoidHint')}
                              label={t('settings.combat.avoidLabel')}
                              name="avoid"
                              onChange={(value) => patch({ combatAvoid: value })}
                              placeholder={t('settings.combat.avoidPlaceholder')}
                              spellCheck={false}
                              value={form.combatAvoid}
                              wide
                            />
                            <CheckField
                              checked={form.combatAvoidUndead}
                              hint={t('settings.combat.avoidUndeadHint')}
                              label={t('settings.combat.avoidUndeadLabel')}
                              name="avoid-undead"
                              onChange={(value) => patch({ combatAvoidUndead: value })}
                            />
                            <CheckField
                              checked={form.combatAvoidDeathSpell}
                              hint={t('settings.combat.avoidDeathSpellHint')}
                              label={t('settings.combat.avoidDeathSpellLabel')}
                              name="avoid-death-spell"
                              onChange={(value) => patch({ combatAvoidDeathSpell: value })}
                            />
                            <NumberField
                              hint={t('settings.combat.maxTargetHealthHint')}
                              label={t('settings.combat.maxTargetHealthLabel')}
                              name="max-target-health"
                              onChange={(value) => patch({ combatMaxTargetHealth: value })}
                              value={form.combatMaxTargetHealth}
                            />
                            <NumberField
                              hint={t('settings.combat.maxMonsterExpHint')}
                              label={t('settings.combat.maxMonsterExpLabel')}
                              name="max-monster-exp"
                              onChange={(value) => patch({ combatMaxMonsterExp: value })}
                              value={form.combatMaxMonsterExp}
                            />
                            <TextField
                              hint={t('settings.combat.preferHint')}
                              label={t('settings.combat.preferLabel')}
                              name="prefer"
                              onChange={(value) => patch({ combatPrefer: value })}
                              placeholder={t('settings.combat.preferPlaceholder')}
                              spellCheck={false}
                              value={form.combatPrefer}
                              wide
                            />
                          </fieldset>
                        </>
                      )}
                    </>
                  )}

                  {section === 'health' && (
                    <>
                      <fieldset className="settings-menus">
                        <legend>{t('settings.health.recoverLegend')}</legend>
                        <p className="settings-note">{t('settings.health.restingNote')}</p>
                        <div className="settings-inline">
                          <NumberField
                            hint={t('settings.health.restBelowHint')}
                            label={t('settings.health.restBelowLabel')}
                            name="rest-below"
                            figure={ofHealth(form.restBelow)}
                            onChange={(value) => patch({ restBelow: value })}
                            value={form.restBelow}
                          />
                          <NumberField
                            hint={t('settings.health.restToHint')}
                            label={t('settings.health.restToLabel')}
                            name="rest-to"
                            figure={ofHealth(form.restTo)}
                            onChange={(value) => patch({ restTo: value })}
                            value={form.restTo}
                          />
                          <NumberField
                            hint={t('settings.health.meditateBelowHint')}
                            label={t('settings.health.meditateBelowLabel')}
                            name="med-below"
                            figure={ofMana(form.meditateBelow)}
                            onChange={(value) => patch({ meditateBelow: value })}
                            value={form.meditateBelow}
                          />
                        </div>
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.health.potionLegend')}</legend>
                        <p className="settings-note">{t('settings.health.potionNote')}</p>
                        <div className="settings-inline">
                          <TextField
                            label={t('settings.health.healingPotionLabel')}
                            name="healing-potion"
                            onChange={(value) => patch({ healingPotionName: value })}
                            spellCheck={false}
                            value={form.healingPotionName}
                          />
                          <NumberField
                            hint={t('settings.health.potionBelowHint')}
                            label={t('settings.health.drinkHealingBelowLabel')}
                            name="healing-potion-below"
                            figure={ofHealth(form.drinkHealingPotionBelow)}
                            onChange={(value) => patch({ drinkHealingPotionBelow: value })}
                            value={form.drinkHealingPotionBelow}
                          />
                        </div>
                        <div className="settings-inline">
                          <TextField
                            label={t('settings.health.manaPotionLabel')}
                            name="mana-potion"
                            onChange={(value) => patch({ manaPotionName: value })}
                            spellCheck={false}
                            value={form.manaPotionName}
                          />
                          <NumberField
                            hint={t('settings.health.potionBelowHint')}
                            label={t('settings.health.drinkManaBelowLabel')}
                            name="mana-potion-below"
                            figure={ofMana(form.drinkManaPotionBelow)}
                            onChange={(value) => patch({ drinkManaPotionBelow: value })}
                            value={form.drinkManaPotionBelow}
                          />
                        </div>
                        <SelectField
                          hint={t('settings.health.potionVerbHint')}
                          label={t('settings.health.potionVerbLabel')}
                          name="potion-verb"
                          onChange={(value) => patch({ potionVerb: value })}
                          options={POTION_VERBS.map((verb) => ({ value: verb, label: verb }))}
                          value={form.potionVerb}
                        />
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.health.retreatLegend')}</legend>
                        <CheckField
                          checked={form.retreat}
                          hint={t('settings.health.retreatHint')}
                          label={t('settings.health.retreatLabel')}
                          name="retreat"
                          onChange={(value) => patch({ retreat: value })}
                        />
                        {form.retreat && (
                          <div className="settings-inline">
                            <NumberField
                              label={t('settings.health.belowHealthLabel')}
                              name="retreat-health"
                              figure={ofHealth(form.retreatBelow)}
                              onChange={(value) => patch({ retreatBelow: value })}
                              value={form.retreatBelow}
                            />
                            <NumberField
                              hint={t('settings.health.outnumberedHint')}
                              label={t('settings.health.outnumberedLabel')}
                              name="outnumbered"
                              onChange={(value) => patch({ retreatOutnumbered: value })}
                              value={form.retreatOutnumbered}
                            />
                          </div>
                        )}
                        {form.retreat && (
                          <>
                            <SelectField
                              hint={t('settings.health.retreatStrategyHint')}
                              label={t('settings.health.retreatStrategyLabel')}
                              name="retreat-strategy"
                              onChange={(value) => patch({ retreatStrategy: value })}
                              options={RETREAT_STRATEGIES.map((s) => ({ value: s, label: s }))}
                              value={form.retreatStrategy}
                            />
                            {form.retreatStrategy === 'safe-haven' && (
                              <TextField
                                hint={t('settings.health.safeHavenHint')}
                                label={t('settings.health.safeHavenLabel')}
                                name="retreat-haven"
                                onChange={(value) => patch({ retreatHaven: value })}
                                placeholder={t('settings.health.safeHavenPlaceholder')}
                                spellCheck={false}
                                value={form.retreatHaven}
                                wide
                              />
                            )}
                          </>
                        )}
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.health.hangUpLegend')}</legend>
                        {/*
                          The second and last warning left in the open. Every
                          MegaMUD-era client offers this; on this server family
                          it is one of the more reliable ways to die.
                        */}
                        <p className="settings-warn">{t('settings.health.hangUpWarning')}</p>
                        <CheckField
                          checked={form.hangUp}
                          label={t('settings.health.hangUpLabel')}
                          name="hangup"
                          onChange={(value) => patch({ hangUp: value })}
                        />
                        {form.hangUp && (
                          <>
                            <div className="settings-inline">
                              <NumberField
                                label={t('settings.health.belowHealthLabel')}
                                name="hangup-health"
                                figure={ofHealth(form.hangUpBelow)}
                                onChange={(value) => patch({ hangUpBelow: value })}
                                value={form.hangUpBelow}
                              />
                            </div>
                            <CheckField
                              checked={form.hangUpOnlyWhenClean}
                              hint={t('settings.health.hangUpCleanHint')}
                              label={t('settings.health.hangUpCleanLabel')}
                              name="clean"
                              onChange={(value) => patch({ hangUpOnlyWhenClean: value })}
                            />
                            <CheckField
                              checked={form.hangUpOnPlayer}
                              label={t('settings.health.hangUpOnPlayer')}
                              name="hangup-player"
                              onChange={(value) => patch({ hangUpOnPlayer: value })}
                            />
                          </>
                        )}
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.health.pvpLegend')}</legend>
                        <CheckField
                          checked={form.pvpNotifyGang}
                          hint={t('settings.health.pvpNotifyHint')}
                          label={t('settings.health.pvpNotifyLabel')}
                          name="pvp-notify"
                          onChange={(value) => patch({ pvpNotifyGang: value })}
                        />
                        <SelectField
                          hint={t('settings.health.pvpActionHint')}
                          label={t('settings.health.pvpActionLabel')}
                          name="pvp-action"
                          onChange={(value) =>
                            patch({ pvpAction: value === 'retreat' ? 'retreat' : 'none' })
                          }
                          options={PVP_ACTIONS.map((action) => ({
                            value: action,
                            label: action
                          }))}
                          value={form.pvpAction}
                        />
                      </fieldset>
                    </>
                  )}

                  {section === 'spells' && (
                    <>
                      {shownBook.unread && (
                        <p className="settings-note">{t('settings.spells.bookUnreadNote')}</p>
                      )}
                      <fieldset className="settings-menus">
                        <legend>{t('settings.spells.legend')}</legend>
                        <SpellField
                          hint={t('settings.spells.castHint')}
                          label={t('settings.spells.castLabel')}
                          name="spell"
                          onChange={(value) => patch({ spellAttack: value })}
                          spells={shownBook.spells}
                          value={form.spellAttack}
                        />
                        <NumberField
                          hint={t('settings.spells.minManaHint')}
                          label={t('settings.spells.minManaLabel')}
                          name="min-mana"
                          onChange={(value) => patch({ spellMinMana: value })}
                          figure={ofMana(form.spellMinMana)}
                          value={form.spellMinMana}
                        />
                        <SpellField
                          hint={t('settings.spells.areaCastHint')}
                          label={t('settings.spells.areaCastLabel')}
                          name="area-spell"
                          onChange={(value) => patch({ spellAreaAttack: value })}
                          spells={shownBook.spells}
                          value={form.spellAreaAttack}
                        />
                        <NumberField
                          hint={t('settings.spells.areaMinMobsHint')}
                          label={t('settings.spells.areaMinMobsLabel')}
                          name="area-min-mobs"
                          onChange={(value) => patch({ spellAreaMinMobs: value })}
                          value={form.spellAreaMinMobs}
                        />
                        <NumberField
                          hint={t('settings.spells.areaMinManaHint')}
                          label={t('settings.spells.areaMinManaLabel')}
                          name="area-min-mana"
                          onChange={(value) => patch({ spellAreaMinMana: value })}
                          figure={ofMana(form.spellAreaMinMana)}
                          value={form.spellAreaMinMana}
                        />
                        <p className="settings-note">{t('settings.spells.note')}</p>
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.spells.healLegend')}</legend>
                        <div className="settings-inline">
                          <SpellField
                            hint={t('settings.spells.healHint')}
                            label={t('settings.spells.healLabel')}
                            name="heal"
                            onChange={(value) => patch({ spellHeal: value })}
                            spells={shownBook.selfHeals}
                            value={form.spellHeal}
                            warning={
                              refusesTarget(shownBook.spells, castsOnSelf, form.spellHeal)
                                ? t('settings.spells.healNoSelfCast')
                                : undefined
                            }
                          />
                          <NumberField
                            label={t('settings.spells.healBelowLabel')}
                            name="heal-below"
                            onChange={(value) => patch({ spellHealBelow: value })}
                            figure={ofHealth(form.spellHealBelow)}
                            value={form.spellHealBelow}
                          />
                          <NumberField
                            hint={t('settings.spells.healBelowInCombatHint')}
                            label={t('settings.spells.healBelowInCombatLabel')}
                            name="heal-below-combat"
                            onChange={(value) => patch({ spellHealBelowInCombat: value })}
                            figure={ofHealth(form.spellHealBelowInCombat)}
                            value={form.spellHealBelowInCombat}
                          />
                          <NumberField
                            hint={t('settings.spells.healToHint')}
                            label={t('settings.spells.healToLabel')}
                            name="heal-to"
                            onChange={(value) => patch({ spellHealTo: value })}
                            figure={ofHealth(form.spellHealTo)}
                            value={form.spellHealTo}
                          />
                        </div>
                        <CheckField
                          checked={form.spellHealParty}
                          hint={t('settings.spells.healPartyHint')}
                          label={t('settings.spells.healParty')}
                          name="heal-party"
                          onChange={(value) => patch({ spellHealParty: value })}
                        />
                        <SpellField
                          hint={t('settings.spells.healPartyWithHint')}
                          label={t('settings.spells.healPartyWithLabel')}
                          name="heal-party-with"
                          onChange={(value) => patch({ spellHealPartyWith: value })}
                          spells={shownBook.partyHeals}
                          value={form.spellHealPartyWith}
                          warning={
                            refusesTarget(shownBook.spells, castsOnOthers, form.spellHealPartyWith)
                              ? t('settings.spells.healNoPartyCast')
                              : undefined
                          }
                        />
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.spells.cureLegend')}</legend>
                        <p className="settings-note">{t('settings.spells.cureNote')}</p>
                        <CureFields
                          cures={form.spellCures}
                          gates={shownBook.gates}
                          namePrefix="character"
                          onChange={(spellCures) => patch({ spellCures })}
                          spells={shownBook.spells}
                        />
                      </fieldset>

                      <fieldset className="settings-menus">
                        <legend>{t('settings.spells.blessingsLegend')}</legend>
                        <p className="settings-note">{t('settings.spells.blessingsNote')}</p>
                        <BlessingList
                          blessings={form.spellBlessings}
                          namePrefix="blessing"
                          onChange={(spellBlessings) => patch({ spellBlessings })}
                          spells={shownBook.spells}
                        />
                        <CheckField
                          checked={form.spellNotifyWearOff}
                          hint={t('settings.spells.notifyWearOffHint')}
                          label={t('settings.spells.notifyWearOffLabel')}
                          name="notify-wear-off"
                          onChange={(value) => patch({ spellNotifyWearOff: value })}
                        />
                      </fieldset>
                    </>
                  )}

                  {section === 'party' && (
                    <>
                      <fieldset className="settings-menus">
                        <legend>{t('settings.party.legend')}</legend>
                        <p className="settings-warn">{t('settings.party.warning')}</p>
                        <CheckField
                          checked={form.partyAssist}
                          hint={t('settings.party.assistHint')}
                          label={t('settings.party.assistLabel')}
                          name="party-assist"
                          onChange={(value) => patch({ partyAssist: value })}
                        />
                        <CheckField
                          checked={form.partyDefend}
                          hint={t('settings.party.defendHint')}
                          label={t('settings.party.defendLabel')}
                          name="party-defend"
                          onChange={(value) => patch({ partyDefend: value })}
                        />
                        <CheckField
                          checked={form.partyRest}
                          hint={t('settings.party.restHint')}
                          label={t('settings.party.restLabel')}
                          name="party-rest"
                          onChange={(value) => patch({ partyRest: value })}
                        />
                      </fieldset>
                      {/*
                        The party's `@` commands, here rather than beside the
                        gang's on the Remotes page, because this is where
                        somebody is thinking about what a party does together —
                        and the Remotes page says the list is here.

                        Drawn whether or not this character answers remotes at
                        all: that switch is on another page, and a grid that
                        vanished when it was off would be a control somebody
                        has to already know about to find. The warning says so
                        instead, the way the Gang card's does.
                      */}
                      <fieldset className="settings-menus">
                        <legend>{t('settings.party.remotesLegend')}</legend>
                        <p className="settings-note">{t('settings.party.remotesNote')}</p>
                        {form.answerRemotes ? null : (
                          <p className="settings-warn">{t('settings.party.remotesOffWarning')}</p>
                        )}
                        <RemoteList
                          allow={form.remoteParty}
                          mode="party"
                          onSet={(remote, stance) =>
                            patch({
                              remoteParty:
                                stance === 'allow'
                                  ? [...form.remoteParty, remote]
                                  : form.remoteParty.filter((entry) => entry !== remote)
                            })
                          }
                          onSetAll={(stance) =>
                            patch({
                              remoteParty: stance === 'allow' ? [...ACTIONABLE_REMOTES] : []
                            })
                          }
                          subject={t('settings.party.remotesLegend')}
                        />
                      </fieldset>
                      <p className="settings-note">{t('settings.party.blessingsMoved')}</p>
                    </>
                  )}

                  {section === 'remotes' && (
                    <fieldset className="settings-menus">
                      <legend>{t('settings.remotes.legend')}</legend>
                      {/*
                        The third warning in the open, and it earns the place
                        the other two do: what this switch turns on is a channel
                        by which somebody else's typing moves this character.
                        Above the control, because a warning behind a hover is
                        one nobody reads until afterwards.
                      */}
                      <p className="settings-warn">{t('settings.remotes.channelWarning')}</p>
                      <CheckField
                        checked={form.answerRemotes}
                        hint={t('settings.remotes.answerHint')}
                        label={t('settings.remotes.enabledLabel')}
                        name="remotes-enabled"
                        onChange={(value) => patch({ answerRemotes: value })}
                      />
                      {/*
                        The gate. Only drawn with the switch on: grants for a
                        channel nobody is listening on are a form asking a
                        question that cannot matter yet.
                      */}
                      {form.answerRemotes && (
                        <>
                          <CheckField
                            checked={form.remoteGangpath}
                            hint={t('settings.remotes.gangpathHint')}
                            label={t('settings.remotes.gangpathLabel')}
                            name="remotes-gangpath"
                            onChange={(value) => patch({ remoteGangpath: value })}
                          />
                          {/*
                            Nothing on the wire establishes who shares a gang
                            on its own: a gangpath does not prove it, and this
                            character's own outgoing one comes back naming
                            itself. Said where the grant is made, not only when
                            it silently fails to allow somebody.
                          */}
                          <p className="settings-warn">{t('settings.remotes.gangWarning')}</p>
                          <h4 className="settings-subhead">{t('settings.remotes.gangLegend')}</h4>
                          <RemoteList
                            allow={form.remoteGang}
                            mode="gang"
                            onSet={(remote, stance) =>
                              patch({
                                remoteGang:
                                  stance === 'allow'
                                    ? [...form.remoteGang, remote]
                                    : form.remoteGang.filter((entry) => entry !== remote)
                              })
                            }
                            onSetAll={(stance) =>
                              patch({
                                remoteGang: stance === 'allow' ? [...ACTIONABLE_REMOTES] : []
                              })
                            }
                            subject={t('settings.remotes.gangLegend')}
                          />

                          {/*
                            The per-player half, which the Player flyout also
                            writes — and it is here because the flyout can only
                            be opened on somebody the client has *seen*. A pair
                            of characters set up before either has logged in is
                            the ordinary case, and a permission reachable only
                            once the person is standing in front of you is one
                            you cannot prepare.
                          */}
                          <PlayerGrants
                            grants={form.remotePlayers}
                            onChange={(players) => patch({ remotePlayers: players })}
                          />
                        </>
                      )}
                      {/*
                        Where the third list is. A permission page showing two
                        of the three grants would have somebody auditing who
                        can drive this character conclude they had seen it all.
                      */}
                      <p className="settings-note">{t('settings.remotes.partyListNote')}</p>
                      <p className="settings-note">{t('settings.remotes.remoteControlNote')}</p>
                      <p className="settings-note">{t('settings.remotes.replyRoutingNote')}</p>
                    </fieldset>
                  )}

                  {section === 'talk' && (
                    <fieldset className="settings-menus">
                      <legend>{t('settings.talk.legend')}</legend>
                      {/*
                        The cost is stated above the switch rather than behind a
                        hover, the way the remotes warning is: this one spends a
                        command per stranger *and* tells them they were looked
                        at, which on a PvP realm is the half somebody would want
                        to know before turning it on rather than after.
                      */}
                      <p className="settings-warn">{t('settings.talk.lookWarning')}</p>
                      <CheckField
                        checked={form.lookAtPlayers}
                        hint={t('settings.talk.lookHint')}
                        label={t('settings.talk.lookLabel')}
                        name="talk-look"
                        onChange={(value) => patch({ lookAtPlayers: value })}
                      />
                    </fieldset>
                  )}

                  {section === 'alerts' && (
                    <fieldset className="settings-menus">
                      <legend>{t('settings.tabs.alerts')}</legend>
                      <SelectField
                        hint={t('settings.alerts.minimumHint')}
                        label={t('settings.alerts.minimumLabel')}
                        name="alert-min"
                        onChange={(value) => patch({ alertMinimum: value as Severity })}
                        options={[
                          { value: 'info', label: t('settings.alerts.minimumInfo') },
                          { value: 'warning', label: t('settings.alerts.minimumWarning') },
                          { value: 'critical', label: t('settings.alerts.minimumCritical') }
                        ]}
                        value={form.alertMinimum}
                      />
                      {/*
                        Checkboxes rather than a comma list, unlike the monster
                        names in Combat: those are the realm's words and could be
                        anything, and these are a closed set of eleven. A field
                        somebody has to spell into correctly, for a value the
                        client already knows every legal spelling of, is a field
                        that fails silently.
                      */}
                      <span className="settings-label">
                        {t('settings.alerts.muteLabel')}
                        <Hint id="hint-alert-mute">{t('settings.alerts.muteHint')}</Hint>
                      </span>
                      <div className="settings-checks">
                        {NOTICE_CHANNELS.map((channel) => (
                          <CheckField
                            checked={form.alertMuted.includes(channel)}
                            describedBy="hint-alert-mute"
                            key={channel}
                            label={CHANNEL_LABEL[channel]}
                            name={`mute-${channel}`}
                            onChange={(value) =>
                              patch({
                                alertMuted: value
                                  ? [...form.alertMuted, channel]
                                  : form.alertMuted.filter((entry) => entry !== channel)
                              })
                            }
                          />
                        ))}
                      </div>
                      <p className="settings-note">{t('settings.alerts.note')}</p>
                    </fieldset>
                  )}

                  {section === 'movement' && (
                    <>
                      <fieldset className="settings-menus">
                        <legend>{t('settings.movement.legend')}</legend>
                        <CheckField
                          checked={form.openDoors}
                          hint={t('settings.movement.openDoorsHint')}
                          label={t('settings.movement.openDoors')}
                          name="open-doors"
                          onChange={(value) => patch({ openDoors: value })}
                        />
                        {form.openDoors && (
                          <NumberField
                            label={t('settings.movement.openTries')}
                            name="open-tries"
                            onChange={(value) => patch({ openTries: value })}
                            value={form.openTries}
                          />
                        )}
                        {/*
                          Picking above bashing, in the order the walker tries
                          them — and for the reason it does: one costs a
                          command and the other costs a command and some
                          health.
                        */}
                        <CheckField
                          checked={form.pickLocks}
                          hint={t('settings.movement.pickLocksHint')}
                          label={t('settings.movement.pickLocks')}
                          name="pick-locks"
                          onChange={(value) => patch({ pickLocks: value })}
                        />
                        {form.pickLocks && (
                          <NumberField
                            label={t('settings.movement.pickTries')}
                            name="pick-tries"
                            onChange={(value) => patch({ pickTries: value })}
                            value={form.pickTries}
                          />
                        )}
                        <CheckField
                          checked={form.bashDoors}
                          hint={t('settings.movement.bashDoorsHint')}
                          label={t('settings.movement.bashDoors')}
                          name="bash-doors"
                          onChange={(value) => patch({ bashDoors: value })}
                        />
                        {form.bashDoors && (
                          <NumberField
                            label={t('settings.movement.bashTries')}
                            name="bash-tries"
                            onChange={(value) => patch({ bashTries: value })}
                            value={form.bashTries}
                          />
                        )}
                        <CheckField
                          checked={form.sneak}
                          hint={t('settings.movement.sneakHint')}
                          label={t('settings.movement.sneak')}
                          name="sneak"
                          onChange={(value) => patch({ sneak: value })}
                        />
                        <CheckField
                          checked={form.provideLight}
                          hint={t('settings.movement.provideLightHint')}
                          label={t('settings.movement.provideLight')}
                          name="provide-light"
                          onChange={(value) => patch({ provideLight: value })}
                        />
                        {form.provideLight && (
                          <>
                            <CheckField
                              checked={form.lightDimRooms}
                              hint={t('settings.movement.lightDimRoomsHint')}
                              label={t('settings.movement.lightDimRooms')}
                              name="light-dim-rooms"
                              onChange={(value) => patch({ lightDimRooms: value })}
                            />
                            <CheckField
                              checked={form.extinguishInLight}
                              hint={t('settings.movement.extinguishInLightHint')}
                              label={t('settings.movement.extinguishInLight')}
                              name="extinguish-in-light"
                              onChange={(value) => patch({ extinguishInLight: value })}
                            />
                          </>
                        )}
                        <p className="settings-note">{t('settings.movement.note')}</p>
                      </fieldset>

                      {/*
                        The loops this character owns, and the ones it merely
                        walks. A separate fieldset from the two switches above
                        rather than three more rows in one, because they answer
                        different questions: those are what a route may do on
                        the way, and this is where the character goes at all.
                      */}
                      <LoopSection
                        catalogue={catalogue}
                        inherited={inheritedLoops}
                        loops={form.loops}
                        note={t('settings.movement.loopsNote')}
                        onDonePicking={() => setPicking(false)}
                        onOpenPicker={openPicker}
                        onToggle={toggleLoop}
                        picking={picking}
                        /*
                          The one thing about this that can be wrong without
                          looking wrong. The shipped loops name rooms by
                          `map/room` in the realm the client ships; a character
                          playing against its own database has different rooms
                          behind the same numbers, and a route planned from one
                          goes somewhere nobody chose.
                        */
                        warning={
                          (servers.find((entry) => entry.name === form.serverName)?.database ?? '')
                            .length > 0 && form.loops.length > 0
                            ? t('settings.movement.loopsWarning')
                            : undefined
                        }
                      />
                    </>
                  )}

                  <div className="settings-actions">
                    {/*
                      Creating still takes a press; editing does not.
                      A half-typed file name is a *different* character, so an
                      auto-saved new one would write a directory per keystroke.
                    */}
                    {selected === NEW_CHARACTER ? (
                      <button className="primary" type="submit">
                        {t('settings.actions.createCharacter')}
                      </button>
                    ) : (
                      <FormActions
                        can={active.can}
                        error={active.save.error}
                        onRedo={active.redo}
                        onUndo={active.undo}
                        state={active.save.state}
                      />
                    )}
                    {selected !== NEW_CHARACTER &&
                      (confirming === selected ? (
                        <>
                          <span className="hint">
                            {t('settings.actions.confirmRemoveCharacter')}
                          </span>
                          <button className="danger" onClick={() => void remove()} type="button">
                            {t('settings.actions.confirmYes')}
                          </button>
                          <button
                            className="quiet"
                            onClick={() => setConfirming(null)}
                            type="button"
                          >
                            {t('settings.actions.confirmKeep')}
                          </button>
                        </>
                      ) : (
                        /* Asked first, because this is a click that may destroy
                           the only record of a password. The file is backed up
                           beside itself either way. */
                        <button
                          className="quiet"
                          onClick={() => setConfirming(selected)}
                          type="button"
                        >
                          {t('settings.actions.remove')}
                        </button>
                      ))}
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
              <ul className="settings-list">
                {servers.map((server) => (
                  <li key={server.name}>
                    <button
                      data-active={serverPick === server.name ? 'true' : 'false'}
                      onClick={() => chooseServer(server.name)}
                      onMouseDown={keepFocus}
                      type="button"
                    >
                      <span className="settings-name">{server.name}</span>
                      <span className="hint">
                        {server.host}:{server.port}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    className="settings-add"
                    data-active={serverPick === NEW_SERVER ? 'true' : 'false'}
                    onClick={() => chooseServer(NEW_SERVER)}
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    {t('settings.realms.new')}
                  </button>
                </li>
              </ul>

              {serverForm === null ? (
                <div className="settings-form empty">{t('settings.realms.empty')}</div>
              ) : (
                <form className="settings-form" onSubmit={(event) => void submitServer(event)}>
                  <TextField
                    hint={t('settings.realms.nameHint')}
                    inputRef={firstFieldRef}
                    label={t('settings.realms.nameLabel')}
                    name="server-name"
                    onChange={(value) => setServerForm({ ...serverForm, name: value })}
                    placeholder={t('settings.realms.namePlaceholder')}
                    value={serverForm.name}
                  />
                  <div className="settings-inline">
                    <TextField
                      label={t('settings.profile.hostLabel')}
                      name="server-host"
                      onChange={(value) => setServerForm({ ...serverForm, host: value })}
                      placeholder={t('settings.profile.hostPlaceholder')}
                      spellCheck={false}
                      value={serverForm.host}
                    />
                    <NumberField
                      label={t('settings.profile.portLabel')}
                      name="server-port"
                      onChange={(value) =>
                        setServerForm({
                          ...serverForm,
                          port: Number.parseInt(value, 10) || 0
                        })
                      }
                      value={serverForm.port || ''}
                    />
                  </div>

                  {/*
                    The map every character here walks.

                    On the realm rather than on the character, for the same
                    reason the menu script below is: two characters on one realm
                    cannot be walking two different maps, and stated per
                    character it was the same answer written out once each with
                    as many places to drift -- a third character added later
                    silently got the shipped world instead.
                  */}
                  <FormField
                    hint={t('settings.worldDatabaseHint')}
                    label={t('settings.worldDatabaseLabel')}
                    name="server-database"
                    wide
                  >
                    {({ describedBy }) => (
                      <div className="settings-file">
                        <input
                          aria-describedby={describedBy}
                          onChange={(event) =>
                            setServerForm({ ...serverForm, database: event.target.value })
                          }
                          placeholder={t('settings.worldDatabasePlaceholder')}
                          spellCheck={false}
                          value={serverForm.database}
                        />
                        <button
                          className="quiet"
                          onClick={() => {
                            void chooseRealm().then((file) => {
                              if (file !== null) setServerForm({ ...serverForm, database: file });
                            });
                          }}
                          onMouseDown={keepFocus}
                          type="button"
                        >
                          {t('settings.realms.databaseBrowse')}
                        </button>
                        {serverForm.database.length > 0 && (
                          <button
                            className="quiet"
                            onClick={() => setServerForm({ ...serverForm, database: '' })}
                            onMouseDown={keepFocus}
                            type="button"
                          >
                            {t('settings.realms.databaseClear')}
                          </button>
                        )}
                      </div>
                    )}
                  </FormField>

                  {/*
                    Behind a press, because it has a right answer already and
                    is not one anybody can choose well without knowing what
                    CP437 is. Not taste: the game lays out maps and stat
                    columns in character cells, and both reference realms open
                    with block glyphs that are invalid UTF-8.
                  */}
                  <Advanced label={t('settings.advancedWire')}>
                    <SelectField
                      hint={t('settings.profile.encodingHint')}
                      label={t('settings.profile.encodingLabel')}
                      name="encoding"
                      onChange={(value) =>
                        setServerForm({ ...serverForm, encoding: value as StreamEncoding })
                      }
                      options={ENCODINGS.map((encoding) => ({ value: encoding, label: encoding }))}
                      value={serverForm.encoding}
                    />
                  </Advanced>

                  {/*
                    How to get through this realm's menus.

                    On the realm rather than on the character, because that is
                    what it is a property of: every character on one realm
                    meets the same menus, and a script stored per character is
                    the same answer written out four times with four places to
                    drift. What is genuinely per character is the account, and
                    the character slot -- which a character overrides with its
                    own script when it needs to.

                    A list rather than named fields. The four this screen used
                    to show were *Paradigm's* menus; MajorMUD, GreaterMUD and a
                    WorldGroup front end all differ, and a client with four
                    slots cannot describe them at all.
                  */}
                  <fieldset className="settings-menus">
                    <legend>{t('settings.realms.loginLegend')}</legend>
                    <p className="settings-note">{t('settings.realms.loginNote')}</p>

                    {serverForm.login.length > 0 && (
                      <ul className="settings-steps">
                        {serverForm.login.map((step, index) => (
                          // Keyed by position, deliberately: rows are edited in
                          // place and identified by nothing else — two blank
                          // rows are genuinely the same until somebody types.
                          <li key={index}>
                            <input
                              aria-label={t('settings.login.stepWhenAria', {
                                stepNumber: index + 1
                              })}
                              onChange={(event) =>
                                setServerForm({
                                  ...serverForm,
                                  login: serverForm.login.map((entry, at) =>
                                    at === index ? { ...entry, when: event.target.value } : entry
                                  )
                                })
                              }
                              placeholder={t('settings.realms.stepWhenPlaceholder')}
                              value={step.when}
                            />
                            <span aria-hidden="true" className="arrow">
                              →
                            </span>
                            <input
                              aria-label={t('settings.login.stepSendAria', {
                                stepNumber: index + 1
                              })}
                              className="answer"
                              onChange={(event) =>
                                setServerForm({
                                  ...serverForm,
                                  login: serverForm.login.map((entry, at) =>
                                    at === index ? { ...entry, send: event.target.value } : entry
                                  )
                                })
                              }
                              placeholder={t('settings.realms.stepSendPlaceholder')}
                              value={step.send}
                            />
                            <button
                              aria-label={t('settings.login.removeStepAria', {
                                stepNumber: index + 1
                              })}
                              className="quiet"
                              onClick={() =>
                                setServerForm({
                                  ...serverForm,
                                  login: serverForm.login.filter((_, at) => at !== index)
                                })
                              }
                              title={t('settings.login.removeStepTitle')}
                              type="button"
                            >
                              <Icon name="close" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <button
                      className="quiet add-step"
                      onClick={() =>
                        setServerForm({
                          ...serverForm,
                          login: [...serverForm.login, { when: '', send: '' }]
                        })
                      }
                      type="button"
                    >
                      <Icon name="plus" />
                      <span>{t('settings.login.addStep')}</span>
                    </button>
                  </fieldset>

                  {/*
                    The loops that belong to the *place*.

                    A loop names rooms in a realm, so it is a fact about where
                    you are playing rather than about who is walking it — and
                    one recorded here is worth having on every character that
                    plays here, rather than pasted into each of their files and
                    then kept in step by hand.
                  */}
                  <LoopSection
                    catalogue={catalogue}
                    loops={serverForm.loops}
                    note={t('settings.realms.loopsNote')}
                    onDonePicking={() => setPicking(false)}
                    onOpenPicker={openPicker}
                    onToggle={toggleServerLoop}
                    picking={picking}
                  />

                  <div className="settings-actions">
                    {serverPick === NEW_SERVER ? (
                      <button className="primary" type="submit">
                        {t('settings.realms.submit')}
                      </button>
                    ) : (
                      <FormActions
                        can={active.can}
                        error={active.save.error}
                        onRedo={active.redo}
                        onUndo={active.undo}
                        state={active.save.state}
                      />
                    )}
                    {serverPick !== NEW_SERVER &&
                      (confirming === serverPick ? (
                        <>
                          <span className="hint">{t('settings.realms.confirmRemove')}</span>
                          <button
                            className="danger"
                            onClick={() => void removeServer()}
                            type="button"
                          >
                            {t('settings.actions.confirmYes')}
                          </button>
                          <button
                            className="quiet"
                            onClick={() => setConfirming(null)}
                            type="button"
                          >
                            {t('settings.actions.confirmKeep')}
                          </button>
                        </>
                      ) : (
                        <button
                          className="quiet"
                          onClick={() => setConfirming(serverPick)}
                          type="button"
                        >
                          {t('settings.actions.remove')}
                        </button>
                      ))}
                  </div>
                </form>
              )}
            </>
          )}
        </div>

        <footer className="settings-foot">
          {problem !== null && <span className="settings-problem">{problem}</span>}
          {problem === null && saved !== null && <span className="settings-saved">{saved}</span>}
          {/* Everything this screen does not cover is one click away, and
              saying so is what keeps the screen from having to grow into a
              YAML editor. */}
          <span className="settings-paths">
            <button className="quiet" onClick={revealConfig} onMouseDown={keepFocus} type="button">
              {t('settings.footer.openConfig')}
            </button>
            <button
              className="quiet"
              onClick={revealProfiles}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.footer.openProfiles')}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
