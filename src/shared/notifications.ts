/**
 * What is worth interrupting someone for, and how loudly.
 *
 * The terminal already carries every line, and that is the problem it does not
 * solve: the thing you needed to see scrolls out of reach behind a combat burst
 * within seconds, which is exactly when you are least able to go looking for
 * it. This is a second reading of the same facts, kept and ranked.
 *
 * **Facts in, facts out** (docs/legacy-assessment.md §6). A notice says what
 * happened. Nothing here decides what to do about it, and nothing here sends.
 *
 * Dependency-free, like the rest of `src/shared`: the block feed is produced in
 * main and read in the renderer, and the ranking has to be the same on both
 * sides of the wire.
 */

import {
  isHostile,
  ownAlignment,
  vitalLevel,
  type CharacterState,
  type VitalLevel,
  type VitalThresholds
} from './character';
import { attacksOnSight, DISPOSITION_WORD } from './mobs';
import type { Block, BlockType } from './blocks';
import type { UiLookup } from './i18n';
import type { WalkProgress } from './walk';
import type { LoopProgress } from './loops';
import { movementOf } from './movement';
import type { ConnectionState } from './types';

/**
 * Three levels, not five.
 *
 * A scale someone has to learn is a scale they read wrong under pressure.
 * `critical` means *act now*, `warning` means something did not work, and
 * `info` is the record. Anything that does not clearly belong in the first two
 * belongs in the third.
 */
export type Severity = 'critical' | 'warning' | 'info';

export const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];

/**
 * The channels a notice can arrive on — a closed union, both halves kept here
 * so the list the settings screens offer and the words the notices carry
 * cannot drift apart.
 *
 * Spelled out rather than derived from `NOTABLE`, because that table is keyed
 * by *block type* and this is the list of words a notice carries — and two of
 * them, `vitals` and `realm`, are produced by no block at all: they come from
 * a state change, which is how the genuinely urgent facts arrive.
 *
 * The order is the order the settings screens offer the mute chips in.
 */
export const NOTICE_CHANNELS = [
  'combat',
  'vitals',
  'room',
  'realm',
  'party',
  'command',
  'movement',
  'items',
  'stealth',
  'presence',
  'session'
] as const;

export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

/**
 * The happenings worth raising *outside* the window, as a closed list.
 *
 * An alert is a second reading of the stream for somebody who is looking; a
 * desktop notification is for somebody who is not, and the two lists are not
 * the same list. A severity floor cannot express this one: arriving where you
 * asked to go ranks as the record, and it is the whole reason somebody walked
 * away from the keyboard in the first place.
 *
 * So four happenings are named, and `critical` catches the rest of the
 * ranking.
 *
 * **A kind, not a switch** (2026-09-13). Each was a checkbox on both settings
 * pages until the rows took the question over; what is left is the key the
 * window rests a notification's *kind* on, so a burst of blows cannot swallow
 * the notice that the character then died.
 */
export const DESKTOP_ALERTS = ['attacked', 'hurt', 'arrived', 'hungup', 'critical'] as const;

export type DesktopAlert = (typeof DESKTOP_ALERTS)[number];

export interface Notice {
  /** Stable within a session, so a list can key on it without an index. */
  id: string;
  at: number;
  severity: Severity;
  /** What kind of thing this is, for filtering — one of {@link NOTICE_CHANNELS}. */
  channel: NoticeChannel;
  text: string;
  /**
   * Which desktop notification this alert is one of, when it is one of the
   * four named ones. Absent means `critical`: the kind is a rest key, and a
   * raise is decided by the row that claimed the notice.
   */
  desktop?: DesktopAlert;
  /**
   * Which of the player's own watches produced this, where one did — the hook
   * an `AlertRule` claims by (todo 29). Absent on every notice the channels
   * alone account for, which is most of them.
   */
  watch?: AlertWatch;
  /**
   * The row that produced this, where a row did.
   *
   * The two numeric events are the case: several rows may watch one vital at
   * several figures, and `watchNotices` knows which of them crossed. Without
   * it `ruleFor` hands every health notice to the *first* health row, so a
   * client told to warn at 35% and again at 15% reports the 35% crossing and
   * silently drops the 15% one — a stated, critical figure swallowed.
   *
   * Absent on every notice nothing configurable produced, which is most of
   * them; those are claimed by event alone.
   */
  from?: AlertRule;
  /**
   * Which event this is, which is what an `AlertRule` claims by (todo 03).
   *
   * Derived where the notice is built — from the block for most, from the
   * watch for the five that are watched — so a row and the thing it claims are
   * matched on the same word the player chose it by. Absent for a notice that
   * is no event at all, which no row can claim and which is therefore shown at
   * the level the ranking gave it.
   */
  event?: AlertEvent;
}

/**
 * Which desktop notification an alert is, or null if it is not worth one.
 *
 * The named four outrank the ranking on purpose: a player attacking you is
 * `critical` as well, and somebody who muted `attacked` has said what they
 * meant — leaving it to be raised again as `critical` would make the switch a
 * lie.
 */
export function desktopAlert(notice: Notice): DesktopAlert | null {
  if (notice.desktop !== undefined) return notice.desktop;
  return notice.severity === 'critical' ? 'critical' : null;
}

/**
 * The desktop notification this alert is worth raising.
 *
 * **The player's own rows are the only thing that decides** (2026-09-13). Two
 * switches stood in front of this — `ui.alerts.desktop.enabled` and
 * `whileFocused` — and every question they answered is already a row: *raise
 * nothing* is every row with `notify` off, and *even while I am looking* is the
 * row's own `whileFocused`. Two vocabularies for one question is how somebody
 * sets one and wonders why the other still decides, which is the ruling the
 * mute list and the severity floor went under.
 *
 * So a notice is raised when a row claims it and says `notify`. **A notice no
 * row claims raises nothing**: a notification interrupts somebody who is not
 * looking, and being interrupted is asked for, never inherited from a ranking.
 * That is the one way this differs from the card, where an unclaimed notice is
 * still shown at the level the ranking gave it.
 */
export function raisable(notice: Notice, rules: readonly AlertRule[] = []): DesktopAlert | null {
  const rule = ruleFor(rules, notice);
  if (rule === null || !rule.notify) return null;
  return desktopAlert(notice) ?? 'critical';
}

/**
 * Whether this notice may be raised while the window has the focus.
 *
 * The row's own answer, and nothing else. Its own function because the hook
 * asks it at a different moment from {@link raisable} — the focus is checked
 * before the fresh notices are even walked — and the two questions are
 * genuinely separate.
 */
export function raisableWhileFocused(notice: Notice, rules: readonly AlertRule[] = []): boolean {
  const rule = ruleFor(rules, notice);
  return rule !== null && rule.notify && rule.whileFocused;
}

/**
 * Which blocks are worth a notice, and how loud.
 *
 * A table rather than a rule, so adding a block type to the parser and deciding
 * it is notable are two separate, visible decisions. A type that is missing
 * here produces no notice at all — silence is the default, because a feed that
 * carries everything is the terminal again.
 */
