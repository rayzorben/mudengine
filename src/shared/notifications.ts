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
import type { FindAlertsConfig } from './config';
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
 * ranking. Each is a switch, because what is worth being interrupted for is a
 * fact about the player and not about the realm.
 *
 * The order is the order the settings screens offer the switches in.
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
   * four named ones. Absent leaves {@link desktopAlert} to the ranking, which
   * answers `critical` or nothing at all.
   */
  desktop?: DesktopAlert;
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
 * The desktop notification this alert is worth raising, for these preferences.
 *
 * Takes the shape rather than `DesktopAlertsConfig`, for the reason
 * {@link wanted} does: `config.ts` imports this module for its values and a
 * value import back the other way would close the loop.
 */
export function raisable(
  prefs: { enabled: boolean; mute: readonly string[] },
  notice: Notice
): DesktopAlert | null {
  if (!prefs.enabled) return null;
  const alert = desktopAlert(notice);
  if (alert === null) return null;
  return prefs.mute.some((entry) => entry.toLowerCase() === alert) ? null : alert;
}

/**
 * Which blocks are worth a notice, and how loud.
 *
 * A table rather than a rule, so adding a block type to the parser and deciding
 * it is notable are two separate, visible decisions. A type that is missing
 * here produces no notice at all — silence is the default, because a feed that
 * carries everything is the terminal again.
 */
const NOTABLE: Partial<Record<BlockType, { severity: Severity; channel: NoticeChannel }>> = {
  // Something is wrong with the connection or the character's standing in it.
  'login-failed': { severity: 'critical', channel: 'session' },
  /* A level, and what it bought. Rare, and the thing a rule file is edited for. */
  'user-levels': { severity: 'info', channel: 'session' },
  'user-learns': { severity: 'info', channel: 'session' },
  'user-reads-spell': { severity: 'info', channel: 'session' },
  /* Leaving on purpose; automatic login stands down, and the rail should say why. */
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
  prefs: { minimum: Severity; mute: readonly string[] },
  notices: readonly (Notice | null | undefined)[]
): Notice[] {
  const floor = SEVERITIES.indexOf(prefs.minimum);
  const muted = new Set(prefs.mute.map((channel) => channel.toLowerCase()));
  const kept: Notice[] = [];
  for (const notice of notices) {
    if (!notice) continue;
    // `SEVERITIES` runs loudest first, so a *lower* index is louder and the
    // floor is an upper bound on the index rather than a lower one.
    if (SEVERITIES.indexOf(notice.severity) > floor) continue;
    if (muted.has(notice.channel.toLowerCase())) continue;
    kept.push(notice);
  }
  return kept;
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
  return {
    id: `b${block.seq}`,
    at: block.at,
    severity: rank.severity,
    channel: rank.channel,
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
  return [{ id: `walk${at}`, at, severity: 'info', channel: 'movement', desktop: 'arrived', text }];
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
    { id: `link${at}`, at, severity: 'warning', channel: 'session', desktop: 'hungup', text }
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
export function findNotices(
  before: CharacterState,
  after: CharacterState,
  alerts: FindAlertsConfig,
  t: UiLookup
): Notice[] {
  if (alerts.items.length === 0 && alerts.cashOverCopper <= 0) return [];

  const at = noticedAt(after);
  const notices: Notice[] = [];
  const had = new Set(before.room.hidden.map((item) => item.name.toLowerCase()));

  for (const item of after.room.hidden) {
    // Already on the previous state's list, so this is the same search's answer
    // arriving again rather than a second find.
    if (had.has(item.name.toLowerCase())) continue;
    const name = item.name.toLowerCase();
    if (!alerts.items.some((word) => name.includes(word))) continue;
    notices.push({
      id: `find-${at}-${name}`,
      at,
      severity: 'critical',
      channel: 'items',
      text: t('cards.alerts.finds.item', { what: item.name })
    });
  }

  const cash = after.room.hiddenCash;
  const before_ = before.room.hiddenCash;
  if (
    cash !== null &&
    alerts.cashOverCopper > 0 &&
    cash.totalCopper >= alerts.cashOverCopper &&
    // Not the same pile the last state already reported.
    before_?.totalCopper !== cash.totalCopper
  ) {
    notices.push({
      id: `find-cash-${at}-${cash.totalCopper}`,
      at,
      severity: 'critical',
      channel: 'items',
      text: t('cards.alerts.finds.cash', { what: cash.rawText ?? String(cash.totalCopper) })
    });
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
