import {
  AUTOMATION_SWITCH_NAMES,
  type AutomationSwitch,
  type AutomationSwitches
} from '@shared/config';

import type { IconName } from '../components/Icon';
import { t } from './i18n';

/**
 * Every button the toolbar can draw, and what each one is.
 *
 * Two kinds and no more. A **switch** is an `automation:` boolean in the
 * character's own file — pressing it writes the file, the store's poll brings
 * it back, and the button and the settings screen therefore cannot disagree
 * about what the character is doing. An **action** is a thing that happens
 * once and is remembered nowhere: dialling, and the loop's and walk's
 * transport.
 *
 * Both are drawn identically — a square glyph that is lit when the thing it
 * names is on — because on a toolbar the difference between "this is set" and
 * "this is running" is a distinction the player does not have to hold: what
 * they want to know is whether it is happening.
 *
 * The label is the tooltip, the accessible name and the row in the kebab's
 * menu. There is no text on the row itself: a toolbar one icon high has no
 * room for words, which is the whole reason `Icon` is required here as it is
 * on a `MenuItem`.
 */
export type ToolbarItemId = AutomationSwitch | ToolbarActionId;

export const TOOLBAR_ACTIONS = [
  'connect',
  'gear:restore',
  'loop:open',
  'loop:toggle',
  'loop:stop',
  'walk:stop'
] as const;
export type ToolbarActionId = (typeof TOOLBAR_ACTIONS)[number];

/**
 * Which glyph names each switch.
 *
 * Written out rather than derived, and the type makes it exhaustive: a switch
 * added to `AUTOMATION_SWITCHES` with no glyph here does not compile, which is
 * the closed-union rule this project states for `GUARD_FIELDS` applied to the
 * one place a switch becomes visible.
 */
const SWITCH_ICONS: Record<AutomationSwitch, IconName> = {
  automation: 'bolt',
  combat: 'sword',
  retaliate: 'shield',
  engageWhileWalking: 'crosshair',
  retreat: 'run',
  hangUp: 'unplug',
  loot: 'coins',
  drop: 'trash',
  // The magnifier, which is what a search is: `search` is the Reference card's
  // own glyph for asking a question of something in front of you.
  search: 'search',
  // The coins again, deliberately: picking coins up and banking them are the
  // same idea at two ends of a lap, and the label is what separates them.
  autoDeposit: 'coins',
  supplies: 'bag',
  openDoors: 'door',
  pickLocks: 'key',
  bashDoors: 'hammer',
  sneak: 'eyeOff',
  provideLight: 'flame',
  healParty: 'heart',
  assistLeader: 'users',
  // The shield again, deliberately: retaliate is this character's own hitting
  // back and this is the party's — the same idea at two scopes, and the label
  // is what separates them.
  defendParty: 'shield',
  restWithLeader: 'moon',
  remotes: 'at',
  gangpath: 'broadcast',
  lookAtPlayers: 'eye'
};

/**
 * The label for each switch, from the dictionary.
 *
 * Two literal `t()` calls per key would be the plural rule; these are single
 * keys, and they are written out one per line for the reason the coverage test
 * requires — it reads the literal key straight after `t(`, so a table built by
 * interpolating the switch name into a key would be an unexempted dynamic
 * call and, worse, unfindable by anybody grepping the dictionary.
 */
function switchLabel(name: AutomationSwitch): string {
  switch (name) {
    case 'automation':
      return t('toolbar.automation');
    case 'combat':
      return t('toolbar.combat');
    case 'retaliate':
      return t('toolbar.retaliate');
    case 'engageWhileWalking':
      return t('toolbar.engageWhileWalking');
    case 'retreat':
      return t('toolbar.retreat');
    case 'hangUp':
      return t('toolbar.hangUp');
    case 'loot':
      return t('toolbar.loot');
    case 'drop':
      return t('toolbar.drop');
    case 'autoDeposit':
      return t('toolbar.autoDeposit');
    case 'openDoors':
      return t('toolbar.openDoors');
    case 'pickLocks':
      return t('toolbar.pickLocks');
    case 'bashDoors':
      return t('toolbar.bashDoors');
    case 'sneak':
      return t('toolbar.sneak');
    case 'healParty':
      return t('toolbar.healParty');
    case 'assistLeader':
      return t('toolbar.assistLeader');
    case 'defendParty':
      return t('toolbar.defendParty');
    case 'restWithLeader':
      return t('toolbar.restWithLeader');
    case 'remotes':
      return t('toolbar.remotes');
    case 'gangpath':
      return t('toolbar.gangpath');
    case 'lookAtPlayers':
      return t('toolbar.lookAtPlayers');
    case 'search':
      return t('toolbar.search');
    case 'supplies':
      return t('toolbar.supplies');
    case 'provideLight':
      return t('toolbar.provideLight');
    default: {
      /* A switch in the union with no label is a button nobody can read. */
      const unreachable: never = name;
      return unreachable;
    }
  }
}

/** One button, resolved against a character: what it says and what it does. */
export interface ToolbarButton {
  id: ToolbarItemId;
  label: string;
  icon: IconName;
  /** Lit when what this names is on or running. */
  on: boolean;
  /**
   * Nothing to act on right now — a loop control with no loop, a walk stop
   * with no walk.
   *
   * Greyed rather than absent, which is `MenuItem.disabled`'s own rule: a row
   * that is available most of the time and a toolbar whose shape changes under
   * the pointer are two different complaints, and the second is worse. A
   * button that moves as the game moves is one nobody can reach for.
   */
  disabled?: boolean;
  run(): void;
}