export const NOTABLE: Partial<Record<BlockType, { severity: Severity; channel: NoticeChannel }>> = {
  // Something is wrong with the connection or the character's standing in it.
  'login-failed': { severity: 'critical', channel: 'session' },
  /* A level, and what it bought. Rare, and the thing a rule file is edited for. */
  'user-levels': { severity: 'info', channel: 'session' },
  'user-learns': { severity: 'info', channel: 'session' },
  'user-reads-spell': { severity: 'info', channel: 'session' },
  /* Asking to leave; the realm may still refuse, and the rail should say it was asked. */
  'user-exits-realm': { severity: 'info', channel: 'session' },
  /*
   * Leaving by accident, charged for on the way back in.
   *
   * `warning` and not `info`: this is the realm saying it took something from
   * the character, and it is the one moment the hang-up penalty — otherwise a
   * reading of the server's source that nobody dares measure — is visible at
   * all. It arrives in the welcome banner, several screens above where anybody
   * is looking by the time they are playing, so the card keeping it is the
   * whole point.
   */
  'user-disconnect-penalty': { severity: 'warning', channel: 'session' },

  /*
   * A command did not do what was asked.
   *
   * Every one of these is a step automation has **silently** failed to take —
   * silently is the whole test. `command-ignored` and `slow-down` are the
   * server saying it stopped listening; `command-not-understood` is worse than
   * a failure, because the unrecognised command is *said out loud in the room*;
   * `attack-refused` is a verb this character will never have and a
   * configuration mistake somebody has to go and fix; `attack-ineffective` is a
   * fight that cannot be won as it is being fought, and nothing else in the
   * stream says so, because the damage lines that would say it never arrive.
   */
  'direction-failed': { severity: 'warning', channel: 'movement' },
  'bash-failed': { severity: 'warning', channel: 'movement' },
  'command-not-understood': { severity: 'warning', channel: 'command' },
  'command-ignored': { severity: 'warning', channel: 'command' },
  'slow-down': { severity: 'warning', channel: 'command' },
  'comms-throttled': { severity: 'warning', channel: 'command' },
  'attack-refused': { severity: 'warning', channel: 'combat' },
  'attack-ineffective': { severity: 'warning', channel: 'combat' },
  /* The spell is landing and doing nothing: the monster is immune. The
     sentence names the target, so the card is where the target is read. */
  'spell-ineffective': { severity: 'warning', channel: 'combat' },
  /* The realm's conscience refused the attack: evil warnings are on. */
  'attack-warned': { severity: 'warning', channel: 'combat' },
  /* Somebody sizing up the room, or you. On a PvP realm, the moment before. */
  'player-looks': { severity: 'info', channel: 'room' },
  'user-sneak-failed': { severity: 'warning', channel: 'stealth' },
  // Blind mid-fight: every swing misses and nothing on screen says so again.
  // The decision it changes — keep fighting or run — is being made right now.
  'user-blinded': { severity: 'warning', channel: 'combat' },
  // The same test as blindness: a condition that changes the decision being
  // made right now. The sentence that ends each is not ranked — good news that
  // nobody acts on is the terminal again.
  'user-poisoned': { severity: 'warning', channel: 'combat' },
  'user-diseased': { severity: 'warning', channel: 'combat' },
  'user-held': { severity: 'warning', channel: 'combat' },
  /* Every command may be thrown away until it ends; the fumbles say so one at a time. */
  'user-confused': { severity: 'warning', channel: 'combat' },
  'user-cant-sneak': { severity: 'warning', channel: 'stealth' },
  'user-hide-failed': { severity: 'warning', channel: 'stealth' },
  'user-cant-hide': { severity: 'warning', channel: 'stealth' },
  /* The mid-round tick fired a round early; the cast was refused and the mana kept. */
  'spell-refused': { severity: 'warning', channel: 'combat' },
  /* The answer to `trac`, both ways round, for the same reason `search` is kept. */
  'user-tracks': { severity: 'info', channel: 'room' },
  'user-tracks-failed': { severity: 'info', channel: 'room' },
  /* Somebody died in this room. On a PvP realm that is worth going back to find. */
  'player-dies': { severity: 'warning', channel: 'room' },
  /*
   * This character's own death, which is the loudest thing that can happen to
   * it: a life spent, everything carried on the ground where it fell, and the
   * character standing in the temple rather than where it was. Critical, on
   * the combat channel with the blow that caused it.
   */
  'user-dies': { severity: 'critical', channel: 'combat' },
  'user-equipped-failed': { severity: 'warning', channel: 'items' },
  /* Two more commands that did nothing, both captured live: an `open` at a wall, a `list` outside a shop. */
  'open-failed': { severity: 'warning', channel: 'movement' },
  'user-list-failed': { severity: 'warning', channel: 'items' },

  /*
   * Somebody walking into *this room* is a different fact from entering the
   * realm, and the more urgent one: the realm is large and this room is where a
   * fight happens. Ranked a warning rather than the record for that reason —
   * and raised to critical when the roster says who it is, in `roomNotices`.
   */
  'player-arrives-room': { severity: 'warning', channel: 'room' },
  'player-leaves-room': { severity: 'info', channel: 'room' },
  'player-disconnects': { severity: 'info', channel: 'presence' },
  /* Something moving in the next room, which is the only warning a lair gives. */
  'heard-movement': { severity: 'info', channel: 'presence' },
  /*
   * The nightly cleanup, announced fifteen, five and one minute out and as it
   * runs. Worth a row because it moves things a player is counting on: every
   * non-placed item on every floor is hidden, `Del@Maint` items are destroyed
   * wherever they lie, and a `Remove@Maint` item leaves the pack.
   */
  'realm-cleanup': { severity: 'info', channel: 'realm' },
  /*
   * The answer to `search`, both ways round, and kept where the rest of the
   * housekeeping was cut because it is *rare*: it arrives only when somebody
   * typed the command, and a found exit is a way through the realm the data may
   * not have. The failure is kept beside it for the same reason it is worth
   * having at all — "is there a hidden exit here" is a question with two useful
   * answers, and somebody standing in a dead end wants both.
   */
  'user-search-succeeded': { severity: 'info', channel: 'room' },
  'user-search-failed': { severity: 'info', channel: 'room' },

  /* Who is travelling with you. The record; the health is what matters, below. */
  'party-invited': { severity: 'info', channel: 'party' },
  'party-joined': { severity: 'info', channel: 'party' },
  'party-left': { severity: 'info', channel: 'party' }

  /*
   * ## What was taken out, and the test that took it
   *
   * An alert is for something you would want to **act on** and could not go
   * back and find. The terminal already carries every line, in the server's own
   * words, in order; a second copy of a line nobody would act on is not a
   * second reading of it, it is the terminal again with a border round it —
   * which is the thing this card exists because of.
   *
   * Five types failed that test and were removed:
   *
   * - `user-gain-experience` — once per kill, all evening. It is a *number
   *   going up*, it is on the Vitals card, and nobody has ever acted on it.
   * - `command-no-effect` — `Your command had no effect.` The commonest line in
   *   the game after the status line, and by far the loudest thing here. It
   *   arrives whenever anything is aimed at something that is not there, which
   *   until the room list learned to drop a monster it had killed was several
   *   times a fight.
   * - `player-gets`, `player-drops`, `user-buys`, `user-sells` — the Carrying
   *   card already shows the result, which is the thing worth having.
   * - `player-enters`, `player-exits` — realm-wide chatter, dozens an hour, and
   *   **already reported**: `rosterNotices` raises an arrival from the roster,
   *   with what the realm thinks of the person attached, which is the half that
   *   decides anything. Two lines for one fact is how a feed stops being read.
   *
   * A type absent from this table produces no notice at all. That is the
   * default, and it is deliberate: adding a block type to the parser and
   * deciding it is worth interrupting somebody for are two separate decisions,
   * and only one of them is made here.
   */
};

/* ---------------------------------------------------------- alert events */

