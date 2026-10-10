import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MobEntity } from '../../../shared/entities';
import { Joiners, type JoinerRealm } from '../joiners';
import type { SupplyRun } from '../supply';
import { WorldGraph } from '../WorldGraph';

/*
 * Who a fight draws in (todo 24): what the foes' spells summon, what an
 * arrival brings, and what those bring in turn, each row once.
 */
const mob = (name: string, row: number, extra: Partial<MobEntity> = {}): MobEntity =>
  ({ kind: 'mob', name, row: { id: row, how: 'here', steps: 0 }, ...extra }) as MobEntity;

const calling = (row: number, brings: number): Partial<MobEntity> => ({
  profiles: [{ attacks: [], casts: [{ spell: row * 10, chance: 0.1, level: 1 }] }],
  spells: { [row * 10]: { id: row * 10, name: 'call', summons: [[[brings, 1]]] } }
});

function realm(
  rows: Record<number, MobEntity>,
  runs: SupplyRun[] = []
): JoinerRealm & {
  asked: number[];
} {
  const asked: number[] = [];
  return {
    asked,
    rowEntity: (id) => {
      asked.push(id);
      return rows[id];
    },
    supply: () => ({ runs })
  };
}

describe('who a fight draws in', () => {
  it('follows a call for aid to the row it names, and what that one calls in turn', () => {
    const warrior = mob('orc warrior', 480, calling(480, 481));
    const captain = mob('orc captain', 481, calling(481, 480));
    const world = realm({ 480: warrior, 481: captain });
    const joined = new Joiners(world).drawnIn(
      [mob('half-orc sentry', 479, calling(479, 480))],
      false
    );
    expect(joined.map(({ row, entity }) => [row, entity.name])).toEqual([
      [480, 'orc warrior'],
      [481, 'orc captain']
    ]);
  });

  it('leaves out a row the realm lacks, as the server brings nobody', () => {
    const joined = new Joiners(realm({})).drawnIn([mob('sentry', 479, calling(479, 999))], false);
    expect(joined).toEqual([]);
  });

  it("brings an arrival's company only where the foes come into the room with the fight", () => {
    const smith = mob('dark-elf weaponsmaster', 77);
    const runs: SupplyRun[] = [
      { by: { kind: 'arrive', monster: 70 }, items: new Map(), monsters: new Map([[77, 1]]) }
    ];
    const joiners = new Joiners(realm({ 77: smith }, runs));
    const queen = mob('dark-elf queen', 70);
    expect(joiners.arrivalsOf(queen)).toEqual([[[77, 1]]]);
    expect(joiners.drawnIn([queen], true).map(({ row }) => row)).toEqual([77]);
    // A room already read holds her company already.
    expect(joiners.drawnIn([queen], false)).toEqual([]);
  });
});

const file = path.resolve('resources/world/paradigm.jsonl.gz');
const graph = fs.existsSync(file) ? WorldGraph.load(file) : null;

describe.skipIf(graph === null)('on the shipped realm', () => {
  it('draws the orc warrior into the half-orc sentry’s fight', () => {
    const sentry = graph!.buildMobEntity('half-orc sentry');
    const joined = graph!.joiners.drawnIn([sentry], false);
    expect(joined.map(({ row, entity }) => [row, entity.name])).toContainEqual([
      480,
      'orc warrior'
    ]);
  });
});
