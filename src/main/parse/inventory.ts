/**
 * What a character is carrying, and how the two sources that talk about it are
 * reconciled.
 *
 * Pulled out of `CharacterTracker` because it is the one cluster in that file
 * with no dependence on the tracker's own state: every function here is
 * `state in -> state out`, or a string in and a value out. What it encodes is
 * one idea, stated at length because every line of it was a bug first — **the
 * two sources for a maintained list are written by different parts of the
 * server and do not have to agree on spelling.** A listing formats for a
 * column (`padded boots (Feet)`); a broadcast formats for a sentence (`You
 * dropped padded boots.`).
 *
 * The rest of that idea:
 *
 * - **The pack holds instances, not names.** A character can carry two of a
 *   thing, so every gain is one more row and every loss takes **the spare
 *   before the worn one** — which is the server's own order for `drop`, `hide`
 *   and `sell`.
 * - **Coins are not items.** They are counted by denomination in
 *   `inventory.coins`; `9 copper farthings` among the items would land in the
 *   encumbrance count and in the paste of what somebody is carrying.
 * - **A slot no listing has named is not invented**, and a charge is not a
 *   slot.
 *
 * Pure, and therefore directly testable without a stream.
 */
import type {
  BankBalance,
  CarriedItem,
  CharacterState,
  Denomination
} from '../../shared/character';
import { bankKey, DENOMINATIONS } from '../../shared/character';
import { wireItem, type ItemEntity } from '../../shared/entities';
import { bareName, sameItem } from '../../shared/items';

/**
 * A purchase or a sale moving the purse, in the copper the server quoted.
 *
 * `You just bought crystal flask for 980 copper farthings.` and
 * `You sold crystal flask for 275 copper farthings.` both state an **exact
 * figure in copper**, which is the same unit `Wealth:` is normalised into — so
 * unlike a coin pick-up, where the denomination counts move and the total is
 * left for the next listing to restate, there is nothing to convert and no
 * guess to make. The item already moves between the pack and the shop; the
 * money did not, so a shop trip left the purse describing the character as it
 * was before it.
 *
 * **An unknown purse stays unknown.** Adding to or subtracting from `null`
 * would claim this transaction was the whole of it — the refusal the coin
 * pick-up already makes, for the same reason. And the figure is floored at
 * zero: a sale recorded against a stale total must never produce a negative
 * purse, which is a number no readout can mean anything by.
 *
 * The per-denomination counts are deliberately *not* touched. The server does
 * not say which coins it took or gave, and inventing a breakdown that adds up
 * to the right total would be a claim about the purse the wire never made; the
 * next `i` states all five.
 */
export function withSpend(s: CharacterState, copper: number): CharacterState | null {
  const wealth = s.inventory.wealth;
  if (wealth === null || !Number.isFinite(copper) || copper === 0) return null;
  return { ...s, inventory: { ...s.inventory, wealth: Math.max(0, wealth + copper) } };
}

/**
 * Records what one bank just said, leaving every other bank alone.
 *
 * **A merge, against this state's own habit.** Every other listing here is
 * authoritative and replaces what it found; `bank` is authoritative about the
 * vault the character is standing in and silent about all the others, so
 * replacing would empty six banks on the word of a command that named one.
 *
 * Matched on the realm's shop id where both sides have one — the only stable
 * key, because the printed name varies by realm — and on the folded name
 * otherwise. An entry that gains an id later (the character banks the same
 * vault on a realm that prints one) matches by name and keeps the id.
 */
