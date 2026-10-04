/**
 * The scrolls a counter sells that teach a spell the character does not know
 * and the server would not refuse it (`learnVerdict`), each with the counter
 * least out of the way and its price: what a planner reads to buy and `read`
 * one. The spell is the scroll's `LearnSp` row, by id, never by name: two
 * rows share `minor healing`, a Priest's and anyone's.
 */
import type { CharacterState } from '../../shared/character';
import {
  learnVerdict,
  listsSpell,
  taughtBy,
  type Learner,
  type SpellScroll
} from '../../shared/learning';
import type { WorldItem, WorldSpell } from '../../shared/world';
import { counterOf, nearestCounters, type UpgradeRealm } from './gearUpgrades';

export interface ScrollRealm extends Pick<UpgradeRealm, 'stockingPlaces' | 'priceAt'> {
  itemsWhere(test: (item: WorldItem) => boolean): readonly WorldItem[];
  spellById(id: number): WorldSpell | null;
}

export function spellScrolls(
  state: CharacterState,
  learner: Learner,
  realm: ScrollRealm
): SpellScroll[] {
  const book = state.spellbook ?? [];
  const wanted: Array<{ item: WorldItem; spell: WorldSpell; verdict: SpellScroll['verdict'] }> = [];
  for (const item of realm.itemsWhere((row) => taughtBy(row).length > 0)) {
    for (const id of taughtBy(item)) {
      const spell = realm.spellById(id);
      if (spell === null || listsSpell(book, spell.name)) continue;
      const verdict = learnVerdict(spell, learner);
      if (verdict.kind === 'refused') continue;
      // A book never read may list it already: unknown, not learnt.
      wanted.push({
        item,
        spell,
        verdict: state.spellbook === null ? { kind: 'unknown' } : verdict
      });
    }
  }
  if (wanted.length === 0) return [];
  const nearest = nearestCounters(
    realm.stockingPlaces([...new Set(wanted.map((each) => each.item.id))])
  );
  return wanted.flatMap(({ item, spell, verdict }): SpellScroll[] => {
    const place = nearest.get(item.id);
    if (place === undefined) return [];
    return [
      { item: item.id, name: item.name, spell, verdict, sold: counterOf(place, item.name, realm) }
    ];
  });
}
