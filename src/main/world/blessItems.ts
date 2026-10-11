/**
 * Every item in the realm that would bless this character when used and is
 * not carried: the spell lands on the user (self or the party in the room),
 * carries something the fight simulator weighs at the character's level
 * (`effectOf`), and the character's level may use it. Each comes with the
 * counter least out of the way that sells it and its price, the monsters that
 * drop it and the scripts that hand it over (todo 44). Ordered by whether a
 * use comes back, then the nearest counter, then the name.
 */
import { effectOf } from '../../shared/blessingeffects';
import { addsOf, type BlessItem } from '../../shared/blessItems';
import type { CharacterState } from '../../shared/character';
import { renews } from '../../shared/charges';
import { blessingOf, type BlessingRealm } from '../../shared/invoke';
import { bareName } from '../../shared/items';
import { spellTargeting } from '../../shared/spellcraft';
import type { WorldItem } from '../../shared/world';
import { counterOf, nearestCounters, wearableAt, type UpgradeRealm } from './gearUpgrades';

export interface BlessItemRealm
  extends Pick<UpgradeRealm, 'stockingPlaces' | 'priceAt'>, Pick<BlessingRealm, 'spellById'> {
  itemsWhere(test: (item: WorldItem) => boolean): readonly WorldItem[];
  /** The monsters whose drop list names an item of this name. */
  dropsOf(item: string): readonly string[];
}

/** The list, or null while the character's level is unread. */
export function blessItems(state: CharacterState, realm: BlessItemRealm): BlessItem[] | null {
  const level = state.progress.level;
  if (level === null) return null;
  const carried = new Set(state.inventory.items.map((item) => bareName(item.name)));
  const found = realm
    .itemsWhere(
      (row) => !carried.has(bareName(row.name)) && wearableAt(row.minLevel ?? null, level)
    )
    .flatMap((row) => {
      const blessing = blessingOf(row, realm);
      if (blessing === null) return [];
      const targeting = spellTargeting(blessing.spell.targets);
      if (targeting !== 'self' && targeting !== 'party') return [];
      const effect = effectOf(blessing.spell, level);
      return effect === null ? [] : [{ row, blessing, party: targeting === 'party', effect }];
    });
  if (found.length === 0) return [];
  const places = realm.stockingPlaces([...new Set(found.map(({ row }) => row.id))]);
  const nearest = nearestCounters(places);
  const counters = new Map<number, number>();
  for (const place of places) counters.set(place.item, (counters.get(place.item) ?? 0) + 1);
  const items = found.map(({ row, blessing, party, effect }): BlessItem => {
    const place = nearest.get(row.id);
    return {
      item: row.id,
      name: row.name,
      spell: blessing.spell.name,
      adds: addsOf(effect),
      capacity: blessing.capacity,
      renews: renews(blessing.capacity),
      party,
      minLevel: row.minLevel ?? null,
      sold: place === undefined ? null : counterOf(place, row.name, realm),
      counters: counters.get(row.id) ?? 0,
      droppedBy: realm.dropsOf(row.name),
      givenBy: (row.from ?? []).flatMap((each) => {
        const who = each.who ?? each.place ?? each.room;
        return who === undefined ? [] : [who];
      })
    };
  });
  return items.sort(
    (a, b) =>
      Number(b.renews) - Number(a.renews) ||
      (a.sold?.moves ?? Infinity) - (b.sold?.moves ?? Infinity) ||
      a.name.localeCompare(b.name)
  );
}
