/**
 * What the realm makes, and how often its own tables say it can: the shelves
 * that restock on a timer, the monsters' stated clocks, the roaming groups,
 * and every run (a drop, a monster's spell, a used item, a typed phrase) with
 * the items and monsters one run makes on average. Read at conversion because
 * the text blocks do not ship; the rates are worked out at runtime
 * (`itemRarity.ts`) where the lair clocks are known. Server rules are from
 * the GreaterMUD source; see `mudengine-world` › *An item's rarity is its
 * quickest source*.
 */
import { HAZARD_ABILITY } from '../../shared/abilities';
import type { MobProfile } from '../../shared/world';
import type { BuiltSpell } from './buildRealm';
import { columnRows, scriptsOf } from './navigation/scriptWays';
import {
  blockRun,
  isStepArgument,
  linesRun,
  phrasedSteps,
  phraseOf,
  rollOf,
  stepsRun,
  untilUnrun,
  type Textblock,
  type TbStep,
  type TbUse
} from './navigation/textblock';
import type { RealmSource } from './RealmSource';
import { abilityPairs, dropSlots, number, shopSlots, text, type ShopSlotField } from './values';

/** `[row, copies]`: how many of each one run makes on average. */
export type BuiltMade = Array<[number, number]>;

/**
 * What runs: a monster arriving (its drops are rolled then, `Mob.cs:713`, and
 * its `CreateSpell` cast), dying, casting between rounds or as a blow (`p` the
 * chance a round), an item used (`CastsSp`), or a phrase asked of a monster or
 * typed in a room (`q` a quest flag on the way, `u` the items it uses up).
 */
export type BuiltRunBy =
  | { k: 'drop' | 'arrive' | 'death'; m: number }
  | { k: 'fight' | 'attack'; m: number; p: number }
  | { k: 'use'; it: number }
  | { k: 'ask'; m: number; say: string; q?: 1; u?: number[] }
  /** Every room whose command block holds the phrase, as `map/room`. */
  | { k: 'say'; at: string[]; say: string; q?: 1; u?: number[] };

/** A run, with the items it gives (`gi`) and the monsters it summons (`sm`). */
export type BuiltRun = BuiltRunBy & { gi?: BuiltMade; sm?: BuiltMade };

/** Format 56: the header's `supply`. */
export interface BuiltSupply {
  /** `[shop, item, amount, percent, minutes]`: a slot restocked on a timer (`Shop.FillShop`). */
  sh: Array<[number, number, number, number, number]>;
  /** `[monster row, hours]`: `Monsters.RegenTime` as stated, where above zero. */
  rt: Array<[number, number]>;
  /** Monster rows whose `Summoned By` puts them in a roaming group (`Group:`). */
  ro: number[];
  runs: BuiltRun[];
}

/** What a chain of steps makes: copies of items and monsters, what it uses up, a quest flag. */
interface Yield {
  items: Map<number, number>;
  monsters: Map<number, number>;
  uses: Set<number>;
  quest: boolean;
}

const empty = (): Yield => ({
  items: new Map(),
  monsters: new Map(),
  uses: new Set(),
  quest: false
});

function add(into: Yield, from: Yield, weight: number): void {
  for (const [id, copies] of from.items)
    into.items.set(id, (into.items.get(id) ?? 0) + copies * weight);
  for (const [id, copies] of from.monsters)
    into.monsters.set(id, (into.monsters.get(id) ?? 0) + copies * weight);
  for (const id of from.uses) into.uses.add(id);
  into.quest ||= from.quest;
}

/** Lines tried in turn: the best of them stands for the block. */
function best(into: Yield, from: Yield): void {
  for (const [id, copies] of from.items)
    into.items.set(id, Math.max(into.items.get(id) ?? 0, copies));
  for (const [id, copies] of from.monsters)
    into.monsters.set(id, Math.max(into.monsters.get(id) ?? 0, copies));
  for (const id of from.uses) into.uses.add(id);
  into.quest ||= from.quest;
}

const makes = (found: Yield): boolean => found.items.size > 0 || found.monsters.size > 0;

/**
 * What a step does toward making something: gives an item, summons a monster,
 * casts a spell, uses an item up (`clearitem 0` clears the floor and uses
 * nothing named), sets or tests a quest flag, hands the run to another block,
 * or none of these.
 */
type StepSupply =
  | { kind: 'gives'; item: number }
  | { kind: 'summons'; monster: number }
  | { kind: 'casts'; spell: number }
  | { kind: 'uses'; item: number }
  | { kind: 'quest' }
  | { kind: 'runs'; block: number; use: TbUse }
  | null;