/** What the toolbar needs about the character it is drawn for. */
export interface ToolbarSubject {
  switches: AutomationSwitches;
  /** Whether the character is connected, and what pressing the dial does. */
  connected: boolean;
  /** Whether a dial or a hang-up is already in flight. */
  dialling: boolean;
  /** Whether a loop is running, paused, or neither. */
  loop: 'running' | 'paused' | 'idle';
  walking: boolean;
  /**
   * Whether anything the character was wearing is in the pack and off.
   *
   * The button is greyed rather than absent when there is nothing to put back
   * — `MenuItem.disabled`'s rule, and the one the transport controls follow: a
   * toolbar whose shape changes under the pointer is worse than one with a
   * dead button on it. It is also the honest answer for a character that has
   * never been listed, where the client knows of no slot at all.
   */
  canRestoreGear: boolean;
  setSwitch(name: AutomationSwitch, on: boolean): void;
  /** Put back what was last worn. See `shared/gear.ts`. */
  restoreGear(): void;
  connect(): void;
  disconnect(): void;
  pauseLoop(): void;
  resumeLoop(): void;
  stopLoop(): void;
  stopWalk(): void;
  /**
   * Open the Loops modal — the shelf, not a control over the running loop.
   *
   * Null on a pinned float, whose toolbar belongs to a character that is not
   * the one on screen: the modal files into a scope and starts a loop, and
   * both are addressed at whoever it was opened for. A button that opened it
   * for somebody else would start the wrong character walking, which on this
   * realm is not free — so the button is not drawn at all, which is what this
   * client does with every control bound to nowhere.
   */
  openLoops: (() => void) | null;
}

/**
 * Every button there is, in the order the kebab lists them.
 *
 * The master switch first, then what it governs, then the transport. The
 * order is fixed whether or not each button is pinned, so unpinning one never
 * moves another out from under the pointer — the same rule the Room card's
 * faces and the map's legend follow.
 */
export function toolbarButtons(subject: ToolbarSubject): ToolbarButton[] {
  const {
    switches,
    connected,
    dialling,
    loop,
    walking,
    setSwitch,
    connect,
    disconnect,
    pauseLoop,
    resumeLoop,
    stopLoop,
    stopWalk,
    openLoops,
    canRestoreGear,
    restoreGear
  } = subject;

  const dial: ToolbarButton = {
    id: 'connect',
    label: connected ? t('toolbar.disconnect') : t('toolbar.connect'),
    // The action, not the state — the tab rail's own rule for its dial button.
    icon: connected ? 'logout' : 'login',
    on: connected,
    // Main refuses the second attempt anyway, and a button that stays
    // pressable through a fifteen-second connect reads as one that did
    // nothing.
    disabled: dialling,
    run: () => (connected ? disconnect() : connect())
  };

  /*
   * Putting the kit back on, which is a thing that happens once — an action,
   * not a switch. It sits beside the dial rather than with the loop's
   * transport because it is what somebody does *on arriving*: a death puts a
   * character back at a healer with a full pack and nothing on, and this is
   * the first press of that recovery.
   */
  const gear: ToolbarButton = {
    id: 'gear:restore',
    label: t('toolbar.restoreGear'),
    icon: 'shirt',
    on: false,
    disabled: !canRestoreGear,
    run: restoreGear
  };

  const switches_: ToolbarButton[] = AUTOMATION_SWITCH_NAMES.map((name) => ({
    id: name,
    label: switchLabel(name),
    icon: SWITCH_ICONS[name],
    on: switches[name],
    run: () => setSwitch(name, !switches[name])
  }));

  const shelf: ToolbarButton[] =
    openLoops === null
      ? []
      : [
          {
            /*
             * Where a loop is *found*, which is a different question from the
             * three below — they drive the loop that is running, and this one
             * runs when none is. Never *disabled*: the shelf is there whether
             * or not a character is in the realm, and a button greyed because
             * nothing is looping would be greyed at exactly the moment
             * somebody wants to start one.
             */
            id: 'loop:open',
            label: t('toolbar.openLoops'),
            icon: 'loop',
            on: false,
            run: openLoops
          }
        ];

  const transport: ToolbarButton[] = [
    ...shelf,
    {
      id: 'loop:toggle',
      /*
       * One button, two words. A loop is either running or held, and a row
       * with a play *and* a pause on it spends two slots to say what one
       * says — with the dead one greyed most of the time.
       */
      label: loop === 'running' ? t('toolbar.pauseLoop') : t('toolbar.resumeLoop'),
      icon: loop === 'running' ? 'pause' : 'play',
      on: loop === 'running',
      disabled: loop === 'idle',
      run: () => (loop === 'running' ? pauseLoop() : resumeLoop())
    },
    {
      id: 'loop:stop',
      label: t('toolbar.stopLoop'),
      icon: 'stop',
      on: false,
      disabled: loop === 'idle',
      run: stopLoop
    },
    {
      id: 'walk:stop',
      label: t('toolbar.stopWalk'),
      icon: 'route',
      on: walking,
      disabled: !walking,
      run: stopWalk
    }
  ];

  return [dial, gear, ...switches_, ...transport];
}
