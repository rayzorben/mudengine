/**
 * The purse as the provider is told it (todos 61, 63): what is carried and
 * banked against what the next level and the cheapest upgrade out of reach
 * cost. Shared by the coin question and the saving questions.
 */
import { bankedCopper } from './coins';
import type { KonamiGoal, KonamiSaving } from './konami';
import type { KonamiBrief, SlotUpgrade } from './konamiBrief';
import { goalKey, itemKey, refusedLately } from './konamiLessons';
import { REALM_ARMOUR_SCALE } from './menace';

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

/**
 * The upgrade to buy now, without asking (todo 77). The item a plan saves for
 * first, once the purse covers it; otherwise the cheapest offer the level
 * wears and the purse covers with the next training and the saving still in
 * hand. An item whose trip was refused within `refusedForMs` is left out.
 * Null where none. Soul held 5,000 to 18,000 copper for an hour and bought
 * nothing, and punched after its staff was lost.
 */
export function upgradeToBuy(
  brief: KonamiBrief,
  refusedForMs: number,
  saving: KonamiSaving | null
): Extract<KonamiGoal, { kind: 'buy' }> | null {
  const { cash, trainCost, level } = brief.character;
  if (cash.total === null) return null;
  const refused = new Set(
    refusedLately(brief.history, 'buy', brief.at, refusedForMs).map((lesson) =>
      goalKey(lesson.goal)
    )
  );
  const offers = brief.gear.flatMap((slot) =>
    slot.offers.flatMap((offer) => {
      if (offer.copper === null || refused.has(itemKey(offer.item))) return [];
      if (offer.minLevel !== null && level !== null && offer.minLevel > level) return [];
      const goal: Extract<KonamiGoal, { kind: 'buy' }> = {
        kind: 'buy',
        item: offer.item,
        name: offer.name,
        slot: slot.slot,
        shop: offer.shop,
        at: offer.at,
        copper: offer.copper
      };
      return [goal];
    })
  );
  const purse = cash.total - (trainCost ?? 0);
  const saved =
    saving?.item === null || saving === null
      ? undefined
      : offers.find((goal) => goal.item === saving.item);
  if (saved !== undefined && saved.copper <= purse) return saved;
  // Short of the item saved for: what it costs stays in hand.
  const spare = saved === undefined ? purse : purse - saved.copper;
  return offers
    .filter((goal) => goal.copper <= spare)
    .reduce<Extract<KonamiGoal, { kind: 'buy' }> | null>(
      (best, goal) => (best === null || goal.copper < best.copper ? goal : best),
      null
    );
}

/** The label an upgrade is offered under, buying it or saving for it: its slot and its place there. */
export function offerLabel(slot: SlotUpgrade, index: number): string {
  return `buy_${slot.slot.toLowerCase().replace(/[^a-z]+/g, '_')}_${index}`;
}

/**
 * The copper training the level that is ready costs, while what is carried does
 * not cover it (the trainer's trip draws on no bank); null otherwise. Reaching
 * it is a trigger, since a level that can be paid for is trained first.
 */
export function trainNotCarried(brief: KonamiBrief): number | null {
  const { levelReady, trainCost, cash } = brief.character;
  return levelReady === true &&
    trainCost !== null &&
    cash.onHand !== null &&
    trainCost > cash.onHand
    ? trainCost
    : null;
}

/**
 * What an item gives in the sheet's own figures: damage a round for a weapon,
 * armour class for armour (the realm's item figure is ten times the sheet's).
 */
export function slotGives(ranking: SlotUpgrade['ranking'], figure: number | null): number | null {
  if (figure === null) return null;
  return ranking === 'weapon' ? figure : figure / REALM_ARMOUR_SCALE;
}
