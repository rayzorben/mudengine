import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';
import { roomBrief } from '../roomBrief';

/**
 * A world holding whatever the case needs: rooms in the body, tables in the
 * header, the way `build-world.mjs` writes them.
 */
function makeWorld(
  rooms: Array<Record<string, unknown>>,
  header: Record<string, unknown> = {}
): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-brief-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const head = JSON.stringify({
    v: 13,
    source: 'test',
    rooms: rooms.length,
    generatedAt: 'x',
    ...header
  });
  fs.writeFileSync(
    file,
    zlib.gzipSync([head, ...rooms.map((room) => JSON.stringify(room))].join('\n') + '\n')
  );
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

describe('the realm’s answer about one room', () => {
  it('refuses a room the realm does not hold', () => {
    const graph = makeWorld([{ m: 1, r: 1, n: 'Here', x: {} }]);
    expect(roomBrief(graph, '1/999')).toBeNull();
  });

  it('names where each way out leads', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Crossroads', x: { n: { m: 1, r: 2 }, e: { m: 2, r: 7 } } },
      { m: 1, r: 2, n: 'Northern Path', x: {} }
    ]);
    const brief = roomBrief(graph, '1/1');
    expect(brief?.name).toBe('Crossroads');
    expect(brief?.exits).toEqual([
      { direction: 'n', to: '1/2', name: 'Northern Path' },
      // The realm has no `2/7`, so the way is listed without a name rather
      // than with a fabricated one — it is still a real way out.
      { direction: 'e', to: '2/7' }
    ]);
  });

  it('composes what stands in a way out, against the realm’s item table', () => {
    const graph = makeWorld(
      [
        { m: 1, r: 1, n: 'Vault Door', x: { n: { m: 1, r: 2, i: 'Key: 12' } } },
        { m: 1, r: 2, n: 'Vault', x: {} }
      ],
      { items: [{ id: 12, n: 'brass key' }] }
    );
    const [north] = roomBrief(graph, '1/1')!.exits;
    expect(north?.obstacle?.kind).toBe('key');
    expect(north?.obstacle?.detail).toContain('brass key');
  });

  /*
   * The question the map's lair glyph has raised since the realm data was
   * indexed, and the one this whole panel exists to answer.
   */
  it('says what a lair spawns, and how many at once', () => {
    const graph = makeWorld([{ m: 1, r: 1, n: 'Den', x: {}, lair: '(Max 2): 781,190,' }], {
      mobs: [
        { i: [781], n: 'gnoll', hp: 40 },
        { i: [190], n: 'gnoll shaman', hp: 55 }
      ]
    });
    const brief = roomBrief(graph, '1/1');
    expect(brief?.lair?.max).toBe(2);
    expect(brief?.lair?.mobs.map((mob) => mob.name)).toEqual(['gnoll', 'gnoll shaman']);
  });

  it('says the place by kind and name, and never its stock', () => {
    const graph = makeWorld([{ m: 1, r: 1, n: 'Counter', x: {}, s: 4 }], {
      items: [{ id: 12, n: 'lantern' }],
      shops: [{ id: 4, n: 'Bank of Godfrey', items: [12], t: 7 }]
    });
    const brief = roomBrief(graph, '1/1');
    expect(brief?.place).toEqual({ kind: 'bank', name: 'Bank of Godfrey' });
    expect(brief).not.toHaveProperty('place.items');
  });

  /*
   * `Rooms.Spell` has been written into the realm file since format 13 and
   * read by nothing — a room that heals you and a room that drowns you are the
   * same column, and only the name tells them apart.
   */
  it('names the spell the realm casts on whoever stands there', () => {
    const graph = makeWorld([{ m: 1, r: 1, n: 'The Silver River', x: {}, sp: 753 }], {
      spells: [{ id: 753, n: 'river damage' }]
    });
    expect(roomBrief(graph, '1/1')?.spell?.name).toBe('river damage');
  });

  it('leaves out what the realm records nothing for', () => {
    const graph = makeWorld([{ m: 1, r: 1, n: 'Plain Room', x: {} }]);
    const brief = roomBrief(graph, '1/1');
    expect(brief).not.toHaveProperty('place');
    expect(brief).not.toHaveProperty('lair');
    expect(brief).not.toHaveProperty('spell');
    expect(brief).not.toHaveProperty('light');
    expect(brief).not.toHaveProperty('commands');
  });
});
