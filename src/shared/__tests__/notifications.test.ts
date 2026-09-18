import { NO_LOOP } from '../loops';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  alertQuiet,
  desktopAlert,
  namedNotices,
  linkNotices,
  noticeFor,
  partyNotices,
  raisable,
  raisableWhileFocused,
  roomNotices,
  rosterNotices,
  vitalNotices,
  walkNotices,
  wanted,
  watchNotices,
  type AlertRule,
  type Notice
} from '../notifications';
import { IDLE_WALK } from '../walk';
import type { ConnectionState } from '../types';
import { asUiDict, makeT } from '../i18n';
import { EMPTY_CHARACTER, type CharacterState } from '../character';
import type { Block, BlockType } from '../blocks';
import { domainOf } from '../blocks';
import { classifyOccupant, type MobDisposition } from '../mobs';

const BOUNDS = { hp: { caution: 0.5, critical: 0.25 }, mana: { caution: 0.5, critical: 0.25 } };

/**
 * The real dictionary, so these tests keep asserting the copy a player sees.
 * A lookup problem — a missing key, an unfilled placeholder — throws rather
 * than passing quietly with the raw key in the asserted text.
 */
const dict = asUiDict(
  parse(readFileSync(new URL('../../../locales/ui.en.yaml', import.meta.url), 'utf8'))
);
if (dict === null) throw new Error('locales/ui.en.yaml did not parse to a UI dictionary');
const t = makeT(dict, (problem) => {
  throw new Error(problem);
});

function block(type: BlockType, text: string): Block {
  return {
    seq: 1,
    at: 1000,
    type,
    domain: domainOf(type),
    groups: {},
    text,
    terminator: 'newline',
    confidence: 0.8
  };
}

function withVitals(hp: number | null, hpMax: number | null, at = 2000): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax },
    updatedAt: at
  };
}

describe('which blocks are worth a notice', () => {
  it('ranks a failed login as critical', () => {
    const notice = noticeFor(block('login-failed', 'Invalid password.'), t);
    expect(notice?.severity).toBe('critical');
    expect(notice?.channel).toBe('session');
  });

  it('ranks a command that did not run as a warning', () => {
    expect(
      noticeFor(block('direction-failed', 'There is no exit in that direction!'), t)?.severity
    ).toBe('warning');
    expect(noticeFor(block('slow-down', 'Slow down!'), t)?.severity).toBe('warning');
  });

  it('ranks presence as the record, not an emergency', () => {
    expect(
      noticeFor(block('player-leaves-room', 'Soul just left to the north.'), t)?.severity
    ).toBe('info');
  });

  /*
   * The line the whole retune was for. `Your command had no effect.` is the
   * commonest thing in the game after the status line, it says nothing anybody
   * would act on, and it filled this card with copies of itself.
   */
  it('says nothing about the noise the terminal already carries', () => {
    expect(noticeFor(block('command-no-effect', 'Your command had no effect.'), t)).toBeNull();
    expect(noticeFor(block('user-gain-experience', 'You gain 17 experience.'), t)).toBeNull();
    expect(noticeFor(block('player-gets', 'You took quarterstaff.'), t)).toBeNull();
    // Reported once, by the roster, with what the realm thinks of them
    // attached — which is the half that decides anything.
    expect(noticeFor(block('player-enters', 'Soul just entered the Realm.'), t)).toBeNull();
  });

  /*
   * The default is silence. A feed that carries every block is the terminal
   * again, and the terminal is the thing this card exists because of.
   */
  it('says nothing about a block that is not in the table', () => {
    expect(noticeFor(block('status-line', '[HP=42/MA=0]:'), t)).toBeNull();
    expect(noticeFor(block('room-name', 'Newhaven Village Entrance'), t)).toBeNull();
    expect(noticeFor(block('conversation-gossip', 'Soul gossips: hi'), t)).toBeNull();
  });

  it("keeps the server's own words rather than paraphrasing them", () => {
    const text = 'There is no exit in that direction!';
    expect(noticeFor(block('direction-failed', `  ${text}  `), t)?.text).toBe(text);
  });
});

const LINK: ConnectionState = {
  phase: 'connected',
  target: null,
  connectedAt: 1000,
  detail: null,
  endedBy: null,
  negotiated: {
    localEnabled: [],
    remoteEnabled: [],
    binary: false,
    suppressGoAhead: false,
    remoteEcho: false
  }
};

