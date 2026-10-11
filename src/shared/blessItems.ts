/**
 * The items in the realm that would bless this character when used, what
 * each adds and where each comes from: the Gear card's Bless Items face
 * (todo 44). Built in main by `world/blessItems.ts`; the figures are the ones
 * the fight simulator weighs (`effectOf`).
 */
import { PLAIN_SPEED, type BlessingEffect } from './blessingeffects';
import type { ChargeCapacity } from './charges';
import type { GearCounter } from './upgrades';

/** A figure a blessing moves, in `BlessingEffect`'s units. */
export const BLESS_FIGURES = [
  'armourClass',
  'damageResist',
  'magicRes',
  'dodge',
  'accuracy',
  'maxDamage',
  'martialAccuracy',
  'martialDamage',
  'crits',
  'maxHp',
  'hpRegen',
  'speed'
] as const;

export type BlessFigure = (typeof BLESS_FIGURES)[number];

/** One figure the spell moves, and by how much; `speed` is per cent faster (negative slower). */
export interface BlessAdd {
  figure: BlessFigure;
  value: number;
}

export interface BlessItem {
  /** The realm's `Items` row. */
  item: number;
  name: string;
  spell: string;
  /** What it adds at the character's level; never empty. */
  adds: BlessAdd[];
  capacity: ChargeCapacity;
  /** A use comes back: unlimited, or kept at none and refilled each new day (`renews`). */
  renews: boolean;
  /** The spell lands on everyone in the party in the room. */
  party: boolean;
  minLevel: number | null;
  /** The counter least out of the way that stocks it, or null where none does. */
  sold: GearCounter | null;
  counters: number;
  droppedBy: readonly string[];
  /** Who a realm script hands it over from, by name or room. */
  givenBy: readonly string[];
}

/** The figures an effect moves, in `BLESS_FIGURES` order; a martial row is its best attack's. */
export function addsOf(effect: BlessingEffect): BlessAdd[] {
  const best = (rows: Readonly<Record<string, number>>): number => Math.max(...Object.values(rows));
  const value = (figure: BlessFigure): number => {
    switch (figure) {
      case 'martialAccuracy':
        return best(effect.martialAccuracy);
      case 'martialDamage':
        return best(effect.martialDamage);
      case 'speed':
        // Below `PLAIN_SPEED` a blow costs less energy: faster.
        return PLAIN_SPEED - effect.speed;
      case 'armourClass':
      case 'damageResist':
      case 'magicRes':
      case 'dodge':
      case 'accuracy':
      case 'maxDamage':
      case 'crits':
      case 'maxHp':
      case 'hpRegen':
        return effect[figure];
      default: {
        const never: never = figure;
        return never;
      }
    }
  };
  return BLESS_FIGURES.flatMap((figure) => {
    const moved = value(figure);
    return moved === 0 ? [] : [{ figure, value: moved }];
  });
}
