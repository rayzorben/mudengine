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
  it('adds up the file and what is still held, across the printed spellings', async () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat', mine: 30, blows: 6, killed: true, ms: 4000, at: 1 }));
    log.flush();
    log.record(
      fight({ mob: 'small giant rat', mine: 10, blows: 2, killed: false, ms: null, at: 2 })
    );
    expect(await log.summary('giant rat', resolve)).toEqual({
      fights: 2,
      kills: 1,
      meanMine: 20,
      meanBlows: 4,
      meanMs: 4000,
      opened: 2,
      latest: 2
    });
    // Null is no fights, not zero of everything.
    expect(await log.summary('cave bear', resolve)).toBeNull();
    // With no realm table at all, a spelling is itself: nothing folds.
    expect((await log.summary('giant rat'))?.fights).toBe(1);
    log.dispose();
  });

  /* `mobNameCandidates` is an order, and its safety is the caller stopping at
     the first name the realm knows: a rat king the realm names is its own
     monster, and fifty of its fights must not become the rat's. */
  it('keeps a longer monster the realm names out of a shorter one it also names', async () => {
    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat king', mine: 100, at: 1 }));
    log.record(fight({ mob: 'giant rat', mine: 10, at: 2 }));
    log.record(fight({ mob: 'small giant rat', mine: 12, at: 3 }));
    expect((await log.summary('giant rat', resolve))?.fights).toBe(2);
    expect((await log.summary('giant rat king', resolve))?.fights).toBe(1);
    expect(await log.summary('rat', resolve)).toBeNull();
    // One read for the lot.
    expect([...(await log.summaries(['giant rat', 'rat', 'cave bear'], resolve)).keys()]).toEqual([
      'giant rat'
    ]);
    log.dispose();
  });

  it('reads what earlier sessions wrote once, and never counts its own writes twice', async () => {
    /*
     * The whole file was gunzipped and parsed on every click: 41,679 fights,
     * a second of the socket's thread. Now the part written before this
     * instance is folded once, off the thread, and this instance's own
     * fights are folded as they happen — including the ones it goes on to
     * flush into the same file.
     */
    vi.useRealTimers();
    const earlier = new FightLog(file);
    earlier.record(fight({ mob: 'giant rat', mine: 30, at: 1 }));
    earlier.record(fight({ mob: 'giant rat', mine: 10, at: 2 }));
    earlier.dispose();

    const log = new FightLog(file);
    log.record(fight({ mob: 'giant rat', mine: 20, at: 3 }));
    expect(await log.summary('giant rat')).toMatchObject({ fights: 3, meanMine: 20, latest: 3 });
    log.flush();
    expect((await log.summary('giant rat'))?.fights).toBe(3);
    log.record(fight({ mob: 'giant rat', mine: 40, at: 4 }));
    expect(await log.summary('giant rat')).toMatchObject({ fights: 4, meanMine: 25, latest: 4 });
    log.dispose();

    // And the file itself holds all four for the next session.
    const later = new FightLog(file);
    expect((await later.summary('giant rat'))?.fights).toBe(4);
    later.dispose();
  });

  it('answers as empty, out loud, from a record it cannot read', async () => {
    vi.useRealTimers();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from('not a gzip stream at all'));
    const notices: string[] = [];
    const log = new FightLog(file, { notice: (message) => notices.push(message) });
    log.record(fight({ mob: 'giant rat', at: 5 }));
    expect((await log.summary('giant rat'))?.fights).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('could not be read');
    log.dispose();
  });
});

/*
 * The hunting survey's rounds where the realm's arithmetic declines
 * (2026-09-19): what this character deals a round, off its own opened fights.
 */
describe('what the record says this character deals a round', () => {
  const ask = { least: 2, roundMs: 5000, openerRounds: 1 };

  it('counts a fight of k rounds as k, from its first blow to its last', () => {
    const log = new FightLog(file);
    // 10s is two round lengths, so three rounds; one blow is one round.
    log.record(fight({ level: 5, mine: 90, ms: 10_000 }));
    log.record(fight({ level: 5, mine: 30, ms: null }));
    expect(log.measured(5, ask)).toEqual({ perRound: 30, fights: 2, fromLevel: 5 });
    // A backstab opener is credited by the survey itself, so it is taken back out.
    expect(log.measured(5, { ...ask, openerRounds: 4 })?.perRound).toBe(120 / 10);
    log.dispose();
  });

  it('measures nothing from a fight it joined or shared, or under the least', () => {
    const log = new FightLog(file);
    log.record(fight({ level: 5, mine: 500, ms: 0, opened: false }));
    log.record(fight({ level: 5, mine: 500, ms: 0, others: 40 }));
    log.record(fight({ level: 5, mine: 30, ms: 0 }));
    expect(log.measured(5, ask)).toBeNull();
    // Positive control: the one fight that measures is there.
    expect(log.measured(5, { ...ask, least: 1 })).toMatchObject({ perRound: 30, fights: 1 });
    log.dispose();
  });

  it('adds the levels below, nearest first, and never one above', () => {
    const log = new FightLog(file);
    log.record(fight({ level: 3, mine: 10, ms: 0 }));
    log.record(fight({ level: 4, mine: 20, ms: 0 }));
    log.record(fight({ level: 6, mine: 900, ms: 0 }));
    log.record(fight({ level: 5, mine: 40, ms: 0 }));
    expect(log.measured(5, ask)).toEqual({ perRound: 30, fights: 2, fromLevel: 4 });
    log.dispose();
  });

  it('answers from the file once it has been folded, and this session’s fights before', async () => {
    vi.useRealTimers();
    const earlier = new FightLog(file);
    earlier.record(fight({ level: 5, mine: 50, ms: 0 }));
    earlier.dispose();

    const log = new FightLog(file);
    log.record(fight({ level: 5, mine: 10, ms: 0 }));
    // Synchronous, so what it has: this session's one fight.
    expect(log.measured(5, { ...ask, least: 1 })?.fights).toBe(1);
    await log.ready();
    expect(log.measured(5, ask)).toEqual({ perRound: 30, fights: 2, fromLevel: 5 });
    log.dispose();
  });
});
