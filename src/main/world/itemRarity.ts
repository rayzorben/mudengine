/**
 * How often the realm makes each item and each monster, worked out together
 * from the supply (`supply.ts`) and the rooms' lairs, residents and placed
 * items, and the rarity read from it (`src/shared/rarity.ts`). A rate is
 * copies an hour at one place: a monster's quickest way in, an item's
 * quickest source. See `mudengine-world` › *An item's rarity is its quickest
 * source* for the server rules each figure follows.
 */
import { tuning } from '../app/tuning';
import { respawnSeconds } from '../../shared/hunting';
import type { TuningConfig } from '../../shared/internal';
import type { RealmFamily } from '../../shared/realm';
import { itemRarity, type ItemRarity, type RarityFrom, type RarityGate } from '../../shared/rarity';
import {
  parseLair,
  roomId,
  type RoomId,
  type WorldItem,
  type WorldMob,
  type WorldRoom,
  type WorldShop
} from '../../shared/world';
import type { Shelf, SupplyGate, SupplyRun, SupplyTrigger, WorldSupply } from './supply';

/** What the book reads of the realm; `WorldGraph` is one. */
export interface RarityWorld {
  supply(): WorldSupply;
  everyRoom(): Iterable<WorldRoom>;
  item(id: number): Pick<WorldItem, 'name' | 'limit'> | undefined;
  mobById(id: number): Pick<WorldMob, 'name'> | undefined;
  shop(id: number): Pick<WorldShop, 'name'> | undefined;
  readonly info: { family: RealmFamily | null };
}

export type RarityConstants = TuningConfig['rarity'] &
  Pick<TuningConfig['hunting'], 'roomRegenSeconds' | 'greatermudRespawnOffsetSeconds'>;

/** Where a rate comes from, kept to say it back. */
type Feed =
  | { kind: 'shelf'; shelf: Shelf }
  | { kind: 'placed'; room: RoomId }
  | { kind: 'run'; by: SupplyTrigger; copies: number };

/** Copies an hour, or null where the source is labelled rather than timed (a quest). */
interface Rated {
  rate: number | null;
  feed: Feed;
}

const perHour = (seconds: number): number => 3600 / seconds;

function raise(rates: Map<number, number>, id: number, rate: number): void {
  if (rate > (rates.get(id) ?? 0)) rates.set(id, rate);
}

function sameRates(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, rate] of a) {
    if (b.get(id)?.toPrecision(6) !== rate.toPrecision(6)) return false;
  }
  return true;
}

export class RarityBook {
  /** Item row → every source, as the last pass rated it. */
  private sources = new Map<number, Rated[]>();
  /** How many passes the rates took to stop changing. */
  readonly passes: number;

  constructor(
    private readonly world: RarityWorld,
    private readonly constants: RarityConstants
  ) {
    this.passes = this.settle();
  }

  of(item: number): ItemRarity {
    const sources = (this.sources.get(item) ?? []).map((rated) => ({
      hours: rated.rate !== null && rated.rate > 0 ? 1 / rated.rate : null,
      from: this.said(rated.feed)
    }));
    return itemRarity(sources, (this.world.item(item)?.limit ?? 0) > 0, this.constants);
  }

  /**
   * Monster and item rates feed each other (a summon gated by an item, a drop
   * from a summoned monster, a chest out of a chest), so they are worked out
   * in passes until none changes. Each pass reads only the last one's rates.
   */
  private settle(): number {
    const supply = this.world.supply();
    const { arrivals, fixed } = this.fixedSources(supply);
    let monsters = new Map<number, number>();
    let items = new Map<number, number>();
    for (let pass = 1; ; pass += 1) {
      const nextMonsters = new Map(arrivals);
      const sources = new Map<number, Rated[]>();
      for (const [item, rated] of fixed) sources.set(item, [...rated]);
      for (const run of supply.runs) this.rateRun(run, monsters, items, nextMonsters, sources);
      // A monster with a clock of its own is one at a time (`GameLimit` is not in the database).
      for (const [monster, hours] of supply.clocks) {
        const rate = nextMonsters.get(monster);
        if (rate !== undefined) nextMonsters.set(monster, Math.min(rate, 1 / hours));
      }
      const nextItems = new Map<number, number>();
      for (const [item, rated] of sources) {
        for (const { rate } of rated) if (rate !== null) raise(nextItems, item, rate);
      }
      const settled = sameRates(monsters, nextMonsters) && sameRates(items, nextItems);
      monsters = nextMonsters;
      items = nextItems;
      this.sources = sources;
      if (settled || pass >= this.constants.passes) return pass;
    }
  }

