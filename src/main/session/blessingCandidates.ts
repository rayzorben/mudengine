/**
 * What Auto Choose Blessings weighs (`BlessingChoice`, todo 10 and 41): the
 * spellbook's self blessings at the character's level, and every carried item
 * that blesses (`carriedBlessings`). An item cast skips the spellbook and the
 * level (`UseCommand` calls `TrySpell` with its check overridden) but pays the
 * spell's mana and rolls the caster's own spellcasting (`InitiateSpell`,
 * `TryInvokeSpell`), so both are priced the same way. See
 * mudengine-automation › *Recovery*.
 */
import type { BlessingCandidate, BlessingVia, ItemHand } from '../../shared/blessingchoice';
import { effectOf } from '../../shared/blessingeffects';
import type { BlessingConfig } from '../../shared/blessings';
import type { CharacterState } from '../../shared/character';
import { offRoundPlan, type HandsOf } from '../../shared/gear';
import { carriedBlessings, type BlessingRealm, type ItemBlessing } from '../../shared/invoke';
import { effectSeconds, scaledDuration } from '../../shared/menace';
import { castOdds, type ProwessSheet } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import { castsOnSelf, sameSpell, spellTargeting } from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';

/** What pricing a candidate reads besides the spell. */
export interface CandidatePricing {
  level: number;
  sheet: ProwessSheet;
  family: RealmFamily | null;
  /** The realm's speed, which a duration in ticks is read at. */
  speed: number;
  /** This character's measured duration of the spell, seconds; null unmeasured. */
  learnedDuration(spell: string): number | null;
}

/** The book's self blessings this character can cast at its level, each priced. */
export function bookCandidates(
  bare: CharacterState,
  pricing: CandidatePricing,
  own: readonly BlessingConfig[],
  spellOf: (name: string) => WorldSpell | null
): BlessingCandidate[] {
  if (bare.spellbook === null) return [];
  return bare.spellbook.flatMap((known): BlessingCandidate[] => {
    const spell = spellOf(known.name);
    if (spell === null || (known.level ?? spell.level ?? 0) > pricing.level) return [];
    const row = own.find((each) => sameSpell(each.spell, known.name, bare.spellbook, spellOf));
    const candidate = priced(known.name, spell, pricing, { kind: 'book', row: row ?? null });
    return candidate === null ? [] : [candidate];
  });
}

/**
 * The carried items that bless, each priced. Only a listed pack: an unlisted
 * one is not an empty one. A weapon in the pack carries its swap's commands
 * and armour in the pack is `not-worn`, so the choice can price the one and
 * say why it passed over the other.
 */
export function itemCandidates(
  bare: CharacterState,
  pricing: CandidatePricing,
  realm: BlessingRealm,
  handsOf: HandsOf
): BlessingCandidate[] {
  if (bare.inventory.listedAt === null) return [];
  const items = bare.inventory.items;
  return carriedBlessings(items, realm).flatMap(
    ({ item, blessing, equipped }): BlessingCandidate[] => {
      const hand = handOf(item, blessing, equipped, items, handsOf);
      const candidate = priced(item, blessing.spell, pricing, { kind: 'item', item, hand });
      return candidate === null ? [] : [candidate];
    }
  );
}

/** How `use` takes the item as carried; a swap is the one `AutoInvoke` sends. */
function handOf(
  item: string,
  blessing: ItemBlessing,
  equipped: boolean,
  items: CharacterState['inventory']['items'],
  handsOf: HandsOf
): ItemHand {
  if (equipped || !blessing.mustBeEquipped) return { kind: 'ready' };
  if (!blessing.weapon) return { kind: 'not-worn' };
  // The `use` is a cast like any book cast; the commands around it are the swap.
  const commands = offRoundPlan(item, null, items, handsOf).length - 1;
  return commands < 1 ? { kind: 'not-worn' } : { kind: 'swap', commands };
}

/**
 * A spell as a candidate: one that lands on the caster and weighs something
 * the fight reads, with its expected cost and how long it lasts. Null where
 * it is neither.
 */
function priced(
  name: string,
  spell: WorldSpell,
  pricing: CandidatePricing,
  via: BlessingVia
): BlessingCandidate | null {
  const aim = spellTargeting(spell.targets);
  if (aim === 'unknown' || !castsOnSelf(aim)) return null;
  const effect = effectOf(spell, pricing.level);
  if (effect === null) return null;
  // The book's own spelling, which its measurement was kept under; an item's spell by its whole name.
  const measured = pricing.learnedDuration(via.kind === 'book' ? name : spell.name);
  const ticks = scaledDuration(spell, pricing.level);
  return {
    name,
    spell,
    effect,
    cost: castOdds(spell, pricing.sheet, pricing.family)?.expectedMana.value ?? null,
    duration:
      measured !== null && measured > 0
        ? { seconds: measured, from: 'measured' }
        : ticks > 0
          ? { seconds: effectSeconds(ticks, pricing.speed), from: 'realm' }
          : null,
    via
  };
}