/**
 * What a row can be about, in the realm's own terms rather than the client's
 * (todo 03).
 *
 * The list used to offer the eleven `NOTICE_CHANNELS` — `combat`, `vitals`,
 * `room` — which are the buckets this module sorts notices into and not things
 * that happen in a realm. Nothing in that picker read as selectable because
 * nothing in it was a *happening*: somebody looking for *tell me when a player
 * attacks me* had to know that lived in `combat`, along with every monster's
 * blow and every refused spell.
 *
 * So a row names an **event**, and an event is one thing the realm does. Each
 * one carries the block types that are it, so the claim is made against the
 * block that arrived rather than against the bucket it was filed in.
 *
 * **The channel survives underneath** as the category these are grouped under,
 * and as what the Alerts card's chips still filter on. It is derived from
 * `NOTABLE` for every event here, so the two vocabularies cannot disagree:
 * one is what the player reads, the other is how the client sorts.
 *
 * A `metric` says which figure the event is measured by, where it has one; a
 * `measure` (a comparison and a value) is offered only where that figure is a
 * number. Both are optional and most events have neither — *gained a new
 * level* is the whole row — which is what the settings grid's empty cells are.
 */
export interface AlertEventSpec {
  /** The category it is grouped under, and the channel its notices carry. */
  channel: NoticeChannel;
  /**
   * The block types that are this event. Empty for the four events that are
   * not a block at all but a condition the client watches (`health`, `mana`,
   * `item`, `player`, `cash`), which carry a `watch` instead.
   */
  types: readonly BlockType[];
  /** The watch hook that produces it, for the events no block type is. */
  watch?: AlertWatch;
  /**
   * What this event is measured by, if anything.
   *
   * `figure` takes a comparison and a number — *health, below, 35%*. `name`
   * takes the name of a thing to wait for. Absent is an event that either
   * happened or did not.
   */
  metric?: 'figure' | 'name';
  /** Whether the figure can be stated as a share of a maximum as well as flat. */
  percent?: boolean;
  /** Whether it fires only downward, as money turning up does. */
  oneSided?: boolean;
}

/**
 * Every event a row can name, in the order the picker offers them.
 *
 * Grouped by channel, and within a group ordered by how much somebody is
 * likely to want it — which is roughly how urgent it is. The key is what goes
 * in the file, so it is written in the client's own spelling rather than the
 * realm's sentence; the sentence is `locales/ui.en.yaml`'s.
 *
 * **Every `NOTABLE` block type appears here exactly once**, and
 * `alert-events.test.ts` asserts both halves of that: an event naming a type
 * the table does not rank could never fire, and a ranked type no event names
 * is a happening the player cannot ask about. That pairing is what stops this
 * list drifting from the one that decides what a notice costs.
 */
export const ALERT_EVENTS = {
  /* The five the client watches rather than reads off one block. */
  health: { channel: 'vitals', types: [], watch: 'health', metric: 'figure', percent: true },
  mana: { channel: 'vitals', types: [], watch: 'mana', metric: 'figure', percent: true },
  attacked: { channel: 'combat', types: [], watch: 'attacked' },
  'item-found': { channel: 'items', types: [], watch: 'item', metric: 'name' },
  'player-seen': { channel: 'presence', types: [], watch: 'player', metric: 'name' },
  'cash-found': {
    channel: 'items',
    types: [],
    watch: 'cash',
    metric: 'figure',
    oneSided: true
  },

  /* Combat. */
  died: { channel: 'combat', types: ['user-dies'] },
  blinded: { channel: 'combat', types: ['user-blinded'] },
  poisoned: { channel: 'combat', types: ['user-poisoned'] },
  diseased: { channel: 'combat', types: ['user-diseased'] },
  held: { channel: 'combat', types: ['user-held'] },
  confused: { channel: 'combat', types: ['user-confused'] },
  'attack-refused': { channel: 'combat', types: ['attack-refused'] },
  'attack-useless': { channel: 'combat', types: ['attack-ineffective'] },
  'spell-useless': { channel: 'combat', types: ['spell-ineffective'] },
  'spell-refused': { channel: 'combat', types: ['spell-refused'] },
  'attack-warned': { channel: 'combat', types: ['attack-warned'] },

  /* This room. */
  'player-arrives': { channel: 'room', types: ['player-arrives-room'] },
  'player-leaves': { channel: 'room', types: ['player-leaves-room'] },
  'player-dies': { channel: 'room', types: ['player-dies'] },
  'player-looks': { channel: 'room', types: ['player-looks'] },
  searched: { channel: 'room', types: ['user-search-succeeded', 'user-search-failed'] },
  tracked: { channel: 'room', types: ['user-tracks', 'user-tracks-failed'] },

  /* Somebody near, or gone. */
  'movement-heard': { channel: 'presence', types: ['heard-movement'] },
  'player-disconnects': { channel: 'presence', types: ['player-disconnects'] },
  /* The realm's own clock: the nightly cleanup, fifteen minutes out to done. */
  cleanup: { channel: 'realm', types: ['realm-cleanup'] },

  /* Getting about. */
  'way-blocked': { channel: 'movement', types: ['direction-failed', 'open-failed'] },
  'bash-failed': { channel: 'movement', types: ['bash-failed'] },

  /* The shadows. */
  'sneak-failed': { channel: 'stealth', types: ['user-sneak-failed', 'user-cant-sneak'] },
  'hide-failed': { channel: 'stealth', types: ['user-hide-failed', 'user-cant-hide'] },

  /* Things carried. */
  'equip-failed': { channel: 'items', types: ['user-equipped-failed'] },
  'list-failed': { channel: 'items', types: ['user-list-failed'] },

  /* The party. */
  'party-invited': { channel: 'party', types: ['party-invited'] },
  'party-joined': { channel: 'party', types: ['party-joined'] },
  'party-left': { channel: 'party', types: ['party-left'] },

  /* What the client said, and what the realm said back. */
  'command-refused': {
    channel: 'command',
    types: ['command-not-understood', 'command-ignored']
  },
  throttled: { channel: 'command', types: ['slow-down', 'comms-throttled'] },

  /*
   * The six the client composes rather than reads off one block.
   *
   * Every one is a fact assembled from two things — a roster and a room, a
   * route and an arrival, a party listing and the last one — so no block type
   * is it, and before todo 03 none of them could be named by a row at all.
   * They are the events somebody is most likely to want, which is what made
   * the channel picker's silence about them worth fixing.
   */
  arrived: { channel: 'movement', types: [] },
  'connection-lost': { channel: 'session', types: [] },
  'hostile-arrives': { channel: 'room', types: [] },
  'monster-arrives': { channel: 'room', types: [] },
  'hostile-in-realm': { channel: 'realm', types: [] },
  'party-hurt': { channel: 'party', types: [] },
  'vitals-crossing': { channel: 'vitals', types: [] },

  /* The character itself, and the connection under it. */
  levelled: { channel: 'session', types: ['user-levels'] },
  learned: { channel: 'session', types: ['user-learns', 'user-reads-spell'] },
  'left-realm': { channel: 'session', types: ['user-exits-realm'] },
  'hangup-penalty': { channel: 'session', types: ['user-disconnect-penalty'] },
  'login-failed': { channel: 'session', types: ['login-failed'] }
} as const satisfies Record<string, AlertEventSpec>;

export type AlertEvent = keyof typeof ALERT_EVENTS;

/** The event names, for a picker and for the runtime half of the union. */
export const ALERT_EVENT_NAMES = Object.keys(ALERT_EVENTS) as AlertEvent[];

/**
 * One event's specification, widened to the interface.
 *
 * `as const satisfies` keeps each entry's literal type — which is what makes
 * the table readable and the channel exact — but narrows every entry to
 * exactly the keys it wrote, so `spec.metric` is a type error on the rows that
 * have none. One accessor widens it back, in one place, rather than at every
 * reader.
 */
export function alertEvent(on: AlertEvent): AlertEventSpec {
  return ALERT_EVENTS[on];
}

/** Whether a word names an event this client knows. */
export function isAlertEvent(value: unknown): value is AlertEvent {
  return typeof value === 'string' && value in ALERT_EVENTS;
}

