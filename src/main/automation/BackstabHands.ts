/**
 * What the hands held before the derived backstab weapon went on (todo 76),
 * so the fight after the backstab puts it back. Read off the pack listing:
 * whatever is wielded that is not a weapon chosen for the backstab is the
 * character's own weapon, with the off-hand beside it. A weapon the player
 * wields by hand is therefore what comes back. See `shared/backstab.ts`.
 */
import { chosenForBackstab } from '../../shared/backstab';
import type { CarriedItem } from '../../shared/character';
import { inOffHand, heldWeapon } from '../../shared/gear';

export class BackstabHands {
  /** Every weapon chosen for a backstab this session. */
  private readonly chosen = new Set<string>();
  /** The weapon hand's item and then the off-hand's, as last seen without a backstab weapon in hand. */
  private before: readonly string[] = [];

  /** Notes the weapon chosen now (null for none) and the hands; returns what to put back. */
  note(items: readonly CarriedItem[], weapon: string | null): readonly string[] {
    if (weapon !== null) this.chosen.add(weapon);
    const hand = heldWeapon(items);
    if (hand !== undefined && !chosenForBackstab(this.chosen, hand.name)) {
      const off = inOffHand(items);
      this.before = off === undefined ? [hand.name] : [hand.name, off.name];
    }
    return this.before;
  }

  reset(): void {
    this.chosen.clear();
    this.before = [];
  }
}
