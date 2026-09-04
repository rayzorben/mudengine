import { describe, expect, it } from 'vitest';

import { ago, isKnownPlayer, knownPlayerNames, place } from '../players';
import type { PlayerRecord } from '@shared/players';
import { EMPTY_CHARACTER } from '@shared/character';

const NOW = 1_700_000_000_000;

/** A sighting and nothing else, which is what most records are. */
function seen(fields: Partial<PlayerRecord> = {}): PlayerRecord {
  return {
    name: 'Meia',
    alignment: null,
    title: null,
    flags: null,
    gang: null,
    level: null,
    race: null,
    className: null,
    gangRank: null,
    equipment: null,
    equipmentAt: null,
    lastRoom: null,
    lastRoomName: null,
    lastRoomAt: NOW,
    lastSeen: NOW,
    online: true,
    vitals: null,
    vitalsAt: null,
    inParty: false,
    commandsSent: 0,
    lastCommand: null,
    lastCommandAt: null,
    ...fields
  };
}

/*
 * Coarse on purpose: the registry timestamps a *sighting*, not a position, and
 * a phrase precise to the second invites a reader to believe the client knows
 * where somebody is now.
 */
describe('how long ago somebody was seen', () => {
  it('says just now only for the first ten seconds', () => {
    expect(ago(NOW, NOW)).toBe('just now');
    expect(ago(NOW - 9_000, NOW)).toBe('just now');
  });

  /*
   * The grain the first minute used to lack. `just now` covered forty-five
   * seconds, which is most of the stretch in which the difference between five
   * seconds and fifty decides whether following somebody is worth trying.
   */
  it('counts the rest of the minute in tens of seconds', () => {
    expect(ago(NOW - 10_000, NOW)).toBe('10s ago');
    expect(ago(NOW - 45_000, NOW)).toBe('40s ago');
    expect(ago(NOW - 59_000, NOW)).toBe('50s ago');
  });

  /*
   * Rounding to the nearest ten would say `60s ago` here — a phrase this scale
   * does not have, and one that reads as a minute spelled wrong.
   */
  it('never says sixty seconds', () => {
    expect(ago(NOW - 55_000, NOW)).toBe('50s ago');
    expect(ago(NOW - 60_000, NOW)).toBe('1m ago');
  });

  it('counts minutes from the minute to the hour', () => {
    expect(ago(NOW - 90_000, NOW)).toBe('1m ago');
    expect(ago(NOW - 30 * 60_000, NOW)).toBe('30m ago');
    expect(ago(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('counts hours, then days, and stops at days', () => {
    expect(ago(NOW - 90 * 60_000, NOW)).toBe('1h ago');
    expect(ago(NOW - 23 * 3_600_000, NOW)).toBe('23h ago');
    // Floored: 30 hours is yesterday morning, and `1d ago` is the honest half
    // of that. Rounding would call it two days.
    expect(ago(NOW - 30 * 3_600_000, NOW)).toBe('1d ago');
    expect(ago(NOW - 400 * 24 * 3_600_000, NOW)).toBe('400d ago');
  });

  /*
   * A record can carry a stamp from a moment fractionally ahead of the state
   * push that draws it. "In 2 seconds" about a sighting is the readout claiming
   * something impossible, so the clamp says the plainly true thing instead.
   */
  it('never claims somebody was seen in the future', () => {
    expect(ago(NOW + 5_000, NOW)).toBe('just now');
  });
});

describe('where somebody was', () => {
  it('prefers the name the room had at the time, because a number names nothing', () => {
    expect(place(seen({ lastRoom: 1124, lastRoomName: 'Town Square' }))).toBe('Town Square');
  });

  it('says a number as a number when there is no name for it', () => {
    expect(place(seen({ lastRoom: 1124 }))).toBe('room 1124');
  });

  /*
   * A telepath reaches across the realm and says nothing about where its sender
   * is standing. Somebody known only from one is a name with no place, and the
   * card admits it rather than filling one in.
   */
  it('admits it when the only sightings carried no place at all', () => {
    expect(place(seen({ lastRoomAt: null }))).toBe('not seen in a room');
  });

  /*
   * A pitch-black room has occupants and no name or number. Somebody seen in
   * one was seen in a room, at a time the card states — so the place row must
   * not deny the sighting the row above it reports.
   */
  it('says a placed sighting was placed even when the room could not be', () => {
    expect(place(seen({ lastRoomAt: NOW }))).toBe('a room the client could not place');
  });
});

describe('the people a character knows', () => {
  /* Offline people included: a name seen an hour ago is still a name the
     console should recognise when it is printed again. */
  it('is the registry and the roster, minus the character itself, sorted', () => {
    const names = knownPlayerNames({
      ...EMPTY_CHARACTER,
      name: 'vaelor',
      online: [
        {
          name: 'Vaelor',
          alignment: null,
          title: null,
          flags: null,
          gang: null,
          provisional: false
        },
        { name: 'Rand', alignment: null, title: null, flags: null, gang: null, provisional: false }
      ],
      players: {
        soul: seen({ name: 'Soul', online: false }),
        rand: seen({ name: 'Rand' })
      }
    });
    expect(names).toEqual(['Rand', 'Soul']);
  });
});

describe('whether a name on a card is a person', () => {
  const character = {
    ...EMPTY_CHARACTER,
    online: [
      { name: 'Rand', alignment: null, title: null, flags: null, gang: null, provisional: true }
    ],
    players: { soul: seen({ name: 'Soul', online: false }) }
  };

  it('is, for the roster and for the registry, whatever the case', () => {
    expect(isKnownPlayer(character, 'rand')).toBe(true);
    expect(isKnownPlayer(character, 'SOUL')).toBe(true);
  });

  /* A stranger is not a person here: the realm's answer says it knows nothing,
     which is the honest thing to open, and never that they are safe. */
  it('is not, for a name nobody has listed', () => {
    expect(isKnownPlayer(character, 'orc rogue')).toBe(false);
    expect(isKnownPlayer(character, 'Nathaniel')).toBe(false);
    expect(isKnownPlayer(character, '')).toBe(false);
  });
});