/**
 * Which event a block is, or null where it is not one.
 *
 * Built once rather than searched per block: this runs on every notice, and
 * the table is fixed for the life of the process.
 */
const EVENT_OF_TYPE = new Map<BlockType, AlertEvent>(
  ALERT_EVENT_NAMES.flatMap((name) =>
    alertEvent(name).types.map((type) => [type, name] as [BlockType, AlertEvent])
  )
);

export function eventOfBlock(type: BlockType): AlertEvent | null {
  return EVENT_OF_TYPE.get(type) ?? null;
}

/** Which event a watch produces, for the five that are watched rather than read. */
const EVENT_OF_WATCH = new Map<AlertWatch, AlertEvent>(
  ALERT_EVENT_NAMES.flatMap((name) => {
    const watch = alertEvent(name).watch;
    return watch === undefined ? [] : [[watch, name] as [AlertWatch, AlertEvent]];
  })
);

export function eventOfWatch(watch: AlertWatch): AlertEvent | null {
  return EVENT_OF_WATCH.get(watch) ?? null;
}

/** Whether this event takes a comparison and a number. */
export function eventIsMeasured(on: AlertEvent): boolean {
  return alertEvent(on).metric === 'figure';
}

/** Whether this event is matched by the name of a thing. */
export function eventIsNamed(on: AlertEvent): boolean {
  return alertEvent(on).metric === 'name';
}

/** Whether this event fires only one way, as money turning up does. */
export function eventIsOneSided(on: AlertEvent): boolean {
  return alertEvent(on).oneSided === true;
}

/** Whether its figure may be stated as a share of a maximum. */
export function eventTakesPercent(on: AlertEvent): boolean {
  return alertEvent(on).percent === true;
}

/**
 * How long a row stays quiet after it has fired, in seconds.
 *
 * Thirty, as the ask named. The case is a row on something the realm repeats —
 * a refused attack every round, a search in a dead end — where the first is
 * the whole of the news and the next twenty are the terminal again with a
 * border round it. Zero is off, and means every occurrence.
 */
export const DEFAULT_ALERT_DEBOUNCE_SECONDS = 30;

/* ------------------------------------------------------------ alert rules */

/**
 * What a rule watches — the closed union, and its runtime half beside it
 * (todo 29, 2026-09-12).
 *
 * Two shapes, deliberately. A **channel** rule is the old mute list turned the
 * right way up: it says what to do with everything arriving on one of the
 * eleven channels, which is how somebody says *I do not care about items* or
 * *tell me about the party, loudly*. A **watch** rule is a condition the
 * channels cannot express — a number crossing a figure the player chose, a
 * name they are waiting for — and each has its own fields.
 *
 * Kept as one union rather than two lists because the settings screen draws
 * one table and the answer for a notice is *the first rule that claims it*:
 * two lists would need an order between them anyway, and it would be invisible.
 */
export const ALERT_WATCHES = [
  /** Health, as a share of maximum or as a figure. */
  'health',
  /** Mana, likewise; a class with none never matches. */
  'mana',
  /** A person — not a monster — swinging at this character. */
  'attacked',
  /** An item found or picked up whose name matches. */
  'item',
  /** A named player seen: arriving, listed, or speaking. */
  'player',
  /**
   * A pile of coins a search turned up, worth at least the figure on the row
   * in copper.
   *
   * A number like `health`, but not `alertIsMeasured`: there is no maximum to
   * be a share of and no *above* to fire on — money turning up is one-sided.
   * It was `ui.alerts.finds.cashOverCopper` until the list became the only
   * place alerts are configured (todo 02), and it is a watch rather than a
   * channel because a figure is exactly what a channel cannot carry.
   */
  'cash'
] as const;
export type AlertWatch = (typeof ALERT_WATCHES)[number];

/** Whether a rule's `on` is the one-sided figure money turning up carries. */
export function alertIsCash(on: AlertRule['on']): boolean {
  return eventIsOneSided(on);
}

/** Which side of the figure a `health` or `mana` rule fires on. */
export const ALERT_SIDES = ['below', 'above'] as const;
export type AlertSide = (typeof ALERT_SIDES)[number];

/**
 * One row of the player's alert list.
 *
 * **Order is the rule**: the first row that claims a notice decides it, so a
 * quiet blanket row at the bottom and a loud specific one above it says what
 * MegaMUD's own tables could not. A notice no row claims keeps the severity
 * `NOTABLE` gave it and is shown — the list adds and overrides, it is not an
 * allow list, so a channel added to the client later arrives visible.
 */
export interface AlertRule {
  /**
   * What this row is about: one of the events in {@link ALERT_EVENTS}.
   *
   * It used to be one of the eleven channels or one of the five watches — a
   * bucket the client sorts into, offered to somebody who was looking for a
   * thing that happens (todo 03). A word the client does not know is dropped
   * at load rather than defaulted, the closed union's runtime rule.
   */
  on: AlertEvent;
  /** Whether the row does anything at all. Off keeps it in the list, editable. */
  enabled: boolean;
  /**
   * The level this row's notices carry, or null to keep the one the client
   * decided. **The ranking is still the client's by default** — what a line
   * costs is a fact about the realm — and this is the player overruling it for
   * their own reasons, one row at a time, which is a different thing from a
   * per-character severity table replacing it.
   */
  level: Severity | null;
  /** Whether a notice claimed by this row is shown at all. */
  alert: boolean;
  /** Whether it also raises a desktop notification. */
  notify: boolean;
  /**
   * Raise that notification even while the window has the focus. Meaningless
   * — and refused by the form — while `notify` is off.
   */
  whileFocused: boolean;
  /** `below` or `above`, for the two watches that are numbers. */
  side: AlertSide;
  /**
   * The figure. A share of maximum when `percent`, else the number itself —
   * *below 60%* and *below 100 hit points* are both things a player says, and
   * which they meant is not guessable from the number.
   */
  value: number;
  percent: boolean;
  /**
   * The name an `item-found` or `player-seen` row waits for, matched the way
   * the server matches a typed name. Empty matches nothing, so an unfinished
   * row is inert rather than firing on everything.
   */
  name: string;
  /**
   * How long this row stays quiet after it has fired, in seconds.
   *
   * Thirty by default (todo 03). The case is an event the realm repeats — a
   * refused attack every round of a fight, a search in a dead end — where the
   * first is the whole of the news and the next twenty are the terminal again
   * with a border round it.
   *
   * **Per row, not per event**: two rows on one event at two figures are two
   * separate clocks, which is what makes *warn me at 35% and again at 15%*
   * work. 0 is off and means every occurrence, which is what the client did
   * before this existed.
   */
  quietSeconds: number;
}

/**
 * Whether a rule's `on` takes a figure, which is what decides whether the form
 * draws one at all. One statement of it, because a figure on a row nothing
 * reads it for is a control that does nothing.
 *
 * Reads the event table rather than listing names, so an event that gains a
 * figure later gains its control with it (todo 03).
 */
export function alertIsMeasured(on: AlertRule['on']): boolean {
  return eventIsMeasured(on);
}

/** Whether a rule's `on` names something matched by name rather than by kind. */
export function alertIsNamed(on: AlertRule['on']): boolean {
  return eventIsNamed(on);
}

/** The watch hook behind an event, for the five that are watched. */
export function watchOf(on: AlertEvent): AlertWatch | undefined {
  return alertEvent(on).watch;
}