  /**
   * What hangs off nothing else: lairs (`RegenSlot` picks one of a lair's
   * monsters at random per slot), a room's own monster on its clock or at the
   * next regen pass, a roaming group, a restocking shelf, a placed item.
   */
  private fixedSources(supply: WorldSupply): {
    arrivals: Map<number, number>;
    fixed: Map<number, Rated[]>;
  } {
    const { constants } = this;
    const arrivals = new Map<number, number>();
    const fixed = new Map<number, Rated[]>();
    const put = (item: number, rated: Rated): void => {
      const held = fixed.get(item);
      if (held === undefined) fixed.set(item, [rated]);
      else held.push(rated);
    };
    const family = this.world.info.family;
    for (const room of this.world.everyRoom()) {
      if (room.lair) {
        const { max, ids } = parseLair(room.lair);
        const stated = respawnSeconds(room.delay ?? null, family, constants);
        const clock = stated !== null && stated > 0 ? stated : constants.lairSeconds;
        for (const id of ids) raise(arrivals, id, ((max ?? 1) / ids.length) * perHour(clock));
      }
      if (room.npcId !== undefined) {
        const hours = supply.clocks.get(room.npcId);
        raise(
          arrivals,
          room.npcId,
          hours === undefined ? perHour(constants.roomRegenSeconds) : 1 / hours
        );
      }
      for (const item of room.placed ?? []) {
        put(item, {
          rate: 1 / constants.placedHours,
          feed: { kind: 'placed', room: roomId(room.map, room.room) }
        });
      }
    }
    for (const monster of supply.roams) raise(arrivals, monster, perHour(constants.roamSeconds));
    for (const shelf of supply.shelves) {
      const rate = ((shelf.amount * shelf.percent) / 100) * (60 / shelf.minutes);
      put(shelf.item, { rate, feed: { kind: 'shelf', shelf } });
    }
    return { arrivals, fixed };
  }

  private rateRun(
    run: SupplyRun,
    monsters: ReadonlyMap<number, number>,
    items: ReadonlyMap<number, number>,
    nextMonsters: Map<number, number>,
    sources: Map<number, Rated[]>
  ): void {
    const rate = this.runRate(run.by, monsters, items);
    for (const [item, copies] of run.items) {
      const rated: Rated = {
        rate: rate === null ? null : rate * copies,
        feed: { kind: 'run', by: run.by, copies }
      };
      const held = sources.get(item);
      if (held === undefined) sources.set(item, [rated]);
      else held.push(rated);
    }
    if (rate === null) return;
    for (const [monster, copies] of run.monsters) raise(nextMonsters, monster, rate * copies);
  }

  /**
   * Runs an hour. A fight's spell may come every round; one round's chance is
   * the floor, which errs rare. A phrase that uses an item up is as rare as
   * the rarest it uses; a quest flag has no rate.
   */
  private runRate(
    by: SupplyTrigger,
    monsters: ReadonlyMap<number, number>,
    items: ReadonlyMap<number, number>
  ): number | null {
    switch (by.kind) {
      case 'drop':
      case 'arrive':
      case 'death':
        return monsters.get(by.monster) ?? 0;
      case 'fight':
      case 'attack':
        return (monsters.get(by.monster) ?? 0) * by.chance;
      case 'use':
        return items.get(by.item) ?? 0;
      case 'ask':
      case 'say':
        return this.gateRate(by.gate, items);
      default: {
        const never: never = by;
        return never;
      }
    }
  }

