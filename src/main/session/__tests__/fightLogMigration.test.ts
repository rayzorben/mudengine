import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { segmentFightLogs } from '../fightLogMigration';
import { FightLog } from '../FightLog';
import { foldFile, readFights, segmentFile, segmentsIn } from '../fightSegments';
import type { FightRecord } from '../../../shared/fights';

let fights: string;
let notes: string[];
const note = (message: string): void => {
  notes.push(message);
};

const fight = (mob: string, at = 1): FightRecord =>
  ({
    at,
    ms: 1000,
    mob,
    killed: true,
    mine: 10,
    others: 0,
    blows: 2,
    opened: true,
    level: 3
  }) as FightRecord;

/** An old one-file log: one gzip member per batch, as the old flush wrote it. */
const oldLog = (id: string, ...batches: string[][]): string => {
  const file = path.join(fights, `${id}.jsonl.gz`);
  fs.mkdirSync(fights, { recursive: true });
  for (const batch of batches) {
    const lines = batch.map((mob) => `${JSON.stringify(fight(mob))}\n`).join('');
    fs.appendFileSync(file, zlib.gzipSync(Buffer.from(lines)));
  }
  return file;
};

const oldLogMore = (file: string, batch: string[]): void => {
  const lines = batch.map((mob) => `${JSON.stringify(fight(mob))}\n`).join('');
  fs.appendFileSync(file, zlib.gzipSync(Buffer.from(lines)));
};

const mobs = (id: string): string[] => readFights(path.join(fights, id)).map((each) => each.mob);

beforeEach(() => {
  fights = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-split-')), 'fights');
  notes = [];
});

afterEach(() => {
  fs.rmSync(path.dirname(fights), { recursive: true, force: true });
});

describe('splitting an old fight log into segments', () => {
  it('writes full segments with their folds, keeps a copy, and says so', async () => {
    const old = oldLog('festus', ['a', 'b', 'c'], ['d', 'e']);
    const bytes = fs.readFileSync(old);
    await segmentFightLogs(fights, 2, note);

    const dir = path.join(fights, 'festus');
    expect(segmentsIn(dir)).toEqual([1, 2, 3]);
    expect(mobs('festus')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fs.existsSync(foldFile(dir, 1))).toBe(true);
    expect(fs.existsSync(foldFile(dir, 2))).toBe(true);
    // The last is the open one: a log appends to it and folds it on reading.
    expect(fs.existsSync(foldFile(dir, 3))).toBe(false);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(`${old}.bak`)).toEqual(bytes);
    expect(notes).toHaveLength(1);
    // And a log reads it whole.
    expect((await new FightLog(dir).summary('c'))?.fights).toBe(1);
  });

  it('leaves out, and counts, a line that is not a fight', async () => {
    const old = oldLog('festus', ['a']);
    fs.appendFileSync(old, zlib.gzipSync(Buffer.from('{"mob":"no figures"}\nnot json\n')));
    oldLogMore(old, ['b']);
    await segmentFightLogs(fights, 10, note);
    expect(mobs('festus')).toEqual(['a', 'b']);
    // Split, and the two lines that were not fights.
    expect(notes).toHaveLength(2);
  });

  it('does nothing the second time', async () => {
    oldLog('festus', ['a']);
    await segmentFightLogs(fights, 2, note);
    await segmentFightLogs(fights, 2, note);
    expect(notes).toHaveLength(1);
    expect(mobs('festus')).toEqual(['a']);
  });

  it('keeps every fight before a truncated last member', async () => {
    const old = oldLog('festus', ['a', 'b']);
    fs.appendFileSync(old, zlib.gzipSync(Buffer.from('{"mob":"c"}\n')).subarray(0, 12));
    await segmentFightLogs(fights, 10, note);
    expect(mobs('festus')).toEqual(['a', 'b']);
  });

  it('places segments a stopped run had finished', async () => {
    const old = oldLog('festus', ['a', 'b', 'c']);
    // A run that stopped after the old file went: the built segments are complete.
    await segmentFightLogs(fights, 2, note);
    const dir = path.join(fights, 'festus');
    fs.renameSync(dir, path.join(fights, '.festus.segmenting'));
    expect(fs.existsSync(old)).toBe(false);
    await segmentFightLogs(fights, 2, note);
    expect(mobs('festus')).toEqual(['a', 'b', 'c']);
    expect(fs.existsSync(path.join(fights, '.festus.segmenting'))).toBe(false);
  });

  it('puts fights written while it ran after the old ones', async () => {
    oldLog('festus', ['a', 'b', 'c']);
    // A quit during the split writes into the record's directory.
    const quit = new FightLog(path.join(fights, 'festus'));
    quit.record(fight('late'));
    quit.dispose();
    await segmentFightLogs(fights, 2, note);
    expect(mobs('festus')).toEqual(['a', 'b', 'c', 'late']);
    expect(segmentsIn(path.join(fights, 'festus'))).toEqual([1, 2, 3]);
    expect(fs.existsSync(segmentFile(path.join(fights, 'festus'), 3))).toBe(true);
  });

  it('leaves a log it cannot split where it is, and says so', async () => {
    const old = oldLog('festus', ['a']);
    // A file where the record's directory has to go.
    fs.writeFileSync(path.join(fights, 'festus'), 'in the way');
    await segmentFightLogs(fights, 2, note);
    expect(notes).toHaveLength(1);
    expect(fs.readFileSync(path.join(fights, 'festus'), 'utf8')).toBe('in the way');
    // The built segments wait for the next launch; the copy is kept.
    expect(fs.existsSync(`${old}.bak`)).toBe(true);
  });
});