export function withBankBalance(s: CharacterState, said: BankBalance): CharacterState {
  const key = bankKey(said.name);
  /*
   * The id is searched across the **whole** list before the name is considered
   * at all, and the two passes are why.
   *
   * One pass with the choice made per entry takes the first row that matches
   * *either* rule, and an unided row whose name folds the same way sits ahead
   * of the ided row for the same vault — so `Bank of Godfrey (#8)` arriving
   * against a list holding both matched the unided one, updated it, and left
   * the ided row behind. Two rows, one id, one name, two figures, and the
   * card's total counting the vault twice on the one card whose whole subject
   * is money. A character read on GreaterMUD, reconnected to a realm that
   * prints the id, then re-read walks straight through it.
   */
  const byId = said.shop === null ? -1 : s.banks.findIndex((held) => held.shop === said.shop);
  const index = byId === -1 ? s.banks.findIndex((held) => bankKey(held.name) === key) : byId;

  if (index === -1) return { ...s, banks: [...s.banks, said] };

  const banks = s.banks.map((held, at) =>
    at === index ? { ...said, shop: said.shop ?? held.shop } : held
  );
  return { ...s, banks };
}

/**
 * One entry of an `i` listing, split into the name and the slot.
 *
 * The listing is the only source that states a slot, and it states it as a
 * trailing parenthesised group. Only a trailing group and only one, exactly as
 * `sameItem` strips it — an item genuinely called `flask (empty)` reads its
 * annotation as a slot here, which is wrong in a way that costs a label rather
 * than an item, and is the same trade `sameItem` already makes so the two
 * cannot disagree about where a name ends.
 */
export function parseCarried(entry: string): CarriedItem {
  const match = /^(?<name>.*?)\s*\((?<slot>[^()]*)\)\s*$/.exec(entry.trim());
  if (!match?.groups) return wireItem(entry);
  /*
   * `torch (Readied/79)` — captured live, 2026-08-26. The slot is the
   * listing's word, `Readied`; the number after the slash is how much of the
   * torch is left, which is not a slot and is **kept as its own field**.
   *
   * It was stripped and dropped for a phase, which threw away the one number
   * that says whether a light source lights anything: `glowing pearl
   * (Readied/0)` and `(Readied/9999)` are the same slot and opposite facts,
   * and the server proves the difference by answering `You don't have glowing
   * pearl.` for the spent one (measured live, 2026-08-27).
   */
  const stated = /^(?<slot>.*?)\/(?<charges>\d+)$/.exec(match.groups['slot']!.trim());
  const slot = (stated?.groups?.['slot'] ?? match.groups['slot']!).trim();
  const charges = stated?.groups?.['charges'] ?? null;
  const name = match.groups['name']!.trim();
  // A group with nothing in it says nothing. Keep the whole spelling rather
  // than inventing an empty slot for it.
  if (slot.length === 0 || name.length === 0) return wireItem(entry);
  return wireItem(name, {
    slot,
    equipped: true,
    charges: charges === null ? null : Number(charges)
  });
}

/**
 * One entry of the `i` listing, as the instances it stands for.
 *
 * The listing counts too: two of a thing arrive as `2 scroll of magic missile`
 * (captured live, 2026-08-26), and reading that as an item called "2 scroll
 * of magic missile" is the same mistake the sentences already avoid. A count
 * never carries a slot — the worn one is listed on its own — so the copies
 * are plain.
 */
/**
 * A coin entry in the pack listing, or null for anything else.
 *
 * Coins are listed exactly as a helm is — `51 gold crowns, 7 copper farthings,
 * padded helm (Head)` (captured live, `npm run probe:play`) — so they arrive
 * through the same list and have to be told apart here.
 *
 * They used to be *dropped*, on the reasoning that they were already stated by
 * the listing's own `Wealth:` line. Wealth is one number and this is five, and
 * the four it does not carry were produced by the wire, matched by this very
 * regex, and then thrown away: a fact the client did not have because nobody
 * kept it.
 */
export function parseCoinEntry(
  entry: string
): { denomination: Denomination; count: number } | null {
  const match =
    /^(?<count>\d+) (?<coin>copper farthings?|silver nobles?|gold crowns?|platinum pieces?|runic coins?)$/i.exec(
      entry.trim()
    );
  if (!match?.groups) return null;
  const count = Number(match.groups['count']);
  if (!Number.isFinite(count)) return null;
  // The first word is the denomination; the noun after it is realm data and is
  // not depended on beyond telling a coin from an item. A realm that renames
  // one simply stops being counted, which is the safe direction.
  const word = match.groups['coin']!.split(' ')[0]!.toLowerCase();
  const denomination = DENOMINATIONS.find((name) => name === word);
  return denomination === undefined ? null : { denomination, count };
}

