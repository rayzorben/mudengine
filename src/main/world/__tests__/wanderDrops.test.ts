import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { tuning } from '../../app/tuning';
import type { Traveller } from '../Router';
import { WorldGraph } from '../WorldGraph';
import { roomId } from '../../../shared/world';

const file = path.resolve('resources/world/majormud.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

/*
 * The reported case (the user, 2026-11-24): a collect loop for the black
 * serpent key from Western Road, Fork (2/61) on stock v1.11p had one stop and
 * waited there. Three `dark monk` rows drop the key. Row 228's one lair is
 * the Fork, and its group wanders into the Western Road and the Dragon's
 * Teeth Hills around it, the plain `Group:` entries of `Summoned By`; rows
 * 258 and 488 lair in Rhudaur, behind the door the key opens, and on map 9.
 */
describe.runIf(available)('a dropper is hunted where its group wanders in', () => {
  const key = { id: 593, name: 'black serpent key' };
  const fork = roomId(2, 61);
  const monk: Traveller = { level: 8, packKnown: true, keys: [] };
  const ring = { rooms: tuning().hunting.maxLoopRooms, radius: tuning().hunting.clusterRadius };

  it('fills the ring round the one lair with the rooms the monk wanders into', () => {
    const found = graph!.droppingPlaces(key, fork, monk, ring);
    expect(found.lairs).toHaveLength(ring.rooms);
    // The lair first: it is where the character stands, and the realm places the monk there.
    expect(found.lairs[0]).toMatchObject({ id: fork, mob: 'dark monk', steps: 0 });
    expect(found.lairs[0]!.wander).toBeUndefined();
    for (const lair of found.lairs.slice(1)) {
      expect(lair.wander).toBe(true);
      const room = graph!.byId(lair.id)!;
      expect(room.lair).toBeUndefined();
      expect(room.wanderers).toContain(228);
    }
  });

  it('starts at the lair from a room the monk only wanders into', () => {
    const road = roomId(2, 41);
    expect(graph!.byId(road)!.wanderers).toContain(228);
    const found = graph!.droppingPlaces(key, road, monk, ring);
    expect(found.lairs.map((lair) => lair.id)).toContain(fork);
  });

  it('counts the rooms a dropper wanders into among where it is found', () => {
    const { droppers } = graph!.droppingPlaces(key, fork, monk, ring);
    const monks = droppers.find((dropper) => dropper.mob === 'dark monk')!;
    // Rows 228, 258 and 488 lair in 26 rooms between them.
    expect(monks.placed).toBeGreaterThan(26);
  });

  it('lists a wanderer room as a kill for the plan, marked, and never the lair twice', () => {
    const kills = graph!
      .itemSources(key.id)
      .flatMap((source) => (source.kind === 'kill' ? [source] : []));
    expect(kills).toContainEqual({ kind: 'kill', monster: 'dark monk', room: fork });
    expect(kills).toContainEqual({
      kind: 'kill',
      monster: 'dark monk',
      room: roomId(2, 41),
      wander: true
    });
    expect(kills.some((kill) => kill.room === fork && kill.wander === true)).toBe(false);
  });
});
