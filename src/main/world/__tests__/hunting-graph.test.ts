import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';

function makeWorld(
  rooms: Array<Record<string, unknown>>,
  mobs?: Array<Record<string, unknown>>
): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-hunt-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const head = JSON.stringify({
    v: mobs === undefined ? 33 : 36,
    source: 'test',
    rooms: rooms.length,
    generatedAt: 'x',
    ...(mobs === undefined ? {} : { mobs })
  });
  fs.writeFileSync(
    file,
    zlib.gzipSync([head, ...rooms.map((room) => JSON.stringify(room))].join('\n') + '\n')
  );
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

const exit = (map: number, room: number) => ({ m: map, r: room });

/*
 * A corridor of five rooms and a side room off the second: the sweep the
 * Hunting card runs is breadth-first over the exits, pricing nothing, and it
 * reads the realm's own respawn clock off each room (format 33, todo 05).
 */
describe('the neighbourhood sweep', () => {
  const graph = makeWorld([
    { m: 1, r: 1, n: 'Gate', x: { e: exit(1, 2) } },
    { m: 1, r: 2, n: 'Road', x: { w: exit(1, 1), e: exit(1, 3), n: exit(1, 6) }, dl: 1 },
    { m: 1, r: 3, n: 'Bend', x: { w: exit(1, 2), e: exit(1, 4) } },
    { m: 1, r: 4, n: 'Field', x: { w: exit(1, 3), e: exit(1, 5) }, dl: -20 },
    { m: 1, r: 5, n: 'Far', x: { w: exit(1, 4) } },
    { m: 1, r: 6, n: 'Side', x: { s: exit(1, 2) } }
  ]);

  it('counts the fewest steps to every room within reach, and stops at the bound', () => {
    const within = graph.withinSteps('1/1', 2);
    expect([...within.entries()].sort()).toEqual([
      ['1/1', 0],
      ['1/2', 1],
      ['1/3', 2],
      ['1/6', 2]
    ]);
    expect(graph.withinSteps('1/1', 4).get('1/5')).toBe(4);
  });

  it('answers nothing from a room the realm does not hold', () => {
    expect(graph.withinSteps('9/9', 3).size).toBe(0);
  });

  /*
   * **A way this traveller cannot take is not a way** (todo 09). The survey
   * was offering lairs behind gates the character could not route through, and
   * a loop started on one plans a leg, is refused and stands still. Priced
   * only when a traveller is handed in: without one this is still *what is
   * near*, which is what the map asks.
   */
  it('leaves out what this traveller cannot reach', () => {
    const gated = makeWorld([
      { m: 1, r: 1, n: 'Gate', x: { e: exit(1, 2) } },
      { m: 1, r: 2, n: 'Road', x: { w: exit(1, 1), e: { ...exit(1, 3), i: 'Level: 30 to 999' } } },
      { m: 1, r: 3, n: 'Deep', x: { w: exit(1, 2) } }
    ]);
    // Nobody in particular: the neighbourhood, gate and all.
    expect([...gated.withinSteps('1/1', 4).keys()].sort()).toEqual(['1/1', '1/2', '1/3']);
    // A level 12 character: the gate refuses, so the room behind it is not
    // somewhere this character can hunt.
    expect([...gated.withinSteps('1/1', 4, { level: 12 }).keys()].sort()).toEqual(['1/1', '1/2']);
    // And one the gate takes reaches it.
    expect([...gated.withinSteps('1/1', 4, { level: 40 }).keys()].sort()).toEqual([
      '1/1',
      '1/2',
      '1/3'
    ]);
  });

  it('carries the respawn clock as the realm states it, sign and all', () => {
    expect(graph.byId('1/2')?.delay).toBe(1);
    expect(graph.byId('1/4')?.delay).toBe(-20);
    expect(graph.byId('1/3')?.delay).toBeUndefined();
  });
});

/*
 * **A monster's own clock reaches the lair that spawns it** (format 36).
 *
 * `BuiltMobRow.rt` was the one per-row column with no counterpart on the fold,
 * and `rw` is written only where a name holds several rows — so a uniquely
 * named boss carried no clock at all and the survey averaged its whole
 * experience into a lair that comes back every thirty seconds.
 */
describe('what a lair spawns, and how often', () => {
  it('reads a single-row name’s clock off the fold', () => {
    const graph = makeWorld(
      [{ m: 1, r: 1, n: 'Graveyard', x: {}, lair: '(Max 2): 790,11,', dl: 1 }],
      [
        { n: 'gravedigger', hp: 130, i: [790], xp: 1500, rt: 1 },
        { n: 'skeleton', hp: 43, i: [11], xp: 55 }
      ]
    );
    const found = graph.lairEntities(graph.byId('1/1')!);
    expect(found.map((e) => [e.name, e.regenHours])).toEqual([
      ['gravedigger', 1],
      ['skeleton', undefined]
    ]);
  });

  /*
   * And a row's own clock still overrules the fold, absences included: a name
   * whose rows disagree carries no `rt`, and the row that has one keeps it.
   */
  it('lets a row’s own clock overrule the fold', () => {
    const graph = makeWorld(
      [{ m: 1, r: 1, n: 'Kennel', x: {}, lair: '(Max 1): 377,50,', dl: 1 }],
      [
        {
          n: 'wild dog',
          hp: 20,
          i: [50, 377],
          xp: 75,
          rw: [
            { hp: 20, xp: 75 },
            { hp: 20, xp: 75, rt: 1 }
          ]
        }
      ]
    );
    const found = graph.lairEntities(graph.byId('1/1')!);
    expect(found.map((e) => e.regenHours)).toEqual([1, undefined]);
  });
});