function supplyOf(step: TbStep): StepSupply {
  switch (step.verb) {
    case 'giveitem':
    case 'droproomitem':
      return { kind: 'gives', item: step.item };
    case 'summon':
      return { kind: 'summons', monster: step.monster };
    case 'cast':
      return { kind: 'casts', spell: step.spell };
    case 'takeitem':
    case 'clearitem':
      return step.item > 0 ? { kind: 'uses', item: step.item } : null;
    case 'checkability':
    case 'checkabilityexact':
    case 'testability':
    case 'failability':
    case 'giveability':
    case 'setability':
    case 'addability':
    case 'removeability':
      return { kind: 'quest' };
    case 'show':
    case 'random':
    case 'checkspell':
    case 'failspell':
    case 'testskill': {
      const next = blockRun(step);
      return next === null ? null : { kind: 'runs', block: next[0], use: next[1] };
    }
    case 'nothing':
    case 'checkitem':
    case 'failitem':
    case 'roomitem':
    case 'failroomitem':
    case 'message':
    case 'addexp':
    case 'addevil':
    case 'addlife':
    case 'checklives':
    case 'delay':
    case 'learnspell':
    case 'class':
    case 'race':
    case 'evilaligned':
    case 'goodaligned':
    case 'givecoins':
    case 'minlevel':
    case 'maxlevel':
    case 'needmonster':
    case 'nomonsters':
    case 'monsters':
    case 'price':
    case 'remoteaction':
    case 'teleport':
    case 'unknown':
      return null;
    default: {
      const never: never = step;
      return never;
    }
  }
}

/** Walks spells and blocks for what they make, each once. */
class Makings {
  private readonly held = new Map<string, Yield>();
  private readonly open = new Set<string>();

  constructor(
    private readonly blocks: ReadonlyMap<number, Textblock>,
    private readonly spells: ReadonlyMap<number, Pick<BuiltSpell, 'ab' | 'pw'>>
  ) {}

  /**
   * What one cast makes: ability 12 summons and 148 runs a block, each
   * column naming its rows as `columnRows` reads them; 151 hands on the spell
   * it ends in, which is where a death spell's payload is.
   */
  spell(id: number): Yield {
    return this.once(`spell:${id}`, () => {
      const out = empty();
      const spell = this.spells.get(id);
      const row = {
        abilities: spell?.ab ?? [],
        ...(spell?.pw === undefined ? {} : { power: spell.pw })
      };
      for (const candidates of scriptsOf(row)) {
        for (const block of candidates) add(out, this.block(block, 'steps'), 1 / candidates.length);
      }
      for (const [ability, value] of row.abilities) {
        if (ability === HAZARD_ABILITY.endCast && value > 0) add(out, this.spell(value), 1);
        if (ability !== HAZARD_ABILITY.summon) continue;
        const candidates = columnRows(value, row.power);
        for (const monster of candidates) {
          out.monsters.set(monster, (out.monsters.get(monster) ?? 0) + 1 / candidates.length);
        }
      }
      return out;
    });
  }

  /** What a line's steps make, up to the first the server cannot run. */
  steps(steps: readonly TbStep[]): Yield {
    const out = empty();
    for (const step of untilUnrun(steps)) {
      const supply = supplyOf(step);
      switch (supply?.kind) {
        case undefined:
          break;
        case 'gives':
          out.items.set(supply.item, (out.items.get(supply.item) ?? 0) + 1);
          break;
        case 'summons':
          out.monsters.set(supply.monster, (out.monsters.get(supply.monster) ?? 0) + 1);
          break;
        case 'casts':
          add(out, this.spell(supply.spell), 1);
          break;
        case 'uses':
          out.uses.add(supply.item);
          break;
        case 'quest':
          out.quest = true;
          break;
        case 'runs':
          add(out, this.block(supply.block, supply.use), 1);
          break;
        default: {
          const never: never = supply;
          return never;
        }
      }
    }
    return out;
  }

  /**
   * A block run as `use`: a roll table's line has the chance its threshold
   * less the one before (`TextBlockPart.cs:911`), a shown block runs what it
   * links to, and lines run whole are alternatives.
   */
  block(id: number, use: TbUse): Yield {
    return this.once(`${use}:${id}`, () => {
      const block = this.blocks.get(id);
      const out = empty();
      if (block === undefined) return out;
      switch (use) {
        case 'shown':
          return block.linkTo !== null && block.linkTo > 0
            ? this.block(block.linkTo, 'steps')
            : out;
        case 'roll': {
          let below = 0;
          for (const line of linesRun(block, 'roll')) {
            const top = Math.min(100, rollOf(line) ?? 0);
            const chance = Math.max(0, top - below) / 100;
            below = Math.max(below, top);
            if (chance > 0) add(out, this.steps(stepsRun(line, 'roll')), chance);
          }
          return out;
        }
        case 'steps':
        case 'phrased':
          for (const line of linesRun(block, use)) best(out, this.steps(stepsRun(line, use)));
          return out;
        default: {
          const never: never = use;
          return never;
        }
      }
    });
  }

