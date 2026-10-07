import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildRealm } from '../../world/buildRealm';
import { openRealm } from '../../world/RealmSource';
import { WorldGraph } from '../../world/WorldGraph';
import { gearReads } from '../gearReads';
import { planGearTrip } from '../gearTripPlan';
import { worldLeg } from '../navigation';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { withinBudget } from '../../../shared/gearWorth';
import { bareName } from '../../../shared/items';
import { nameAnswersTo, type RoomId } from '../../../shared/world';

/**
 * The Gear card and its trip on orohost's world database (gmud.zip), as a
 * player's realm is converted: a level 5 Human Warrior with nothing on,
 * standing in the first room the realm lists a shop beside, with a purse of
 * 5,000 copper and a vault of 20,000. Skips where the archive is absent.
 */
const archive = path.resolve('mdb/gmud.zip');
const available = fs.existsSync(archive);
let dir = '';
let world: WorldGraph | null = null;

beforeAll(() => {
  if (!available) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-gear-'));
  const source = openRealm(archive);
  try {
    const built = buildRealm(source, '2026-10-07');
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

function warrior(room: RoomId): CharacterState {
  const [map, number] = room.split('/').map(Number);
  const bank = world!.banks()[0]!;
  return {
    ...structuredClone(EMPTY_CHARACTER),
    phase: 'in-game',
    className: 'Warrior',
    race: 'Human',
    room: { ...EMPTY_CHARACTER.room, map: map!, number: number! },
    progress: { ...EMPTY_CHARACTER.progress, level: 5, strength: 60, charm: 50 },
    inventory: { ...EMPTY_CHARACTER.inventory, listedAt: 1, wealth: 5_000 },
    banks: [{ shop: bank.shop, name: bank.name, copper: 20_000, at: 1 }]
  };
}

describe.skipIf(!available)('the Gear card on gmud.mdb', () => {
  it('reads the slots, buys within the cash, and plans the trip through the banks and shops', async () => {
    const w = world!;
    const bank = w.banks()[0]!;
    const here = `${bank.map}/${bank.room}` as RoomId;
    let state = warrior(here);
    const priceAt = (name: string, shop: RoomId): number | null => {
      const row = w.byId(shop)?.shop;
      const counter = row === undefined ? undefined : w.shop(row);
      const line = counter?.items.find((each) =>
        nameAnswersTo(bareName(each.name), bareName(name))
      );
      return counter === undefined || line === undefined ? null : w.priceAt(line.id, counter.id);
    };
    const errands = {
      realmClass: () => ({
        combat: null,
        magery: null,
        crits: null,
        mageryType: null,
        family: null,
        attack: null
      }),
      capabilities: () => ({ abilities: null }),
      travellerNow: () => ({ level: 5 }),
      priceAt,
      routeBetween: (from: RoomId, to: RoomId) => worldLeg(w, from, to, { level: 5 })
    };
    const reads = gearReads({
      tracker: {
        get current() {
          return state;
        }
      },
      errands: errands as never,
      world: () => w,
      attack: () => 'attack'
    });

    const started = performance.now();
    const choices = reads.choices(20);
    const readMs = performance.now() - started;
    expect(choices.slots.length).toBeGreaterThan(5);
    const sold = choices.slots.flatMap((slot) =>
      slot.items.filter((item) => item.charged !== null)
    );
    expect(sold.length).toBeGreaterThan(0);

    const bought = withinBudget(
      sold.map((item) => ({ ...item, copper: item.charged! })),
      25_000
    );
    const spent = bought.reduce((sum, item) => sum + item.copper, 0);
    expect(spent).toBeLessThanOrEqual(25_000);
    const picks = bought.map((item) => ({ item: item.item, name: item.name, replaces: null }));
    expect(picks.length).toBeGreaterThan(0);

    state = { ...state, inventory: { ...state.inventory, wealth: 100 } };
    const planStarted = performance.now();
    const plan = await planGearTrip(
      { world: () => w, errands: errands as never, state: () => state },
      picks.slice(0, 6)
    );
    const planMs = performance.now() - planStarted;
    expect(plan.refusal).toBeUndefined();
    // A purse of 100 against the picks: a vault first, then the counters.
    expect(plan.stops[0]?.kind).toBe('bank');
    expect(plan.stops.some((stop) => stop.kind === 'shop')).toBe(true);
    expect(plan.stops.every((stop) => stop.leg.steps !== null || stop.leg.blocked !== null)).toBe(
      true
    );

    console.log(
      `gear read ${readMs.toFixed(0)}ms, plan ${planMs.toFixed(0)}ms; ` +
        `${picks.length} picked for ${spent} copper; stops: ` +
        plan.stops
          .map((stop) =>
            stop.kind === 'bank'
              ? `bank ${stop.bank} -${stop.withdraw} (${stop.leg.steps} steps)`
              : `${stop.shop}: ${stop.items.map((item) => item.name).join('+')} (${stop.leg.steps} steps, ${stop.leg.fights.length} fights)`
          )
          .join(' | ') +
        `; left ${JSON.stringify(plan.left)}`
    );
  }, 120_000);
});
