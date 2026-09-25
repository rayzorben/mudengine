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
import type { CarriedItem, CharacterState, Coins, Denomination } from '../../shared/character';
import { coinNamed, DENOMINATIONS } from '../../shared/character';
import { wireItem, type ItemEntity } from '../../shared/entities';
import { bareName, countedName, sameItem } from '../../shared/items';

/**
 * The entries of a listing of **things**, which this server separates with
 * commas and never with `and`, each with its trailing full stop taken off.
 * Shared by the tracker and the console's rewrite of the same listing.
 *
 * `list` below (for prose) splits on ` and ` too, and that is wrong wherever an item's own name
 * contains the word: the shipped realm has two — `rope and grapple` and `black
 * and white serpent ring` — and the first is the item 157 of its exits are
 * gated on, so the router could never see one in a pack that held it. Both
 * appear in the corpus inside real listings, comma-separated
 * (`captures/044`: `… lyrist's companion (Back), black and white serpent ring
 * (Finger), jeweled main-gauche (Off-Hand) …`; `captures/119`: `You notice …
 * 2 rope and grapple, 2 mine pass, …`), and across all 218 captures **not one**
 * of the four listings this splits — 600 `You notice`, 25 `You are carrying`,
 * 17 key lines, and the coins inside them — uses ` and ` as a separator.
 *
 * `list` keeps the ` and ` for the listings measured the same way and left
 * alone: `Also here:` (1,240 lines), `Obvious exits:` (2,628) and the bare
 * purse sentence, which has one sample in the corpus and is prose, where a
 * final `and` is exactly what prose does. Widening a rule past its evidence in
 * either direction is the thing this file refuses.
 */
export function itemList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/\.$/, ''))
    .filter((entry) => entry.length > 0);
}

/** Splits a comma/`and` separated list, each entry trimmed and its closing full stop dropped. */
export function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/,| and /)
    .map((entry) => entry.trim().replace(/\.$/, ''))
    .filter((entry) => entry.length > 0);
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
  const denomination = coinNamed(match.groups['coin']!);
  return denomination === undefined ? null : { denomination, count };
}

/**
 * The five counts a listing that enumerates the purse states: each coin it
 * named, and **zero** for every denomination it did not. An entry that is not
 * a coin (null) says nothing about the purse. Read by the pack listing and by
 * `wealth`'s one line (`ledger.ts`).
 *
 * That is the one place coins depart from "null is not zero", and the
 * departure is what makes the maintained shape work at all: a listing
 * establishes the counts and the pick-up sentences keep them true until the
 * next one, which they can only do from a number. Before any listing every
 * count is null — nobody has said — and a pick-up then leaves it null rather
 * than claiming the coins picked up were the whole purse. Zero is still never
 * *drawn*; the row shows what is there (`mudengine-wire` › *Coins are five
 * facts*).
 */
export function coinsListed(entries: ReadonlyArray<ReturnType<typeof parseCoinEntry>>): Coins {
  const coins = Object.fromEntries(DENOMINATIONS.map((name) => [name, 0])) as Record<
    Denomination,
    number | null
  >;
  for (const coin of entries) if (coin) coins[coin.denomination] = coin.count;
  return coins;
}

export function parseCarriedEntries(entry: string): CarriedItem[] {
  // Coins go to `inventory.coins`, not into the item list: `9 copper farthings`
  // among the items would land in the encumbrance count and in the paste of
  // what somebody is carrying, where it is not an item anybody means.
  if (parseCoinEntry(entry) !== null) return [];
  const { count, name } = countedName(entry);
  // No figure to take off, so there is nothing to expand and the entry is the
  // item exactly as the listing spelled it.
  if (name === entry.trim()) return [parseCarried(entry)];
  const item = parseCarried(name);
  // A count never carries a slot — the worn one is listed on its own — so a
  // figure in front of an annotated entry is part of the name after all.
  if (item.slot !== null) return [parseCarried(entry)];
  return Array.from({ length: count }, () => ({ ...item }));
}

/**
 * One entry of the key listing, as the keys it stands for.
 *
 * The second half of the `i` block counts exactly as the first does, and until
 * 2026-09-06 nothing here took the figure off. Across the 218 captures the
 * corpus holds six distinct key lines and **four of them are counted**:
 * `2 black star keys`, `2 golden idols` (captures/002 and /038), against the
 * plain `bone key` and a realm that lists two the long way,
 * `golden idol, golden idol`. Expanding the counted form into instances is
 * what makes those last two spellings the same fact — and taking the figure
 * off the front is what lets the realm's row for the key be found at all,
 * which is the whole of the reported bug: `2 bone key` in the pack, `Key: 177`
 * on the door, and the router saying the key was missing.
 *
 * A plural the count brought with it is **left on the name**. Only an index
 * can say whether `keys` is this realm's plural of `key` or the last word of
 * the item, and this file has no index; `WorldGraph.itemIdNamed` settles it
 * where the realm can be asked.
 */
export function parseKeyEntries(entry: string): string[] {
  const { count, name } = countedName(entry);
  return Array.from({ length: count }, () => name);
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
 * Something dropped here, as an entity — **or one more of what is already
 * lying here.**
 *
 * `hydrate` is a parameter because resolving a name against the realm asks the
 * world graph, which is the tracker's — this module is `state in → state out`
 * and holds nothing. Without one the floor still gains a whole wire entity,
 * which is the dual-source rule.
 *
 * A name already on the floor used to be a **no-op**, and that was right for
 * exactly as long as the floor could not count: the room prints one entry per
 * name, so a second of a thing had nowhere to go. It counts now
 * (`You notice … 66 bone key, 2 amethyst ring here.`), so the second one goes
 * on the count — which is what the maintained-listing rule asks of a
 * broadcast, keeping the listing true until the next `You notice` states it
 * again.
 */
export function withRoomItem(
  state: CharacterState,
  item: string,
  hydrate?: (name: string) => ItemEntity,
  count = 1
): CharacterState {
  const added = Math.max(1, count);
  const index = state.room.items.findIndex((there) => sameItem(there.name, item));
  const items = [...state.room.items];
  if (index >= 0) {
    const there = items[index]!;
    items[index] = { ...there, count: (there.count ?? 1) + added };
  } else {
    const entity: ItemEntity = hydrate?.(item) ?? wireItem(item);
    items.push(added > 1 ? { ...entity, count: added } : entity);
  }
  return { ...state, room: { ...state.room, items } };
}

/**
 * One off the floor — **one**, not the pile it was part of.
 *
 * This filtered the whole entry out, and that was right for exactly as long as
 * the count was glued to the front of the name: `sameItem('66 bone key',
 * 'bone key')` was false, so `You took bone key.` matched nothing and the
 * floor was left for the next `You notice` to restate. With the count split
 * off (2026-09-06) the name matches, and filtering would have one `get` erase
 * sixty-five keys the server would still print — a broadcast making the
 * listing *false*, which is the opposite of what the broadcasts are for.
 *
 * An entry with no count is one, so it goes as it always did. The name is
 * still all the floor can be searched by, which is why the count is the only
 * thing this can be more careful about.
 */
export function withoutRoomItem(state: CharacterState, item: string, count = 1): CharacterState {
  const index = state.room.items.findIndex((there) => sameItem(there.name, item));
  if (index < 0) return state;
  const there = state.room.items[index]!;
  const left = (there.count ?? 1) - Math.max(1, count);
  const items = [...state.room.items];
  if (left <= 0) items.splice(index, 1);
  else items[index] = { ...there, count: left };
  return { ...state, room: { ...state.room, items } };
}
