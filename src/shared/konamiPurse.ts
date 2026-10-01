/**
 * The purse as the provider is told it (todos 61, 63): what is carried and
 * banked against what the next level and the cheapest upgrade out of reach
 * cost. Shared by the coin question and the saving questions.
 */
import { bankedCopper } from './coins';
import type { KonamiBrief, SlotUpgrade } from './konamiBrief';

/** A figure as the provider reads it; an unknown one is said, never 0. */
export const number = (value: number | null, digits = 0): string =>
  value === null ? 'unknown' : value.toFixed(digits);

/** The cheapest item offered that is not yet affordable, in copper; null when none is priced. */
export function nextUpgradePrice(brief: KonamiBrief): number | null {
  const cash = brief.character.cash.total ?? 0;
  let cheapest: number | null = null;
  for (const slot of brief.gear) {
    for (const offer of slot.offers) {
      if (offer.copper === null || offer.copper <= cash) continue;
      if (cheapest === null || offer.copper < cheapest) cheapest = offer.copper;
    }
  }
  return cheapest;
}

/** The purse, and what the next level and the cheapest upgrade out of reach cost. */
export function purseText(brief: KonamiBrief): string {
  const { cash, trainCost, level } = brief.character;
  const train =
    trainCost === null
      ? 'what training costs is unknown'
      : `training costs ${number(trainCost)} copper`;
  const upgrade = nextUpgradePrice(brief);
  const gear =
    upgrade === null
      ? 'no gear upgrade is priced above what is held'
      : `the cheapest gear upgrade not yet affordable costs ${number(upgrade)} copper`;
  return `In copper: ${number(cash.onHand)} carried and ${number(bankedCopper(cash.banks))} banked, at level ${number(level)}; ${train}, and ${gear}.`;
}

/** The label an upgrade is offered under, buying it or saving for it: its slot and its place there. */
export function offerLabel(slot: SlotUpgrade, index: number): string {
  return `buy_${slot.slot.toLowerCase().replace(/[^a-z]+/g, '_')}_${index}`;
}
