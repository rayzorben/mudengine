/**
 * Saving for something (todo 63): what the next level or a piece of gear costs
 * against the purse, and how long to take earning it. The provider chooses;
 * the plan turns the shortfall over the hours into the copper an hour the hunt
 * should earn (`hunting.cashPerHour`), and reaching the copper asks again.
 */
import type { KonamiBrief } from './konamiBrief';
import type { KonamiQuestion, KonamiSaving } from './konami';
import { number, offerLabel, purseText } from './konamiPurse';

/** The hours offered to earn a saving in. */
const SAVE_WITHIN = [1, 2, 4, 8] as const;

/** A target offered, with what is still short of it. */
export interface SavingOffer extends KonamiSaving {
  short: number;
}

export interface SavingLabels {
  /** Label to target; `none` is null. */
  saveFor: Readonly<Record<string, SavingOffer | null>>;
  saveWithin: Readonly<Record<string, number>>;
}

/**
 * What can be saved for: the level that is ready, while the copper carried does
 * not cover the trainer; and, per slot, the cheapest upgrade offered that the
 * purse does not reach, cheapest slots first, so a robe for a gold can be
 * weighed against one for two platinum without every item sold being sent.
 * Nothing while the purse is unread, since every shortfall would be a guess.
 * Empty where nothing is short.
 */
export function savingOffers(brief: KonamiBrief, most: number): Record<string, SavingOffer> {
  const offers: Record<string, SavingOffer> = {};
  const { trainCost, levelReady, cash, level } = brief.character;
  const carried = cash.onHand;
  const total = cash.total;
  if (carried === null || total === null) return offers;
  if (levelReady === true && trainCost !== null && trainCost > carried) {
    offers['train'] = {
      what: 'training the level that is ready',
      copper: trainCost,
      carried: true,
      short: trainCost - carried
    };
  }
  const gear: Array<[string, SavingOffer]> = [];
  for (const slot of brief.gear) {
    let cheapest: [string, SavingOffer] | null = null;
    for (const [index, offer] of slot.offers.entries()) {
      if (offer.copper === null || offer.copper <= total) continue;
      if (cheapest !== null && cheapest[1].copper <= offer.copper) continue;
      // Saved for ahead of the level it needs, which the provider is told.
      const needs =
        offer.minLevel !== null && level !== null && offer.minLevel > level
          ? ` (wearable from level ${offer.minLevel})`
          : '';
      cheapest = [
        offerLabel(slot, index),
        {
          what: `${offer.name} for the ${slot.slot} slot at ${offer.shop}${needs}`,
          copper: offer.copper,
          carried: false,
          short: offer.copper - total
        }
      ];
    }
    if (cheapest !== null) gear.push(cheapest);
  }
  gear.sort((a, b) => a[1].copper - b[1].copper);
  for (const [label, offer] of gear.slice(0, most)) offers[label] = offer;
  return offers;
}

/** The best copper an hour the spots offered pay, and where. */
function bestCash(brief: KonamiBrief): { name: string; perHour: number } | null {
  let best: { name: string; perHour: number } | null = null;
  for (const spot of brief.hunting.spots) {
    const perHour = spot.cash.perHour;
    if (perHour !== null && perHour > 0 && (best === null || perHour > best.perHour)) {
      best = { name: spot.name, perHour };
    }
  }
  return best;
}

/** The two saving questions, or none where nothing is short. */
export function savingQuestions(
  brief: KonamiBrief,
  aim: string,
  most: number
): { questions: Record<string, KonamiQuestion>; labels: SavingLabels } {
  const offers = savingOffers(brief, most);
  if (Object.keys(offers).length === 0) {
    return { questions: {}, labels: { saveFor: {}, saveWithin: {} } };
  }
  const best = bestCash(brief);
  const saveFor: Record<string, SavingOffer | null> = { none: null };
  const forCriteria: Record<string, string> = {
    none: 'Save for nothing: hunt for exp alone.'
  };
  for (const [label, offer] of Object.entries(offers)) {
    saveFor[label] = offer;
    const pace =
      best === null
        ? 'No spot offered carries coin.'
        : `The most copper a spot offered pays is ${number(best.perHour)} an hour (${best.name}): about ${number(offer.short / best.perHour, 1)} hours there.`;
    forCriteria[label] =
      `Save for ${offer.what}: ${offer.copper} copper${offer.carried ? ' carried' : ''}, ${offer.short} short. ${pace}`;
  }
  const saveWithin: Record<string, number> = {};
  const withinCriteria: Record<string, string> = {};
  for (const hours of SAVE_WITHIN) {
    const label = `hours_${hours}`;
    saveWithin[label] = hours;
    withinCriteria[label] =
      `Earn it over ${hours} hour${hours === 1 ? '' : 's'}: the shortfall over ${hours} is the copper an hour the hunt asks for.`;
  }
  return {
    questions: {
      saveFor: {
        type: 'choice',
        instructions:
          `${aim} Should the character save cash for something, and for what? ${purseText(brief)} ` +
          `While it saves, the hunt prefers spots and lairs whose monsters carry coin, even at a cost in exp, ` +
          `and a new plan is asked for once the copper is there. Save for what can be reached: ` +
          `a target many hours away at the copper rates offered costs more exp than it is worth.`,
        criteria: forCriteria
      },
      saveWithin: {
        type: 'choice',
        instructions: `${aim} If the character saves, over how many hours should it earn the copper? Fewer hours ask more copper an hour, and cost more exp.`,
        criteria: withinCriteria
      }
    },
    labels: { saveFor, saveWithin }
  };
}

/** The saving a reply chose, and the copper an hour it asks of the hunt. */
export function readSaving(
  labels: SavingLabels,
  chosen: { saveFor: string | null; saveWithin: string | null }
): { saving: KonamiSaving | null; cashPerHour: number } | null {
  // Unasked or unanswered leaves the player's own floor, as every other question does.
  if (Object.keys(labels.saveFor).length === 0 || chosen.saveFor === null) return null;
  const offer = labels.saveFor[chosen.saveFor] ?? null;
  if (offer === null) return { saving: null, cashPerHour: 0 };
  const within = chosen.saveWithin === null ? undefined : labels.saveWithin[chosen.saveWithin];
  const hours = within ?? SAVE_WITHIN[0];
  const { what, copper, carried } = offer;
  return { saving: { what, copper, carried }, cashPerHour: Math.ceil(offer.short / hours) };
}
