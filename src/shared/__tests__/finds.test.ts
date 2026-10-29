import { describe, expect, it } from 'vitest';

import {
  alertsFor,
  byNewest,
  byRarest,
  findKey,
  findRate,
  isCash,
  roomsWithFinds,
  within,
  type Find
} from '../finds';

const DAY = 86_400_000;
const NOW = 1_757_000_000_000;

function find(over: Partial<Find> = {}): Find {
  return {
    room: '1/2150',
    roomName: 'Bank of Godfrey',
    name: 'rusty key',
    quantity: null,
    copper: null,
    coins: null,
    at: NOW,
    seen: 1,
    hits: 1,
    searched: 1,
    rarity: { rarity: 'common', hours: 0.02 },
    ...over
  };
}

describe('a find is one thing in one room', () => {
  it('keys on the pair, case- and space-insensitively', () => {
    expect(findKey(find())).toBe(findKey(find({ name: '  Rusty Key ' })));
    // The same thing in another room is another find: where is half the fact.
    expect(findKey(find())).not.toBe(findKey(find({ room: '1/2151' })));
  });

  it('tells money from a thing by whether it is worth anything', () => {
    expect(isCash(find())).toBe(false);
    // Zero copper is still money: a purse the server counted as nothing is a
    // count, and `null` is the absence.
    expect(isCash(find({ copper: 0 }))).toBe(true);
  });
});

describe('the window on the log', () => {
  it('is newest first among equally rare rows', () => {
    const rows = within([find({ at: NOW - DAY }), find({ room: '1/2', at: NOW })], 0, NOW);
    expect(rows.map((row) => row.at)).toEqual([NOW, NOW - DAY]);
  });

  it('is rarest in the realm first, and cash goes last', () => {
    const cash = find({ name: 'coins', copper: 40, rarity: null, at: NOW + 1 });
    const rare = find({ name: 'rusty key', rarity: { rarity: 'rare', hours: 30 }, at: NOW - DAY });
    const common = find({ name: 'sash', hits: 0, searched: 0 });
    const rows = within([cash, common, rare], 0, NOW);
    expect(rows.map((row) => row.name)).toEqual(['rusty key', 'sash', 'coins']);
  });

  it('keeps everything at zero days, which is the shipped answer', () => {
    const old = find({ at: NOW - 400 * DAY });
    expect(within([old], 0, NOW)).toEqual([old]);
  });

  it('drops what fell out of the window, and only that', () => {
    const recent = find({ room: '1/1', at: NOW - 2 * DAY });
    const ancient = find({ room: '1/2', at: NOW - 40 * DAY });
    expect(within([recent, ancient], 7, NOW)).toEqual([recent]);
  });

  it('is a window and not a purge — the rows it hid are still there', () => {
    const rows = [find({ room: '1/1', at: NOW - 40 * DAY })];
    expect(within(rows, 7, NOW)).toEqual([]);
    // Turning the number back up brings it back, which is the whole reason a
    // view preference is allowed to own this.
    expect(within(rows, 90, NOW)).toEqual(rows);
  });

  it('sorts by the stamp, never by the words', () => {
    expect(byNewest(find({ at: 2 }), find({ at: 1 }))).toBeLessThan(0);
  });
});

describe('how often a search turns it up', () => {
  it("is the room's counted searches that found it", () => {
    expect(findRate(find({ hits: 1, searched: 20 }))).toBe(0.05);
  });

  it('is unknown, not zero, before the room has a counted search', () => {
    // A row written before searches were counted: nine finds and no misses on
    // record, which is no rate at all rather than a perfect one.
    expect(findRate(find({ seen: 9, hits: 0, searched: 0 }))).toBeNull();
  });
});

describe('rarest first', () => {
  // The user, 2026-10-29: silk gloves turned up once in about seventy searches
  // and read 1.4%, though a seamstress restocks them every minute.
  const gloves = find({ name: 'silk gloves', hits: 1, searched: 70 });
  const ring = find({ name: 'ring', hits: 9, searched: 10, rarity: { rarity: 'rare', hours: 60 } });

  it("goes by the realm's rarity, never by how often the room turned it up", () => {
    expect(byRarest(ring, gloves)).toBeLessThan(0);
  });

  it('goes by the hours within a band', () => {
    const slower = find({ name: 'amulet', rarity: { rarity: 'rare', hours: 90 } });
    expect(byRarest(slower, ring)).toBeLessThan(0);
  });

  it('puts a quest reward with no hours above the timed rares', () => {
    const reward = find({ name: 'token', rarity: { rarity: 'rare', hours: null } });
    expect(byRarest(reward, ring)).toBeLessThan(0);
  });

  it('puts unknown below every band and cash below unknown', () => {
    const unknown = find({ name: 'odd thing', rarity: { rarity: 'unknown', hours: null } });
    const cash = find({ name: '4 copper farthings', copper: 4, rarity: null });
    expect(byRarest(gloves, unknown)).toBeLessThan(0);
    expect(byRarest(unknown, cash)).toBeLessThan(0);
  });
});

describe('the rooms a log names', () => {
  it('is a set, so the map asks once per drawn room', () => {
    const rooms = roomsWithFinds([find({ room: '1/1' }), find({ room: '1/1', name: 'ring' })]);
    expect([...rooms]).toEqual(['1/1']);
  });
});

describe('what is worth interrupting for', () => {
  it('matches a word anywhere in the name, whatever the case', () => {
    expect(alertsFor(find({ name: 'a rusty key' }), ['key'], 0)).toBe('item');
    expect(alertsFor(find({ name: 'Bone Keys' }), ['KEY'], 0)).toBe('item');
  });

  it('says nothing about a thing nobody asked about', () => {
    expect(alertsFor(find({ name: 'a rusty key' }), ['ring'], 0)).toBeNull();
    expect(alertsFor(find({ name: 'a rusty key' }), [], 0)).toBeNull();
  });

  it('ignores an empty word, which would otherwise match everything', () => {
    expect(alertsFor(find(), ['   '], 0)).toBeNull();
  });

  it('answers about money with the figure, never with the words', () => {
    const cash = find({ name: '4 copper farthings', copper: 4 });
    // The watch list is about things; money has its own question.
    expect(alertsFor(cash, ['copper'], 0)).toBeNull();
    expect(alertsFor(cash, [], 4)).toBe('cash');
    expect(alertsFor(cash, [], 5)).toBeNull();
  });

  it('never alerts on money at zero, which is the off position', () => {
    expect(alertsFor(find({ copper: 0 }), [], 0)).toBeNull();
    expect(alertsFor(find({ copper: 1_000_000 }), [], 0)).toBeNull();
  });
});
