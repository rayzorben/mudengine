import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';

function makeWorld(rooms: Array<Record<string, unknown>>): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-hunt-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const head = JSON.stringify({ v: 33, source: 'test', rooms: rooms.length, generatedAt: 'x' });
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

  it('carries the respawn clock as the realm states it, sign and all', () => {
    expect(graph.byId('1/2')?.delay).toBe(1);
    expect(graph.byId('1/4')?.delay).toBe(-20);
    expect(graph.byId('1/3')?.delay).toBeUndefined();
  });
});
