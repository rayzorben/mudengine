import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { readRows } from '../roomColumns';
import { WorldGraph } from '../WorldGraph';

describe('a room’s list of monster rows', () => {
  it('reads positive row ids, and holds each distinct list once', () => {
    const kept = new Map<string, readonly number[]>();
    const first = readRows([6, 10], kept);
    expect(first).toEqual([6, 10]);
    expect(readRows([6, 10], kept)).toBe(first);
  });

  it('reads nothing from an empty or malformed cell rather than a part of it', () => {
    const kept = new Map<string, readonly number[]>();
    expect(readRows(undefined, kept)).toBeNull();
    expect(readRows([], kept)).toBeNull();
    expect(readRows([6, 'ten'], kept)).toBeNull();
    expect(readRows([6, 0], kept)).toBeNull();
  });
});

const file = path.resolve('resources/world/paradigm.jsonl.gz');
const graph = fs.existsSync(file) ? WorldGraph.load(file) : null;

describe.skipIf(graph === null)('on the shipped realm', () => {
  it('names Slum Street’s thugs and orc rogues as who may walk in, and no lair’s', () => {
    const street = graph!.get(1, 1074)!;
    expect(graph!.wandererEntities(street).map((mob) => mob.name)).toEqual(['orc rogue', 'thug']);
    expect(graph!.wandererEntities(graph!.get(1, 1073)!)).toEqual([]);
  });
});
