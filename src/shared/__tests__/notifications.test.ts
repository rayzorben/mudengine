import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  noticeFor,
  partyNotices,
  roomNotices,
  rosterNotices,
  vitalNotices
} from '../notifications';
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
  return { seq: 1, at: 1000, type, domain: domainOf(type), groups: {}, text, confidence: 0.8 };
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

describe('a vital that has just got worse', () => {
  it('alerts on the crossing into critical', () => {
    const raised = vitalNotices(withVitals(60, 100), withVitals(20, 100), BOUNDS, t);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe('critical');
    expect(raised[0]!.channel).toBe('vitals');
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