  /** Each spell or block worked out once; one met again inside its own run makes nothing more. */
  private once(key: string, work: () => Yield): Yield {
    const held = this.held.get(key);
    if (held !== undefined) return held;
    if (this.open.has(key)) return empty();
    this.open.add(key);
    try {
      const found = work();
      this.held.set(key, found);
      return found;
    } finally {
      this.open.delete(key);
    }
  }
}

const rounded = (copies: number): number => Number(copies.toPrecision(6));

function made(of: ReadonlyMap<number, number>): BuiltMade | undefined {
  const rows = [...of]
    .filter(([, copies]) => copies > 0)
    .sort(([a], [b]) => a - b)
    .map(([id, copies]): [number, number] => [id, rounded(copies)]);
  return rows.length > 0 ? rows : undefined;
}

function runOf(by: BuiltRunBy, found: Yield): BuiltRun | null {
  if (!makes(found)) return null;
  const gi = made(found.items);
  const sm = made(found.monsters);
  return { ...by, ...(gi === undefined ? {} : { gi }), ...(sm === undefined ? {} : { sm }) };
}

/** A typed phrase's gate: a quest flag on the way, else the items it uses up. */
function gateOf(found: Yield): { q?: 1; u?: number[] } {
  if (found.quest) return { q: 1 };
  return found.uses.size > 0 ? { u: [...found.uses].sort((a, b) => a - b) } : {};
}

/**
 * Each phrase of a keyword block a player types (`Rooms.CMD`) or asks a
 * monster (`GreetTXT`), less any that `isStepArgument`.
 */
function phrases(
  block: Textblock | undefined,
  makings: Makings
): Array<{ say: string; found: Yield }> {
  const out: Array<{ say: string; found: Yield }> = [];
  for (const line of block?.lines ?? []) {
    const say = phraseOf(line);
    if (say === null || isStepArgument(say)) continue;
    const found = makings.steps(phrasedSteps(line));
    if (makes(found)) out.push({ say, found });
  }
  return out;
}

const byNumber = (rows: Record<string, unknown>[], column: string): Record<string, unknown>[] =>
  [...rows].sort((a, b) => (number(a[column]) ?? 0) - (number(b[column]) ?? 0));

/** `ShopType` 11: a gang house shop, which never restocks (`Shop.Regen`). */
export const GANG_HOUSE_SHOP = 11;
/** `ShopType` 12: a deed shop, filled to each deed's game limit on no timer (`Shop.FillShop`). */
export const DEED_SHOP = 12;

/**
 * Whether the realm refills a shop slot (format 50). By the shop's kind first:
 * a gang house shop never regenerates ("don't do any regen in gh shops") and a
 * deed shop is filled whatever its slot says. Otherwise a slot is filled only
 * where `Max`, `Amount` and `%` are all above zero; a database that states
 * none of them is read as it was before, restocked.
 */
export function slotRestocks(
  kind: number | null,
  figure: (field: Exclude<ShopSlotField, 'Time'>) => number | null
): boolean {
  if (kind === GANG_HOUSE_SHOP) return false;
  if (kind === DEED_SHOP) return true;
  const figures = (['Max', 'Amount', '%'] as const).map(figure);
  if (figures.every((value) => value === null)) return true;
  return figures.every((value) => (value ?? 0) > 0);
}

/** `rowProfile`, handed in: it lives in `buildRealm.ts`, which imports this file. */
export type ProfileOf = (row: Record<string, unknown>) => MobProfile | null;

