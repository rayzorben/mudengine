/**
 * The saved gear held from a death until each item comes back (todo 82).
 *
 * A death locks every saved slot to what was in it, so spare gear worn on the
 * way back to the corpse is not saved, and Re-equip Gear after `recover
 * corpse` puts on what the character died in. A slot frees when its item is
 * carried again (taken from the corpse, bought, picked up), or when the play
 * allowance (`playedFor`) has run out. Pure, and in `shared/` because the
 * parser (`died`, `rememberGear`) and `GearLockWatch` both use it. See
 * `mudengine-automation` › gear.
 */
import type { CarriedItem } from './character';
import type { Loadout, WornSlot } from './gear';
import { sameItem } from './items';

/**
 * The loadout a death leaves: every free slot locked at `at`. A slot still
 * locked from an earlier death keeps that lock, so a second corpse cannot
 * make the spare gear the saved gear.
 */
export function lockLoadout(held: Loadout, at: number, played: number): Loadout {
  if (held.every((worn) => worn.locked !== null)) return held;
  return held.map((worn) => (worn.locked === null ? { ...worn, locked: { at, played } } : worn));
}

/**
 * The loadout with a lock lifted for each locked item the pack holds again.
 *
 * One carried copy frees one slot of that name, in slot order. A slot a
 * different worn item still fills stays locked until that item comes off:
 * freed while the spare is on, the next listing would save the spare, and the
 * re-equip after the recover would find nothing to put on.
 */
export function freeLoadout(held: Loadout, items: readonly CarriedItem[]): Loadout {
  if (held.every((worn) => worn.locked === null)) return held;
  const used = new Set<CarriedItem>();
  let changed = false;
  const next = held.map((worn) => {
    if (worn.locked === null || filledByAnother(worn, items)) return worn;
    const copy = items.find((item) => !used.has(item) && sameItem(item.name, worn.item));
    if (copy === undefined) return worn;
    used.add(copy);
    changed = true;
    return { ...worn, locked: null };
  });
  return changed ? next : held;
}

function filledByAnother(worn: WornSlot, items: readonly CarriedItem[]): boolean {
  const key = worn.slot.toLowerCase();
  return items.some(
    (item) => item.equipped && item.slot?.toLowerCase() === key && !sameItem(item.name, worn.item)
  );
}

/** The slots still held. */
export function lockedSlots(held: Loadout): WornSlot[] {
  return held.filter((worn) => worn.locked !== null);
}

/** The locked slots whose allowance has run out at `played` (`playedFor`). */
export function expiredSlots(held: Loadout, played: number, allowanceMs: number): WornSlot[] {
  return held.filter((worn) => worn.locked !== null && played - worn.locked.played >= allowanceMs);
}

/** Play time left on the oldest lock, or null when nothing is held. */
export function allowanceLeft(held: Loadout, played: number, allowanceMs: number): number | null {
  const marks = held.flatMap((worn) => (worn.locked === null ? [] : [worn.locked.played]));
  if (marks.length === 0) return null;
  return Math.max(0, allowanceMs - (played - Math.min(...marks)));
}

/** The loadout with the named slots freed. The same reference when none was held. */
export function releaseSlots(held: Loadout, slots: readonly string[]): Loadout {
  const named = new Set(slots.map((slot) => slot.toLowerCase()));
  if (!held.some((worn) => worn.locked !== null && named.has(worn.slot.toLowerCase()))) return held;
  return held.map((worn) =>
    named.has(worn.slot.toLowerCase()) ? { ...worn, locked: null } : worn
  );
}
