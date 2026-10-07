/**
 * What a piece of gear is worth to a character and which of it a purse buys:
 * the arithmetic the Gear card and the planner extension both read. Pure over
 * the slot rankings (`upgrades.ts`); what an item gives is the sheet's figure
 * (armour class added, or damage a round added for a weapon), unless a survey
 * of the character wearing it measured the exp an hour it moves.
 */
import { placesIn, wornOfWord } from './items';
import { REALM_ARMOUR_SCALE } from './menace';
import type { GearRow, SlotWorn } from './upgrades';

/** What an item adds where it is worn; null where it cannot be said. */
export interface GearGain {
  /** Exp an hour more at the best spot the character could then hunt; null where not surveyed. */
  expPerHour: number | null;
  /** Armour class added on the sheet. */
  armourClass: number | null;
  /** Damage a round added, for a weapon. */
  perRound: number | null;
}

/** The places of a slot's kind (two ring fingers), as the realm's `Worn` code holds them. */
export function placesOf(slot: string): number {
  const code = wornOfWord(slot);
  return code === null ? 1 : placesIn(code);
}

/**
 * What an item gives on the sheet: armour class over what is worn, or for a
 * weapon `perRound`, the damage a round the best attack gains holding it (a
 * punch or a kick swings no weapon, so an empty hand is not nothing).
 */
export function sheetGain(
  slot: Pick<SlotWorn, 'ranking' | 'wornFigure'>,
  item: Pick<GearRow, 'figure'>,
  perRound: number | null
): GearGain {
  if (slot.ranking === 'weapon') return { expPerHour: null, armourClass: null, perRound };
  const more = item.figure === null ? null : item.figure - (slot.wornFigure ?? 0);
  return {
    expPerHour: null,
    armourClass: more === null ? null : more / REALM_ARMOUR_SCALE,
    perRound: null
  };
}

/** The sheet's gain as one figure: armour added plus damage a round added. */
export function sheetFigure(gain: GearGain | null): number {
  return (gain?.armourClass ?? 0) + (gain?.perRound ?? 0);
}

/** An item as the worth reads it: what it gives and what it costs, in copper. */
export interface Priced {
  gain: GearGain | null;
  copper: number;
}

export interface Worth {
  /** Whether `gain` is a survey's exp an hour rather than the sheet's figure. */
  surveyed: boolean;
  gain: number;
  sheet: number;
  perCopper: number;
}

/**
 * What an item gives: the survey's exp an hour where it moved the rate, else
 * the sheet's armour or damage. A survey reading of no change falls back to
 * the sheet (one point of armour moves nothing in a level 1 fight); a reading
 * below it keeps the item out, since wearing it costs exp. Null where it gives
 * nothing.
 */
export function worth(item: Priced): Worth | null {
  const exp = item.gain?.expPerHour ?? null;
  if (exp !== null && exp < 0) return null;
  const surveyed = exp !== null && exp > 0;
  const sheet = sheetFigure(item.gain);
  const gain = surveyed ? exp : sheet;
  return gain > 0 ? { surveyed, gain, sheet, perCopper: gain / Math.max(1, item.copper) } : null;
}

/** Items giving nothing last, the rest by `then`. */
function ranked(a: Priced, b: Priced, then: (wa: Worth, wb: Worth) => number): number {
  const wa = worth(a);
  const wb = worth(b);
  if (wa === null || wb === null) return wa === null ? (wb === null ? 0 : 1) : -1;
  return then(wa, wb);
}

/**
 * Best first across slots: a surveyed gain before a sheet's figure, then the
 * most per copper, which orders the slots when the purse cannot cover them all.
 */
export function byWorth(a: Priced, b: Priced): number {
  return ranked(a, b, (wa, wb) =>
    wa.surveyed !== wb.surveyed ? (wa.surveyed ? -1 : 1) : wb.perCopper - wa.perCopper
  );
}

/**
 * The item in one slot giving the most, whatever it costs; null where none
 * gives anything. They compare on exp only when every one was surveyed,
 * otherwise all on the sheet: the survey reaches only some items, and which
 * ones must not decide the slot. A tie goes to the cheaper.
 */
export function bestOfSlot<T>(items: readonly T[], priced: (item: T) => Priced): T | null {
  const rated = items.flatMap((item) => {
    const rating = worth(priced(item));
    return rating === null ? [] : [{ item, rating, copper: priced(item).copper }];
  });
  const by = rated.every((each) => each.rating.surveyed) ? 'gain' : 'sheet';
  let best: (typeof rated)[number] | null = null;
  for (const each of rated) {
    const more = best === null ? 1 : each.rating[by] - best.rating[by];
    if (best === null || more > 0 || (more === 0 && each.copper < best.copper)) best = each;
  }
  return best?.item ?? null;
}

/** Per slot the item giving the most (`bestOfSlot`), the slots most per copper first. */
export function bestPerSlot<T extends Priced & { slot: string }>(options: readonly T[]): T[] {
  return [...bySlot(options).values()]
    .flatMap((items) => {
      const best = bestOfSlot(items, (item) => item);
      return best === null ? [] : [best];
    })
    .sort(byWorth);
}

/** Options grouped by slot, in the order each slot first appears. */
function bySlot<T extends { slot: string }>(options: readonly T[]): Map<string, T[]> {
  const slots = new Map<string, T[]>();
  for (const option of options) {
    const items = slots.get(option.slot);
    if (items === undefined) slots.set(option.slot, [option]);
    else items.push(option);
  }
  return slots;
}

/**
 * What `budget` copper buys: one item a place, each slot's best the copper
 * left still covers (`bestOfSlot`), the slot giving most per copper taken
 * first, until nothing more fits. A ring slot takes as many items as it has
 * places, never one item twice.
 */
export function withinBudget<T extends Priced & { slot: string; item: number }>(
  options: readonly T[],
  budget: number,
  places: (slot: string) => number = placesOf
): T[] {
  const slots = bySlot(options);
  const taken: T[] = [];
  let left = budget;
  for (;;) {
    let pick: T | null = null;
    for (const [slot, items] of slots) {
      const here = taken.filter((each) => each.slot === slot);
      if (here.length >= places(slot)) continue;
      const open = items.filter(
        (item) => item.copper <= left && !here.some((each) => each.item === item.item)
      );
      const best = bestOfSlot(open, (item) => item);
      if (best !== null && (pick === null || byWorth(best, pick) < 0)) pick = best;
    }
    if (pick === null) return taken;
    taken.push(pick);
    left -= pick.copper;
  }
}
