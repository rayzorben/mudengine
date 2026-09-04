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

export interface Notice {
  /** Stable within a session, so a list can key on it without an index. */
  id: string;
  at: number;
  severity: Severity;
  /** What kind of thing this is, for filtering — one of {@link NOTICE_CHANNELS}. */
  channel: NoticeChannel;
  text: string;
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
    bounds: VitalThresholds
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
    thresholds.hp
  );
  check(
    t('cards.alerts.vitals.manaLabel'),
    { current: before.vitals.mana, max: before.vitals.manaMax },
    { current: after.vitals.mana, max: after.vitals.manaMax },
    thresholds.mana
  );
  return notices;
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
