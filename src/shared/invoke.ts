/**
 * The blessing a carried item can be used for, read from the realm: what
 * `AutoInvoke` asks before it sends `use <item>`, and what the Spells page
 * lists for the player to choose from. One reading, so the list never offers
 * an item the automation would refuse. The rules are `UseCommand.cs` and
 * `Player.InitiateSpell`; see `mudengine-automation` › parts/recovery.md.
 */
import type { CarriedItem } from './character';
import { bareName, itemInvocation, sameItem } from './items';
import { nameAnswersTo, type WorldItem, type WorldSpell } from './world';

/** The realm lookups a blessing needs. `WorldGraph` answers both. */
export interface BlessingRealm {
  itemsNamed(names: readonly string[]): Readonly<Record<string, WorldItem | undefined>>;
  spellById(id: number): WorldSpell | null;
}

export interface ItemBlessing {
  spell: WorldSpell;
  /**
   * A weapon or armour, which the server uses only while it is worn or
   * wielded (`You do not have <item> equipped.`). An item whose kind the
   * realm does not state is taken as one, since a `use` refused costs a
   * command and a bless missed costs nothing.
   */
  mustBeEquipped: boolean;
}

/**
 * The blessing the item a listing spelled `name` casts for ever, or null.
 *
 * Only an unlimited item (the realm says `UseCount: -1`; silence is not
 * unlimited, and a charge spent on a buff does not come back), and only a
 * spell with a duration, since anything else is not a blessing.
 */
export function carriedBlessing(name: string, realm: BlessingRealm): ItemBlessing | null {
  const item = realm.itemsNamed([name])[name];
  if (item === undefined) return null;
  // The pack's spelling has to be one the server resolves to this item, or
  // the command goes out for something else.
  if (!nameAnswersTo(bareName(item.name), name)) return null;
  const invocation = itemInvocation(item);
  if (invocation === null || !invocation.unlimited) return null;
  const spell = realm.spellById(invocation.spell);
  if (spell === null || spell.duration === undefined || spell.duration <= 0) return null;
  return { spell, mustBeEquipped: item.kind !== undefined ? isWorn(item.kind) : true };
}

function isWorn(kind: NonNullable<WorldItem['kind']>): boolean {
  return kind === 'weapon' || kind === 'armour';
}

/** One row of the Spells page's list of items that can bless. */
export interface InvokeChoice {
  /** The item, as the inventory spells it without its slot. */
  item: string;
  spell: string;
  /** The spell's mana, or null where the realm states none. */
  mana: number | null;
  /** Worn or wielded now. */
  equipped: boolean;
  mustBeEquipped: boolean;
}

/** Every item in a listed inventory that can bless, each name once. */
export function invokeChoices(items: readonly CarriedItem[], realm: BlessingRealm): InvokeChoice[] {
  const byName = new Map<string, InvokeChoice>();
  for (const carried of items) {
    const item = bareName(carried.name);
    const blessing = carriedBlessing(item, realm);
    if (blessing === null) continue;
    const known = byName.get(item);
    // Two of one weapon, one wielded: the row says what can be used now.
    if (known !== undefined && (known.equipped || !carried.equipped)) continue;
    byName.set(item, {
      item,
      spell: blessing.spell.name,
      mana: blessing.spell.mana ?? null,
      equipped: carried.equipped,
      mustBeEquipped: blessing.mustBeEquipped
    });
  }
  return [...byName.values()];
}

/** Whether `invokeWith` names this item. */
export function chosenToInvoke(chosen: readonly string[], item: string): boolean {
  return chosen.some((name) => sameItem(name, item));
}