describe('what is worth saying outside the window', () => {
  const alert = (over: Partial<Notice>): Notice => ({
    id: 'x',
    at: 1,
    severity: 'info',
    channel: 'room',
    text: 'something',
    ...over
  });

  /* Its own, because the two lower describes each lean on their own defaults
     for `percent` and `quietSeconds` and these tests care about neither. */
  const rule = (over: Partial<AlertRule> & { on: AlertRule['on'] }): AlertRule => ({
    enabled: true,
    level: null,
    alert: true,
    notify: false,
    whileFocused: false,
    side: 'below',
    value: 0,
    percent: true,
    name: '',
    quietSeconds: 0,
    ...over
  });

  it('answers critical for a ranked alert that names no happening', () => {
    expect(desktopAlert(alert({ severity: 'critical' }))).toBe('critical');
    expect(desktopAlert(alert({ severity: 'warning' }))).toBeNull();
  });

  /*
   * The named four outrank the ranking: a player attacking you is critical as
   * well, and the happening is the more specific word for it. The kind is what
   * the window rests a notification on, so the *naming* is what this holds;
   * whether it is raised at all is the rows', below.
   */
  it('names the happening rather than falling back to the ranking', () => {
    const attacked = alert({ severity: 'critical', desktop: 'attacked', event: 'attacked' });
    expect(desktopAlert(attacked)).toBe('attacked');
    expect(raisable(attacked, [rule({ on: 'attacked', notify: true })])).toBe('attacked');
  });

  /*
   * The one way the notification differs from the card: an unclaimed notice is
   * still *shown* at the level the ranking gave it, and raises nothing. Being
   * interrupted away from the keyboard is asked for, never inherited -- and
   * with the two switches gone (2026-09-13) a row is the only place to ask.
   */
  it('raises nothing for a notice no row claims', () => {
    expect(raisable(alert({ severity: 'critical' }))).toBeNull();
    expect(raisable(alert({ severity: 'critical', event: 'attacked' }), [])).toBeNull();
  });
});

describe('a route reaching where it was going', () => {
  const arrived = { ...IDLE_WALK, status: 'arrived' as const, destination: 'Bank of Godfrey' };

  it('alerts on the crossing into arrived, naming where', () => {
    const raised = walkNotices(IDLE_WALK, arrived, NO_LOOP, 5, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.desktop).toBe('arrived');
    expect(raised[0]!.channel).toBe('movement');
    expect(raised[0]!.text).toContain('Bank of Godfrey');
  });

  it('alerts once, not on every push while it stands arrived', () => {
    expect(walkNotices(arrived, arrived, NO_LOOP, 6, t)).toHaveLength(0);
  });

  it('says nothing about a walk that stopped', () => {
    const stopped = { ...IDLE_WALK, status: 'stopped' as const, reason: 'a shut door' };
    expect(walkNotices(IDLE_WALK, stopped, NO_LOOP, 7, t)).toHaveLength(0);
  });

  /*
   * A lap never arrives. Its legs do, every few seconds — a two-room lap
   * raised one of these almost every five seconds, which is the client
   * announcing its own footwork rather than telling anybody anything.
   */
  it('says nothing about a leg landing under a running loop', () => {
    const looping = { ...NO_LOOP, status: 'running' as const, name: 'Arena' };
    expect(walkNotices(IDLE_WALK, arrived, looping, 8, t)).toHaveLength(0);
  });

  /*
   * And a lap that is merely *stopped* does not silence a route: the character
   * is walking somewhere the player asked for, with a lap waiting to be
   * pressed play on when it gets there.
   */
  it('still announces a route walked while a lap sits stopped', () => {
    const waiting = { ...NO_LOOP, status: 'stopped' as const, name: 'Arena' };
    expect(walkNotices(IDLE_WALK, arrived, waiting, 9, t)).toHaveLength(1);
  });
});

describe('a character leaving the realm', () => {
  it('says nothing when the player pressed Disconnect', () => {
    expect(linkNotices(LINK, { ...LINK, phase: 'closed', endedBy: 'player' }, 8, t)).toHaveLength(
      0
    );
  });

  it('alerts when the link went without anybody here asking', () => {
    const raised = linkNotices(LINK, { ...LINK, phase: 'closed', endedBy: 'realm' }, 9, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.desktop).toBe('hungup');
    expect(raised[0]!.channel).toBe('session');
  });

  it('alerts when the client hung up for an absent player, in its own words', () => {
    const byClient = { ...LINK, phase: 'closed' as const, endedBy: 'client' as const };
    const raised = linkNotices(LINK, byClient, 10, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.text).not.toBe(
      linkNotices(LINK, { ...LINK, phase: 'closed', endedBy: 'realm' }, 10, t)[0]!.text
    );
    // And once: a closed state republished says the same thing again.
    expect(linkNotices(byClient, byClient, 11, t)).toHaveLength(0);
  });
});

