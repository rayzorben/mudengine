import { describe, expect, it } from 'vitest';

import { alertsFor, byNewest, findKey, isCash, roomsWithFinds, within, type Find } from '../finds';

const DAY = 86_400_000;
const NOW = 1_757_000_000_000;

function find(over: Partial<Find> = {}): Find {
  return {
    room: '1/2150',
    roomName: 'Bank of Godfrey',
    name: 'rusty key',
    quantity: null,
    copper: null,
    at: NOW,
    seen: 1,
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
  it('is newest first', () => {
    const rows = within([find({ at: NOW - DAY }), find({ room: '1/2', at: NOW })], 0, NOW);
    expect(rows.map((row) => row.at)).toEqual([NOW, NOW - DAY]);
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
