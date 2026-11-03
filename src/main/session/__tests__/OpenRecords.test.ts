import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_TALLY, type CombatTally } from '../../../shared/tally';
import { Belongings } from '../Belongings';
import { OpenRecords, type ClosingRecord } from '../OpenRecords';

const REALM = 'orohost:2427';

class Fake implements ClosingRecord {
  closes = 0;
  constructor(readonly realm: string) {}
  close(): void {
    this.closes += 1;
  }
}

describe('the records open per character', () => {
  it('keeps one record per realm and closes the old one on a dial elsewhere', () => {
    const records = new OpenRecords<Fake>('belongings');
    const first = records.at('vaelor', REALM, () => new Fake(REALM));
    expect(records.at('vaelor', REALM, () => new Fake(REALM))).toBe(first);
    const second = records.at('vaelor', 'paramud:23', () => new Fake('paramud:23'));
    expect(first.closes).toBe(1);
    expect(records.get('vaelor')).toBe(second);
  });

  it('closes and drops a record when its tab is closed', () => {
    const records = new OpenRecords<Fake>('belongings');
    const record = records.at('vaelor', REALM, () => new Fake(REALM));
    records.release('vaelor');
    expect(record.closes).toBe(1);
    expect(records.get('vaelor')).toBeUndefined();
    records.release('vaelor');
    expect(record.closes).toBe(1);
  });

  it('closes every record at quit, past one that throws', () => {
    const records = new OpenRecords<Fake>('belongings');
    const broken = records.at('a', REALM, () => new Fake(REALM));
    broken.close = () => {
      throw new Error('disk full');
    };
    const fine = records.at('b', REALM, () => new Fake(REALM));
    const failed: string[] = [];
    records.releaseAll((what, step) => {
      try {
        step();
      } catch {
        failed.push(what);
      }
    });
    expect(failed).toEqual(['belongings a']);
    expect(fine.closes).toBe(1);
    expect(records.get('a')).toBeUndefined();
    expect(records.get('b')).toBeUndefined();
  });
});

describe('a connected character whose tab is closed', () => {
  let dir = '';
  let file = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-open-records-'));
    file = path.join(dir, 'belongings', 'vaelor.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('has its online clock settled when its tab is closed', () => {
    const records = new OpenRecords<Belongings>('belongings');
    const record = records.at('vaelor', REALM, () => new Belongings({ file, realm: REALM }));
    const tally: CombatTally = { ...NO_TALLY, onlineMs: 4_000, onlineSince: 5_000 };
    record.rememberStats(tally);
    const before = Date.now();

    records.release('vaelor');

    const back = new Belongings({ file, realm: REALM }).recallStats();
    expect(back?.tally.onlineSince).toBeNull();
    expect(back?.tally.onlineMs).toBeGreaterThanOrEqual(4_000 + (before - 5_000));
  });
});
