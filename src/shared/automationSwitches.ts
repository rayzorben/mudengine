/**
 * The toolbar's automation switches (moved out of `config.ts`, todo 140): one
 * table of names and their paths under `automation:`, so the union and the
 * path cannot drift.
 */
import type { AutomationConfig } from './config';
import { isRecord } from './values';

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
  runBetweenRounds: ['movement', 'runBetweenRounds'],
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
