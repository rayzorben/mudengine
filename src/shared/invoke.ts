/**
 * The blessing a carried item can be used for, read from the realm: what
 * `AutoInvoke` asks before it sends `use <item>`, and what the Spells page
 * lists for the player to choose from. One reading, so the list never offers
 * an item the automation would refuse. The rules are `UseCommand.cs` and
 * `Player.InitiateSpell`; see `mudengine-automation` › parts/recovery.md.
 */
import type { CarriedItem } from './character';
import { chargeCapacity, renews, type ChargeCapacity } from './charges';
import { bareName, itemInvocation, sameItem } from './items';
import { castsOnSelf, spellTargeting } from './spellcraft';
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
  /**
   * The item casts more spells after this one. Each is refused for the round
   * (`You have already cast a spell this round!`) every time it is used.
   */
  several: boolean;
  /**
   * A weapon by the realm's word, which can be wielded from the pack for the
   * cast and put away again (todo 42). False where the kind is unstated.
   */
  weapon: boolean;
  /** Unlimited, or the uses a fresh copy holds and gets back each day. */
  capacity: ChargeCapacity;
}

/**
 * The blessing the item a listing spelled `name` casts for ever, or null.
 *
 * Only an unlimited item (the realm says `UseCount: -1`; silence is not
 * unlimited, and a charge spent on a buff does not come back until the
 * cleanup). A charged one is `itemBlessing`, which routine upkeep never uses.
 */
export function carriedBlessing(name: string, realm: BlessingRealm): ItemBlessing | null {
  const blessing = itemBlessing(name, realm);
  return blessing?.capacity.kind === 'unlimited' ? blessing : null;
}

/**
 * The blessing an item casts whose uses come back (`renews`): unlimited, or
 * kept at none left and refilled at each cleanup. What `AutoInvoke` uses and
 * the Spells page lists (todo 44); a charge spent on one returns by the next
 * day, while a potion's or an unrecharged wand's never does.
 */
export function renewingBlessing(name: string, realm: BlessingRealm): ItemBlessing | null {
  const blessing = itemBlessing(name, realm);
  return blessing !== null && renews(blessing.capacity) ? blessing : null;
}

/**
 * The blessing the item a listing spelled `name` casts, charged or not, or
 * null. Only a spell with a duration that lands on the user, since anything
 * else is not a blessing, and only an item whose `UseCount` the realm states.
 */
export function itemBlessing(name: string, realm: BlessingRealm): ItemBlessing | null {
  const item = realm.itemsNamed([name])[name];
  if (item === undefined) return null;
  // The pack's spelling has to be one the server resolves to this item, or
  // the command goes out for something else.
  if (!nameAnswersTo(bareName(item.name), name)) return null;
  return blessingOf(item, realm);
}

/** The blessing a realm row casts on `use`, charged or not, or null: `itemBlessing` without the name. */
export function blessingOf(
  item: WorldItem,
  realm: Pick<BlessingRealm, 'spellById'>
): ItemBlessing | null {
  const invocation = itemInvocation(item);
  const capacity = chargeCapacity(item);
  if (invocation === null || capacity === null) return null;
  const spell = realm.spellById(invocation.spell);
  if (spell === null || spell.duration === undefined || spell.duration <= 0) return null;
  // A lasting spell aimed at a monster (`disease` on a nightblack scythe,
  // `bites` on a serrated dwarven axe, `Targets` 8) is a curse. `unknown`
  // passes, as for `castsOnSelf`'s other callers: a derivative realm may not
  // state the column.
  if (!castsOnSelf(spellTargeting(spell.targets))) return null;
  return {
    spell,
    mustBeEquipped: item.kind !== undefined ? isWorn(item.kind) : true,
    several: invocation.spells.length > 1,
    weapon: item.kind === 'weapon',
    capacity
  };
}

/** What the realm says a copy of the item the pack spelled `name` holds; null unstated. */
export function capacityNamed(
  name: string,
  realm: Pick<BlessingRealm, 'itemsNamed'> | undefined
): ChargeCapacity | null {
  const item = realm?.itemsNamed([name])[name];
  return item === undefined ? null : chargeCapacity(item);
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
  /**
   * The spell lands on everyone in the party in the room (`FullPartyArea`,
   * targets 13): a bare `use` blesses them all (todo 43).
   */
  party: boolean;
  /**
   * A charged item's `UseCount` and daily `Recharge`, with the uses left as
   * the wire last said (null unknown); null for an unlimited item.
   */
  charges: { of: number; daily: number; left: number | null } | null;
}

/** A carried item that can bless, as the pack lists it. */
export interface CarriedBlessing {
  /** The item, as the inventory spells it without its slot. */
  item: string;
  blessing: ItemBlessing;
  /** Worn or wielded now. */
  equipped: boolean;
}

/**
 * Every item in a listed inventory that can bless, each name once: the
 * reading the Spells page lists and Auto Choose Blessings weighs.
 */
export function carriedBlessings(
  items: readonly CarriedItem[],
  realm: BlessingRealm,
  reading: (name: string, realm: BlessingRealm) => ItemBlessing | null = carriedBlessing
): CarriedBlessing[] {
  const byName = new Map<string, CarriedBlessing>();
  for (const carried of items) {
    const item = bareName(carried.name);
    const blessing = reading(item, realm);
    if (blessing === null) continue;
    const known = byName.get(item);
    // Two of one weapon, one wielded: the row says what can be used now.
    if (known !== undefined && (known.equipped || !carried.equipped)) continue;
    byName.set(item, { item, blessing, equipped: carried.equipped });
  }
  return [...byName.values()];
}

/**
 * Every item in a listed inventory that can bless and whose uses come back,
 * each name once; `usesLeft` is the ledger's count for a charged one.
 */
export function invokeChoices(
  items: readonly CarriedItem[],
  realm: BlessingRealm,
  usesLeft: (item: string) => number | null
): InvokeChoice[] {
  return carriedBlessings(items, realm, renewingBlessing).map(({ item, blessing, equipped }) => ({
    item,
    spell: blessing.spell.name,
    mana: blessing.spell.mana ?? null,
    equipped,
    mustBeEquipped: blessing.mustBeEquipped,
    party: spellTargeting(blessing.spell.targets) === 'party',
    charges: chargesOf(blessing.capacity, () => usesLeft(item))
  }));
}

function chargesOf(capacity: ChargeCapacity, left: () => number | null): InvokeChoice['charges'] {
  return capacity.kind === 'unlimited'
    ? null
    : { of: capacity.of, daily: capacity.daily, left: left() };
}

/**
 * The carried items Auto Choose Blessings picked (`BlessingChoice`), which
 * `AutoInvoke` uses in place of `invokeWith`.
 */
export interface ChosenItems {
  /** The items, by the pack's spelling; null where nothing was chosen or the switch is off. */
  chosenItems(): readonly string[] | null;
}

/** No choice: `invokeWith` always stands. */
export const NO_CHOSEN_ITEMS: ChosenItems = { chosenItems: () => null };

/** Whether `invokeWith` names this item. */
export function chosenToInvoke(chosen: readonly string[], item: string): boolean {
  return chosen.some((name) => sameItem(name, item));
}