  private gateRate(gate: SupplyGate, items: ReadonlyMap<number, number>): number | null {
    switch (gate.kind) {
      case 'onDemand':
        return perHour(this.constants.onDemandSeconds);
      case 'uses':
        return Math.min(...gate.items.map((item) => items.get(item) ?? 0));
      case 'quest':
        return null;
      default: {
        const never: never = gate;
        return never;
      }
    }
  }

  /** A source as a card says it: names for rows. */
  private said(feed: Feed): RarityFrom {
    switch (feed.kind) {
      case 'shelf': {
        const { shop, amount, percent, minutes } = feed.shelf;
        return { kind: 'shop', shop: this.shopName(shop), amount, percent, minutes };
      }
      case 'placed':
        return { kind: 'placed', room: feed.room };
      case 'run':
        return this.saidRun(feed.by, feed.copies);
      default: {
        const never: never = feed;
        return never;
      }
    }
  }

  private saidRun(by: SupplyTrigger, copies: number): RarityFrom {
    switch (by.kind) {
      case 'drop':
        return { kind: 'drop', monster: this.monsterName(by.monster), percent: copies * 100 };
      case 'arrive':
      case 'death':
        return { kind: 'spell', monster: this.monsterName(by.monster), when: by.kind, copies };
      case 'fight':
      case 'attack':
        return {
          kind: 'spell',
          monster: this.monsterName(by.monster),
          when: by.kind,
          copies: copies * by.chance
        };
      case 'use':
        return { kind: 'use', item: this.itemName(by.item), copies };
      case 'ask':
        return {
          kind: 'ask',
          who: this.monsterName(by.monster),
          say: by.say,
          gate: this.saidGate(by.gate),
          copies
        };
      case 'say':
        return { kind: 'say', rooms: by.rooms, say: by.say, gate: this.saidGate(by.gate), copies };
      default: {
        const never: never = by;
        return never;
      }
    }
  }

  private saidGate(gate: SupplyGate): RarityGate {
    switch (gate.kind) {
      case 'onDemand':
      case 'quest':
        return { kind: gate.kind };
      case 'uses':
        return { kind: 'uses', items: gate.items.map((item) => this.itemName(item)) };
      default: {
        const never: never = gate;
        return never;
      }
    }
  }

  // A row the realm names nothing for is said by its number.
  private monsterName(row: number): string {
    return this.world.mobById(row)?.name ?? `#${row}`;
  }

  private itemName(row: number): string {
    return this.world.item(row)?.name ?? `#${row}`;
  }

  private shopName(row: number): string {
    return this.world.shop(row)?.name ?? `#${row}`;
  }
}

/** Worked out once per realm loaded and per `tuning.rarity`, on the first ask. */
const books = new WeakMap<RarityWorld, { key: string; book: RarityBook }>();

export function rarityBook(world: RarityWorld): RarityBook {
  const {
    commonHours,
    uncommonHours,
    rareHours,
    veryRareHours,
    lairSeconds,
    roamSeconds,
    onDemandSeconds,
    placedHours,
    passes
  } = tuning().rarity;
  const { roomRegenSeconds, greatermudRespawnOffsetSeconds } = tuning().hunting;
  const constants: RarityConstants = {
    commonHours,
    uncommonHours,
    rareHours,
    veryRareHours,
    lairSeconds,
    roamSeconds,
    onDemandSeconds,
    placedHours,
    passes,
    roomRegenSeconds,
    greatermudRespawnOffsetSeconds
  };
  const key = JSON.stringify(constants);
  const held = books.get(world);
  if (held?.key === key) return held.book;
  const book = new RarityBook(world, constants);
  books.set(world, { key, book });
  return book;
}