/**
 * The rows a client ships with (todo 02, 2026-09-12).
 *
 * The list used to be empty, which was right while a severity floor and a
 * per-channel mute list stood behind it. With those gone the list is the only
 * place alerts are configured, and an empty one is a settings page with nothing
 * on it — nothing to read, nothing to copy, and no way to learn what a row can
 * say without writing one blind.
 *
 * **Four rows, in the two categories the ask named**, and every one of them a
 * thing somebody would otherwise have had to discover:
 *
 * - the two vitals, as the crossings a player actually watches for, with the
 *   figures MegaMUD's own defaults use;
 * - a person swinging, which is the single most urgent thing on this realm and
 *   the one the channels cannot say — `combat` carries every monster's blow as
 *   well;
 * - arriving where you asked to go, which is `info` in the ranking and is the
 *   reason somebody walked away from the keyboard.
 *
 * Kept deliberately short. Todo 29 declined a shipped list because *four rows
 * somebody has to understand before they can turn one off* is a cost, and that
 * is still true — it is now the smaller of two costs rather than the larger.
 *
 * Every row is on, and every row is removable: nothing here is special, and a
 * client whose list is empty shows what the ranking says, which is what it did
 * before there were rows at all.
 */
export const STARTER_ALERTS: readonly AlertRule[] = [
  {
    on: 'health',
    enabled: true,
    level: 'critical',
    alert: true,
    notify: true,
    whileFocused: false,
    side: 'below',
    value: 35,
    percent: true,
    name: '',
    quietSeconds: DEFAULT_ALERT_DEBOUNCE_SECONDS
  },
  {
    on: 'mana',
    enabled: true,
    level: 'warning',
    alert: true,
    notify: false,
    whileFocused: false,
    side: 'below',
    value: 20,
    percent: true,
    name: '',
    quietSeconds: DEFAULT_ALERT_DEBOUNCE_SECONDS
  },
  {
    on: 'attacked',
    enabled: true,
    level: 'critical',
    alert: true,
    notify: true,
    whileFocused: true,
    side: 'below',
    value: 0,
    percent: false,
    name: '',
    quietSeconds: DEFAULT_ALERT_DEBOUNCE_SECONDS
  },
  {
    on: 'arrived',
    enabled: true,
    level: null,
    alert: true,
    notify: true,
    whileFocused: false,
    side: 'below',
    value: 0,
    percent: false,
    name: '',
    quietSeconds: DEFAULT_ALERT_DEBOUNCE_SECONDS
  }
];

/**
 * The rule that claims a notice, or null where none does.
 *
 * A row claims a notice that is its own event (todo 03). Disabled rows are
 * skipped rather than claiming and doing nothing, so a row turned off leaves
 * the one below it in charge — which is what somebody turning a row off
 * expects, and the opposite of what skipping *after* claiming would do.
 *
 * A notice carrying no event is claimed by nothing and shown at the level the
 * ranking gave it: the list adds and overrides, it is never an allow list.
 */
export function ruleFor(rules: readonly AlertRule[], notice: Notice): AlertRule | null {
  /*
   * A notice that names its own row is claimed by that row, if it is still
   * enabled and still in the list. Several rows may watch one vital at several
   * figures, and matching on the event alone would hand every one of their
   * notices to whichever came first -- see `Notice.from`.
   */
  if (notice.from !== undefined) {
    const named = rules.find((rule) => rule === notice.from);
    if (named !== undefined) return named.enabled ? named : null;
  }
  if (notice.event === undefined) return null;
  for (const rule of rules) {
    if (rule.enabled && rule.on === notice.event) return rule;
  }
  return null;
}

/**
 * Whether a block could produce a notice at all.
 *
 * A cheap pre-filter, so the renderer does not have to reach into a character's
 * state for every line the server sends — most lines are not notable and the
 * common case should cost one lookup. It has to stay in step with
 * {@link noticeFor}, which is why both live here rather than the predicate
 * being spelled out at the call site.
 */
export function mayNotice(block: Block): boolean {
  return block.type === 'user-hits' || NOTABLE[block.type] !== undefined;
}

/**
 * The notices this character asked to see, in order.
 *
 * The ranking is not configurable and the *audience* is: what a line costs is a
 * fact about the realm, and whether somebody wants to hear about it is a fact
 * about them. A healer watching a party wants the party channel; a soloing
 * thief wants none of it.
 *
 * Takes the shape rather than `AlertsUiConfig` itself, because `config.ts`
 * imports this module for `Severity` and a value import back the other way
 * would close the loop.
 */
export function wanted(
  prefs: { rules?: readonly AlertRule[] },
  notices: readonly (Notice | null | undefined)[],
  quiet?: AlertQuiet
): Notice[] {
  const rules = prefs.rules ?? [];
  const kept: Notice[] = [];
  for (const notice of notices) {
    if (!notice) continue;
    /*
     * The player's own rows, and nothing else (todo 02).
     *
     * A row that claims a notice decides it outright — shown or not, and at
     * which level. **A notice no row claims is shown**, at the level the
     * ranking gave it: the list is not an allow list, so a channel the client
     * gains later arrives visible, and a player who has deleted every row sees
     * what the client would have shown them anyway rather than nothing.
     *
     * The severity floor and the per-channel mute list were the other half of
     * this until now. Both said *everything, except* — which is precisely a
     * row with `alert` off, or a row naming a level — so they were a second
     * way of writing what the list already writes, in a different vocabulary,
     * on a different part of the same page.
     */
    const rule = ruleFor(rules, notice);
    if (rule !== null) {
      if (!rule.alert) continue;
      // Quiet since it last fired (todo 03). Checked after the claim, so a
      // row that is resting still keeps the row below it from claiming --
      // the debounce silences an event, it does not hand it on.
      if (quiet !== undefined && resting(quiet, rule, notice.at)) continue;
      kept.push(rule.level === null ? notice : { ...notice, severity: rule.level });
      continue;
    }
    kept.push(notice);
  }
  return kept;
}

/**
 * When each row last fired, so a row can stay quiet for a while afterwards.
 *
 * The caller owns it — one per character, living as long as the session — so
 * `wanted` stays a pure function of its arguments and the clock, which is what
 * makes the whole ranking testable without a fake timer.
 *
 * Keyed by **what the row says**, not by its place in the list. Two rows on one
 * event at two figures are two separate clocks, which is what makes *warn me at
 * 35% and again at 15%* work — and a position cannot express that, because
 * `ruleFor` hands every notice for an event to the first row that claims it, so
 * every one of those rows would share index 0's clock. A position is also
 * unstable: reordering or deleting a row would renumber the rest and hand one
 * of them another's clock.
 */
export type AlertQuiet = Map<string, number>;

/** A fresh clock, for a session or a test. */
export function alertQuiet(): AlertQuiet {
  return new Map();
}

/**
 * A row's identity, for its own clock.
 *
 * Everything that makes one row a different question from another: what it is
 * about, and the figure or name it is about it at. Not `enabled`, `level` or
 * the three switches — those change what a row *does* when it fires, and
 * turning a row's level up should not give it a fresh clock.
 */
function keyOfRule(rule: AlertRule): string {
  return `${rule.on}|${rule.side}|${rule.value}|${rule.percent ? '%' : ''}|${rule.name.trim().toLowerCase()}`;
}

/**
 * Whether this row is still resting, and marks it fired when it is not.
 *
 * `at` is the notice's own moment rather than `Date.now()`: the notices of one
 * flush share a moment, so two occurrences arriving together are one firing
 * and not two — which is the case the debounce exists for.
 */
function resting(quiet: AlertQuiet, rule: AlertRule, at: number): boolean {
  const seconds = Math.max(0, rule.quietSeconds);
  // Off means every occurrence, so nothing is remembered either: a clock
  // nobody reads would still grow an entry per row.
  if (seconds <= 0) return false;
  const key = keyOfRule(rule);
  const last = quiet.get(key);
  if (last !== undefined && at - last < seconds * 1000) return true;
  quiet.set(key, at);
  return false;
}

