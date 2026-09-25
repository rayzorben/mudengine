import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import {
  newPlayer,
  NO_REALM_PLAYERS,
  toFacts,
  type PlayerFacts,
  type RealmPlayers
} from '../../../shared/players';
import { blockOf } from '../../../shared/__tests__/blocks';
import { CharacterTracker } from '../CharacterTracker';
import { Company } from '../company';

/*
 * The order company reaches out in, and when it lets go of what it holds
 * (todo 700: *order is a decision*). The tracker's tests drive whole blocks
 * and assert the state and the registry that come out, so they cannot see
 * whether a kit taught its slots before the pack remembered them, or what
 * reached the realm's book on the block that walked out to the menu; and a
 * replay of a whole session never resets, leaves or walks to the menu in the
 * middle of one. So these hand `Company` sources that write down each reach
 * into them, and hand the forgetting to a real tracker.
 */

const T = 1_700_000_000_000;

/** A book that recalls `known` and writes down every record it is told, by name. */
function bookOf(known: readonly PlayerFacts[] = []): { told: string[]; book: RealmPlayers } {
  const told: string[] = [];
  return {
    told,
    book: { ...NO_REALM_PLAYERS, recall: () => known, remember: (facts) => told.push(facts.name) }
  };
}

/** A company whose every reach into its sources is logged, in order. */
function rig(
  inGame = true,
  { told, book } = bookOf()
): { log: string[]; told: string[]; company: Company } {
  const log: string[] = [];
  const company = new Company(book, {
    inGame: () => inGame,
    teachSlot: (item, slot) => log.push(`teach ${item} ${slot}`),
    rememberSlot: (item, slot) => log.push(`remember ${item} ${slot}`)
  });
  return { log, told, company };
}

/** In the realm as Vaelor. */
const vaelor = (): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  phase: 'in-game',
  name: 'Vaelor'
});

const KIT = [
  { item: 'silver ring', slot: 'Finger' },
  { item: '<empty>', slot: 'Head' },
  { item: 'torch', slot: 'Readied/79' }
];

describe('the order a kit reaches out in', () => {
  it('teaches every slot a look at somebody else names, then files the kit against them', () => {
    const { log, company } = rig();
    const s = vaelor();
    company.lookOpened(s, 'Soul', undefined);
    expect(company.equipment(s, KIT, T)).toBeNull();
    expect(log).toEqual(['teach silver ring Finger', 'teach torch Readied']);
    expect(company.players['soul']?.equipment?.map((worn) => worn.name)).toEqual([
      'silver ring',
      'torch'
    ]);
  });

  it('teaches every slot of this character’s own kit before the pack remembers any', () => {
    const { log, company } = rig();
    const s = vaelor();
    company.lookOpened(s, 'vaelor ', undefined);
    const before = company.players;
    const after = company.equipment(s, KIT, T);
    expect(log).toEqual([
      'teach silver ring Finger',
      'teach torch Readied',
      'remember silver ring Finger',
      'remember torch Readied'
    ]);
    expect(after).not.toBeNull();
    expect(company.players).toBe(before);
  });

  it('refuses a kit no look line named, and still teaches its slots', () => {
    const { log, company } = rig();
    const before = company.players;
    expect(company.equipment(vaelor(), KIT, T)).toBeNull();
    expect(log).toEqual(['teach silver ring Finger', 'teach torch Readied']);
    expect(company.players).toBe(before);
  });

  it('files no description of this character, and one of anybody else', () => {
    const { company } = rig();
    const before = company.players;
    company.described(vaelor(), 'Vaelor', 'massive, muscular Nekojin Ranger', T);
    expect(company.players).toBe(before);
    company.described(vaelor(), 'Soul', 'thin, moderately built Human Warrior', T);
    expect(company.players['soul']?.className).toBe('Warrior');
  });
});

