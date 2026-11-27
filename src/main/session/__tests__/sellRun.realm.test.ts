import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildRealm } from '../../world/buildRealm';
import { openRealm } from '../../world/RealmSource';
import { WorldGraph } from '../../world/WorldGraph';
import { worldLeg } from '../navigation';
import { planSellRun, sellChoices, type SellPlanParts } from '../sellRunPlan';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireItem, type ItemEntity } from '../../../shared/entities';
import type { SellPick } from '../../../shared/sellRun';
import type { RoomId, WorldItem } from '../../../shared/world';

/**
 * The Sell face and its plan on orohost's world database (gmud.zip): a
 * character standing in the first bank, carrying three things shops stock and
 * with three more on the floor, once with room in the pack and once with it
 * nearly full. Skips where the archive is absent.
 */
const archive = path.resolve('mdb/gmud.zip');
const available = fs.existsSync(archive);
let dir = '';
let world: WorldGraph | null = null;

beforeAll(() => {
  if (!available) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-sell-'));
  const source = openRealm(archive);
  try {
    const built = buildRealm(source, '2026-11-27');
    const file = path.join(dir, 'gmud.jsonl.gz');
    fs.writeFileSync(
      file,
      zlib.gzipSync([JSON.stringify(built.header), ...built.lines].join('\n') + '\n')
    );
    world = WorldGraph.load(file);
  } finally {
    source.close();
  }
}, 120_000);

afterAll(() => {
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

const entity = (row: WorldItem, count?: number): ItemEntity => ({
  ...wireItem(row.name, count === undefined ? {} : { count }),
  id: row.id,
  ...(row.encumbrance === undefined ? {} : { encumbrance: row.encumbrance })
});

describe.skipIf(!available)('the Sell face on gmud.mdb', () => {
  it('prices what shops stock and plans the shops, coming back for what is too heavy', async () => {
    const w = world!;
    const bank = w.banks()[0]!;
    // Weighed, priced things on a shelf, one a name, so each row is its own.
    const seen = new Set<string>();
    const stocked = w
      .itemsWhere(
        (item) =>
          (item.price ?? 0) > 0 && (item.shops?.length ?? 0) > 0 && (item.encumbrance ?? 0) > 20
      )
      .filter((item) => !seen.has(item.name) && seen.add(item.name) !== undefined)
      .slice(0, 6);
    expect(stocked.length).toBe(6);
    const pack = stocked.slice(0, 3).map((row) => entity(row));
    const floor = stocked.slice(3).map((row) => entity(row, 2));
    const carried = pack.reduce((sum, item) => sum + (item.encumbrance ?? 0), 0);

    const parts = (load: number, max: number): SellPlanParts => {
      const state: CharacterState = {
        ...structuredClone(EMPTY_CHARACTER),
        phase: 'in-game',
        room: { ...EMPTY_CHARACTER.room, map: bank.map, number: bank.room, items: floor },
        progress: { ...EMPTY_CHARACTER.progress, level: 5, charm: 50 },
        inventory: {
          ...EMPTY_CHARACTER.inventory,
          listedAt: 1,
          items: pack,
          encumbrance: load,
          encumbranceMax: max
        }
      };
      return {
        state: () => state,
        kept: { wantedBy: () => null },
        world: () => w,
        errands: {
          travellerNow: () => ({ level: 5 }),
          routeBetween: (from: RoomId, to: RoomId) => worldLeg(w, from, to, { level: 5 })
        } as never
      };
    };

    const started = performance.now();
    const choices = sellChoices(parts(carried, 100_000));
    const readMs = performance.now() - started;
    expect(choices).toHaveLength(6);
    const sellable = choices.filter((choice) => choice.kept === null);
    expect(sellable.length).toBeGreaterThan(0);
    for (const choice of sellable) {
      expect(choice.copper).toBeGreaterThan(0);
      expect(choice.shop).not.toBeNull();
    }

    const picks: SellPick[] = sellable.map(({ name, from, count }) => ({ name, from, count }));
    const planStarted = performance.now();
    const roomy = await planSellRun(parts(carried, 100_000), picks);
    const planMs = performance.now() - planStarted;
    expect(roomy.refusal).toBeUndefined();
    expect(roomy.rounds).toBe(1);
    expect(roomy.stops.some((stop) => stop.kind === 'shop')).toBe(true);
    expect(roomy.stops.every((stop) => stop.leg.steps !== null || stop.leg.blocked !== null)).toBe(
      true
    );
    // Everything a shop buys is sold in one visit to its room.
    const rooms = roomy.stops.filter((stop) => stop.kind === 'shop').map((stop) => stop.room);
    expect(new Set(rooms).size).toBe(rooms.length);

    // One point under the most it holds: nothing on the floor fits until the pack has sold.
    const full = await planSellRun(parts(carried, carried + 2), picks);
    const fromFloor = sellable.some((choice) => choice.from === 'floor');
    const fromPack = sellable.some((choice) => choice.from === 'pack');
    if (fromFloor && fromPack) {
      expect(full.rounds).toBeGreaterThan(1);
      expect(full.stops[0]?.kind).toBe('shop');
      expect(full.stops.some((stop) => stop.kind === 'floor' && stop.round > 1)).toBe(true);
    }

    const said = (plan: typeof roomy): string =>
      plan.stops
        .map(
          (stop) =>
            `${stop.round}:${stop.kind === 'shop' ? stop.shop : 'floor'} ` +
            `${stop.items.map((item) => `${item.count} ${item.name}`).join('+')} (${stop.leg.steps} steps)`
        )
        .join(' | ');
    console.log(
      `sell read ${readMs.toFixed(0)}ms, plan ${planMs.toFixed(0)}ms; roomy: ${said(roomy)}; ` +
        `pays ${roomy.copper}; full (${full.rounds} rounds, ${full.moves} moves): ${said(full)}; ` +
        `left ${JSON.stringify([...roomy.left, ...full.left])}; ` +
        `kept ${JSON.stringify(choices.filter((c) => c.kept !== null).map((c) => [c.name, c.kept]))}`
    );
  }, 120_000);
});
