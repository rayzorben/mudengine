/**
 * How many uses a copy of a charged item has left, as far as the wire has
 * said (todo 44). The server never lists a copy's `UsesLeft` in the pack;
 * `look <item>` prints `Uses remaining: N` for one with a `UseCount`, a `use`
 * of one kept at none prints `There are no more uses in X.`, a `use` whose
 * cast worked spends one (`UseCommand.Execute`; a failed roll spends none),
 * and the cleanup gives back the item's `Recharge`. Unknown is null, never full.
 */
import { abilityValues, RECHARGE_ABILITY } from './abilities';
import type { WorldItem } from './world';

/** What the realm says a copy can hold. */
export type ChargeCapacity =
  | { kind: 'unlimited' }
  | {
      kind: 'charged';
      /** `UseCount`: a fresh copy's uses. */
      of: number;
      /** `Recharge`: uses given back at each cleanup, 0 where it has none. */
      daily: number;
      /** `Retain After Uses`: kept at none left rather than destroyed. */
      retains: boolean;
    };

export type Charged = Extract<ChargeCapacity, { kind: 'charged' }>;

/** Null where the realm states no `UseCount`. */
export function chargeCapacity(
  item: Pick<WorldItem, 'uses' | 'abilities' | 'retains'>
): ChargeCapacity | null {
  if (item.uses === -1) return { kind: 'unlimited' };
  if (item.uses === undefined || item.uses <= 0) return null;
  const daily = abilityValues(item.abilities, RECHARGE_ABILITY).reduce(
    (sum, each) => sum + each,
    0
  );
  return {
    kind: 'charged',
    of: item.uses,
    daily: Math.max(0, daily),
    retains: item.retains === true
  };
}

/**
 * Whether a use spends nothing that does not come back: unlimited, or kept at
 * none left and given uses back at each cleanup.
 */
export function renews(capacity: ChargeCapacity): boolean {
  return capacity.kind === 'unlimited' || (capacity.retains && capacity.daily > 0);
}

/** What the wire said about one copy. */
export type ChargeEvent =
  /** `Uses remaining: N`, the answer to a `look` at it. */
  | { kind: 'looked'; uses: number }
  /** A `use` of it whose spell landed. */
  | { kind: 'used' }
  /** `There are no more uses in X.` */
  | { kind: 'used-up' }
  /** `A new day has come!`: the cleanup ran `RechargeAll`. */
  | { kind: 'new-day' };

/**
 * A copy's uses left after `event`, from `left` (null unknown). `capacity`
 * is the realm's, null where it states none: a look's count stands as read,
 * and a cleanup leaves the count unknown.
 */
export function chargesAfter(
  left: number | null,
  capacity: Charged | null,
  event: ChargeEvent
): number | null {
  switch (event.kind) {
    case 'looked': {
      const uses = Math.max(0, event.uses);
      return capacity === null ? uses : Math.min(capacity.of, uses);
    }
    case 'used':
      return left === null ? null : Math.max(0, left - 1);
    case 'used-up':
      return 0;
    case 'new-day':
      if (capacity === null) return null;
      // A recharge that fills the item fills it from anything; a smaller one
      // adds to a count the client does not have.
      if (capacity.daily >= capacity.of) return capacity.of;
      return left === null ? null : Math.min(capacity.of, left + capacity.daily);
    default: {
      const never: never = event;
      return never;
    }
  }
}
