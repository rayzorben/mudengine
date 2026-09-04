import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { FightLog, readFights } from '../FightLog';
import type { FightRecord } from '../../../shared/fights';

let dir: string;
let file: string;

const fight = (over: Partial<FightRecord> = {}): FightRecord => ({
  at: 1_700_000_000_000,
  ms: 4200,
  mob: 'giant rat',
  killed: true,
  mine: 31,
  others: 0,
  blows: 7,
  wound: null,
  opened: true,
  name: 'Vaelor',
  race: 'Kang',
  className: 'Mystic',
  level: 1,
  hp: 30,
  hpMax: 34,
  mana: null,
  manaMax: null,
  martialArts: null,
  magicRes: null,
  alignment: 'Neutral',
  encumbrance: 500,
  encumbranceMax: 3360,
  gear: [{ name: 'quarterstaff', slot: 'Weapon Hand' }],
  room: '1/2150',
  roomName: 'Newhaven, Arena',
  others_here: 0,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-fights-'));
  file = path.join(dir, 'fights', 'main.jsonl.gz');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writing fights down', () => {
  it('writes what it was given, once the timer fires', () => {
    const log = new FightLog(file);
    log.record(fight());
    // Deferred on purpose: the parse path pushes and returns.
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(readFights(file)).toEqual([fight()]);
    log.dispose();
  });

  it('creates the directory it was pointed at', () => {
    const log = new FightLog(file);
    log.record(fight());
    log.flush();
    expect(fs.existsSync(path.dirname(file))).toBe(true);
    log.dispose();
  });

  /*
   * `gzip` members concatenate, which is the whole reason this can append
   * rather than rewrite: a file of many independent members is one valid gzip
   * stream and every tool reads it whole.
   */
  it('appends rather than rewriting, and the file stays one readable stream', () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat' }));
    log.flush();
    const afterFirst = fs.readFileSync(file).length;
    log.record(fight({ mob: 'lashworm' }));
    log.flush();

    expect(fs.readFileSync(file).length).toBeGreaterThan(afterFirst);
    expect(readFights(file).map((entry) => entry.mob)).toEqual(['giant rat', 'lashworm']);
    // And the whole file is still one gzip stream to anything else that reads it.
    expect(
      zlib.gunzipSync(fs.readFileSync(file)).toString().split('\n').filter(Boolean)
    ).toHaveLength(2);
    log.dispose();
  });

  it('batches what arrives together into one member', () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'a' }));
    log.record(fight({ mob: 'b' }));
    log.record(fight({ mob: 'c' }));
    vi.advanceTimersByTime(3000);
    expect(readFights(file).map((entry) => entry.mob)).toEqual(['a', 'b', 'c']);
    log.dispose();
  });

  it('writes what is held when it is disposed, which is what quitting does', () => {
    const log = new FightLog(file);
    log.record(fight());
    log.dispose();
    expect(readFights(file)).toHaveLength(1);
  });

  it('writes nothing at all when nothing happened', () => {
    const log = new FightLog(file);
    log.dispose();
    expect(fs.existsSync(file)).toBe(false);
  });

  /*
   * A statistics file that cannot be written must not cost a character its
   * connection — and must not say so once per fight either.
   */
  it('reports a path it cannot write once, and carries on', () => {
    const said: string[] = [];
    // A *file* where the directory should be, so `mkdir` cannot succeed.
    fs.writeFileSync(path.join(dir, 'blocked'), 'not a directory');
    const log = new FightLog(path.join(dir, 'blocked', 'main.jsonl.gz'), {
      notice: (message) => said.push(message)
    });
    log.record(fight());
    log.flush();
    log.record(fight());
    log.flush();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/could not be written/i);
    log.dispose();
  });

  /* A truncated last member is what a crash leaves. Every record before it
     is still an answer, and returning nothing would throw those away. */
  it('reads back everything before a truncated tail', () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat' }));
    log.flush();
    fs.appendFileSync(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(readFights(file).map((entry) => entry.mob)).toEqual(['giant rat']);
    log.dispose();
  });

  it('says nothing about a file that is not there', () => {
    expect(readFights(path.join(dir, 'nothing.jsonl.gz'))).toEqual([]);
  });
});

describe('what the record says about a monster', () => {
  /* A realm table of three, as `WorldGraph.mobAsPrinted` would answer for it:
     the first name on the ladder the realm knows. */
  const realm = new Set(['giant rat', 'giant rat king', 'rat']);
  const resolve = (printed: string): string => {
    const words = printed.split(' ');
    for (let take = words.length; take >= 1; take -= 1) {
      const candidate = words.slice(words.length - take).join(' ');
      if (realm.has(candidate)) return candidate;
    }
    return printed;
  };
  it('adds up the file and what is still held, across the printed spellings', () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat', mine: 30, blows: 6, killed: true, ms: 4000, at: 1 }));
    log.flush();
    log.record(
      fight({ mob: 'small giant rat', mine: 10, blows: 2, killed: false, ms: null, at: 2 })
    );
    expect(log.summary('giant rat', resolve)).toEqual({
      fights: 2,
      kills: 1,
      meanMine: 20,
      meanBlows: 4,
      meanMs: 4000,
      opened: 2,
      latest: 2
    });
    // Null is no fights, not zero of everything.
    expect(log.summary('cave bear', resolve)).toBeNull();
    // With no realm table at all, a spelling is itself: nothing folds.
    expect(log.summary('giant rat')?.fights).toBe(1);
    log.dispose();
  });

  /* `mobNameCandidates` is an order, and its safety is the caller stopping at
     the first name the realm knows: a rat king the realm names is its own
     monster, and fifty of its fights must not become the rat's. */
  it('keeps a longer monster the realm names out of a shorter one it also names', () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat king', mine: 100, at: 1 }));
    log.record(fight({ mob: 'giant rat', mine: 10, at: 2 }));
    log.record(fight({ mob: 'small giant rat', mine: 12, at: 3 }));
    expect(log.summary('giant rat', resolve)?.fights).toBe(2);
    expect(log.summary('giant rat king', resolve)?.fights).toBe(1);
    expect(log.summary('rat', resolve)).toBeNull();
    // One read for the lot.
    expect([...log.summaries(['giant rat', 'rat', 'cave bear'], resolve).keys()]).toEqual([
      'giant rat'
    ]);
    log.dispose();
  });
});