describe('a vital that has just got worse', () => {
  it('alerts on the crossing into critical', () => {
    const raised = vitalNotices(withVitals(60, 100), withVitals(20, 100), BOUNDS, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
    expect(raised[0]!.channel).toBe('vitals');
    // And is the happening somebody switches on to be told about away from the
    // window, rather than merely one of the critical ones.
    expect(raised[0]!.desktop).toBe('hurt');
  });

  /*
   * Health only. Mana running out is a decision about whether to cast, and
   * nobody makes that from another room.
   */
  it('names no desktop happening for a caution crossing, or for mana', () => {
    expect(vitalNotices(withVitals(90, 100), withVitals(40, 100), BOUNDS, t)[0]!.desktop).toBe(
      undefined
    );
  });

  it('alerts once, not on every status line below the line', () => {
    // Already critical, and it drops further. The crossing has been reported.
    expect(vitalNotices(withVitals(20, 100), withVitals(15, 100), BOUNDS, t)).toHaveLength(0);
  });

  it('says nothing about healing back through a threshold', () => {
    expect(vitalNotices(withVitals(20, 100), withVitals(80, 100), BOUNDS, t)).toHaveLength(0);
  });

  /*
   * The failure this is guarding against is the one docs/CLAUDE.md calls out:
   * a bar painted red for want of a number that has not arrived is what makes
   * a player run from a fight they were winning.
   */
  it('never alerts because a maximum has not arrived yet', () => {
    expect(vitalNotices(withVitals(60, null), withVitals(20, null), BOUNDS, t)).toHaveLength(0);
    expect(vitalNotices(withVitals(60, null), withVitals(20, 100), BOUNDS, t)).toHaveLength(0);
  });

  it('reports mana on its own thresholds, separately from health', () => {
    const before: CharacterState = {
      ...EMPTY_CHARACTER,
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 90, hpMax: 100, mana: 90, manaMax: 100 }
    };
    const after: CharacterState = {
      ...before,
      vitals: { ...before.vitals, mana: 10 },
      updatedAt: 3000
    };
    const raised = vitalNotices(before, after, BOUNDS, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.text).toContain('Mana');
  });

  /* A class with no mana is absence, not zero, and absence never alarms. */
  it('says nothing about a class that has no mana at all', () => {
    const warrior: CharacterState = {
      ...EMPTY_CHARACTER,
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 90, hpMax: 100, mana: null, manaMax: null }
    };
    const hurt: CharacterState = {
      ...warrior,
      vitals: { ...warrior.vitals, hp: 80 },
      updatedAt: 3000
    };
    expect(vitalNotices(warrior, hurt, BOUNDS, t)).toHaveLength(0);
  });
});

/*
 * The one thing a PvP realm makes urgent is not a number; it is a name. The
 * server announces arrivals for free, but an arrival carries only a name — what
 * the realm thinks of that person lands with the next `who`. Those are two
 * moments and they deserve different volumes.
 */
