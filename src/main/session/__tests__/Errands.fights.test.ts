import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { WorldGraph } from '../../world/WorldGraph';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { NO_LORE } from '../../../shared/lore';
import { WANDERER_CHANCE } from '../../../shared/runPass';
import type { Odds, Survival } from '../../../shared/survival';

/*
 * `travellerNow` counts a wanderer auto-combat would fight as a fight, and
 * guesses one the odds book has no result for from the realm's numbers (todo
 * 20261103-1100-01). `reachKey` moves with the combat switch and with the
 * tolls the purse and the banks pay.
 */

/** A gate charging a toll of 5 gold, and past it a road a goblin may wander onto. */
function realm(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-fights-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const rooms = [
    { m: 1, r: 1, n: 'Gate', x: { e: { m: 1, r: 2, i: 'Toll: 5' } } },
    { m: 1, r: 2, n: 'Road', x: { w: { m: 1, r: 1 } }, wd: [7] }
  ];
  const header = {
    v: 61,
    source: 'test',
    rooms: rooms.length,
    generatedAt: 'x',
    classes: [{ id: 3, n: 'Paladin', combat: 3 }],
    mobs: [
      {
        n: 'goblin',
        hp: 200,
        i: [7],
        d: 'h',
        ac: 20,
        xp: 300,
        pf: [{ a: [[1, 1, 200, 3, 9, 1000, 0]], c: [] }]
      }
    ]
  };
  fs.writeFileSync(
    file,
    zlib.gzipSync([header, ...rooms].map((row) => JSON.stringify(row)).join('\n') + '\n')
  );
  try {
    return WorldGraph.load(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const STANDING: CharacterState = {
  ...EMPTY_CHARACTER,
  name: 'Festus',
  className: 'Paladin',
  room: { ...EMPTY_CHARACTER.room, map: 1, number: 1, name: 'Gate' },
  progress: {
    ...EMPTY_CHARACTER.progress,
    level: 10,
    strength: 60,
    agility: 50,
    intellect: 40,
    charm: 40
  },
  vitals: { ...EMPTY_CHARACTER.vitals, hp: 148, hpMax: 148 },
  inventory: { ...EMPTY_CHARACTER.inventory, encumbrance: 0, encumbranceMax: 1000, wealth: 0 }
};

/** A goblin fight the odds book has run: half the fights lost, and nobody struck on a run past. */
const RUN: Odds = {
  kind: 'run',
  survival: { survives: 0.5, horizons: [] } as unknown as Survival
};

/** One character's `Errands`, with combat and the goblin's odds held here so a test can move them. */
function book() {
  const inputs = { combat: true, goblin: { kind: 'unrun' } as Odds };
  const world = realm();
  const errands = new Errands(
    {
      world,
      tracker: { current: STANDING, pendingMoves: 0 },
      fightRecord: {},
      combatOn: () => inputs.combat,
      lore: NO_LORE
    } as unknown as ErrandsParts,
    {
      config: () => DEFAULT_CONFIG.automation,
      family: () => 'greatermud',
      odds: () => ({
        lair: () => ({ kind: 'unrun' }),
        lairKnown: () => ({ kind: 'unrun' }),
        pass: () => ({ kind: 'unrun' }),
        passKnown: () => ({ kind: 'unrun' }),
        mob: () => inputs.goblin,
        mobKnown: () => inputs.goblin
      }),
      notice: () => undefined
    } as unknown as ErrandsSession
  );
  const road = world.byId('1/2')!;
  /** The road's death as `travellerNow` hands it to the router, walked in from the gate. */
  const roadDeath = (state: CharacterState): number | null | undefined =>
    errands.travellerNow(state).runDeath?.(road, '1/1');
  return { inputs, errands, roadDeath };
}

const holding = (wealth: number | null, banked?: number): CharacterState => ({
  ...STANDING,
  inventory: { ...STANDING.inventory, wealth },
  banks:
    banked === undefined ? [] : [{ shop: null, name: 'Bank of Silvermere', copper: banked, at: 0 }]
});

const health = (hp: number | null): CharacterState => ({
  ...STANDING,
  vitals: { ...STANDING.vitals, hp }
});

describe('fights on a route, through `Errands`', () => {
  it('carries the inventory’s wealth as the purse', () => {
    const { errands } = book();
    expect(errands.travellerNow(holding(499)).purse).toBe(499);
    expect(errands.travellerNow(holding(null)).purse).toBeNull();
  });

  it('moves the reach key when combat is switched', () => {
    const { inputs, errands } = book();
    const on = errands.reachKey(STANDING);
    expect(errands.reachKey(STANDING)).toBe(on);
    inputs.combat = false;
    expect(errands.reachKey(STANDING)).not.toBe(on);
    inputs.combat = true;
    expect(errands.reachKey(STANDING)).toBe(on);
  });

  it('moves the reach key when the purse crosses the toll, and not on either side of it', () => {
    const { errands } = book();
    const short = errands.reachKey(holding(0));
    const paid = errands.reachKey(holding(500));
    // Positive control: the toll is 500 copper, and crossing it moves the key.
    expect(paid).not.toBe(short);
    expect(errands.reachKey(holding(499))).toBe(short);
    expect(errands.reachKey(holding(10_000))).toBe(paid);
    // An unread purse has its own key, apart from an empty one.
    expect(errands.reachKey(holding(null))).not.toBe(short);
  });

  it('moves the reach key on the purse alone, with the banks over the toll', () => {
    const { errands } = book();
    const banked = errands.reachKey(holding(0, 1_000));
    // Positive control: the same copper carried instead of banked moves the key.
    expect(errands.reachKey(holding(500, 1_000))).not.toBe(banked);
    expect(errands.reachKey(holding(499, 1_000))).toBe(banked);
    // An unread purse beside a known bank balance is its own key too.
    expect(errands.reachKey(holding(null, 1_000))).not.toBe(banked);
  });

  it('hands the run whether combat is on', () => {
    const { inputs, roadDeath } = book();
    inputs.goblin = RUN;
    // With combat on, the goblin is a lost fight half the time; with it off, the run past takes no hits.
    expect(roadDeath(STANDING)).toBeCloseTo(WANDERER_CHANCE * 0.5);
    inputs.combat = false;
    expect(roadDeath(STANDING)).toBe(0);
  });

  it('guesses an unrun fight as its cost over the health now, at most one', () => {
    const { roadDeath } = book();
    const atLow = roadDeath(health(100_000));
    const atDouble = roadDeath(health(200_000));
    expect(atLow).toBeGreaterThan(0);
    expect(atLow).toBeLessThan(WANDERER_CHANCE);
    expect(atDouble).toBeCloseTo(atLow! / 2, 12);
    // A cost past the health is a certain death, never more.
    expect(roadDeath(health(1))).toBe(WANDERER_CHANCE);
  });

  it('guesses nothing for health at nought or unread', () => {
    const { roadDeath } = book();
    // Positive control: the guess is there at a health it can divide by.
    expect(roadDeath(health(148))).not.toBeNull();
    expect(roadDeath(health(0))).toBeNull();
    expect(roadDeath(health(null))).toBeNull();
  });
});
