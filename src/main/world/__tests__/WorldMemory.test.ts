import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorldMemory } from '../WorldMemory';
import type { Discovery } from '../../../shared/memory';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-memory-'));
  file = path.join(dir, 'memory', 'vaelor.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const discovery = (over: Partial<Discovery> = {}): Discovery => ({
  reason: 'unknown-exit',
  from: '1/10',
  fromName: 'Cliff Top',
  command: 'jump cliff',
  to: '1/12',
  name: 'Narrow Ledge',
  exits: ['u'],
  at: 1_700_000_000_000,
  ...over
});

describe('what a character remembers about its realm', () => {
  it('keeps a discovery and writes it where it was told to', () => {
    const memory = new WorldMemory(file, 'test-realm');
    expect(memory.learn(discovery())).not.toBeNull();
    memory.close();

    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written).toMatchObject({ version: 1, realm: 'test-realm' });
    expect(written.discoveries).toHaveLength(1);
  });

  /*
   * The reason the store de-duplicates rather than the caller: walking a new
   * corridor is something a player does every day, and a record that grew by
   * one entry each time would bury the day it was found.
   */
  it('keeps one copy of the same way out, however often it is walked', () => {
    const memory = new WorldMemory(file, 'test-realm');
    expect(memory.learn(discovery())).not.toBeNull();
    expect(memory.learn(discovery({ at: 1_700_000_009_999 }))).toBeNull();
    expect(memory.all).toHaveLength(1);
    // The *first* sighting is the discovery; a repeat does not restamp it.
    expect(memory.all[0]?.at).toBe(1_700_000_000_000);
  });

  it('treats the same command from a different room as a different way out', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    expect(memory.learn(discovery({ from: '1/99' }))).not.toBeNull();
    expect(memory.all).toHaveLength(2);
  });

  it('reads back what a previous session learned', () => {
    const first = new WorldMemory(file, 'test-realm');
    first.learn(discovery());
    first.close();

    const second = new WorldMemory(file, 'test-realm');
    expect(second.all).toHaveLength(1);
    // And still knows it, so the same walk does not announce itself again.
    expect(second.learn(discovery())).toBeNull();
  });

  /*
   * A realm that changes its `database` is a different map: room
   * numbers do not mean the same places, so an edge learned against one realm
   * is not merely stale against another, it is wrong.
   */
  it('ignores a record learned against a different realm', () => {
    const first = new WorldMemory(file, 'shipped-realm');
    first.learn(discovery());
    first.close();

    expect(new WorldMemory(file, 'somebody-elses-realm').all).toEqual([]);
  });

  it('keeps a record it cannot read rather than overwriting it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'this is not json', 'utf8');

    const problems: string[] = [];
    const memory = new WorldMemory(file, 'test-realm', (message) => problems.push(message));
    expect(memory.all).toEqual([]);
    expect(problems).toHaveLength(1);
    // Untouched: it is the only copy of what this character learned, and a
    // parse failure is not permission to throw it away.
    expect(fs.readFileSync(file, 'utf8')).toBe('this is not json');
  });

  it('refuses a file that parses but is not a memory file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, realm: 1 }), 'utf8');

    const problems: string[] = [];
    expect(new WorldMemory(file, 'test-realm', (m) => problems.push(m)).all).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  it('drops a malformed entry rather than trusting the file whole', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        realm: 'test-realm',
        discoveries: [discovery(), { from: '1/10' }]
      }),
      'utf8'
    );
    const problems: string[] = [];
    // One bad row makes the file untrustworthy, and half a record read as a
    // whole one is the failure this refuses: `exits` missing is not "no exits".
    expect(new WorldMemory(file, 'test-realm', (m) => problems.push(m)).all).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  it('answers what has been found about leaving one room', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    memory.learn(discovery({ command: 'climb tree', to: null, reason: 'unknown-room' }));
    memory.learn(discovery({ from: '1/99', command: 'n' }));

    expect(memory.from('1/10').map((entry) => entry.command)).toEqual(['jump cliff', 'climb tree']);
  });

  it('survives being closed twice', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    memory.close();
    expect(() => memory.close()).not.toThrow();
  });
});

/*
 * The one edit the record accepts is a player striking an observation out.
 * Nothing automatic can tell a mistyped direction the server accepted from a
 * genuine way through, so the decision is theirs — and it is not final: the
 * next walk down the same way writes it down again, which is the right answer
 * when the player was wrong and the map was not.
 */
describe('forgetting an observation the player says is wrong', () => {
  it('strikes it out, on disk as well as in memory', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    memory.learn(discovery({ command: 'ne', to: '1/13', name: 'Ledge Path' }));
    expect(memory.forget('1/10|jump cliff')).toBe(true);
    expect(memory.all.map((entry) => entry.command)).toEqual(['ne']);
    memory.close();

    const again = new WorldMemory(file, 'test-realm');
    expect(again.all.map((entry) => entry.command)).toEqual(['ne']);
  });

  it('says so when there was nothing to strike', () => {
    const memory = new WorldMemory(file, 'test-realm');
    expect(memory.forget('1/10|jump cliff')).toBe(false);
  });

  it('can learn the same way again afterwards', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    memory.forget('1/10|jump cliff');
    expect(memory.learn(discovery())).not.toBeNull();
    expect(memory.all).toHaveLength(1);
  });

  /*
   * The regression this file existed without.
   *
   * `isDiscovery` named two of the three reasons — `unknown-stock` was added to
   * the type when shops were first learned from and never to the reader — and
   * the check is whole-file, so one stock row made the client reject its own
   * file entirely and start fresh. The visible symptom was a shop being learned
   * again every session, which reads as a record that is not being *saved*
   * rather than one that cannot be *read*, and the exits learned beside it went
   * silently too.
   *
   * The exit is in this test on purpose: it is the half that was lost without
   * anything saying so.
   */
  it('reads back a stock discovery, and does not discard the file over one', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    memory.learn(
      discovery({
        reason: 'unknown-stock',
        from: '1/3302',
        fromName: "Jorah's Plate/Scale",
        command: 'black plate leggings',
        to: null,
        name: 'black plate leggings',
        exits: []
      })
    );
    memory.close();

    const again = new WorldMemory(file, 'test-realm');
    expect(again.all.map((entry) => entry.command)).toEqual(['jump cliff', 'black plate leggings']);
    // And the point of reading it back: it is not learned a second time, which
    // is what was announcing the same three lines every session.
    expect(
      again.learn(
        discovery({
          reason: 'unknown-stock',
          from: '1/3302',
          command: 'black plate leggings',
          to: null,
          name: 'black plate leggings',
          exits: []
        })
      )
    ).toBeNull();
  });

  /*
   * A reason from a *newer* build costs its own row and nothing else — which is
   * deliberately **not** what a malformed row costs (the test above keeps that
   * refusing the whole file). An unnamed reason is intact data this version has
   * no word for; a row missing `exits` is damage. Reading them as one thing is
   * what erased `unknown-stock` characters' whole records.
   */
  it('drops a row whose reason this build does not know, and keeps the rest', () => {
    const memory = new WorldMemory(file, 'test-realm');
    memory.learn(discovery());
    memory.close();

    const held = JSON.parse(fs.readFileSync(file, 'utf8')) as { discoveries: unknown[] };
    held.discoveries.push({ ...discovery(), reason: 'unknown-something-later', command: 'sw' });
    fs.writeFileSync(file, JSON.stringify(held), 'utf8');

    const again = new WorldMemory(file, 'test-realm');
    expect(again.all.map((entry) => entry.command)).toEqual(['jump cliff']);
  });
});