describe('who has turned up', () => {
  const withRoster = (online: CharacterState['online'], at = 5000): CharacterState => ({
    ...EMPTY_CHARACTER,
    online,
    updatedAt: at
  });
  const who = (
    name: string,
    alignment: CharacterState['online'][number]['alignment'] = null,
    provisional = false
  ): CharacterState['online'][number] => ({
    name,
    alignment,
    title: null,
    flags: null,
    gang: null,
    provisional
  });

  it('reports an arrival as the record, because a name is all it knows', () => {
    const raised = rosterNotices(withRoster([]), withRoster([who('Grimjaw', null, true)]), t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('info');
    expect(raised[0]!.text).toContain('Grimjaw');
  });

  it('interrupts for somebody hostile', () => {
    const raised = rosterNotices(withRoster([]), withRoster([who('Grimjaw', 'Outlaw')]), t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
    expect(raised[0]!.channel).toBe('realm');
  });

  /*
   * The moment that would otherwise be missed entirely: somebody already in the
   * roster whose standing a listing has just revealed. Nothing arrives on the
   * wire at that moment — it is a state change and nothing else.
   */
  it('interrupts when a listing reveals what somebody already here is', () => {
    const before = withRoster([who('Grimjaw', null, true)]);
    const after = withRoster([who('Grimjaw', 'Villain')]);
    const raised = rosterNotices(before, after, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
  });

  it('does not cry wolf twice about the same person', () => {
    const roster = withRoster([who('Grimjaw', 'Outlaw')]);
    expect(rosterNotices(roster, roster, t)).toHaveLength(0);
  });

  it('says nothing about somebody harmless who was already listed', () => {
    const before = withRoster([who('Yang', 'Good')]);
    const after = withRoster([who('Yang', 'Good')]);
    expect(rosterNotices(before, after, t)).toHaveLength(0);
  });

  /* Leaving is not news worth an alert; the card simply stops listing them. */
  it('says nothing when somebody leaves', () => {
    const before = withRoster([who('Yang', 'Good'), who('Grimjaw', 'Outlaw')]);
    const after = withRoster([who('Yang', 'Good')]);
    expect(rosterNotices(before, after, t)).toHaveLength(0);
  });
});

/*
 * The realm is large; the room is where a fight happens. Raised from the *room*
 * rather than from a line, because the line that says somebody walked in does
 * not say what they are — the roster does, and the two arrive separately.
 */
describe('somebody in the room', () => {
  /**
   * A room holding these names, classified the way the tracker classifies them.
   *
   * Through the real classifier so a test cannot assert against a room the
   * client could never produce. The roster is passed in as both the realm
   * listing and the source of who is a player, which is what it is.
   */
  const inRoom = (names: string[], online: CharacterState['online'] = []): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: {
      ...EMPTY_CHARACTER.room,
      occupants: names.map((name) =>
        classifyOccupant(name, {
          players: new Set(online.map((entry) => entry.name.toLowerCase())),
          mob: () => undefined
        })
      )
    },
    online,
    updatedAt: 7000
  });

  /** A room holding one monster the realm data can place. */
  const withMob = (name: string, disposition: MobDisposition): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: {
      ...EMPTY_CHARACTER.room,
      occupants: [
        classifyOccupant(name, {
          players: new Set<string>(),
          mob: () => ({ disposition, uncertain: false, costly: 'never' })
        })
      ]
    },
    updatedAt: 7000
  });
  const who = (
    name: string,
    alignment: CharacterState['online'][number]['alignment']
  ): CharacterState['online'][number] => ({
    name,
    alignment,
    title: null,
    flags: null,
    gang: null,
    provisional: false
  });

  it('interrupts for a hostile walking in', () => {
    const roster = [who('Cutthroat', 'Villain')];
    const raised = roomNotices(inRoom([], roster), inRoom(['Cutthroat'], roster), t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
    expect(raised[0]!.channel).toBe('room');
  });

  it('says nothing about somebody harmless', () => {
    const roster = [who('Yang', 'Good')];
    expect(roomNotices(inRoom([], roster), inRoom(['Yang'], roster), t)).toHaveLength(0);
  });

  /*
   * A monster the realm data cannot place says nothing. It has no alignment of
   * its own and no row to read a disposition off, and treating an unplaced
   * occupant as hostile would fire on every room with anything in it.
   */
  it('says nothing about a monster nothing can place', () => {
    expect(roomNotices(inRoom([]), inRoom(['orc rogue']), t)).toHaveLength(0);
  });

  /*
   * One that the realm data *can* place is worth a line — and a quiet one.
   * Most of the realm is hostile, so this is the weather rather than the news:
   * `warning`, where a person who has gone Outlaw is `critical`.
   */
  it('mentions a monster the realm says attacks on sight, quietly', () => {
    const raised = roomNotices(inRoom([]), withMob('giant rat', 'hostile'), t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('warning');
    expect(raised[0]!.channel).toBe('room');
  });

  it('says nothing about a monster that only fights back', () => {
    expect(roomNotices(inRoom([]), withMob('shopkeeper', 'passive'), t)).toHaveLength(0);
  });

  /*
   * A monster whose answer depends on how the realm ranks this character, met
   * before anything has said. Unknown never alarms — the same rule an unknown
   * maximum follows on a meter.
   */
  it('says nothing about a conditional monster when the standing is unknown', () => {
    expect(roomNotices(inRoom([]), withMob('town guard', 'hates-evil'), t)).toHaveLength(0);
  });

  it('does not repeat itself for somebody who was already here', () => {
    const roster = [who('Cutthroat', 'Villain')];
    const here = inRoom(['Cutthroat'], roster);
    expect(roomNotices(here, here, t)).toHaveLength(0);
  });

  it('says nothing when somebody leaves', () => {
    const roster = [who('Cutthroat', 'Villain')];
    expect(roomNotices(inRoom(['Cutthroat'], roster), inRoom([], roster), t)).toHaveLength(0);
  });
});

/*
 * The reason the party roster matters: three of four characters are unattended,
 * and the one being watched is not usually the one that is dying.
 */
describe('somebody in the party in trouble', () => {
  const member = (
    name: string,
    health: number | null
  ): CharacterState['party']['members'][number] => ({
    name,
    activity: null,
    className: 'Paladin',
    health,
    invited: false,
    vitals: null,
    mana: null,
    rank: 'front'
  });
  const party = (
    members: CharacterState['party']['members'],
    name: string | null = 'Vaelor'
  ): CharacterState => ({
    ...EMPTY_CHARACTER,
    name,
    party: { following: null, members, engaged: {}, threatened: {} },
    updatedAt: 9000
  });

  it('interrupts when a member falls to critical', () => {
    const raised = partyNotices(
      party([member('Soul', 0.9)]),
      party([member('Soul', 0.1)]),
      BOUNDS.hp,
      t
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
    expect(raised[0]!.channel).toBe('party');
    expect(raised[0]!.text).toContain('Soul');
  });

  it('warns when one merely gets low', () => {
    const raised = partyNotices(
      party([member('Soul', 0.9)]),
      party([member('Soul', 0.4)]),
      BOUNDS.hp,
      t
    );
    expect(raised[0]!.severity).toBe('warning');
  });

  /* On the crossing: a member listed at 30% on every `party` is one alert. */
  it('says it once, not once per listing', () => {
    const low = party([member('Soul', 0.1)]);
    expect(partyNotices(low, low, BOUNDS.hp, t)).toHaveLength(0);
  });

  it('says nothing about somebody healing back up', () => {
    expect(
      partyNotices(party([member('Soul', 0.1)]), party([member('Soul', 0.9)]), BOUNDS.hp, t)
    ).toHaveLength(0);
  });

  /*
   * The follow announcements carry no health, so a member added that way has
   * none — and unknown is not zero, which is the same rule the vitals meters
   * follow and for the same reason.
   */
  it('never alarms about a member whose health is not known', () => {
    expect(
      partyNotices(party([member('Soul', null)]), party([member('Soul', null)]), BOUNDS.hp, t)
    ).toHaveLength(0);
    // Nor on the *first* listing that gives them one: there is nothing to
    // compare against, and "they were already hurt when I looked" is not news.
    expect(
      partyNotices(party([member('Soul', null)]), party([member('Soul', 0.1)]), BOUNDS.hp, t)
    ).toHaveLength(0);
  });

  /*
   * This character's own health already has a meter, a bar and its own alerts.
   * Saying it twice is how a feed becomes one nobody reads.
   */
  it('says nothing about this character’s own row', () => {
    expect(
      partyNotices(
        party([member('Vaelor', 0.9)], 'Vaelor'),
        party([member('Vaelor', 0.1)], 'Vaelor'),
        BOUNDS.hp,
        t
      )
    ).toHaveLength(0);
  });

  it('reports each member that got worse, not only the first', () => {
    const raised = partyNotices(
      party([member('Soul', 0.9), member('Thorn', 0.9)]),
      party([member('Soul', 0.1), member('Thorn', 0.2)]),
      BOUNDS.hp,
      t
    );
    expect(raised).toHaveLength(2);
  });
});

/*
 * The player's own alert rows (todo 29, 2026-09-12).
 *
 * They add to the floor and the mute list rather than replacing them: the
 * first enabled row that claims a notice decides it outright, and anything no
 * row claims still meets `minimum` and `mute`. So an empty list behaves
 * exactly as the client always did.
 */
describe('the alert rules', () => {
  const rule = (over: Partial<AlertRule> & { on: AlertRule['on'] }): AlertRule => ({
    enabled: true,
    level: null,
    alert: true,
    notify: false,
    whileFocused: false,
    side: 'below',
    value: 0,
    percent: true,
    name: '',
    // Off, so these measure the ranking rather than the debounce, which has
    // its own tests below.
    quietSeconds: 0,
    ...over
  });

  const said = (over: Partial<Notice> = {}): Notice => ({
    id: 'n1',
    at: 1,
    severity: 'info',
    channel: 'items',
    // A row claims by event now, not by channel (todo 03), so a notice used to
    // exercise the rules has to be one.
    event: 'item-found',
    text: 'something',
    ...over
  });

  /*
   * The list is not an allow list (todo 02). A client with no rows shows what
   * the ranking says, which is what it did before there were rows at all --
   * and is why deleting every row is not the same as muting everything.
   */
  it('shows everything the ranking says, with no rules at all', () => {
    const notices = [said(), said({ id: 'n2', severity: 'critical', channel: 'combat' })];
    expect(wanted({}, notices)).toHaveLength(2);
    expect(wanted({ rules: [] }, notices)).toHaveLength(2);
  });

  it('hides what a row says not to show', () => {
    const kept = wanted({ rules: [rule({ on: 'item-found', alert: false })] }, [said()]);
    expect(kept).toEqual([]);
  });

  /* A row off is silence for that channel alone; the rest carry on. */
  it('leaves every other channel alone while one row hides its own', () => {
    const kept = wanted({ rules: [rule({ on: 'item-found', alert: false })] }, [
      said(),
      said({ id: 'n2', channel: 'combat', event: 'died' })
    ]);
    expect(kept.map((notice) => notice.channel)).toEqual(['combat']);
  });

  it('raises the level a row states, leaving the rest alone', () => {
    const kept = wanted({ rules: [rule({ on: 'item-found', level: 'critical' })] }, [said()]);
    expect(kept[0]?.severity).toBe('critical');
  });

  /* The first enabled row wins; a row turned off leaves the next in charge. */
  it('takes the first enabled row that claims it', () => {
    const rules = [
      rule({ on: 'item-found', enabled: false, alert: false }),
      rule({ on: 'item-found', level: 'warning' })
    ];
    const kept = wanted({ rules }, [said()]);
    expect(kept[0]?.severity).toBe('warning');
  });

  /* A watch row claims by the watch the producer marked, not by the channel. */
  it('claims a notice by its watch as well as by its channel', () => {
    const kept = wanted({ rules: [rule({ on: 'attacked', level: 'info' })] }, [
      said({ channel: 'combat', severity: 'critical', watch: 'attacked', event: 'attacked' })
    ]);
    expect(kept[0]?.severity).toBe('info');
  });

  /*
   * And the desktop half: a row decides whether it is raised at all, and it is
   * the only thing that does. A per-happening mute list was one half of the
   * old surface and the two `ui.alerts.desktop` switches the other; every
   * question both asked is a row, which is what this asserts.
   */
  it('lets a row decide whether a notification is raised', () => {
    const notice = said({
      channel: 'combat',
      watch: 'attacked',
      event: 'attacked',
      desktop: 'attacked'
    });
    // Claimed by nothing raises nothing; a row marked `notify` raises it.
    expect(raisable(notice)).toBeNull();
    expect(raisable(notice, [rule({ on: 'attacked', notify: true })])).toBe('attacked');
    expect(raisable(notice, [rule({ on: 'attacked', notify: false })])).toBeNull();
    // A row that claims it but is switched off claims nothing.
    expect(raisable(notice, [rule({ on: 'attacked', notify: true, enabled: false })])).toBeNull();
  });

  it('lets a row ask to be raised while the window is in front', () => {
    const notice = said({
      channel: 'combat',
      watch: 'attacked',
      event: 'attacked',
      desktop: 'attacked'
    });
    expect(raisableWhileFocused(notice)).toBe(false);
    expect(
      raisableWhileFocused(notice, [rule({ on: 'attacked', notify: true, whileFocused: true })])
    ).toBe(true);
    // `whileFocused` means nothing on a row that does not notify at all.
    expect(
      raisableWhileFocused(notice, [rule({ on: 'attacked', notify: false, whileFocused: true })])
    ).toBe(false);
  });
});

/*
 * The player's own numeric watches (todo 29).
 *
 * Their figure, their direction — and still a crossing rather than a value,
 * for the reason `vitalNotices` watches edges: a notice per status line while
 * standing at 20% health hides the crossing that mattered.
 */
describe('a figure the player chose', () => {
  const watch = (over: Partial<AlertRule> & { on: AlertRule['on'] }): AlertRule => ({
    enabled: true,
    level: null,
    alert: true,
    notify: false,
    whileFocused: false,
    side: 'below',
    value: 0,
    percent: true,
    name: '',
    quietSeconds: 0,
    ...over
  });

  it('fires when health crosses the share it was given', () => {
    const raised = watchNotices(
      withVitals(70, 100),
      withVitals(50, 100),
      [watch({ on: 'health', side: 'below', value: 60 })],
      t
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.watch).toBe('health');
  });

  /* And not again while it stays there: the crossing is the fact. */
  it('does not fire again while it stays below', () => {
    const rules = [watch({ on: 'health', side: 'below', value: 60 })];
    expect(watchNotices(withVitals(50, 100), withVitals(40, 100), rules, t)).toEqual([]);
  });

  /* Upward too, which the client's own levels deliberately never do. */
  it('fires on the way back up where the row asked for above', () => {
    const raised = watchNotices(
      withVitals(50, 100),
      withVitals(90, 100),
      [watch({ on: 'health', side: 'above', value: 80 })],
      t
    );
    expect(raised).toHaveLength(1);
  });

  /* An absolute figure, which is the other thing a player says. */
  it('takes a figure rather than a share', () => {
    const raised = watchNotices(
      withVitals(150, 500),
      withVitals(80, 500),
      [watch({ on: 'health', side: 'below', value: 100, percent: false })],
      t
    );
    expect(raised).toHaveLength(1);
  });

  /* Unknown never alarms — the rule every threshold in this client follows. */
  it('crosses nothing while a figure or a maximum is unread', () => {
    const rules = [watch({ on: 'health', side: 'below', value: 60 })];
    expect(watchNotices(withVitals(70, 100), withVitals(null, 100), rules, t)).toEqual([]);
    expect(watchNotices(withVitals(70, null), withVitals(50, null), rules, t)).toEqual([]);
  });

  it('ignores a row that is turned off', () => {
    const raised = watchNotices(
      withVitals(70, 100),
      withVitals(50, 100),
      [watch({ on: 'health', side: 'below', value: 60, enabled: false })],
      t
    );
    expect(raised).toEqual([]);
  });
});

/*
 * The player's own named watches (todo 29): an item, and a person.
 *
 * Beside the finds settings rather than inside them: those are about what a
 * *search* turned up, and these are anything of this name however it arrived.
 */
describe('a name the player is waiting for', () => {
  const watch = (over: Partial<AlertRule> & { on: AlertRule['on'] }): AlertRule => ({
    enabled: true,
    level: null,
    alert: true,
    notify: false,
    whileFocused: false,
    side: 'below',
    value: 0,
    percent: true,
    name: '',
    quietSeconds: 0,
    ...over
  });

  const withRoom = (over: Partial<CharacterState['room']>, at = 2000): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: { ...EMPTY_CHARACTER.room, ...over },
    updatedAt: at
  });

  it('says so when the item turns up on the floor', () => {
    const raised = namedNotices(
      withRoom({ items: [] }),
      withRoom({ items: [{ name: 'a gold jeweled ring' }] as never }),
      [watch({ on: 'item-found', name: 'jeweled ring' })],
      t
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.watch).toBe('item');
  });

  /* And not again while it lies there: what appeared is the fact. */
  it('does not say so again while it is still there', () => {
    const room = { items: [{ name: 'a gold jeweled ring' }] as never };
    expect(
      namedNotices(withRoom(room), withRoom(room), [watch({ on: 'item-found', name: 'ring' })], t)
    ).toEqual([]);
  });

  it('says so when the person walks in', () => {
    const raised = namedNotices(
      withRoom({ occupants: [] }),
      withRoom({ occupants: [{ name: 'Rend' }] as never }),
      [watch({ on: 'player-seen', name: 'rend' })],
      t
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.channel).toBe('presence');
  });

  /* A row with no name is inert rather than firing on everything. */
  it('does nothing for a row that names nothing', () => {
    expect(
      namedNotices(
        withRoom({ items: [] }),
        withRoom({ items: [{ name: 'a rusty dagger' }] as never }),
        [watch({ on: 'item-found', name: '  ' })],
        t
      )
    ).toEqual([]);
  });

  /*
   * And what a search turned up, which was `ui.alerts.finds.items` until the
   * rows became the only place alerts are set (todo 02). A player waiting for a
   * gold ring does not care which of the realm's two lists it landed on.
   */
  it('says so when a search turns the item up', () => {
    const raised = namedNotices(
      withRoom({ hidden: [] }),
      withRoom({ hidden: [{ name: 'a gold jeweled ring' }] as never }),
      [watch({ on: 'item-found', name: 'jeweled ring' })],
      t
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.watch).toBe('item');
  });

  /* One find, not two, for a realm that lists it on both. */
  it('says so once for an item on both lists', () => {
    const there = [{ name: 'a gold jeweled ring' }] as never;
    const raised = namedNotices(
      withRoom({ items: [], hidden: [] }),
      withRoom({ items: there, hidden: there }),
      [watch({ on: 'item-found', name: 'ring' })],
      t
    );
    expect(raised).toHaveLength(1);
  });

  /* The cash watch: a figure in copper, one-sided, and only on a fresh pile. */
  it('says so when a search turns up cash worth the figure', () => {
    const pile = { totalCopper: 5000, rawText: '5000 copper' } as never;
    const raised = namedNotices(
      withRoom({ hiddenCash: null }),
      withRoom({ hiddenCash: pile }),
      [watch({ on: 'cash-found', value: 4000 })],
      t
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.watch).toBe('cash');
    expect(raised[0]?.channel).toBe('items');
  });

  it('stays quiet for a pile under the figure, and for the same pile again', () => {
    const pile = { totalCopper: 500, rawText: '500 copper' } as never;
    expect(
      namedNotices(
        withRoom({ hiddenCash: null }),
        withRoom({ hiddenCash: pile }),
        [watch({ on: 'cash-found', value: 4000 })],
        t
      )
    ).toEqual([]);
    const big = { totalCopper: 9000, rawText: '9000 copper' } as never;
    expect(
      namedNotices(
        withRoom({ hiddenCash: big }),
        withRoom({ hiddenCash: big }),
        [watch({ on: 'cash-found', value: 4000 })],
        t
      )
    ).toEqual([]);
  });

  /* A figure of nothing is a row somebody has not finished. */
  it('does nothing for a cash row with no figure', () => {
    expect(
      namedNotices(
        withRoom({ hiddenCash: null }),
        withRoom({ hiddenCash: { totalCopper: 9000, rawText: '9000' } as never }),
        [watch({ on: 'cash-found', value: 0 })],
        t
      )
    ).toEqual([]);
  });
});

