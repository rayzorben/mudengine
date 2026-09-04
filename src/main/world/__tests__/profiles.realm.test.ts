import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { attackChances, rowProfile } from '../buildRealm';
import { openRealm } from '../RealmSource';
import { WorldGraph } from '../WorldGraph';

const mdb = path.resolve('resources/mdb/gmud20230902.mdb');
const shipped = path.resolve('resources/world/rooms.jsonl.gz');

/** The five attack slots the server loads off a row, in slot order. */
function loadedSlots(row: Record<string, unknown>): number[] {
  return [0, 1, 2, 3, 4].filter((slot) => {
    const type = row[`AttType-${slot}`];
    return type === 1 || type === 2;
  });
}

/*
 * Claims about the GMUD database (`gmud20230902.mdb`), read straight off it — format 20's
 * reading of the attack and between-round columns, checked against the
 * realm rather than against a fixture that would prove only the fixture.
 */
describe.skipIf(!fs.existsSync(mdb))('how the GMUD realm’s monsters fight', () => {
  it('reads a profile off nearly every monster row, and the server’s attack types only', () => {
    const source = openRealm(mdb);
    try {
      const rows = source
        .table('Monsters')!
        .rows.filter((row) => row['In Game'] !== 0 && Number(row['HP']) > 0);
      const profiled = rows.filter((row) => rowProfile(row) !== null);
      // 1,786 rows in game; the ones without are the shopkeepers, trainers
      // and the like that state no slot the server loads.
      expect(rows.length).toBeGreaterThan(1700);
      expect(profiled.length).toBeGreaterThan(1600);

      // The one slot of type 3 in the whole realm sits on the first `giant
      // rat` row, and `MobType.GetAttackTypes` loads only 1 and 2 — so the
      // first monster anybody meets has, on this server, a row that never
      // swings. The other giant rat rows do.
      const odd = rows.filter((row) =>
        [0, 1, 2, 3, 4].some((slot) => row[`AttType-${slot}`] === 3)
      );
      expect(odd.map((row) => String(row['Name']).toLowerCase())).toEqual(['giant rat']);
      expect(rowProfile(odd[0]!)).toBeNull();
    } finally {
      source.close();
    }
  });

  /*
   * The editor's `AttTrue%` column is a cached figure from a model that is
   * not the server's loop, and this records the measurement rather than
   * asserting agreement: two slots in five agree within a point, which is what
   * says the *columns* are being read right (a wrong threshold column would
   * agree on nothing), and the long tail is the editor's, not ours. Numbers
   * from 2026-09-04; a realm file that moves them should move this.
   */
  it('walks the thresholds as the server does, which the editor’s cached column only half agrees with', () => {
    const source = openRealm(mdb);
    try {
      let slots = 0;
      let close = 0;
      let far = 0;
      for (const row of source.table('Monsters')!.rows) {
        if (row['In Game'] === 0 || !(Number(row['HP']) > 0)) continue;
        const loaded = loadedSlots(row);
        if (loaded.length === 0) continue;
        const stated = loaded.map((slot) => Number(row[`AttTrue%-${slot}`]) || 0);
        if (Math.abs(stated.reduce((sum, each) => sum + each, 0) - 100) > 0.5) continue;
        const walked = attackChances(loaded.map((slot) => Number(row[`Att%-${slot}`]) || 0));
        loaded.forEach((_, index) => {
          const gap = Math.abs((walked[index] ?? 0) * 100 - (stated[index] ?? 0));
          slots += 1;
          if (gap <= 1) close += 1;
          if (gap > 5) far += 1;
        });
      }
      expect(slots).toBeGreaterThan(3500);
      expect(close / slots).toBeGreaterThan(0.4);
      expect(far / slots).toBeGreaterThan(0.2);
    } finally {
      source.close();
    }
  });
});

describe.skipIf(!fs.existsSync(shipped))('the shipped realm carries the profiles', () => {
  const graph = WorldGraph.load(shipped);

  it('states how a guardsman fights, with its call for aid resolved', () => {
    const entity = graph.buildMobEntity('guardsman');
    expect(entity.profiles?.length).toBeGreaterThan(0);
    expect(
      entity.profiles?.some((profile) => profile.attacks.some((attack) => attack.kind === 'spell'))
    ).toBe(true);
    expect(Object.values(entity.spells ?? {}).map((spell) => spell.name)).toContain(
      'calls for aid'
    );
  });

  it('states a dark cleric’s between-round paralysis, with the spell to weigh it by', () => {
    const entity = graph.buildMobEntity('dark cleric');
    expect(entity.profiles?.some((profile) => profile.casts.length > 0)).toBe(true);
    expect(Object.values(entity.spells ?? {}).map((spell) => spell.name)).toContain('hold person');
  });

  /* Paradigm's `old man` is three rows of a real fighter; its boatman states
     no slot the server loads, and is told apart from a file that says nothing. */
  it('says the boatman fights with nothing, rather than saying nothing', () => {
    expect(graph.mob('boatman')?.profiles).toEqual([]);
  });
});