export function parseCarriedEntries(entry: string): CarriedItem[] {
  // Coins go to `inventory.coins`, not into the item list: `9 copper farthings`
  // among the items would land in the encumbrance count and in the paste of
  // what somebody is carrying, where it is not an item anybody means.
  if (parseCoinEntry(entry) !== null) return [];
  const counted = /^(?<count>\d+) (?<rest>\S.*)$/.exec(entry.trim());
  if (!counted?.groups) return [parseCarried(entry)];
  const count = Number(counted.groups['count']);
  const item = parseCarried(counted.groups['rest']!);
  if (!Number.isFinite(count) || count < 1 || item.slot !== null) return [parseCarried(entry)];
  return Array.from({ length: count }, () => ({ ...item }));
}

/**
 * The pack holds *instances*, not names.
 *
 * A character can carry two of a thing — captured live, 2026-08-26: `padded
 * gloves (Hands), …, padded gloves`, one worn and one spare — so every gain is
 * one more row, never a no-op because the name was already there. Before this,
 * a second pair bought or picked up vanished from the card, and dropping one
 * pair took both rows with it.
 */
export function gained(items: CarriedItem[], item: string, count: number): CarriedItem[] {
  const added = Array.from({ length: Math.max(1, count) }, () => wireItem(item));
  return [...items, ...added];
}

/**
 * Takes `count` instances of a name out of the pack, spares first.
 *
 * The server's own order, measured: `drop`, `hide` and `sell` take from what
 * is merely carried before they touch what is worn, so with one pair of
 * gloves on the hands and one in the pack, `drop gloves` drops the spare.
 * Removing by name would have taken both, and removing in listing order would
 * have taken the worn pair — either way the card lied about what was still on.
 *
 * The count is the server's (`You dropped 2 padded gloves.`); a count no row
 * satisfies removes what there is. A name that matches nothing is tried once
 * more without a trailing `s`, because a counted sentence may pluralise a name
 * the listing wrote singular — and if that guess is wrong too, nothing is
 * removed and the next `i` corrects it, which is what makes the guess safe.
 */
export function lost(items: CarriedItem[], item: string, count: number): CarriedItem[] {
  const pick = (name: string): number[] => {
    const spare: number[] = [];
    const worn: number[] = [];
    items.forEach((held, index) => {
      if (!sameItem(held.name, name)) return;
      (held.equipped ? worn : spare).push(index);
    });
    return [...spare, ...worn];
  };
  let matches = pick(item);
  if (matches.length === 0 && count > 1 && /s$/i.test(bareName(item))) {
    matches = pick(item.trim().replace(/s$/i, ''));
  }
  if (matches.length === 0) return items;
  const going = new Set(matches.slice(0, Math.max(1, count)));
  return items.filter((_, index) => !going.has(index));
}

export function withItem(state: CharacterState, item: string, count = 1): CharacterState {
  return {
    ...state,
    inventory: { ...state.inventory, items: gained(state.inventory.items, item, count) }
  };
}

export function withoutItem(state: CharacterState, item: string, count = 1): CharacterState {
  const items = lost(state.inventory.items, item, count);
  if (items.length === state.inventory.items.length) return state;
  return { ...state, inventory: { ...state.inventory, items } };
}

/**
 * Puts one instance of an item in use, or takes one out of use, without
 * moving it.
 *
 * Wearing something is not acquiring it — it was already in the pack — so the
 * one thing this must not do is add or remove an entry. It adds one only when
 * the item is not there at all, which happens when something is worn before any
 * `i` has been typed: refusing to would leave the card silent about an item the
 * server has just confirmed the character is holding.
 *
 * **One instance.** With a spare pair of gloves beside the worn pair, `You are
 * now wearing padded gloves.` puts the spare on and leaves the worn pair as it
 * was; marking every row by name would have shown two pairs on two hands.
 */