describe('what reaches the realm’s book', () => {
  it('tells it a record an @ command moved, from inside the realm only', () => {
    const outside = rig(false);
    expect(outside.company.noteRemoteCall('Soul', '@health', T)).toBe(true);
    expect(outside.told).toEqual([]);
    const inside = rig(true);
    expect(inside.company.noteRemoteCall('Soul', '@health', T)).toBe(true);
    expect(inside.told).toEqual(['Soul']);
  });

  it('tells it nothing when nothing moved', () => {
    const { told, company } = rig();
    const before = company.players;
    company.remember(before);
    expect(told).toEqual([]);
  });

  it('files where another client said it stands as a sighting, and tells the book', () => {
    const { told, company } = rig();
    expect(company.noteRemoteRoom('Soul', 1234, 'Town Square', T)).toBe(true);
    expect(company.players['soul']).toMatchObject({
      lastRoom: 1234,
      lastRoomName: 'Town Square',
      lastRoomAt: T,
      online: true
    });
    expect(told).toEqual(['Soul']);
    // An answer that named no room keeps the name the last one gave.
    company.noteRemoteRoom('Soul', 1235, null, T + 1);
    expect(company.players['soul']?.lastRoomName).toBe('Town Square');
  });

  it('files which client another player runs, and tells the book', () => {
    const { told, company } = rig();
    const facts = { client: 'mudengine 0.7.0', extendedRemotes: 'yes' } as const;
    expect(company.noteRemoteClient('Soul', T, facts)).toBe(true);
    expect(company.players['soul']).toMatchObject({ ...facts, online: true });
    expect(told).toEqual(['Soul']);
  });

  it('seeds from, and tells, the book a new realm hands it, from the next reset on', () => {
    const a = bookOf([toFacts(newPlayer('Nester', T))]);
    const b = bookOf([toFacts(newPlayer('Durnan', T))]);
    const { company } = rig(true, a);
    company.useRealm(b.book);
    expect(Object.keys(company.players)).toEqual(['nester']);
    company.reset();
    expect(Object.keys(company.players)).toEqual(['durnan']);
    company.noteRemoteCall('Soul', '@health', T);
    expect(b.told).toEqual(['Soul']);
    expect(a.told).toEqual([]);
  });

  it('never writes back what another session learned', () => {
    const { told, company } = rig();
    expect(company.absorb([toFacts(newPlayer('Nester', T))])).toBe(true);
    expect(company.absorb([toFacts(newPlayer('Nester', T))])).toBe(false);
    expect(Object.keys(company.players)).toEqual(['nester']);
    expect(told).toEqual([]);
  });
});

describe('when the tracker makes company let go', () => {
  /*
   * A tracker in the realm whose book knows Nester, reading a look at Soul
   * whose kit has not arrived yet — so a look kept through a forgetting would
   * file that kit against Soul, and a registry kept through a reset would
   * still hold Soul, whom the book never recalled.
   */
  const lookingAtSoul = (): { tracker: CharacterTracker; told: string[] } => {
    const { told, book } = bookOf([toFacts(newPlayer('Nester', T))]);
    const tracker = new CharacterTracker(undefined, undefined, undefined, undefined, book);
    tracker.reset();
    tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T));
    tracker.apply(blockOf('player-look', '[ Soul Guardian ]', { name: 'Soul' }, T + 1));
    return { tracker, told };
  };
  const kitArrives = (tracker: CharacterTracker): void => {
    tracker.apply(blockOf('player-equipment', 'He is equipped with:', {}, T + 9), [
      { item: 'silk gloves', slot: 'Hands' }
    ]);
  };

  it('files the kit, and keeps Soul online, while nothing has been forgotten', () => {
    const { tracker } = lookingAtSoul();
    expect(tracker.current.phase).toBe('in-game');
    expect(tracker.players['soul']?.online).toBe(true);
    kitArrives(tracker);
    expect(tracker.players['soul']?.equipment).toEqual([{ name: 'silk gloves', slot: 'Hands' }]);
  });

  it('tells the book what a look described, on the block that described it', () => {
    const { tracker, told } = lookingAtSoul();
    told.length = 0;
    tracker.apply(
      blockOf(
        'player-described',
        'Soul is a thin, moderately built Human Warrior',
        { player: 'Soul', who: 'thin, moderately built Human Warrior' },
        T + 2
      )
    );
    expect(told).toEqual(['Soul']);
  });

  it('at a new connection: reseeded from the book, and the look gone', () => {
    const { tracker } = lookingAtSoul();
    tracker.reset();
    expect(Object.keys(tracker.players)).toEqual(['nester']);
    tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T + 3));
    kitArrives(tracker);
    expect(tracker.players['soul']).toBeUndefined();
  });

  it('when the socket closes: everyone offline, and nobody forgotten', () => {
    const { tracker } = lookingAtSoul();
    tracker.leaveRealm(T + 3);
    expect(tracker.players['soul']?.online).toBe(false);
    expect(Object.keys(tracker.players).sort()).toEqual(['nester', 'soul']);
  });

  it('when a socket closes on a character that was never anywhere: nobody moves', () => {
    const tracker = new CharacterTracker();
    tracker.noteRemoteCall('Soul', '@health', T);
    const before = tracker.players;
    expect(tracker.leaveRealm(T + 1)).toBe(false);
    expect(tracker.players).toBe(before);
    expect(tracker.players['soul']?.online).toBe(true);
  });

  it('when the character walks out to the menu: offline, the look gone, the book told nothing', () => {
    const { tracker, told } = lookingAtSoul();
    told.length = 0;
    tracker.apply(blockOf('prompt-character', 'Please select a character:', {}, T + 3));
    expect(tracker.current.phase).toBe('authenticating');
    expect(tracker.players['soul']?.online).toBe(false);
    expect(told).toEqual([]);
    kitArrives(tracker);
    expect(tracker.players['soul']?.equipment).toBeNull();
  });
});
