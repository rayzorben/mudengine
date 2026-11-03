import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { WorldGraph } from '../../world/WorldGraph';
import { edgePenalty } from '../../world/Router';
import { tuning } from '../../app/tuning';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/*
 * A room command whose spell lands once (`fall`, 5–15) is a wall for a bar it
 * can empty at its most or a bar nobody has read, so the health decides which
 * ways a route reaches: the reach key moves when it crosses a hit's most, and
 * not on every tick. A lap walks the fall, as it walks a room's damage.
 */
function ledge(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-hit-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const header = JSON.stringify({
    v: 43,
    source: 'test',
    rooms: 2,
    generatedAt: 'x',
    spells: [{ id: 335, n: 'fall', ab: [[1, 0]], pw: [5, 15] }]
  });
  const rooms = [
    { m: 1, r: 1, n: 'Ledge', x: {}, cmd: [{ say: ['go hole'], to: '1/2', casts: 335 }] },
    { m: 1, r: 2, n: 'Pit', x: {} }
  ];
  fs.writeFileSync(
    file,
    zlib.gzipSync([header, ...rooms.map((r) => JSON.stringify(r))].join('\n'))
  );
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

const world = ledge();
const book = new Errands(
  {
    world,
    tracker: { current: EMPTY_CHARACTER, pendingMoves: 0 },
    fightRecord: {},
    lore: { measuredRounds: () => null }
  } as unknown as ErrandsParts,
  {
    config: () => DEFAULT_CONFIG.automation,
    family: () => 'greatermud',
    notice: () => undefined
  } as unknown as ErrandsSession
);
const at = (hp: number | null, hpMax: number | null = 100): CharacterState => ({
  ...EMPTY_CHARACTER,
  vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax }
});
const fall = world.portalsFrom('1/1')[0]!.requirement;
const wall = tuning().world.wallCost;

describe('a fall against the bar', () => {
  it('walls on a bar it can empty or nobody has read, and the maximum does not stand in', () => {
    expect(edgePenalty(fall, book.travellerNow(at(100)))).toBeLessThan(wall);
    expect(edgePenalty(fall, book.travellerNow(at(15)))).toBe(wall);
    expect(edgePenalty(fall, book.travellerNow(at(null)))).toBe(wall);
  });

  it('moves the reach key when the bar crosses its most, and not below or above it', () => {
    expect(book.reachKey(at(100))).toBe(book.reachKey(at(80)));
    expect(book.reachKey(at(15))).toBe(book.reachKey(at(10)));
    expect(book.reachKey(at(100))).not.toBe(book.reachKey(at(15)));
    expect(book.reachKey(at(null))).not.toBe(book.reachKey(at(100)));
  });

  it('is walked by a lap at no price, as a room’s damage is', () => {
    expect(edgePenalty(fall, book.lapTraveller(at(15)))).toBe(0);
    expect(edgePenalty(fall, book.lapTraveller(at(null)))).toBe(0);
  });
});