/**
 * The notice a block is worth, or `null` if it is not worth one.
 *
 * The character is passed because one line's severity depends on who sent it,
 * and only one: a blow landing on this character is the ordinary weather of
 * every fight when a monster throws it, and the single most urgent thing that
 * happens on this realm when a *person* does.
 */
export function noticeFor(block: Block, t: UiLookup, state?: CharacterState): Notice | null {
  const pvp = state ? pvpNotice(block, state, t) : null;
  if (pvp) return pvp;
  const rank = NOTABLE[block.type];
  if (!rank) return null;
  const event = eventOfBlock(block.type);
  return {
    id: `b${block.seq}`,
    at: block.at,
    severity: rank.severity,
    channel: rank.channel,
    ...(event === null ? {} : { event }),
    // The server's own words. A paraphrase is a second thing to keep true, and
    // the line is already the clearest statement of what happened.
    text: block.text.trim()
  };
}

/**
 * A **player** hitting this character, which is the one thing on this realm
 * worth interrupting anybody for.
 *
 * The first blow opens a five-minute window in which disconnecting is penalised
 * and at low health kills outright (docs/greatermud/combat.md), and nothing on
 * screen shows that window running. A monster's blow is `mob-hits` and is not
 * notable at all — it is what every fight is made of; a person's arrives as
 * `user-hits` with `you` as the target, and the roster is what tells the two
 * apart.
 *
 * Nothing is raised for an attacker nobody has listed. That is the same refusal
 * `AutoCombat` makes about swinging at one: a name with no listing behind it is
 * as likely to be a quest NPC as a person, and crying wolf in this channel is
 * how the channel stops being read.
 */
function pvpNotice(block: Block, state: CharacterState, t: UiLookup): Notice | null {
  if (block.type !== 'user-hits') return null;
  const target = block.groups['target'];
  const attacker = block.groups['attacker'];
  if (target === undefined || !/^you$/i.test(target) || !attacker) return null;
  const key = attacker.toLowerCase();
  const listed = state.online.find((entry) => entry.name.toLowerCase() === key);
  if (listed === undefined) return null;
  return {
    id: `pvp${block.seq}`,
    at: block.at,
    severity: 'critical',
    channel: 'combat',
    desktop: 'attacked',
    // The watch a player's own row claims by (todo 29): *a person swinging at
    // me*, which is a different question from *anything on the combat channel*.
    watch: 'attacked',
    event: 'attacked',
    text: t('cards.alerts.combat.playerAttacking', { name: listed.name })
  };
}

/**
 * When `after` last learned anything, which is when whatever changed changed.
 * One definition, because every channel stamps its notices from the same clock
 * and two spellings of the fallback would drift.
 */
function noticedAt(state: CharacterState): number {
  return state.updatedAt ?? state.lastStatusAt ?? 0;
}

/**
 * The player's own numeric watches, as crossings (todo 29, 2026-09-12).
 *
 * Beside `vitalNotices` rather than inside it, because the two ask different
 * questions: that one watches the client's three *levels* and only downward,
 * where a rule watches **one figure the player chose**, in the direction they
 * chose. *Tell me when mana is back above 80%* is a thing somebody wants and
 * the levels cannot say.
 *
 * **Still a crossing, not a value.** A notice per status line while standing
 * at 20% health is noise that hides the crossing that mattered — the reason
 * `vitalNotices` watches edges — and that reasoning does not change because
 * the figure is the player's. So this fires only where the previous status
 * line was on the other side.
 *
 * An unknown figure on either side crosses nothing: unknown never alarms, and
 * a maximum that has not arrived would make every percentage rule fire on the
 * first status line of a session.
 */
export function watchNotices(
  before: CharacterState,
  after: CharacterState,
  rules: readonly AlertRule[],
  t: UiLookup
): Notice[] {
  const notices: Notice[] = [];
  const at = noticedAt(after);
  for (const rule of rules) {
    if (!rule.enabled || !alertIsMeasured(rule.on)) continue;
    const was = rule.on === 'health' ? before.vitals.hp : before.vitals.mana;
    const now = rule.on === 'health' ? after.vitals.hp : after.vitals.mana;
    const max = rule.on === 'health' ? after.vitals.hpMax : after.vitals.manaMax;
    if (was === null || now === null) continue;
    // The figure the rule is really about: a share needs a maximum, and
    // without one there is nothing to be a share of.
    if (rule.percent && (max === null || max <= 0)) continue;
    const mark = rule.percent ? ((max ?? 0) * rule.value) / 100 : rule.value;
    const crossed = rule.side === 'below' ? was >= mark && now < mark : was <= mark && now > mark;
    if (!crossed) continue;
    notices.push({
      id: `w${rule.on}${rule.side}${rule.value}-${at}`,
      at,
      severity: rule.level ?? 'warning',
      channel: 'vitals',
      watch: watchOf(rule.on),
      event: rule.on,
      from: rule,
      ...(rule.notify ? { desktop: 'hurt' as const } : {}),
      text:
        rule.on === 'health'
          ? t('cards.alerts.vitals.watchHealth', {
              side: rule.side,
              mark: Math.round(mark),
              current: now
            })
          : t('cards.alerts.vitals.watchMana', {
              side: rule.side,
              mark: Math.round(mark),
              current: now
            })
    });
  }
  return notices;
}

/**
 * The crossing worth an alert: into `critical` from anything better, or into
 * `caution` from `ok`. Defined once so the vitals and the party cannot come to
 * mean different things by "worse". `unknown` is the caller's problem — both
 * callers rule it out first, because unknown never alarms.
 */
function crossedIntoWorse(previous: VitalLevel, level: VitalLevel): boolean {
  return (
    (level === 'critical' && previous !== 'critical') || (level === 'caution' && previous === 'ok')
  );
}

/**
 * Notices for a vital that has just got worse.
 *
 * The one genuinely critical thing in a MUD is a number, not a message: the
 * server never says "you are about to die", it just prints a smaller figure in
 * a status line that has printed a hundred figures already. So this watches the
 * *crossing*, not the value — a notice per status line while standing at 20%
 * health is noise that hides the crossing that mattered.
 *
 * Only downward. Healing back through a threshold is good news, and good news
 * does not need an alert.
 */
export function vitalNotices(
  before: CharacterState,
  after: CharacterState,
  thresholds: { hp: VitalThresholds; mana: VitalThresholds },
  t: UiLookup
): Notice[] {
  const notices: Notice[] = [];

  const at = noticedAt(after);

  const check = (
    label: string,
    was: { current: number | null; max: number | null },
    now: { current: number | null; max: number | null },
    bounds: VitalThresholds,
    /*
     * Which desktop notification a *critical* crossing of this vital is.
     * Health only: `hurt` is the one the player asked to be told about away
     * from the keyboard, and mana running out is a decision about whether to
     * cast, which nobody makes from another room.
     */
    alarm: DesktopAlert | undefined
  ): void => {
    // Unknown is not zero: a figure that has not arrived yet must never raise
    // an alarm, because the first thing a player does about a red bar is run from a
    // fight they were winning.
    if (now.current === null || now.max === null) return;
    const previous = vitalLevel(was.current, was.max, bounds);
    const level = vitalLevel(now.current, now.max, bounds);
    if (level === 'unknown' || previous === 'unknown') return;
    if (!crossedIntoWorse(previous, level)) return;
    notices.push({
      id: `v${label}${now.current}-${at}`,
      at,
      severity: level === 'critical' ? 'critical' : 'warning',
      channel: 'vitals',
      event: 'vitals-crossing',
      ...(level === 'critical' && alarm !== undefined ? { desktop: alarm } : {}),
      text: t('cards.alerts.vitals.crossing', {
        label,
        level,
        current: now.current,
        max: now.max
      })
    });
  };

  check(
    t('cards.player.detail.health'),
    { current: before.vitals.hp, max: before.vitals.hpMax },
    { current: after.vitals.hp, max: after.vitals.hpMax },
    thresholds.hp,
    'hurt'
  );
  check(
    t('cards.alerts.vitals.manaLabel'),
    { current: before.vitals.mana, max: before.vitals.manaMax },
    { current: after.vitals.mana, max: after.vitals.manaMax },
    thresholds.mana,
    undefined
  );
  return notices;
}

