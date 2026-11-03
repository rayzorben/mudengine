/**
 * The toolbar's automation switches (moved out of `config.ts`, todo 140): one
 * table of names, each saying where its answer lives, so the union and the
 * place cannot drift. See `mudengine-settings` › *Settings and the toolbar
 * switches are separate*.
 */
import type { AutomationConfig } from './config';
import { isRecord } from './values';

/**
 * The automation switches that can be flipped without opening a form.
 *
 * A row is either a path to a boolean under `automation:`, the character's
 * standing value that the toolbar writes to its file, or `'session'`: a
 * switch the session holds and the file never states (2026-11-02, the user,
 * todo 20261102-1830-01). Auto-combat is the one held switch: it is on
 * unless the toolbar, `@auto-combat` or *Run it* turned it off for now, and a
 * lap, an arrival and a dial turn it back on (`HeldSwitches`).
 *
 * A config row added here with no boolean behind it fails the test that
 * walks every path against `DEFAULT_CONFIG`, the failure `GUARD_FIELDS`
 * records: a field in the type and not the list type-checks, then silently
 * does nothing.
 */
export const AUTOMATION_SWITCHES = {
  /** The master switch. Off, only what the player types is sent, bar the keep-alive. */
  automation: ['enabled'],
  combat: 'session',
  retaliate: ['combat', 'retaliate'],
  autoBless: ['spells', 'autoBless'],
  autoRest: ['health', 'autoRest'],
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
  runBetweenRounds: ['movement', 'runBetweenRounds'],
  provideLight: ['movement', 'provideLight'],
  healParty: ['spells', 'healParty'],
  invokeItems: ['spells', 'invokeItems'],
  assistLeader: ['party', 'assistLeader'],
  defendParty: ['party', 'defendParty'],
  attackLast: ['party', 'attackLast'],
  restWithLeader: ['party', 'restWithLeader'],
  remotes: ['remotes', 'enabled'],
  gangpath: ['remotes', 'gangpath'],
  lookAtPlayers: ['talk', 'lookAtPlayers'],
  quests: ['quests', 'enabled'],
  gear: ['gear', 'enabled']
} as const satisfies Record<string, readonly string[] | 'session'>;

type SwitchTable = typeof AUTOMATION_SWITCHES;

export type AutomationSwitch = keyof SwitchTable;

/** A switch the session holds, never written to a file. */
export type HeldSwitch = {
  [K in AutomationSwitch]: SwitchTable[K] extends 'session' ? K : never;
}[AutomationSwitch];

/** A switch that is a boolean in the character's file. */
export type ConfigSwitch = Exclude<AutomationSwitch, HeldSwitch>;

/** Every held switch's answer for one session. */
export type HeldSwitches = Record<HeldSwitch, boolean>;

/** What a session's held switches say before anything turns one off: on. */
export const HELD_DEFAULTS: HeldSwitches = { combat: true };

/** Whether `name` is held by the session rather than written to the file. */
export function isHeldSwitch(name: AutomationSwitch): name is HeldSwitch {
  return AUTOMATION_SWITCHES[name] === 'session';
}

export const AUTOMATION_SWITCH_NAMES = Object.keys(AUTOMATION_SWITCHES) as AutomationSwitch[];

/** Every switch's current answer for one character. */
export type AutomationSwitches = Record<AutomationSwitch, boolean>;

/** The file's switches for one character. */
export type ConfigSwitches = Record<ConfigSwitch, boolean>;

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
export function readAutomationSwitch(automation: AutomationConfig, name: ConfigSwitch): boolean {
  let node: unknown = automation;
  for (const key of AUTOMATION_SWITCHES[name]) {
    if (!isRecord(node)) return false;
    node = node[key];
  }
  return node === true;
}

/** The file's switches for one character, as its profile summary carries them. */
export function configSwitches(automation: AutomationConfig): ConfigSwitches {
  const out = {} as ConfigSwitches;
  for (const name of AUTOMATION_SWITCH_NAMES) {
    if (!isHeldSwitch(name)) out[name] = readAutomationSwitch(automation, name);
  }
  return out;
}

/** Every switch for one character, as the toolbar draws them: the file's and the session's. */
export function automationSwitches(file: ConfigSwitches, held: HeldSwitches): AutomationSwitches {
  return { ...file, ...held };
}

/** What one switch says now: the session's for a held one, the file's otherwise. */
export function switchIsOn(
  automation: AutomationConfig,
  held: HeldSwitches,
  name: AutomationSwitch
): boolean {
  return isHeldSwitch(name) ? held[name] : readAutomationSwitch(automation, name);
}

/**
 * The session's held switches, as the modules that turn one off or back on
 * see them (`SessionSwitches`). Nothing here can refuse: the session holds
 * the answer, and no file is written.
 */
export interface HeldSwitchPort {
  on(name: HeldSwitch): boolean;
  set(name: HeldSwitch, on: boolean): void;
  /** Turns `name` back on where it is off, says `said`, and answers whether it was off. */
  backOn(name: HeldSwitch, said: string): boolean;
}
