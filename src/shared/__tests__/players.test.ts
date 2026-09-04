import { describe, expect, it } from 'vitest';

import {
  absorbFacts,
  mergeFacts,
  newPlayer,
  NO_PLAYERS,
  observe,
  readFacts,
  toFacts,
  type PlayerFacts
} from '../players';

const facts = (over: Partial<PlayerFacts> = {}): PlayerFacts => ({
  name: 'Soul',
  alignment: null,
  title: null,
  gang: null,
  level: null,
  race: null,
  className: null,
  gangRank: null,
  equipment: null,
  equipmentAt: null,
  lastRoom: null,
  lastRoomName: null,
  lastRoomAt: null,
  lastSeen: 1_000,
  vitals: null,
  vitalsAt: null,
  ...over
});

const GLOVES = [{ name: 'silk gloves', slot: 'Hands' }];
const ROBES = [{ name: 'gilded robes', slot: 'Torso' }];

describe('folding what the realm knows into a record', () => {
  it('returns the record itself when nothing is news', () => {
    const base = facts({ gang: 'Valor', equipment: GLOVES, equipmentAt: 500 });
    expect(mergeFacts(base, facts({ gang: 'Valor', equipment: GLOVES, equipmentAt: 500 }))).toBe(
      base
    );
    // Older, and saying less: nothing to take.
    expect(mergeFacts(base, facts({ lastSeen: 10 }))).toBe(base);
  });

  /*
   * Kit and the time it was seen move together: the later look wins whole,
   * and a list with no time on it is not a sighting at all.
   */
  it('takes the later-stamped kit whole, and never one from nowhen', () => {
    const base = facts({ equipment: GLOVES, equipmentAt: 500 });
    expect(mergeFacts(base, facts({ equipment: ROBES, equipmentAt: 900 }))).toMatchObject({
      equipment: ROBES,
      equipmentAt: 900
    });
    expect(mergeFacts(base, facts({ equipment: ROBES, equipmentAt: 400 }))).toBe(base);
    expect(mergeFacts(base, facts({ equipment: ROBES, equipmentAt: null }))).toBe(base);
    // Wearing nothing is a real answer, and a later one replaces the gloves.
    expect(mergeFacts(base, facts({ equipment: [], equipmentAt: 901 })).equipment).toEqual([]);
  });

  it('moves a room and a quotation by their own clocks', () => {
    const base = facts({
      lastRoom: 1,
      lastRoomName: 'Town Square',
      lastRoomAt: 500,
      vitals: { hp: 10, hpMax: 20, mana: null, manaMax: null },
      vitalsAt: 500
    });
    const merged = mergeFacts(
      base,
      facts({
        lastRoom: 2,
        lastRoomName: 'Docks',
        lastRoomAt: 600,
        vitals: { hp: 1, hpMax: 20, mana: null, manaMax: null },
        vitalsAt: 100
      })
    );
    expect(merged).toMatchObject({ lastRoom: 2, lastRoomName: 'Docks', lastRoomAt: 600 });
    expect(merged.vitals?.hp).toBe(10);
  });

  /* A title changes as somebody levels; between two claims the fresher wins. */
  it('lets the side seen more recently settle a field with no time on it', () => {
    const base = facts({ title: 'Apprentice', lastSeen: 1_000 });
    expect(mergeFacts(base, facts({ title: 'Journeyman', lastSeen: 2_000 })).title).toBe(
      'Journeyman'
    );
    expect(mergeFacts(base, facts({ title: 'Journeyman', lastSeen: 500 })).title).toBe(
      'Apprentice'
    );
  });

  it('never lets null overwrite a fact, however recent the silence', () => {
    const base = facts({ alignment: 'Good', gang: 'Valor', level: 6 });
    expect(mergeFacts(base, facts({ lastSeen: 9_000 }))).toMatchObject({
      alignment: 'Good',
      gang: 'Valor',
      level: 6
    });
    // And an older record still fills what the newer one never heard.
    expect(mergeFacts(facts({ lastSeen: 9_000 }), base).gang).toBe('Valor');
  });

  it('keeps the latest sighting, whichever side had it', () => {
    expect(mergeFacts(facts({ lastSeen: 1 }), facts({ lastSeen: 5 })).lastSeen).toBe(5);
    expect(mergeFacts(facts({ lastSeen: 5 }), facts({ lastSeen: 1 })).lastSeen).toBe(5);
  });

  it('carries a record’s own fields through untouched', () => {
    const record = { ...newPlayer('Soul', 1_000), inParty: true, commandsSent: 3 };
    const merged = mergeFacts(record, facts({ gang: 'Valor', lastSeen: 2_000 }));
    expect(merged.inParty).toBe(true);
    expect(merged.commandsSent).toBe(3);
    expect(merged.online).toBe(true);
  });
});