export function withEquipped(
  state: CharacterState,
  item: string,
  equipped: boolean,
  slot: string | null,
  /**
   * Where `slot` came from, when a listing did not say. Carried onto the item
   * rather than resolved here, because only the caller knows which of its
   * three sources answered — see `CarriedItem.slotSource`.
   */
  slotSource?: 'realm'
): CharacterState {
  // Absent rather than `undefined`, so an item whose slot a listing named
  // carries no key at all and two states built from the same facts compare
  // equal.
  const source = equipped && slot !== null && slotSource !== undefined ? { slotSource } : {};
  const items = state.inventory.items;
  const at = items.findIndex((held) => sameItem(held.name, item) && held.equipped !== equipped);
  if (at === -1) {
    // Every instance is already in the asked-for state, or there is none.
    if (!equipped || items.some((held) => sameItem(held.name, item))) return state;
    return {
      ...state,
      inventory: {
        ...state.inventory,
        items: [...items, { ...wireItem(item, { slot, equipped: true }), ...source }]
      }
    };
  }
  const changed = items.map((held, index) => {
    if (index !== at) return held;
    // The slot goes away with the item coming off: the listing would not print
    // one, and a removed boot still labelled `Feet` reads as worn. The source
    // goes with it — there is no word left for it to describe — which is why
    // the row is rebuilt from its fields rather than spread over.
    const kept: CarriedItem = {
      ...held,
      slot: equipped ? slot : null,
      slotSource: undefined,
      equipped,
      charges: held.charges
    };
    // `slotSource` is deleted rather than left undefined so a row that never
    // had one is `toEqual` a row that lost one — the two are the same fact.
    delete kept.slotSource;
    return equipped ? { ...kept, ...source } : kept;
  });
  return { ...state, inventory: { ...state.inventory, items: changed } };
}

/**
 * A readied light's charge, restated by a sentence rather than a listing.
 *
 * `Your torch flickers and goes out.` is the count reaching zero: the torch is
 * still readied and still carried, and `(Readied/0)` is what the next `i`
 * would print. Only the equipped instance is touched — a spare torch in the
 * pack is a different torch — and an item nothing equipped answers to is left
 * alone rather than guessed at.
 */
export function withCharges(state: CharacterState, item: string, charges: number): CharacterState {
  const items = state.inventory.items;
  const at = items.findIndex((held) => held.equipped && sameItem(held.name, item));
  if (at === -1) return state;
  if (items[at]!.charges === charges) return state;
  const changed = items.map((held, index) => (index === at ? { ...held, charges } : held));
  return { ...state, inventory: { ...state.inventory, items: changed } };
}

/**
 * A `look` at **this character**, which is the one listing besides `i` that
 * names a slot.
 *
 * `l vaelor` on yourself prints the same equipment block a look at anybody else
 * does — `silver ring   (Finger)`, one row per slot — and it was read only for
 * what it teaches the realm's slot table and for the *other* player's record.
 * So a ring worn and then looked at still read `in use` on the card, which is
 * the reported complaint: the fact was on the wire, matched by a rule, and
 * dropped for the one character it was actually about.
 *
 * **Authoritative over what is worn, and about nothing else.** The block lists
 * kit, not the pack, so nothing is ever removed here — an item it does not name
 * is one this character is not wearing, not one it does not have. That
 * distinction is what stops a look emptying the card.
 *
 * And "does not name" is only a claim where the block is **exhaustive**.
 * GreaterMUD prints all eighteen slots every time and marks the bare ones
 * `<empty>`; MajorMUD says the same thing by omitting the row (see
 * `withEquipment` in `presence.ts`, where that difference is recorded from the
 * corpus). So an unnamed item is taken out of use when the block printed an
 * `<empty>` — proof it enumerates — or when the slot the client thinks that
 * item is in was printed as belonging to something else. Otherwise it is left
 * alone: on a realm that omits its empty slots there is no evidence either way,
 * and clearing on no evidence is the reassuring guess this project refuses.
 *
 * **A worn instance keeps its row.** With a spare pair of gloves beside the
 * worn pair, the block's one `padded gloves (Hands)` is matched to the pair
 * already in use before the spare is considered — otherwise a look would take
 * the gloves off the hands and put the spare on them.
 */
