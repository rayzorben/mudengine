import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';
import { describeObstacle } from '../obstacle';
import { parseInstruction } from '../instructions';
import type { Requirement } from '../../../shared/world';

/**
 * A realm holding one room and one item, which is all the composer asks of it:
 * `graph.item(id)` for a key's name and where it comes from.
 */
function world(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-obstacle-'));
  const rooms = path.join(dir, 'rooms.jsonl.gz');
  const header = {
    v: 2,
    source: 'test',
    rooms: 1,
    generatedAt: 'x',
    // The item index rides in the header, which is where the composer reads a
    // key's name from — `build:world` puts only the ~130 items some exit
    // actually references in it.
    items: [{ id: 1124, n: 'angular key', mobs: ['gate guard'] }]
  };
  fs.writeFileSync(
    rooms,
    zlib.gzipSync(
      [JSON.stringify(header), JSON.stringify({ m: 1, r: 1, n: 'Here', x: {} })].join('\n') + '\n'
    )
  );
  const graph = WorldGraph.load(rooms);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

const of = (raw: string): Requirement => {
  const parsed = parseInstruction(raw);
  if (parsed === null) throw new Error(`not a requirement: ${raw}`);
  return parsed;
};

/*
 * The chip beside a route step used to be `requirement.kind` — `toll`, `level`,
 * `key` — with every number the realm recorded sitting unread in the same
 * object. A player decides whether to walk a step *on the number*, so the
 * number belongs on the step.
 */
describe('what an obstacle says, at three lengths', () => {
  const graph = world();
  const describe_ = (raw: string) => describeObstacle(of(raw), graph);

  it('quotes a toll in the coin the server charges it in', () => {
    // `Toll: 5` is a bare number in the realm data and the unit is gold — the
    // gate that records 5 answers `5 gold crowns` on the wire.
    const toll = describe_('Toll: 5');
    expect(toll.kind).toBe('toll');
    expect(toll.label).toBe('Toll: 5 gold');
    expect(toll.detail).toContain('5 gold');
  });

  it('states a level gate as the window the realm wrote', () => {
    expect(describe_('Level: 66 to 255').label).toBe('Levels 66–255');
    // `999` and `0` are the two ways the realm writes "no limit" — see
    // `parseInstruction`. A gate with only one end says only that end.
    expect(describe_('Level: 10 to 999').label).toBe('Level 10+');
    expect(describe_('Level: 0 to 5').label).toBe('Level 5 and under');
    // And a gate with neither has nothing to state but that it is one.
    expect(describe_('Level: 0 to 0').label).toBe('Level restricted');
  });

  it('names the key rather than its number, and the way through without it', () => {
    const locked = describe_('Key: 1124 [or 157 picklocks]');
    expect(locked.label).toBe('Key: angular key, pick 157');
    // The detail has room for where one is found; the chip does not.
    expect(locked.detail).toContain('gate guard');
    expect(locked.label).not.toContain('gate guard');
  });

  /*
   * Two bracket shapes and they are not the same fact: `[301
   * picklocks/strength]` takes either skill, `[or 157 picklocks]` takes only
   * the lock-pick — 89 exits in the shipped realm are the second kind. Saying
   * "bash" for one of those sends somebody to lean on a door that will not
   * yield.
   */
  it('offers to bash only where the realm says strength will do', () => {
    expect(describe_('Door [301 picklocks/strength]').label).toBe('Door, pick/bash 301');
    expect(describe_('Door [or 157 picklocks]').label).toBe('Door, pick 157');
  });

  it('says a bare door is a door', () => {
    expect(describe_('Door').label).toBe('Door');
  });

  it('keeps a trap damage figure', () => {
    expect(describe_('Trap, 30 damage').label).toContain('30');
  });

  /*
   * Class, race, alignment and the rest are not modelled, and a word invented
   * for a chip would be a claim the data does not make. The realm's own
   * instruction is what is shown.
   */
  it('falls back to the realm own words for anything unmodelled', () => {
    const raw = 'Class: Warrior';
    const said = describeObstacle({ kind: 'class', raw }, graph);
    expect(said.label).toBe(raw);
    expect(said.detail).toBe(raw);
  });
});