describe('absorbing a batch into a session', () => {
  /* The book says they exist and what they wore, and nothing about now. */
  it('enters a stranger offline and in no party', () => {
    const players = absorbFacts(NO_PLAYERS, [facts({ equipment: GLOVES, equipmentAt: 500 })]);
    expect(players['soul']).toMatchObject({
      name: 'Soul',
      online: false,
      inParty: false,
      commandsSent: 0,
      equipment: GLOVES
    });
  });

  it('keeps what is this session’s own about somebody it has met', () => {
    const met = observe(NO_PLAYERS, 'Soul', 1_000, { inParty: true, commandsSent: 2 });
    const players = absorbFacts(met, [facts({ gang: 'Valor', lastSeen: 2_000 })]);
    expect(players['soul']).toMatchObject({
      inParty: true,
      commandsSent: 2,
      online: true,
      gang: 'Valor'
    });
  });

  it('returns the same registry when the realm has nothing newer', () => {
    const met = observe(NO_PLAYERS, 'Soul', 1_000, { gang: 'Valor' });
    expect(absorbFacts(met, [facts({ gang: 'Valor', lastSeen: 1_000 })])).toBe(met);
    expect(absorbFacts(met, [facts({ name: '   ' })])).toBe(met);
  });
});

describe('reading a record back from disk', () => {
  it('needs a name and nothing else', () => {
    expect(readFacts({ name: 'Soul' })).toMatchObject({ name: 'Soul', lastSeen: 0, gang: null });
    expect(readFacts({ name: '  ' })).toBeNull();
    expect(readFacts('Soul')).toBeNull();
    expect(readFacts(null)).toBeNull();
  });

  /*
   * `You` is the realm's pronoun, not a name, and a book written before the
   * pattern refused it holds a row for it. Dropped on the way in so the file
   * heals itself on the next save, rather than carrying a player called `You`
   * to every session on the realm for ever.
   */
  it('drops the realm’s pronoun, however it was cased', () => {
    expect(readFacts({ name: 'You' })).toBeNull();
    expect(readFacts({ name: ' you ' })).toBeNull();
    expect(readFacts({ name: 'Youngblood' })).toMatchObject({ name: 'Youngblood' });
  });

  it('drops kit that has no time on it, and junk in the list', () => {
    expect(readFacts({ name: 'Soul', equipment: GLOVES })?.equipment).toBeNull();
    expect(
      readFacts({ name: 'Soul', equipment: [...GLOVES, 'hat', { name: 'ring' }], equipmentAt: 5 })
    ).toMatchObject({ equipment: GLOVES, equipmentAt: 5 });
    // A time with no list behind it is not a sighting either.
    expect(readFacts({ name: 'Soul', equipmentAt: 5 })?.equipmentAt).toBeNull();
  });

  it('refuses an alignment the realm does not have, and a figure that is not one', () => {
    expect(readFacts({ name: 'Soul', alignment: 'Good' })?.alignment).toBe('Good');
    expect(readFacts({ name: 'Soul', alignment: 'Friendly' })?.alignment).toBeNull();
    expect(readFacts({ name: 'Soul', level: 'six', lastRoom: 1.5 })).toMatchObject({
      level: null,
      lastRoom: null
    });
    expect(
      readFacts({ name: 'Soul', vitals: { hp: 10, hpMax: 'lots' }, vitalsAt: 5 })?.vitals
    ).toBeNull();
    expect(readFacts({ name: 'Soul', vitals: { hp: 10, hpMax: 20 }, vitalsAt: 5 })?.vitals).toEqual(
      { hp: 10, hpMax: 20, mana: null, manaMax: null }
    );
  });
});

describe('the facts, out of a record', () => {
  it('leaves the session’s own fields behind', () => {
    const record = { ...newPlayer('Soul', 1_000), inParty: true, commandsSent: 3, flags: 'S' };
    const stripped = toFacts(record);
    expect(stripped).not.toHaveProperty('inParty');
    expect(stripped).not.toHaveProperty('online');
    expect(stripped).not.toHaveProperty('commandsSent');
    expect(stripped).not.toHaveProperty('flags');
    expect(stripped.name).toBe('Soul');
  });
});