export function indexSupply(
  source: RealmSource,
  blocks: ReadonlyMap<number, Textblock>,
  spells: readonly BuiltSpell[],
  profileOf: ProfileOf
): BuiltSupply {
  const makings = new Makings(blocks, new Map(spells.map((spell) => [spell.id, spell])));
  const supply: BuiltSupply = { sh: [], rt: [], ro: [], runs: [] };
  const push = (by: BuiltRunBy, found: Yield): void => {
    const run = runOf(by, found);
    if (run !== null) supply.runs.push(run);
  };

  for (const row of byNumber(source.table('Shops')?.rows ?? [], 'Number')) {
    const shop = number(row['Number']);
    const kind = number(row['ShopType']);
    // A deed shop restocks, to each deed's limit and on no timer, so it rates nothing.
    if (shop === null || shop <= 0 || kind === DEED_SHOP) continue;
    for (const { item, figure } of shopSlots(row)) {
      const [minutes, amount, percent] = [figure('Time'), figure('Amount'), figure('%')];
      if (!slotRestocks(kind, figure) || minutes === null || minutes <= 0) continue;
      // `slotRestocks` admits a database stating none of the figures, which has no rate.
      if (amount === null || percent === null) continue;
      supply.sh.push([shop, item, amount, percent, minutes]);
    }
  }

  for (const row of byNumber(source.table('Monsters')?.rows ?? [], 'Number')) {
    const m = number(row['Number']);
    if (m === null || m <= 0) continue;
    const clock = number(row['RegenTime']);
    if (clock !== null && clock > 0) supply.rt.push([m, clock]);
    if (/(^|,)\s*Group:\s/.test(text(row['Summoned By']))) supply.ro.push(m);

    const drops = empty();
    for (const { item, percent } of dropSlots(row)) {
      if (percent === null || percent <= 0) continue;
      drops.items.set(item, (drops.items.get(item) ?? 0) + Math.min(100, percent) / 100);
    }
    push({ k: 'drop', m }, drops);
    const create = number(row['CreateSpell']);
    if (create !== null && create > 0) push({ k: 'arrive', m }, makings.spell(create));
    const death = number(row['DeathSpell']);
    if (death !== null && death > 0) push({ k: 'death', m }, makings.spell(death));
    // A spell in a fight may come every round; one round's chance is the floor, which errs rare.
    const profile = profileOf(row);
    for (const cast of profile?.casts ?? []) {
      push({ k: 'fight', m, p: rounded(cast.chance) }, makings.spell(cast.spell));
    }
    for (const attack of profile?.attacks ?? []) {
      if (attack.kind !== 'spell') continue;
      const p = rounded(attack.chance * attack.castChance);
      if (p > 0) push({ k: 'attack', m, p }, makings.spell(attack.spell));
    }
    const greet = number(row['GreetTXT']);
    if (greet === null || greet <= 0) continue;
    for (const { say, found } of phrases(blocks.get(greet), makings)) {
      push({ k: 'ask', m, say, ...gateOf(found) }, found);
    }
  }

  for (const row of byNumber(source.table('Items')?.rows ?? [], 'Number')) {
    const it = number(row['Number']);
    if (it === null || it <= 0) continue;
    for (const [ability, spell] of abilityPairs(row)) {
      if (ability === HAZARD_ABILITY.castsSpell && spell > 0)
        push({ k: 'use', it }, makings.spell(spell));
    }
  }

  const rooms = [...(source.table('Rooms')?.rows ?? [])].sort(
    (a, b) =>
      (number(a['Map Number']) ?? 0) - (number(b['Map Number']) ?? 0) ||
      (number(a['Room Number']) ?? 0) - (number(b['Room Number']) ?? 0)
  );
  // One run per command block and phrase: 2,213 rooms in gmud.mdb share 380 of them.
  const typed = new Map<string, BuiltRun & { k: 'say' }>();
  for (const row of rooms) {
    const cmd = number(row['CMD']);
    const map = number(row['Map Number']);
    const room = number(row['Room Number']);
    if (cmd === null || cmd <= 0 || map === null || room === null) continue;
    for (const { say, found } of phrases(blocks.get(cmd), makings)) {
      const key = `${cmd}:${say}`;
      const held = typed.get(key);
      if (held !== undefined) {
        held.at.push(`${map}/${room}`);
        continue;
      }
      const run = runOf({ k: 'say', at: [`${map}/${room}`], say, ...gateOf(found) }, found);
      if (run === null || run.k !== 'say') continue;
      typed.set(key, run);
      supply.runs.push(run);
    }
  }
  return supply;
}

/** Every item the supply names, so the item index can name it back. */
export function itemsInSupply(supply: BuiltSupply): Set<number> {
  const found = new Set<number>(supply.sh.map(([, item]) => item));
  for (const run of supply.runs) {
    if (run.k === 'use') found.add(run.it);
    if ((run.k === 'ask' || run.k === 'say') && run.u !== undefined)
      for (const id of run.u) found.add(id);
    for (const [id] of run.gi ?? []) found.add(id);
  }
  return found;
}