export function withOwnEquipment(
  state: CharacterState,
  rows: Array<Record<string, string>> | undefined
): CharacterState | null {
  const worn: Array<{ name: string; slot: string }> = [];
  /** Every slot word the block printed, `<empty>` ones included. */
  const printed = new Set<string>();
  let exhaustive = false;

  for (const row of rows ?? []) {
    const name = row['item']?.trim();
    // A charge count is not a slot, exactly as in an `i` listing's annotation.
    const slot = row['slot']?.trim().replace(/\/\d+$/, '');
    if (!name || !slot) continue;
    printed.add(slot);
    if (name === '<empty>') {
      exhaustive = true;
      continue;
    }
    worn.push({ name, slot });
  }

  const items = state.inventory.items;
  /** Which row each carried instance answers to, and which rows are spoken for. */
  const slotOf = new Map<number, string>();
  const claimed = new Set<number>();
  const pass = (wants: (item: CarriedItem) => boolean): void => {
    items.forEach((item, index) => {
      if (slotOf.has(index) || !wants(item)) return;
      const at = worn.findIndex((row, i) => !claimed.has(i) && sameItem(item.name, row.name));
      if (at === -1) return;
      claimed.add(at);
      slotOf.set(index, worn[at]!.slot);
    });
  };
  // The instance already in use first, so a look does not swap a worn pair for
  // its spare; anything else after.
  pass((item) => item.equipped);
  pass(() => true);

  let moved = false;
  const changed: CarriedItem[] = items.map((item, index) => {
    const slot = slotOf.get(index);
    if (slot !== undefined) {
      if (item.equipped && item.slot === slot) return item;
      moved = true;
      return { ...item, equipped: true, slot };
    }
    // Named nowhere in a block that enumerates, or standing in a slot the block
    // gave to something else: not worn.
    const contradicted = exhaustive || (item.slot !== null && printed.has(item.slot));
    if (!item.equipped || !contradicted) return item;
    moved = true;
    return { ...item, equipped: false, slot: null };
  });

  /*
   * Something worn that no listing has ever put in the pack. The same answer
   * `withEquipped` gives: create the entry rather than drop the fact, because
   * the server has just confirmed the character is holding it.
   */
  for (const [at, row] of worn.entries()) {
    if (claimed.has(at)) continue;
    changed.push(wireItem(row.name, { slot: row.slot, equipped: true }));
    moved = true;
  }

  if (!moved) return null;
  return { ...state, inventory: { ...state.inventory, items: changed } };
}

/**
 * Something dropped here, as an entity.
 *
 * `hydrate` is a parameter because resolving a name against the realm asks the
 * world graph, which is the tracker's — this module is `state in → state out`
 * and holds nothing. Without one the floor still gains a whole wire entity,
 * which is the dual-source rule.
 */
export function withRoomItem(
  state: CharacterState,
  item: string,
  hydrate?: (name: string) => ItemEntity
): CharacterState {
  if (state.room.items.some((there) => sameItem(there.name, item))) return state;
  const entity: ItemEntity = hydrate?.(item) ?? wireItem(item);
  return { ...state, room: { ...state.room, items: [...state.room.items, entity] } };
}

export function withoutRoomItem(state: CharacterState, item: string): CharacterState {
  const items = state.room.items.filter((there) => !sameItem(there.name, item));
  if (items.length === state.room.items.length) return state;
  return { ...state, room: { ...state.room, items } };
}