/*
 * A row stays quiet for a while after it fires (todo 03).
 *
 * The case is an event the realm repeats -- a refused attack every round, a
 * search in a dead end -- where the first is the whole of the news and the
 * next twenty are the terminal again with a border round it.
 */
describe('the quiet time after a row fires', () => {
  const rule = (over: Partial<AlertRule> & { on: AlertRule['on'] }): AlertRule => ({
    enabled: true,
    level: null,
    alert: true,
    notify: false,
    whileFocused: false,
    side: 'below',
    value: 0,
    percent: false,
    name: '',
    quietSeconds: 30,
    ...over
  });
  const said = (at: number): Notice => ({
    id: `n${at}`,
    at,
    severity: 'info',
    channel: 'combat',
    event: 'died',
    text: 'you died'
  });

  it('shows the first and swallows one that follows too soon', () => {
    const quiet = alertQuiet();
    const rules = [rule({ on: 'died' })];
    expect(wanted({ rules }, [said(0)], quiet)).toHaveLength(1);
    expect(wanted({ rules }, [said(1_000)], quiet)).toHaveLength(0);
  });

  it('shows one again once the quiet time has passed', () => {
    const quiet = alertQuiet();
    const rules = [rule({ on: 'died' })];
    expect(wanted({ rules }, [said(0)], quiet)).toHaveLength(1);
    expect(wanted({ rules }, [said(30_000)], quiet)).toHaveLength(1);
  });

  /* 0 is off, which is what the client did before the setting existed. */
  it('shows every occurrence where the row asks for no quiet time', () => {
    const quiet = alertQuiet();
    const rules = [rule({ on: 'died', quietSeconds: 0 })];
    expect(wanted({ rules }, [said(0)], quiet)).toHaveLength(1);
    expect(wanted({ rules }, [said(1)], quiet)).toHaveLength(1);
  });

  /*
   * Two rows on one event at two figures are two clocks -- which is what makes
   * *warn me at 35% and again at 15%* work at all.
   *
   * The clock is keyed on what the row **says**, not on its place in the list:
   * `ruleFor` hands every notice for an event to the first row that claims it,
   * so keying on position gave both rows index 0's clock and the second
   * warning was swallowed. Driven through `watchNotices`, which is the path
   * that actually produces these, because the bug was invisible from `wanted`
   * alone -- a hand-built notice can name any row, and the real one cannot.
   */
  it('warns at both figures when two rows watch one vital', () => {
    const quiet = alertQuiet();
    const rules = [
      rule({ on: 'health', value: 35, percent: true, quietSeconds: 30 }),
      rule({ on: 'health', value: 15, percent: true, quietSeconds: 30 })
    ];
    // `updatedAt` is what `noticedAt` reads, and the notice's moment is what
    // the debounce measures against.
    const at = (hp: number, moment: number): CharacterState => ({
      ...EMPTY_CHARACTER,
      updatedAt: moment,
      vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 100 }
    });
    const first = wanted({ rules }, watchNotices(at(50, 0), at(30, 0), rules, t), quiet);
    expect(first).toHaveLength(1);
    // Five seconds later, well inside both rows' quiet time, and through the
    // lower figure: a different row, so a different clock.
    const second = wanted({ rules }, watchNotices(at(30, 5_000), at(10, 5_000), rules, t), quiet);
    expect(second).toHaveLength(1);
  });

  /* And the same row twice really is the same clock. */
  it('keeps one clock for one row', () => {
    const quiet = alertQuiet();
    const rules = [rule({ on: 'died' })];
    expect(wanted({ rules }, [said(0)], quiet)).toHaveLength(1);
    expect(wanted({ rules }, [said(1_000)], quiet)).toHaveLength(0);
  });

  /* Turning a row's level up is not a reason to give it a fresh clock: the
     switches say what a row does when it fires, not what it is about. */
  it('keeps a row’s clock when only what it does changes', () => {
    const quiet = alertQuiet();
    expect(wanted({ rules: [rule({ on: 'died' })] }, [said(0)], quiet)).toHaveLength(1);
    const louder = [rule({ on: 'died', level: 'critical', notify: true })];
    expect(wanted({ rules: louder }, [said(1_000)], quiet)).toHaveLength(0);
  });

  /*
   * A resting row still claims: the debounce silences an event, it does not
   * hand it to the row below, which would make a quiet row a way of promoting
   * the next one.
   */
  it('does not hand a silenced notice to the row beneath it', () => {
    const quiet = alertQuiet();
    const rules = [rule({ on: 'died' }), rule({ on: 'died', level: 'critical' })];
    expect(wanted({ rules }, [said(0)], quiet)).toHaveLength(1);
    expect(wanted({ rules }, [said(1_000)], quiet)).toEqual([]);
  });

  /* No clock handed in is the old behaviour exactly, which keeps every other
     caller and every other test in this file measuring the ranking alone. */
  it('debounces nothing when no clock is handed in', () => {
    const rules = [rule({ on: 'died' })];
    expect(wanted({ rules }, [said(0)])).toHaveLength(1);
    expect(wanted({ rules }, [said(1)])).toHaveLength(1);
  });
});