/**
 * The route reaching where it was going.
 *
 * The one alert here that is *good news*, and it is kept for the reason the
 * rest of the good news is dropped: a walk across the realm is the thing
 * somebody starts and then goes and does something else during, so the moment
 * it finishes is the moment they are not looking. `info`, because a player
 * watching the card already has a bar that filled.
 *
 * From the crossing, like the vitals: `arrived` stands until the next route
 * is planned, and one notice per push while it stands is the same figure
 * announced over and over.
 *
 * **A loop never arrives** (2026-09-11). Its legs do, every few seconds — a
 * two-room lap raised one notice and one desktop alert almost every five
 * seconds, which is the client announcing its own footwork. An arrival is *I
 * set off for somewhere and I am there*, and a lap sets off for nowhere. So
 * the loop is handed in and `movementOf` decides: while the movement is the
 * lap, the walk underneath it is the lap's business and says nothing.
 *
 * `at` is passed rather than read off a clock, so this stays as pure as the
 * rest of the module; the caller stamps it with the moment the push landed.
 */
export function walkNotices(
  before: WalkProgress,
  after: WalkProgress,
  loop: LoopProgress,
  at: number,
  t: UiLookup
): Notice[] {
  /*
   * The lap is the movement *and* it is going, so this walk is one of its
   * legs. A lap that is merely stopped silences nothing: the character is
   * walking somewhere the player asked for, with a lap waiting to be pressed
   * play on when it gets there.
   */
  const { kind, moving } = movementOf(after, loop);
  if (kind === 'loop' && moving) return [];
  if (after.status !== 'arrived' || before.status === 'arrived') return [];
  const text =
    after.destination === null
      ? t('cards.alerts.walk.arrivedSomewhere')
      : t('cards.alerts.walk.arrived', { destination: after.destination });
  return [
    {
      id: `walk${at}`,
      at,
      severity: 'info',
      channel: 'movement',
      desktop: 'arrived',
      event: 'arrived',
      text
    }
  ];
}

/**
 * The character leaving the realm without the player asking.
 *
 * Two of the three ways a connection ends are worth saying and one is not:
 * pressing Disconnect is not news to whoever pressed it. The other two are the
 * same fact to somebody who is away from the keyboard — the character is out
 * of the realm and standing wherever it was — so they share a notification and
 * differ only in the sentence.
 *
 * `warning` rather than `critical`: on this server family the damage is
 * already done by the time this is read, and the ranking's loudest level is
 * for a decision being made right now.
 */
export function linkNotices(
  before: ConnectionState,
  after: ConnectionState,
  at: number,
  t: UiLookup
): Notice[] {
  if (after.endedBy === null || after.endedBy === before.endedBy) return [];
  if (after.endedBy === 'player') return [];
  const text =
    after.endedBy === 'client'
      ? t('cards.alerts.session.hungUp')
      : t('cards.alerts.session.dropped');
  return [
    {
      id: `link${at}`,
      at,
      severity: 'warning',
      channel: 'session',
      desktop: 'hungup',
      event: 'connection-lost' as const,
      text
    }
  ];
}

/**
 * Notices for who has turned up in the realm.
 *
 * The one thing a PvP realm makes urgent is not a number: it is a name. The
 * server announces arrivals for free — no command spent — but an arrival
 * carries only a name, so what the realm *thinks* of that person arrives later,
 * with the next `who` listing.
 *
 * So there are two moments worth reporting and they are not the same one:
 * somebody arriving, and somebody turning out to be hostile. An arrival whose
 * alignment is still unknown is reported as an arrival and nothing more —
 * calling it safe would be a guess, and calling it hostile would cry wolf.
 */
/**
 * Somebody in the party in trouble.
 *
 * The party roster is the only place another character's health is visible, and
 * this is the reason that matters: three of four characters are unattended, and
 * the one being watched is not usually the one that is dying.
 *
 * On the **crossing**, like vitals, and only downward — a member listed at 30%
 * on every `party` is one alert, not one per listing, and healing back through
 * a threshold is good news. A member with no health yet raises nothing: the
 * follow announcements carry none, and unknown is not zero.
 *
 * This character's own row is skipped. Its health already has a meter, a bar
 * and its own alerts; saying it twice is how a feed becomes one nobody reads.
 */
export function partyNotices(
  before: CharacterState,
  after: CharacterState,
  thresholds: VitalThresholds,
  t: UiLookup
): Notice[] {
  const at = noticedAt(after);
  const was = new Map(before.party.members.map((member) => [member.name, member]));
  const notices: Notice[] = [];

  for (const member of after.party.members) {
    if (after.name !== null && member.name === after.name) continue;
    if (member.health === null) continue;
    // Compared against a maximum of 1 because the roster is already a fraction.
    const level = vitalLevel(member.health, 1, thresholds);
    if (level !== 'critical' && level !== 'caution') continue;
    const previous = was.get(member.name);
    const before_ =
      previous?.health === null || previous === undefined
        ? 'unknown'
        : vitalLevel(previous.health, 1, thresholds);
    // Unknown on either side is absence, and absence never alarms.
    if (before_ === 'unknown') continue;
    if (!crossedIntoWorse(before_, level)) continue;
    notices.push({
      id: `p${member.name}-${Math.round(member.health * 100)}-${at}`,
      at,
      severity: level === 'critical' ? 'critical' : 'warning',
      channel: 'party',
      event: 'party-hurt',
      text: t('cards.alerts.party.memberHealth', {
        name: member.name,
        percent: Math.round(member.health * 100)
      })
    });
  }
  return notices;
}

/**
 * A hostile in the room, which is not the same as a hostile in the realm.
 *
 * The realm is large; the room is where a fight happens. Raised from the *room*
 * rather than from a line, because the line that says somebody walked in does
 * not say what they are — the roster does, and the two arrive separately.
 */
/**
 * What a `search` just turned up, when somebody asked to be told about it.
 *
 * From the **state**, like `roomNotices` and for the same kind of reason: the
 * line that says `You notice a rusty key here.` is the same sentence a look
 * prints, and what tells them apart is which command it answers — a fact
 * `CharacterTracker` has already settled by the time this state arrives.
 * `room.hidden` and `room.hiddenCash` are set only by a search's answer and
 * cleared by walking out and by `Your search revealed nothing.`, so a change
 * *into* something is the find, once.
 *
 * `critical`, and deliberately louder than the `user-search-succeeded` line
 * already in `NOTABLE`: that one is *a search worked*, which is common and
 * quiet. This one only fires for a word somebody typed into the watch list or
 * for money over a figure they chose, and an alert nobody asked for at a level
 * nobody chose is the one this project spends its silence budget avoiding.
 */
/**
 * The player's own named watches: an item, and a person (todo 29).
 *
 * Beside `findNotices` rather than inside it, because that one is about what a
 * **search** turned up — a narrower and louder fact, with its own settings —
 * and these are *anything of this name, however it arrived*: on the floor, in
 * the pack, or standing in the room.
 *
 * **Only what has just appeared.** Both halves compare against the previous
 * state and report the difference, for the reason every other producer here
 * does: a notice per status line while a gold ring lies on the floor is noise
 * that hides the moment it turned up.
 *
 * Matched by substring, case-insensitively, as `finds.items` is — somebody
 * types the word they are waiting for, not the realm's spelling of it.
 */
