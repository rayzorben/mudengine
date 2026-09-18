import {
  AUTOMATION_SWITCH_NAMES,
  type AutomationSwitch,
  type AutomationSwitches
} from '@shared/config';

import type { Movement } from '@shared/movement';

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
  'loop:build',
  /**
   * Go, or stop — the whole transport, on one key (2026-09-11).
   *
   * It was three: `loop:toggle`, `loop:stop` and `walk:stop`, which asked the
   * player to know whether they were looping or routing before they could
   * press the right one. They are one thing — *moving* — so this is one
   * button, and which of the two it stops is main's to work out
   * (`SessionManager.stopMoving`).
   */
  'move:toggle',
  /**
   * One room back the way the character came, per press.
   *
   * Its own button rather than a face of the transport: *go*, *stop* and *back*
   * are three different intentions, and back is the one pressed while nothing
   * is moving at all — after a walk into a room somebody did not mean to be in.
   * What it walks is a route to the previous room on the trail, which main
   * plans; see `SessionManager.stepBack`.
   */
  'move:back'
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
  autoBless: 'sparkle',
  retreat: 'run',
  hangUp: 'unplug',
  loot: 'coins',
  /*
   * The flame, which is what a blessing off an item looks like on screen: the
   * weapon glows and the sentence lands. Shared with the light switch and
   * deliberately -- both are *invoking an item*, and a second flame-ish glyph
   * would be a distinction nobody could read at 14px.
   */
  invokeItems: 'flame',
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
    case 'autoBless':
      return t('toolbar.autoBless');
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
    case 'invokeItems':
      return t('toolbar.invokeItems');
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
  /**
   * Whether the character is standing in the realm.
   *
   * Not the same question as `connected`: a socket that is up with the
   * account menu on screen can be dialled and hung up and have its switches
   * written, and can do nothing that needs a room. Every button that sends a
   * command is greyed on it — greyed, because the row must not change shape
   * under the pointer (`ToolbarButton.disabled`).
   */
  inRealm: boolean;
  /** Whether a dial or a hang-up is already in flight. */
  dialling: boolean;
  /** Routing, looping or stopped, and whether it is going. See `movementOf`. */
  movement: Movement;
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
  /** Play: pick back up whatever was stopped. The card's picker is not here. */
  startMoving(): void;
  /** One room back the way the character came. See `SessionManager.stepBack`. */
  stepBack(): void;
  /** Stop, whichever of the two is running. */
  stopMoving(): void;
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
  /**
   * Open the loop builder — the card a loop is drawn on. Null on a pinned
   * float for `openLoops`' reason: the builder plans on the shown
   * character's realm and files into its scope.
   */
  openBuilder: (() => void) | null;
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
    inRealm,
    movement,
    setSwitch,
    connect,
    disconnect,
    startMoving,
    stopMoving,
    stepBack,
    openLoops,
    openBuilder,
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
    // Dressing is a command per item, so it needs a room to be standing in as
    // much as it needs something in the pack to put on.
    disabled: !inRealm || !canRestoreGear,
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

  const builder: ToolbarButton[] =
    openBuilder === null
      ? []
      : [
          {
            /*
             * Where a loop is *drawn*, beside where one is found. Never
             * disabled, for the shelf's reason: the map is there whether or
             * not the character is looping.
             */
            id: 'loop:build',
            label: t('toolbar.buildLoop'),
            icon: 'flag',
            on: false,
            run: openBuilder
          }
        ];

  const transport: ToolbarButton[] = [
    ...shelf,
    ...builder,
    {
      id: 'move:toggle',
      /*
       * One button, two words. A character is going or it is not, and a row
       * with a play *and* a stop on it spends two slots to say what one says —
       * with the dead one greyed most of the time. The picker is the card's;
       * this presses play on whatever was last being walked.
       */
      label: movement.moving ? t('toolbar.stopMoving') : t('toolbar.startMoving'),
      icon: movement.moving ? 'stop' : 'play',
      on: movement.moving,
      disabled: !inRealm || (!movement.moving && !movement.resumable),
      run: () => (movement.moving ? stopMoving() : startMoving())
    },
    {
      /*
       * Back, beside the transport because it is a way of moving, and after it
       * because it is the smaller gesture.
       *
       * Never disabled on the trail: whether there is anything behind the
       * character is main's to say — the trail lives there — and a button
       * greyed off a second copy of that fact in the window is a button that
       * disagrees with the client. A press with nothing behind it says so in
       * the console, which is what every other refusal here does.
       *
       * Out of the realm is not that fact. There is no room to step out of,
       * and the refusal would be the same one every press.
       */
      id: 'move:back',
      label: t('toolbar.stepBack'),
      icon: 'undo',
      on: false,
      disabled: !inRealm,
      run: stepBack
    }
  ];

  return [dial, gear, ...switches_, ...transport];
}