export function namedNotices(
  before: CharacterState,
  after: CharacterState,
  rules: readonly AlertRule[],
  t: UiLookup
): Notice[] {
  const wanted = rules.filter(
    (rule) => rule.enabled && alertIsNamed(rule.on) && rule.name.trim().length > 0
  );
  // The cash rows carry a figure rather than a name, so they are not in
  // `wanted` and the early return has to count them too.
  const money = rules.filter((rule) => rule.enabled && alertIsCash(rule.on) && rule.value > 0);
  if (wanted.length === 0 && money.length === 0) return [];

  const at = noticedAt(after);
  const notices: Notice[] = [];

  const items = wanted.filter((rule) => rule.on === 'item-found');
  if (items.length > 0) {
    /*
     * Lying in the room **and** turned up by a search, in one pass.
     *
     * These were two settings until the list became the only place alerts are
     * configured (todo 02): `ui.alerts.finds.items` watched `room.hidden` and
     * this watched `room.items`. A player waiting for a gold ring does not
     * care which of the two lists the realm happened to put it on, and two
     * controls asking the same question in different words is how somebody
     * comes to believe one of them is broken. Both lists are compared against
     * the previous state, so a ring that stays on the floor is announced once.
     */
    const had = new Set(
      [...before.room.items, ...before.room.hidden].map((item) => item.name.toLowerCase())
    );
    const seen = new Set<string>();
    for (const item of [...after.room.items, ...after.room.hidden]) {
      const name = item.name.toLowerCase();
      // A realm that lists one item on both lists is one find, not two.
      if (had.has(name) || seen.has(name)) continue;
      for (const rule of items) {
        if (!name.includes(rule.name.trim().toLowerCase())) continue;
        seen.add(name);
        notices.push({
          id: `watch-item-${at}-${name}`,
          at,
          severity: rule.level ?? 'warning',
          channel: 'items',
          watch: 'item',
          event: 'item-found',
          from: rule,
          text: t('cards.alerts.watch.item', { what: item.name })
        });
        break;
      }
    }
  }

  const people = wanted.filter((rule) => rule.on === 'player-seen');
  if (people.length > 0) {
    const had = new Set(before.room.occupants.map((who) => who.name.toLowerCase()));
    for (const who of after.room.occupants) {
      const name = who.name.toLowerCase();
      if (had.has(name)) continue;
      for (const rule of people) {
        if (!name.includes(rule.name.trim().toLowerCase())) continue;
        notices.push({
          id: `watch-player-${at}-${name}`,
          at,
          severity: rule.level ?? 'warning',
          channel: 'presence',
          watch: 'player',
          event: 'player-seen',
          from: rule,
          text: t('cards.alerts.watch.player', { who: who.name })
        });
        break;
      }
    }
  }

  /*
   * A pile of coins a search turned up, worth at least the figure on the row.
   *
   * Not `wanted` above -- that list is the two *named* watches, and this one
   * carries a figure rather than a name. It was `ui.alerts.finds.cashOverCopper`
   * until the list became the only place alerts are configured (todo 02).
   *
   * The same pile reported again is the same search's answer arriving again,
   * which is the rule every producer here keeps.
   */
  const cash = after.room.hiddenCash;
  if (
    money.length > 0 &&
    cash !== null &&
    before.room.hiddenCash?.totalCopper !== cash.totalCopper
  ) {
    for (const rule of money) {
      if (cash.totalCopper < rule.value) continue;
      notices.push({
        id: `watch-cash-${at}-${cash.totalCopper}`,
        at,
        severity: rule.level ?? 'warning',
        channel: 'items',
        watch: 'cash',
        event: 'cash-found',
        from: rule,
        text: t('cards.alerts.watch.cash', {
          what: cash.rawText ?? String(cash.totalCopper)
        })
      });
      break;
    }
  }

  return notices;
}

export function roomNotices(before: CharacterState, after: CharacterState, t: UiLookup): Notice[] {
  const at = noticedAt(after);
  const standing = new Map(after.online.map((entry) => [entry.name.toLowerCase(), entry]));
  const wasHere = new Set(before.room.occupants.map((who) => who.name.toLowerCase()));
  const mine = ownAlignment(after);

  const notices: Notice[] = [];
  for (const who of after.room.occupants) {
    const key = who.name.toLowerCase();
    if (wasHere.has(key)) continue;

    /*
     * A monster that will open the fight itself.
     *
     * Raised at `warning` rather than `critical`, unlike a hostile player: this
     * is the ordinary condition of most of the realm, and a feed that shouted
     * at every rat would be the terminal again — which is the thing this card
     * exists because of (`NOTABLE`, above). A person who has gone Outlaw is
     * news; a hostile monster is the weather, and worth one quiet line.
     *
     * Only when the realm data actually said so. `attacksOnSight` returns null
     * for a monster nothing can place and for a conditional one met by a
     * character whose standing has not been read, and null never alarms — the
     * same rule an unknown maximum follows.
     */
    if (who.kind === 'mob') {
      if (attacksOnSight(who.disposition, mine) !== true) continue;
      const arrived = t('cards.alerts.room.mobArrived', {
        name: who.name,
        dispositionWord: DISPOSITION_WORD[who.disposition ?? 'hostile']
      });
      notices.push({
        id: `m${who.name}-${at}`,
        at,
        severity: 'warning',
        channel: 'room',
        event: 'monster-arrives',
        text: who.uncertain ? arrived + t('cards.alerts.room.mobArrivedUncertainSuffix') : arrived
      });
      continue;
    }

    const known = standing.get(key);
    // Never listed, or listed with nothing said about their standing yet.
    if (known === undefined || known.alignment === null) continue;
    if (!isHostile(known.alignment)) continue;
    notices.push({
      id: `r${who.name}-${at}`,
      at,
      severity: 'critical',
      channel: 'room',
      event: 'hostile-arrives',
      text: t('cards.alerts.room.playerArrived', { name: who.name, alignment: known.alignment })
    });
  }
  return notices;
}

export function rosterNotices(
  before: CharacterState,
  after: CharacterState,
  t: UiLookup
): Notice[] {
  const notices: Notice[] = [];
  const at = noticedAt(after);
  const known = new Map(before.online.map((entry) => [entry.name, entry]));

  for (const entry of after.online) {
    const was = known.get(entry.name);
    const wasHostile = isHostile(was?.alignment ?? null);

    // Newly hostile — either they just appeared as one, or a listing has just
    // said what somebody already here is. This is the one to interrupt for.
    if (entry.alignment !== null && isHostile(entry.alignment) && !wasHostile) {
      notices.push({
        id: `h${entry.name}-${at}`,
        at,
        severity: 'critical',
        channel: 'realm',
        event: 'hostile-in-realm',
        text: t('cards.alerts.realm.becameHostile', {
          name: entry.name,
          alignment: entry.alignment,
          titleSuffix: entry.title ? `, ${entry.title}` : ''
        })
      });
      continue;
    }

    // Somebody new, and nothing yet known about them beyond the name.
    if (!was) {
      notices.push({
        id: `a${entry.name}-${at}`,
        at,
        severity: 'info',
        channel: 'realm',
        text: entry.provisional
          ? t('cards.alerts.realm.entered', { name: entry.name })
          : t('cards.alerts.realm.seen', {
              name: entry.name,
              alignmentSuffix: entry.alignment ? ` — ${entry.alignment}` : ''
            })
      });
    }
  }

  return notices;
}
