/**
 * The realm's reference data — monsters, items, shops, spells, races and
 * classes — read out of a realm file's header once: the rows are never
 * written after, and four indexes derived from them are built on first ask.
 *
 * Carved out of `WorldGraph` (todo 711), which reads this first, its rooms
 * second and the router over both, and keeps a one-line delegation per
 * accessor. No room table lives here: a room is only ever handed in, and what
 * is read is its own columns; a join that has to find a room is the graph's.
 * See `mudengine-world` › *The catalogue is its own unit*.
 */
import { tuning } from '../app/tuning';
import { spellElementOf } from '../../shared/spellchoice';
import {
  mobKey,
  parseLair,
  hazardFor,
  shopKind,
  type ItemHandover,
  type LevelBand,
  type MobAttack,
  type MobCast,
  type MobProfile,
  type MobRowChoice,
  type RoomId,
  type ShopKind,
  type SpellHazard,
  type WorldClass,
  type WorldItem,
  type WorldLair,
  type WorldLookup,
  type WorldMob,
  type WorldMobRow,
  type WorldNames,
  type WorldRace,
  type WorldRoom,
  type WorldShop,
  type WorldShopItem,
  type WorldSpell
} from '../../shared/world';
import type { TrainerRow } from '../../shared/training';
import { spellServes, spellTargeting, type SpellServes } from '../../shared/spellcraft';
import {
  ARMOUR_TYPE,
  WEAPON_CLASS,
  WEAPON_TYPE,
  WORN_SLOT,
  bareName,
  itemInvocation,
  itemKind
} from '../../shared/items';
import { CONFUSE_MESSAGE_ABILITY, HAZARD_ABILITY } from '../../shared/abilities';
import { dispositionFromCode, mobNameCandidates } from '../../shared/mobs';
import { counterPriceInCopper, currencyOfCode } from '../../shared/coins';
import { respawnSeconds } from '../../shared/hunting';
import type { ItemEntity, MobEntity, NpcEntity } from '../../shared/entities';
import type { AttributeSpans } from '../../shared/character';
import type { SpellOption } from '../../shared/ipc';
import type { RealmFamily } from '../../shared/realm';
import type { RealmHeader } from './realmHeader';

export class Catalogue {
  /**
   * The catalogue a realm file's header states, each table read by its
   * loader in the order they depend on — a shop names items, so items first.
   * The rows are never written after; `droppers`, `summoners`, `stockists`
   * and `confusionRows` are derived from them on first ask. `NO_HEADER`
   * states nothing, which every accessor answers as *the realm does not say*;
   * the header's own `v` is what the loaders' format gates read.
   */
  static read(header: RealmHeader): Catalogue {
    const version = header.v;
    const catalogue = new Catalogue();
    catalogue.loadMobs(header['mobs'], version);
    // Only present from v2 on; an older realm file simply names no items.
    catalogue.loadItems(header['items'], version);
    // Both only from v4 on; an older realm names no shops and no spells,
    // and every consumer already has to answer "the realm does not say".
    catalogue.loadShops(header['shops']);
    catalogue.loadSpells(header['spells']);
    // v10. A realm converted by an older build names no races or classes,
    // and every consumer already answers "the realm does not say".
    catalogue.loadRaces(header['races']);
    catalogue.loadClasses(header['classes']);
    catalogue.itemNames = (Array.isArray(header['itemNames']) ? header['itemNames'] : [])
      .map((name) => String(name).trim().toLowerCase())
      .filter((name) => name.length > 0);
    return catalogue;
  }

  private constructor() {}

  // ---------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------

  /** Items some exit requires, by number. Only those; see `build-world.mjs`. */
  private readonly items = new Map<number, WorldItem>();
  /**
   * The same items by name, lower-cased.
   *
   * A second index rather than a scan: the Carrying card asks about every item
   * a character holds each time the listing changes, and a linear search over
   * 1,650 items per item is the shape of thing this whole layer exists to avoid
   * (docs/legacy-assessment.md §5: the CoffeeScript engine ran a query per
   * line, on the main thread). First name wins, because the realm has a handful
   * of duplicates and the earlier row is the one the shops reference.
   */
  private readonly itemsByName = new Map<string, WorldItem>();
  /**
   * Every row a name belongs to, where `itemsByName` keeps only the first.
   *
   * Two indexes on one column because they answer two questions: *what is this
   * thing called `moonstone`* wants one row to describe and takes the first,
   * while *is the thing this exit demands in the pack* has to know that
   * `moonstone` is two rows and therefore says nothing about either. Collapsing
   * the second onto the first would have opened a gate on a name.
   */
  private readonly itemRowsByName = new Map<string, number[]>();
  /**
   * The items whose use casts a spell, by the spell — `Items.Abil-n = CastsSp`
   * the other way round. A room spell's script names the spell that stops it
   * (`failspell 711`), and this is how a plan gets from that to the waterskin.
   */
  private readonly grants = new Map<number, WorldItem[]>();
  /**
   * Every item name the realm has, for recognising one in a line of text.
   * Empty before v11, where the console recognised only the ~100 items some
   * exit needs and whatever the shops stock.
   */
  private itemNames: string[] = [];

  /** The item index out of the header, with the indexes by name and by the spell a use casts. */
  private loadItems(raw: unknown, version: number): void {
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      if (!Number.isInteger(id)) continue;
      const item: WorldItem = { id, name: String(record['n'] ?? '') };
      if (Array.isArray(record['shops'])) item.shops = record['shops'].map(String);
      if (Array.isArray(record['mobs'])) item.mobs = record['mobs'].map(String);
      // Format 39. Absent before it, and absent for the great majority
      // after — a script hands over 46 of the stock realm's items.
      const from = readHandovers(record['from']);
      if (from.length > 0) item.from = from;
      // Where using it puts you — format 40, and a way into somewhere for
      // `WorldGraph.approachItems`. A handful of items per realm.
      const lands = String(record['lands'] ?? '').trim();
      if (lands.length > 0) item.lands = lands as RoomId;
      // And where using it works — format 41. Absent is *wherever you
      // stand*; a pre-41 file says nothing, which reads the same and is
      // the shape format 40 shipped.
      const landsFrom = record['landsFrom'];
      if (Array.isArray(landsFrom)) {
        const where = landsFrom
          .filter((at): at is string => typeof at === 'string' && at.length > 0)
          .map((at) => at as RoomId);
        if (where.length > 0) item.usableIn = where;
      }
      const price = Number(record['price']);
      if (Number.isFinite(price) && price > 0) item.price = price;
      // Format 47: absent is copper, and before it the coin is unknown.
      if (version >= CURRENCY_SINCE) {
        const currency = currencyOfCode(Number(record['cur'] ?? 0));
        if (currency !== null) item.currency = currency;
      }
      const encumbrance = Number(record['enc']);
      if (Number.isFinite(encumbrance) && encumbrance > 0) item.encumbrance = encumbrance;
      /*
       * What it does — format 12, and read *before* the kind rather than
       * inside it.
       *
       * `readItemKind` returns early when the record states no `ItemType`,
       * and the effect pairs used to be read after that gate — so an item
       * with effects and no kind lost every one of them, silently. No item
       * on the shipped realm is in that state, which is exactly why it
       * would not have been noticed: a derivative omitting the column
       * would have dropped the lot with nothing to say so.
       */
      const abilities = readAbilities(record);
      if (abilities.length > 0) item.abilities = abilities;
      /*
       * Who may use it — format 15, and outside `readItemKind` for the
       * same reason the pairs above are: that function returns early on a
       * record with no `ItemType`, and a restriction lost silently is a
       * button the card offers and the server refuses.
       */
      const classes = readIdList(record['cls']);
      if (classes.length > 0) item.classes = classes;
      const races = readIdList(record['race']);
      if (races.length > 0) item.races = races;
      const minLevel = Number(record['lvl']);
      if (Number.isInteger(minLevel) && minLevel > 0) item.minLevel = minLevel;
      /*
       * Format 18. Only the refusals are on disk, so absent is the
       * permissive answer — a derivative realm without the columns must
       * not have its looting and dropping switched off by this client's
       * ignorance of them.
       */
      if (record['ngt'] === 1) item.gettable = false;
      if (record['ndr'] === 1) item.notDroppable = true;
      const limit = Number(record['lim']);
      if (Number.isInteger(limit) && limit > 0) item.limit = limit;
      readItemKind(record, item);
      this.items.set(id, item);
      for (const [ability, spell] of item.abilities ?? []) {
        if (ability !== HAZARD_ABILITY.castsSpell || spell <= 0) continue;
        const holders = this.grants.get(spell);
        if (holders === undefined) this.grants.set(spell, [item]);
        else if (!holders.includes(item)) holders.push(item);
      }
      const key = item.name.trim().toLowerCase();
      if (key.length > 0) {
        if (!this.itemsByName.has(key)) this.itemsByName.set(key, item);
        const rows = this.itemRowsByName.get(key);
        if (rows) rows.push(id);
        else this.itemRowsByName.set(key, [id]);
      }
    }
  }

  /**
   * The `Items` row ids a pack holds, for the two exits that ask *is this
   * thing carried* — a `Key:` lock and an `Item:` gate.
   *
   * Takes the names rather than the pack, because the server prints a
   * character's belongings as two listings — `You are carrying …` and `You
   * have the following keys: bone key.` — which land in two fields, and the
   * question is asked of both at once.
   *
   * The join runs name-to-id and refuses where the name is shared. Twenty of
   * the shipped realm's 1,915 item names belong to two or more rows and four
   * of those are keys (`iron key` is three), so a listing naming one says
   * which *kind* of thing is in the pack and not which row — and a door opened
   * on a coin toss is the confidently wrong answer the router refuses
   * everywhere else. Every one of the 26 items the shipped realm gates an exit
   * on has a name of its own, so the refusal costs nothing that is asked for.
   *
   * `bareName` first, because the listing marks what it prints —
   * `katana (Weapon Hand)`, `torch (Readied/79)` — and the realm's row is
   * called `katana`. It lower-cases as it goes, which is the spelling both
   * indexes are keyed on.
   */
  itemIdsCarried(items: readonly { name: string }[]): number[] {
    const ids: number[] = [];
    for (const item of items) {
      const id = this.itemIdNamed(item.name);
      if (id === null) continue;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * The one `Items` row a name can only mean, or null.
   *
   * The whole of the ambiguity rule above, in one place, because two things
   * now ask it: what the pack holds, and what is lying on the floor of the
   * room a keyed door leads out of. Asked twice with two spellings of the rule
   * is the "two halves of one gate" failure, and here the halves would have
   * been *is this the key* and *may I pick this key up*.
   *
   * **A plural is undone only where the index confirms it.** A counted key
   * entry is pluralised on some realms and not on others — `2 black star keys`
   * and `2 golden idols` in captures/002 and /038 against the row names
   * `black star key` and `golden idol`, and a plain `2 bone key` on the wire
   * that reported this (2026-09-06). The count comes off in the parse
   * (`countedName`); the `s` cannot, because nothing there can tell this
   * realm's plural from an item whose name simply ends in one — `padded
   * gloves`, `rigid leather pants`, `spiked leather boots` are all real rows.
   * Here the realm can be asked, so the trailing `s` is dropped **only** when
   * the shorter name is itself a row the index holds unambiguously. That is a
   * confirmation, not the guess `lost()` makes for want of an index.
   */
  itemIdNamed(name: string): number | null {
    const key = bareName(name);
    if (key.length === 0) return null;
    const exact = this.oneRowNamed(key);
    if (exact !== null) return exact;
    return key.endsWith('s') ? this.oneRowNamed(key.slice(0, -1)) : null;
  }

  /** One row for this exact spelling, or null for absent and for shared. */
  private oneRowNamed(key: string): number | null {
    const rows = this.itemRowsByName.get(key);
    // Absent is a name the realm cannot place; more than one is a name that
    // does not say which row. Both are *nobody has said*, not *not carried*.
    if (rows === undefined) return null;
    if (rows.length === 1) return rows[0]!;
    /*
     * Among several, a row the realm offers no way to hold is never the one
     * held: not gettable, and nothing sells, drops or hands it over. Format 42
     * named the furniture and gave `silver box` — the Guildmaster's handover —
     * a fixed twin. Only among several: `acid gland` is `Gettable` 0 and a
     * script hands it over, so the flag alone says nothing about a pack.
     */
    const holdable = rows.filter((id) => this.holdable(id));
    return holdable.length === 1 ? holdable[0]! : null;
  }

  /** Whether the realm offers any way to be holding this row. See `oneRowNamed`. */
  private holdable(id: number): boolean {
    const item = this.items.get(id);
    if (item === undefined || item.gettable !== false) return true;
    return (
      (item.shops?.length ?? 0) > 0 ||
      (item.mobs?.length ?? 0) > 0 ||
      (item.from?.length ?? 0) > 0 ||
      this.stockedBy(id).length > 0
    );
  }

  /**
   * What the realm knows about items with these names, keyed by the name asked
   * for.
   *
   * By *name*, because a name is all the wire ever gives: an `i` listing writes
   * `padded boots (Feet)` and nothing in it carries the realm's item number.
   * The stripping is the caller's — `sameItem`'s rule, which takes a trailing
   * parenthesised group off — so this only lower-cases and trims.
   *
   * A name the index does not have is simply absent from the result rather than
   * present and empty. About 1,650 of the realm's items are named here — every
   * one some exit demands and every one a shop stocks — which covers gear and
   * does not cover everything a monster drops. Saying nothing about a name it
   * cannot place is the same rule the rest of the world layer follows.
   */
  itemsNamed(names: readonly string[]): Record<string, WorldItem> {
    const found: Record<string, WorldItem> = {};
    for (const name of names) {
      const item = this.itemsByName.get(name.trim().toLowerCase());
      if (item) found[name] = item;
    }
    return found;
  }

  /**
   * An item an exit asks for, if the realm data can name it.
   *
   * Undefined for anything no exit references — the index is deliberately
   * small — and for a realm built before the index existed.
   */
  item(id: number): WorldItem | undefined {
    return this.items.get(id);
  }

  /**
   * Every row a name belongs to, or undefined for a name the realm does not
   * carry — for the graph's join from a name to the rooms its rows stand in.
   */
  itemRowsNamed(name: string): readonly number[] | undefined {
    return this.itemRowsByName.get(name.trim().toLowerCase());
  }

  /** Every item row, in the order the header listed them: the landings and ways in. */
  everyItem(): IterableIterator<WorldItem> {
    return this.items.values();
  }

  /**
   * The items the realm says would serve a condition — the picker's list
   * (todo 19).
   *
   * An item that carries a usable spell (`itemInvocation`, which is the
   * `CastsSp` the server rewrites into `UseSpell` and deliberately steps over
   * a hit-proc) whose row serves the condition asked about. So a list for
   * *poisoned* holds the antidotes and not the healing potions, which is the
   * reviewer's own requirement and the reason it is a realm query rather than
   * a name match: `cure poison potion` casts `violet potion`, and no amount of
   * reading the two names says they are the same fact.
   *
   * Capped, and sorted by name so the same realm answers the same way twice.
   */
  itemsServing(condition: keyof SpellServes, limit = 400): WorldItem[] {
    const found: WorldItem[] = [];
    for (const item of this.items.values()) {
      const invocation = itemInvocation(item);
      if (invocation === null) continue;
      const spell = this.spellById(invocation.spell);
      if (spell === null) continue;
      if (!spellServes(spell.abilities)[condition]) continue;
      found.push(item);
    }
    /*
     * Sorted the way a reader reads a list, which is not the way the default
     * comparison sorts one (todo 00): `localeCompare` on the raw names puts
     * `Kher grass` among the lower-case k's on some locales and ahead of every
     * one on others, so the list looked unsorted where it was merely
     * case-sensitive. Folded, with the raw name as the tie-break so two items
     * differing only in case still have one stable order.
     *
     * The cap is a guard against a pathological realm rather than a page size
     * — the picker scrolls now (todo 00), so a list cut at sixty was hiding
     * items with nothing on screen to say so.
     */
    return found
      .sort(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name)
      )
      .slice(0, limit);
  }

  /**
   * The items whose *use* casts this spell — `Items.Abil-n = CastsSp`, the
   * `grants` index read the other way — for a ward the walk keeps up (todo
   * 105): the waterskin against the desert's spell.
   */
  itemsCasting(spell: number): readonly WorldItem[] {
    return this.grants.get(spell) ?? [];
  }

  /**
   * Every item the realm says stops a room's spell: the ones its script
   * names outright (`failitem`), and the ones whose *use* casts a spell it
   * names (`failspell 711` is the waterskin, through `grants`). In the
   * realm's order, items before spells.
   */
  stoppersOf(spell: number): WorldItem[] {
    const hazard = this.spellById(spell)?.hazard;
    if (hazard === undefined) return [];
    const found: WorldItem[] = [];
    for (const id of hazard.avoidedBy ?? []) {
      const item = this.items.get(id);
      if (item !== undefined && !found.includes(item)) found.push(item);
    }
    for (const id of hazard.avoidedBySpell ?? []) {
      for (const item of this.grants.get(id) ?? []) if (!found.includes(item)) found.push(item);
    }
    return found;
  }

  /**
   * Where the realm says an item comes from: shops that stock it by id, and
   * monsters that drop it by name (todo 07).
   *
   * The public half of the two indexes the quest book already joins, for the
   * one other caller that asks the same question — a route that crosses a
   * keyed door and wants to go and get the key. Both directions, as
   * `QuestPlanner.joinStep` reads them: a shop's stock list and an item's own `shops`, a
   * monster's drop list and an item's own `mobs`.
   */
  sourcesOf(item: { id: number; name?: string }): { shops: string[]; mobs: string[] } {
    const known = this.items.get(item.id);
    const shops = new Set(known?.shops ?? []);
    for (const shop of this.stockedBy(item.id)) shops.add(shop);
    const mobs = new Set(known?.mobs ?? []);
    const name = item.name ?? known?.name;
    if (name !== undefined) for (const mob of this.dropsOf(name)) mobs.add(mob);
    return { shops: [...shops], mobs: [...mobs] };
  }

  // ---------------------------------------------------------------------
  // Monsters
  // ---------------------------------------------------------------------

  /**
   * Every monster the realm names, keyed by lowercased name.
   *
   * By name because that is all the wire gives — the combat lines carry `the
   * giant rat` and never a record id — and the whole table rather than a
   * referenced subset, because any monster can walk into the room.
   */
  private readonly mobs = new Map<string, WorldMob>();
  /** By the realm's own number, for lairs. Empty on a realm built before v9. */
  private readonly mobsById = new Map<number, WorldMob>();
  /**
   * Each row answering for itself, by row number — format 32.
   *
   * A name off the wire folds every row sharing it (`mobs`); a lair names a
   * row outright and a room resolves a name to one (`WorldGraph.resolveMobRow`). A row
   * absent from here is a name the realm places once — the fold *is* the row —
   * or a file written before the format, and both fall back to the fold, which
   * is the cautious reading rather than the reassuring one.
   */
  private readonly rowsById = new Map<number, WorldMobRow>();
  /** Item name -> the monsters that drop it, built with the first join. */
  private droppers: Map<string, string[]> | null = null;
  /** Monster row → the monsters whose death spell summons it — `summonersOf`. */
  private summoners: Map<number, WorldMob[]> | null = null;

  /**
   * The monster index out of the header. Present from v3 on, with a
   * disposition from v5 on.
   *
   * A realm file built before this existed simply names no monsters, and every
   * consumer already has to handle a name the realm cannot place — so an older
   * file degrades to exactly that case rather than failing to load.
   */
  private loadMobs(raw: unknown, version: number): void {
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const name = String(record['n'] ?? '').trim();
      const lo = Number(record['hp']);
      if (name.length === 0 || !Number.isFinite(lo) || lo <= 0) continue;
      const hi = Number(record['hi']);
      const ambiguous = Number.isFinite(hi) && hi > lo;
      // The *high* end is what a bar works from: see `WorldMob`. The span is
      // carried alongside so a card can admit the realm data is not certain.
      const mob: WorldMob = {
        name,
        hp: ambiguous ? hi : lo,
        // Null on a realm built before v5, which is the same answer a realm
        // that never stated the column gives: nothing knows, so nothing swings.
        disposition: dispositionFromCode(record['d']),
        uncertain: record['x'] === 1,
        // `a` always, `s` sometimes, absent never. A realm built before this
        // was indexed says nothing, which reads as never — and never is right:
        // it is what every realm without the column also means.
        costly: record['ep'] === 'a' ? 'always' : record['ep'] === 's' ? 'sometimes' : 'never'
      };
      if (ambiguous) mob.span = [lo, hi];
      /*
       * Format 12. Each absent both on an older realm file and on a realm that
       * states no such column, which every consumer already treats the same
       * way: the realm does not say. `positive` refuses zero for the same
       * reason `number()` in `buildRealm` does — a monster with no armour and
       * a realm that never stated one are the same fact, and neither is "0".
       */
      const positive = (key: string): number | undefined => {
        const value = Number(record[key]);
        return Number.isFinite(value) && value > 0 ? value : undefined;
      };
      mob.armour = positive('ac');
      mob.damageResist = positive('dr');
      mob.magicResist = positive('mr');
      mob.experience = positive('xp');
      mob.regen = positive('rgn');
      // Format 36. Written only where every row of the name agrees, so where
      // it is here it answers for the fold as exactly as a row would.
      mob.regenHours = positive('rt');
      mob.follows = positive('fol');
      if (record['und'] === 1) mob.undead = true;
      const drops = Array.isArray(record['drops'])
        ? record['drops'].filter(
            (name): name is string => typeof name === 'string' && name.length > 0
          )
        : [];
      if (drops.length > 0) mob.drops = drops;
      // Format 18. `realmTypes` is carried and read by nothing; see the field.
      const realmTypes = readIdList(record['ty']);
      if (realmTypes.length > 0) mob.realmTypes = realmTypes;
      mob.averageDamage = positive('dmg');
      mob.charmLevel = positive('chl');
      const casts = readIdList(record['cast']);
      if (casts.length > 0) mob.casts = casts;
      const deathSpell = Number(record['ds']);
      if (Number.isInteger(deathSpell) && deathSpell > 0) mob.deathSpell = deathSpell;
      /*
       * Format 20. Two absences, told apart by the file's own version: a
       * realm written with profiles that states none for this name is saying
       * it fights with nothing, which is `[]` and weighs nothing; a realm
       * written before them says nothing at all, which stays absent and is
       * weighed as unknown — never as harmless.
       */
      const profiles = readProfiles(record['pf']);
      if (profiles.length > 0) mob.profiles = profiles;
      else if (version >= PROFILES_SINCE) mob.profiles = [];
      // What it resists and ignores — format 14, the worst of the rows sharing
      // this name. See `BuiltMob.ab`.
      const abilities = readAbilities(record);
      if (abilities.length > 0) mob.abilities = abilities;
      this.mobs.set(mobKey(name), mob);
      const ids = (Array.isArray(record['i']) ? record['i'] : []).filter(
        (id): id is number => typeof id === 'number'
      );
      if (ids.length > 0) mob.ids = ids;
      /*
       * Format 32: each row's own answers ride beside its number, and are read
       * only where the writer kept the two lists in step — a list one short
       * would answer for the row beside the one asked about. And only where
       * every written profile was read back, for the same reason:
       * `readProfiles` drops a row it cannot read, which slides every index
       * after it along by one.
       */
      const rows = Array.isArray(record['rw']) ? record['rw'] : [];
      const byRow =
        rows.length === ids.length &&
        (!Array.isArray(record['pf']) || record['pf'].length === profiles.length);
      for (const [k, id] of ids.entries()) {
        this.mobsById.set(id, mob);
        if (!byRow) continue;
        const own = rows[k];
        if (typeof own !== 'object' || own === null) continue;
        const row = own as Record<string, unknown>;
        const hp = Number(row['hp']);
        if (!Number.isFinite(hp) || hp <= 0) continue;
        const at = row['p'];
        const kept: WorldMobRow = {
          id,
          hp,
          disposition: dispositionFromCode(row['d']),
          profile: typeof at === 'number' ? (profiles[at] ?? null) : null
        };
        const stated = (key: string): number | undefined => {
          const value = Number(row[key]);
          return Number.isFinite(value) && value > 0 ? value : undefined;
        };
        kept.armour = stated('ac');
        kept.damageResist = stated('dr');
        kept.magicResist = stated('mr');
        kept.experience = stated('xp');
        kept.regen = stated('rgn');
        kept.regenHours = stated('rt');
        kept.follows = stated('fol');
        kept.averageDamage = stated('dmg');
        kept.charmLevel = stated('chl');
        if (row['und'] === 1) kept.undead = true;
        this.rowsById.set(id, kept);
      }
    }
  }

  /**
   * What the realm says a monster of this name is worth in health.
   *
   * Case- and article-insensitive, because the stream is not consistent about
   * either: `The giant rat bites you` and `You slash the giant rat` produce the
   * same monster spelled two ways, and the realm data is `giant rat`.
   *
   * Undefined for a name the realm does not carry — a realm built before this
   * index existed, a derivative that renamed things, or a monster that simply
   * is not in the table. That is a first-class answer: the caller falls back to
   * what it has learned by fighting, and says so.
   */
  mob(name: string): WorldMob | undefined {
    return this.mobs.get(mobKey(name));
  }

  /**
   * Every monster name this realm holds, alphabetically — the priority list's
   * picker.
   *
   * Names alone, and the whole list in one answer rather than a query per
   * keystroke: the shipped realm names 849 monsters, which is a list the
   * picker can rank and cap in the renderer exactly as it does the potion
   * items, and asking once when the section opens is what `itemsServing`
   * already does for the same reason. A realm large enough for that to stop
   * being true would want a query, and this is where it would go.
   */
  mobNames(): string[] {
    return [...this.mobs.values()].map((mob) => mob.name).sort((a, b) => a.localeCompare(b));
  }

  /** How many monsters the realm named. Zero on a realm built before v3. */
  get mobCount(): number {
    return this.mobs.size;
  }

  /**
   * The realm's row for a name the server *printed* — modifier and all.
   *
   * `MobNameModifierType.Before` and `.After` hang a word off either end of a
   * monster's name, and those words are realm data this client's database does
   * not carry: `small elite guardsman` is a name the table cannot match while
   * `elite guardsman` is right there in it, at 500 hp. Modifiers are not an
   * edge case on the live realm — twenty-four distinct monsters, every one
   * carrying one or none, docs/game-behaviour.md — so a lookup that only ever
   * tries the name as printed misses most of what it was built to answer.
   *
   * `classifyOccupant` has always undone it for the room listing. This is the
   * same rule (`mobNameCandidates`: exact first, then least stripping) for
   * every other caller holding a name off the wire rather than out of the
   * table, so the two cannot come to different conclusions about whether the
   * realm knows a monster.
   */
  mobAsPrinted(name: string): WorldMob | undefined {
    for (const candidate of mobNameCandidates(name)) {
      const found = this.mob(candidate);
      if (found) return found;
    }
    return undefined;
  }

  /** A monster by the realm's own number. Undefined on a realm built before v9. */
  mobById(id: number): WorldMob | undefined {
    return this.mobsById.get(id);
  }

  /** One row, answering for itself. Undefined for a name the realm places once. */
  mobRow(id: number): WorldMobRow | undefined {
    return this.rowsById.get(id);
  }

  /**
   * What a room's lair spawns, resolved.
   *
   * The descriptor is verbatim realm data — `(Max 2): 781,190,` — and the
   * numbers are the only key the room table has for its monsters. Resolved
   * here rather than at build time so the descriptor stays what the realm
   * said, and a realm built before v9 simply answers nothing.
   */
  lairOf(room: WorldRoom): WorldMob[] {
    // The clock is discarded here: this asks what spawns, never when.
    return this.lair(room, null)?.mobs ?? [];
  }

  /**
   * The lair whole: how many at once, and what. Null only for a room the
   * realm does not mark as one — the same test the map's glyph makes, so the
   * two cannot disagree. A descriptor naming no monster this table knows
   * (a derivative that added monsters after this data was built) comes back
   * with an empty list rather than null, so the face can say *that* instead
   * of the map promising a lair the card silently declines to show.
   *
   * **By the row, because the descriptor names one.** A lair is the strongest
   * evidence about a monster there is — stronger than the search
   * `WorldGraph.resolveMobRow` runs for a name off the wire, because there is nothing to
   * search for: `(Max 1): 224,` says row 224, and row 224 is a 100-HP gnoll
   * scout. Read through the fold, the room quick view answered `100–830 hp`
   * about that room — the range across row 224 and row 2204, an 830-HP scout
   * that spawns somewhere else entirely — and the Room card's own `LAIR` face
   * said the same about the room the character was standing in.
   *
   * **The family is the caller's**, and it is not the world file's `WorldGraph.info.family`:
   * the clock's only interpretation that is not in the column is GreaterMUD's
   * thirty-second offset, which is a behaviour of the *server* rather than of
   * the data — and on the shipped configuration the two legitimately disagree
   * (a Paradigm-built world file against a GreaterMUD default realm; see
   * `Vocabulary.noteFamily`). Null is *unknown*, and reads as the nominal
   * figure, which is the longer of the two.
   */
  lair(room: WorldRoom, family: RealmFamily | null): WorldLair | null {
    if (!room.lair) return null;
    // `parseLair` reads the descriptor, and reads *only* the monster numbers in
    // it — see its own note for the four that were being invented per lair.
    const { max, ids } = parseLair(room.lair);
    const mobs: WorldMob[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const mob = this.mobsById.get(id);
      if (mob === undefined) continue;
      const row = this.rowsById.get(id);
      /*
       * A row is its own identity; the fold's is the name. So where the file
       * carries rows a descriptor naming 224 and 2204 names *two* monsters and
       * gets two lines, and where it does not — a realm built before format 32
       * — the fold is every answer the file holds and two ids of one name are
       * one line, as they have always been.
       */
      const key = row === undefined ? `n:${mob.name}` : `r:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mobs.push(row === undefined ? mob : mobAsRow(mob, row, namedHere(id)));
    }
    /*
     * And when it fills again — `Rooms.Delay` (format 33), read here so the
     * Room card's face and the map's quick view cannot come to two answers
     * about one room's clock. `respawnSeconds` is the one reading of the
     * column and stays that.
     */
    const { greatermudRespawnOffsetSeconds } = tuning().hunting;
    return {
      max,
      respawnSeconds: respawnSeconds(room.delay ?? null, family, {
        greatermudRespawnOffsetSeconds
      }),
      mobs
    };
  }

  /**
   * What a room's lair spawns, weighed as the rows the lair names.
   *
   * `lair()`'s answer in the shape a price is taken from: the same rows, with
   * the drops resolved and the profiles whole, because `weighVerdicts` reads a
   * `MobEntity` and a readout reads a `WorldMob`. Both come off the row the
   * descriptor names — the guard post on the Hillside Path names row 224, a
   * 100-HP scout that lands one blow in twenty-five against a level-12
   * Paladin, not row 2204, the 830-HP one that swings four times a round, and
   * weighed by name the room was expected to kill a character it could barely
   * scratch (todo 01, 2026-09-10).
   *
   * A file written before format 32 has nothing per row and degrades to the
   * fold, which is the dangerous reading rather than the reassuring one.
   * Empty for a room that is not a lair, and for a descriptor naming rows this
   * table lacks.
   */
  lairEntities(room: WorldRoom): MobEntity[] {
    if (!room.lair) return [];
    const entities: MobEntity[] = [];
    for (const id of parseLair(room.lair).ids) {
      const mob = this.mobsById.get(id);
      if (mob === undefined) continue;
      const entity = this.mobEntity(mob.name, this.mobAsPrinted(mob.name));
      overlayRow(entity, this.rowsById.get(id));
      entities.push(entity);
    }
    return entities;
  }

  /**
   * The room's placed resident (`Rooms.NPC`), weighed as its own row — the
   * same reading `lairEntities` gives a lair, for the room that has a boss
   * rather than a lair. Its clock is the row's `regenHours`, not the room's
   * `delay`. Empty for a room with no resident, or one this table lacks.
   */
  residentEntities(room: WorldRoom): MobEntity[] {
    if (room.npcId === undefined) return [];
    const mob = this.mobsById.get(room.npcId);
    if (mob === undefined) return [];
    const entity = this.mobEntity(mob.name, this.mobAsPrinted(mob.name));
    overlayRow(entity, this.rowsById.get(room.npcId));
    return [entity];
  }

  /**
   * The monsters whose death brings this one into the world — a death spell
   * summoning one of its rows (`HAZARD_ABILITY.summon`, realm data read since
   * format 31). A monster the realm places nowhere is found where whatever
   * summons it lives (todo 806): the amber talisman drops from the *dying*
   * slaver leader, which no room spawns and the slaver leader's death spell
   * does. One link, never a chain.
   */
  summonersOf(mob: WorldMob): WorldMob[] {
    if (this.summoners === null) {
      const index = new Map<number, WorldMob[]>();
      for (const candidate of new Set(this.mobs.values())) {
        const spell =
          candidate.deathSpell === undefined
            ? undefined
            : this.spellsById.get(candidate.deathSpell);
        for (const [ability, value] of spell?.abilities ?? []) {
          if (ability !== HAZARD_ABILITY.summon || value <= 0) continue;
          const held = index.get(value);
          if (held === undefined) index.set(value, [candidate]);
          else if (!held.includes(candidate)) held.push(candidate);
        }
      }
      this.summoners = index;
    }
    const found: WorldMob[] = [];
    for (const id of mob.ids ?? []) {
      for (const summoner of this.summoners.get(id) ?? []) {
        if (summoner !== mob && !found.includes(summoner)) found.push(summoner);
      }
    }
    return found;
  }

  /**
   * Which monsters are known to drop an item of this name.
   *
   * Built once, on the first quest asked for, out of the drop lists the monster
   * index already carries — 538 of the realm's monsters name something. Keyed
   * the way every other name lookup here is keyed, so `Goru-Nezar` and
   * `goru-nezar` are one monster.
   */
  dropsOf(item: string): readonly string[] {
    if (this.droppers === null) {
      const index = new Map<string, string[]>();
      for (const mob of new Set(this.mobs.values())) {
        for (const drop of mob.drops ?? []) {
          const key = mobKey(drop);
          const held = index.get(key);
          if (held === undefined) index.set(key, [mob.name]);
          else if (!held.includes(mob.name)) held.push(mob.name);
        }
      }
      this.droppers = index;
    }
    return this.droppers.get(mobKey(item)) ?? [];
  }

  // ---------------------------------------------------------------------
  // Entity builders
  //
  // The join between what the wire saw and what the realm knows, made in
  // main at the moment a block is parsed. Every one of these returns a
  // **whole** entity for a name the realm has never heard of — that is the
  // dual-source rule in `src/shared/entities.ts`, and it is what keeps the
  // client working on a derivative realm rather than degrading to nothing.
  // ---------------------------------------------------------------------

  /**
   * A thing, joined to the realm's row for it where there is one.
   *
   * The wire's facts are the arguments and are never overwritten: the slot a
   * listing named, whether it is in use, and how many charges are left are
   * observations about *this* one, and the realm's row is about the kind.
   */
  buildItemEntity(
    rawName: string,
    observed: {
      slot?: string | null;
      slotSource?: 'realm';
      equipped?: boolean;
      charges?: number | null;
      count?: number;
      rawText?: string;
    } = {}
  ): ItemEntity {
    const name = rawName.trim();
    const known = this.itemsByName.get(name.toLowerCase());
    const entity: ItemEntity = {
      name,
      source: known === undefined ? 'wire' : 'hybrid',
      slot: observed.slot ?? null,
      equipped: observed.equipped ?? false,
      charges: observed.charges ?? null
    };
    if (observed.slotSource !== undefined) entity.slotSource = observed.slotSource;
    if (observed.count !== undefined) entity.count = observed.count;
    if (observed.rawText !== undefined) entity.rawText = observed.rawText;
    if (known === undefined) return entity;

    entity.id = known.id;
    /*
     * And every row the *name* holds, which is what a card prints as this
     * thing's number. `id` above is `itemsByName`'s first row and the one the
     * shops reference; for twenty of the shipped realm's names that is one of
     * several, and printing it would make the same claim `oneRowNamed`
     * refuses to make about a key.
     */
    const rows = this.itemRowsByName.get(name.toLowerCase());
    if (rows !== undefined && rows.length > 0) entity.ids = rows;
    this.fillFromRow(entity, known);
    /*
     * A realm row with nothing observed against it — a shop's shelf, a drop
     * table — is `mdb` rather than `hybrid`. The distinction is what lets a
     * card say "the realm says this shop stocks it" apart from "this is in
     * your pack".
     */
    if (
      observed.slot === undefined &&
      observed.equipped === undefined &&
      observed.charges === undefined &&
      observed.count === undefined &&
      observed.rawText === undefined
    ) {
      entity.source = 'mdb';
    }
    return entity;
  }

  /**
   * A floor item settled to the row this room places — format 42.
   *
   * A name several rows share says nothing about which is lying here, and the
   * entity is built from the first; but a room placing exactly one of them
   * has said, as a lair says which monster row stands in it
   * (`WorldGraph.resolveMobRow`). The Treasure Room's `wooden box` is its own fixed row,
   * not the loot row a lookup by name answers with. Anything else comes back
   * as it was.
   */
  itemPlacedHere(item: ItemEntity, room: WorldRoom): ItemEntity {
    const rows = item.ids;
    const placed = room.placed;
    if (rows === undefined || rows.length < 2 || placed === undefined) return item;
    const here = rows.filter((id) => placed.includes(id));
    const known = here.length === 1 ? this.items.get(here[0]!) : undefined;
    if (known === undefined) return item;
    const entity: ItemEntity = {
      name: item.name,
      source: item.source,
      slot: item.slot,
      equipped: item.equipped,
      charges: item.charges,
      ...(item.slotSource === undefined ? {} : { slotSource: item.slotSource }),
      ...(item.count === undefined ? {} : { count: item.count }),
      ...(item.rawText === undefined ? {} : { rawText: item.rawText }),
      id: known.id,
      ids: rows,
      row: { id: known.id }
    };
    this.fillFromRow(entity, known);
    return entity;
  }

  /** What an item's realm row says, onto an entity being built. */
  private fillFromRow(entity: ItemEntity, known: WorldItem): void {
    if (known.price !== undefined) entity.price = known.price;
    if (known.encumbrance !== undefined) entity.encumbrance = known.encumbrance;
    if (known.kind !== undefined) entity.kind = known.kind;
    if (known.worn !== undefined) entity.wornSlotCode = known.worn;
    if (known.slot !== undefined) entity.realmSlot = known.slot;
    if (known.weapon !== undefined) entity.weapon = known.weapon;
    if (known.armour !== undefined) entity.armour = known.armour;
    if (known.uses !== undefined) entity.uses = known.uses;
    if (known.abilities !== undefined) entity.abilities = known.abilities;
    if (known.classes !== undefined) entity.classes = known.classes;
    if (known.races !== undefined) entity.races = known.races;
    if (known.minLevel !== undefined) entity.minLevel = known.minLevel;
    if (known.gettable !== undefined) entity.gettable = known.gettable;
    if (known.notDroppable !== undefined) entity.notDroppable = known.notDroppable;
    if (known.limit !== undefined) entity.limit = known.limit;
    if (known.shops !== undefined) entity.shops = known.shops;
    if (known.mobs !== undefined) entity.droppedBy = known.mobs;
  }

  /**
   * A monster, joined to the row its name has already been answered with:
   * `known` is the fold, or the row the room resolved it to
   * (`WorldGraph.buildMobEntity`), and undefined for a name the realm does not
   * carry. `raw` is what the server printed.
   *
   * `drops` is resolved to entities rather than left as names: choosing a
   * target by what it carries is the question `WorldMob.drops` could not
   * answer, since a bare name has no price and no weight.
   */
  mobEntity(raw: string, known: WorldMob | undefined, charmed = false): MobEntity {
    const entity: MobEntity = {
      name: known?.name ?? raw,
      rawName: raw,
      source: known === undefined ? 'wire' : 'hybrid',
      charmed,
      // A monster the realm cannot place is `null`, and null is never safe —
      // the same three-state `RoomOccupant` has always carried.
      disposition: known?.disposition ?? null,
      uncertain: known?.uncertain ?? false,
      costly: known?.costly ?? 'never'
    };
    if (known === undefined) return entity;

    if (known.row !== undefined) entity.row = known.row;
    // Every `Monsters` row the name holds, for the number a card prints. The
    // fold is by name, so this is the list `row` was resolved out of — and
    // where nothing resolved it, the list is the honest answer. See
    // `entityNumber`.
    if (known.ids !== undefined) entity.ids = known.ids;
    entity.hp = known.hp;
    if (known.span !== undefined) entity.span = known.span;
    if (known.armour !== undefined) entity.armour = known.armour;
    if (known.damageResist !== undefined) entity.damageResist = known.damageResist;
    if (known.magicResist !== undefined) entity.magicResist = known.magicResist;
    if (known.experience !== undefined) entity.experience = known.experience;
    if (known.regen !== undefined) entity.regen = known.regen;
    if (known.regenHours !== undefined) entity.regenHours = known.regenHours;
    if (known.follows !== undefined) entity.follows = known.follows;
    if (known.undead !== undefined) entity.undead = known.undead;
    if (known.abilities !== undefined) entity.abilities = known.abilities;
    if (known.averageDamage !== undefined) entity.averageDamage = known.averageDamage;
    if (known.charmLevel !== undefined) entity.charmLevel = known.charmLevel;
    if (known.casts !== undefined) entity.casts = known.casts;
    if (known.deathSpell !== undefined) entity.deathSpell = known.deathSpell;
    /*
     * Format 20. The profiles ride along whole, and every spell they or the
     * death spell name is resolved here — the decision that reads them is
     * made from the room's occupants in `AutoCombat`, which holds no realm
     * and must not ask one per status line.
     */
    if (known.profiles !== undefined) entity.profiles = known.profiles;
    const named = new Set<number>();
    for (const profile of known.profiles ?? []) {
      for (const attack of profile.attacks) {
        if (attack.kind === 'spell') named.add(attack.spell);
        else if (attack.onHit !== undefined) named.add(attack.onHit);
      }
      for (const cast of profile.casts) named.add(cast.spell);
    }
    if (known.deathSpell !== undefined) named.add(known.deathSpell);
    const spells: Record<number, WorldSpell> = {};
    let resolved = 0;
    for (const id of named) {
      const spell = this.spellById(id);
      if (spell === null) continue;
      spells[id] = spell;
      resolved += 1;
    }
    if (resolved > 0) entity.spells = spells;
    if (known.realmTypes !== undefined && known.realmTypes.length > 0) {
      entity.realmType = known.realmTypes[0];
    }
    if (known.drops !== undefined && known.drops.length > 0) {
      entity.drops = known.drops.map((drop) => this.buildItemEntity(drop));
    }
    return entity;
  }

  /**
   * The creature the realm ties to a room, or null.
   *
   * `npcType` is filled **only from the room's own shop**, which is a join the
   * data supports: the realm records which shop a room holds and `shopKind`
   * reads what kind it is. `Monsters.Type` is deliberately not read as
   * shopkeeper/trainer/guard — measured 2026-09-02, it does not mean that, and
   * a wrong label here would put "banker" on a werewolf.
   */
  buildNpcEntity(room: WorldRoom): NpcEntity | null {
    if (room.npcId === undefined) return null;
    const known = this.mobsById.get(room.npcId);
    if (known === undefined) return null;
    /*
     * The room names the row, so the resident answers as itself rather than as
     * the worst of the rows sharing its name — the same evidence a lair gives,
     * and `disposition` is the one thing here the fold takes a worst-of.
     */
    const row = this.rowsById.get(room.npcId);
    const entity: NpcEntity = {
      name: known.name,
      source: 'mdb',
      id: room.npcId,
      disposition: row === undefined ? known.disposition : row.disposition,
      costly: known.costly
    };
    if (room.shop !== undefined) {
      entity.shopId = room.shop;
      const kind = this.shop(room.shop)?.kind;
      const role = kind === undefined ? undefined : NPC_ROLE_OF[kind];
      if (role !== undefined) entity.npcType = role;
    }
    return entity;
  }

  // ---------------------------------------------------------------------
  // Shops
  // ---------------------------------------------------------------------

  /** Shops that stock something, by the number `Rooms.Shop` holds. */
  private readonly shops = new Map<number, WorldShop>();
  /** Item id -> the shops that stock it, built with the first join. */
  private stockists: Map<number, string[]> | null = null;

  /**
   * The shop index out of the header. Present from v4 on.
   *
   * Item numbers are resolved to names here rather than at every use: the item
   * index is already loaded by this point, and a card that had to do the lookup
   * would be doing it per render.
   */
  private loadShops(raw: unknown): void {
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      if (!Number.isInteger(id)) continue;
      const ids = Array.isArray(record['items']) ? record['items'] : [];

      const stock: WorldShopItem[] = [];
      for (const raw of ids) {
        const item = this.items.get(Number(raw));
        // An id the item index does not carry is a row the realm dropped;
        // naming it "item 1124" would be worse than leaving it out.
        if (!item || item.name.length === 0) continue;
        const line: WorldShopItem = { id: item.id, name: item.name };
        if (item.price !== undefined) line.price = item.price;
        if (item.encumbrance !== undefined) line.encumbrance = item.encumbrance;
        stock.push(line);
      }
      const kind = shopKind(Number(record['t']));
      // A bank stocks nothing and is still a bank: kept for its kind. A
      // stockless row with no kind is the placeholder it looks like.
      if (stock.length === 0 && (kind === undefined || kind === 'shop')) continue;

      const shop: WorldShop = { id, name: String(record['n'] ?? '').trim(), items: stock };
      const markup = Number(record['markup']);
      if (Number.isFinite(markup) && markup > 0) shop.markup = markup;
      if (kind !== undefined) shop.kind = kind;
      // Who the place serves — format 35. Absent before it, and absent on a
      // row the realm leaves open, which is what `restrictedTo` reads as
      // *anybody*.
      for (const [key, field] of [
        ['min', 'minLevel'],
        ['max', 'maxLevel'],
        ['cls', 'classOnly']
      ] as const) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) shop[field] = value;
      }
      this.shops.set(id, shop);
    }
  }

  /**
   * What a shop stocks, with every item named.
   *
   * The whole point of carrying this: a shop is a property of a *room*, the
   * realm data records which shop a room holds, and so standing in one is
   * enough to know what it sells — without spending a command on `list`.
   * Undefined for a shop number the realm has no stock for, which includes
   * every placeholder row in the table and every realm built before v4.
   */
  shop(id: number): WorldShop | undefined {
    return this.shops.get(id);
  }

  /**
   * What this counter charges for one of this item, in copper, before the
   * buyer's charm (`counterPriceInCopper`). Zero for a thing the realm gives
   * away (`Free` on the listing); null where the file predates the coin
   * (format 47) or the realm holds no such row.
   */
  priceAt(item: number, shop: number): number | null {
    const known = this.items.get(item);
    const place = this.shops.get(shop);
    if (known?.currency === undefined || place === undefined) return null;
    return counterPriceInCopper(known.price ?? 0, known.currency, place.markup ?? 0);
  }

  /**
   * Every trainer the realm states, in table order, as `trainersFor` reads one
   * — the shop half of `WorldGraph.trainersTaking`, which knows the rooms.
   */
  trainerRows(): TrainerRow[] {
    const rows: TrainerRow[] = [];
    for (const shop of this.shops.values()) {
      if (shop.kind !== 'trainer') continue;
      const row: TrainerRow = { id: shop.id, name: shop.name };
      if (shop.minLevel !== undefined) row.minLevel = shop.minLevel;
      if (shop.maxLevel !== undefined) row.maxLevel = shop.maxLevel;
      if (shop.classOnly !== undefined) row.classOnly = shop.classOnly;
      if (shop.markup !== undefined) row.markup = shop.markup;
      rows.push(row);
    }
    return rows;
  }

  /**
   * Which shops are known to stock an item of this id.
   *
   * Built once beside `droppers`, out of the stock lists the shop index already
   * carries. By **id**, not by name: a shop stocks rows, and the realm's own
   * data repeats item names across rows.
   */
  stockedBy(item: number): readonly string[] {
    if (this.stockists === null) {
      const index = new Map<number, string[]>();
      for (const shop of this.shops.values()) {
        const name = shop.name.trim();
        if (name.length === 0) continue;
        for (const line of shop.items) {
          const held = index.get(line.id);
          if (held === undefined) index.set(line.id, [name]);
          else if (!held.includes(name)) held.push(name);
        }
      }
      this.stockists = index;
    }
    return this.stockists.get(item) ?? [];
  }

  // ---------------------------------------------------------------------
  // Spells
  // ---------------------------------------------------------------------

  /** Every spell the realm names, in table order. */
  private spells: WorldSpell[] = [];
  /** The same rows by id — see `spellById` for why this is not a scan. */
  private spellsById = new Map<number, WorldSpell>();
  private confusionRows: ReadonlySet<number> | null = null;

  /** The spell index out of the header. Present from v4 on. */
  private loadSpells(raw: unknown): void {
    const spells: WorldSpell[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['n'] ?? '').trim();
      if (!Number.isInteger(id) || name.length === 0) continue;
      const spell: WorldSpell = { id, name };
      const short = String(record['short'] ?? '').trim();
      if (short.length > 0) spell.short = short;
      for (const [key, field] of [
        ['level', 'level'],
        ['mana', 'mana'],
        ['energy', 'energy'],
        ['dur', 'duration'],
        // Who it may be cast on — format 17. The realm's own number; a realm
        // converted by an older build states none and reads as "does not
        // say", which keeps every picker open rather than emptying it.
        ['tg', 'targets'],
        // Whether resistance can refuse it — format 20, the same rule.
        ['res', 'resist']
      ] as const) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) spell[field] = value;
      }
      /*
       * How much easier or harder than the caster's own figure — format 22.
       *
       * Read on its own and **not** in the loop above, because that loop takes
       * only values above zero and this column is signed: 100 of the shipped
       * realm's spells state a negative difficulty, and a spell that is harder
       * than it looks would have been silently read as one that is neither.
       * Same reason `pw` is read separately.
       */
      const difficulty = Number(record['dif']);
      if (Number.isFinite(difficulty) && difficulty !== 0) spell.difficulty = difficulty;
      // The element — format 34; a file written before it names none.
      const element = spellElementOf(typeof record['at'] === 'number' ? record['at'] : null);
      if (element !== undefined) spell.element = element;
      // What casting it does — format 14, and the whole of what a spell card
      // said nothing about: 1,985 of the realm's 1,990 spells carry these.
      const abilities = readAbilities(record);
      if (abilities.length > 0) spell.abilities = abilities;
      /*
       * And how much of it — format 16. The `Abil-n` row above names what a
       * spell affects; on 1,410 spells the magnitude is here instead, and the
       * card read `M.R. 0` off a column the realm genuinely holds a zero in.
       * A realm converted by an older build states none of this and says
       * nothing rather than zero, which is the same answer as always.
       */
      const power = readPair(record['pw']);
      if (power !== null) spell.power = power;
      const cap = Number(record['cap']);
      if (Number.isFinite(cap) && cap > 0) spell.cap = cap;
      for (const [key, field] of [
        ['mig', 'minGrowth'],
        ['mag', 'maxGrowth'],
        ['dug', 'durationGrowth']
      ] as const) {
        const pair = readPair(record[key]);
        if (pair !== null) spell[field] = pair;
      }
      /*
       * What it does to somebody standing in a room that casts it — format 30.
       * Absent on a realm converted before this reader existed, which reads as
       * *this spell harms nobody standing in the room* — the answer every
       * realm gave until now, and the one this exists to correct.
       */
      const hazard = readHazard(record['hz']);
      if (hazard !== null) spell.hazard = hazard;
      spells.push(spell);
    }
    this.spells = spells;
    this.spellsById = new Map(spells.map((spell) => [spell.id, spell]));
    this.confusionRows = null;
  }

  /**
   * The realm's row for a spell id, or null.
   *
   * The room's own `Spell` column holds an id, not a word, so `spellNamed`
   * cannot answer it — a room that heals you and a room that drowns you are
   * the same column and only the row tells them apart.
   */
  /**
   * The spell the realm numbers this, or null.
   *
   * Indexed rather than scanned: the router asks this **once per room it
   * expands** since a room's own spell started pricing the way through it
   * (todo 01), and a linear walk of 2,094 rows inside an A* over 57,511 rooms
   * is the hidden `O(N²)` the standards name — measured at 430ms a route
   * against 27ms with the map.
   */
  spellById(id: number): WorldSpell | null {
    return this.spellsById.get(id) ?? null;
  }

  /**
   * The spell a name or abbreviation names exactly, or null.
   *
   * Case-insensitive, exact only: the wire prints a spell's whole name in a
   * cast confirmation, so a prefix match here would let `bless` resolve to
   * whichever of the realm's blessings sorts first — the confidently wrong
   * answer this codebase refuses everywhere. The abbreviation is accepted
   * because it is the realm's own second spelling of the same row. Null is
   * *the realm does not name it*, which for a converted derivative realm is a
   * real answer and never an error.
   */
  spellNamed(word: string): WorldSpell | null {
    const needle = word.trim().toLowerCase();
    if (needle.length === 0) return null;
    let byShort: WorldSpell | null = null;
    for (const spell of this.spells) {
      if (spell.name.toLowerCase() === needle) return spell;
      if (byShort === null && spell.short?.toLowerCase() === needle) byShort = spell;
    }
    return byShort;
  }

  /**
   * Spells matching a name fragment, best first.
   *
   * A prefix match sorts ahead of a match anywhere, because somebody typing
   * `heal` means the spell called Heal rather than the eleven with "heal"
   * somewhere in the name. Bounded — a card shows a list, not a table.
   */
  searchSpells(query: string, limit = 40): WorldSpell[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return this.spells.slice(0, limit);
    const hits: Array<{ spell: WorldSpell; rank: number }> = [];
    for (const spell of this.spells) {
      const name = spell.name.toLowerCase();
      const short = spell.short?.toLowerCase() ?? '';
      const rank = name.startsWith(needle) || short === needle ? 0 : name.includes(needle) ? 1 : -1;
      if (rank < 0) continue;
      hits.push({ spell, rank });
    }
    return hits
      .sort((a, b) => a.rank - b.rank || a.spell.name.localeCompare(b.spell.name))
      .slice(0, limit)
      .map((hit) => hit.spell);
  }

  /**
   * Every spell a player could cast, named for a settings picker.
   *
   * The `isCastable` discriminator `names()` already uses, for the same
   * reason: the realm's `Spells` table is every *effect* the engine has, and
   * offering `fall` and `sdf` in a picker would be the false-spell field the
   * console rule exists to prevent. Sorted by name, because a picker filters
   * as somebody types and its resting order should read as a list.
   */
  castableSpells(): SpellOption[] {
    return this.spells
      .filter(isCastable)
      .map((spell) => ({
        name: spell.name,
        short: spell.short ?? null,
        targeting: spellTargeting(spell.targets),
        // What the realm says it serves, so the cure fields can each
        // offer the spells that answer their own question (todo 00).
        serves: spellServes(spell.abilities)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The message rows this realm's spells print on a fumble — every
   * `ConfuseMsg` value across the spell table (todo 05). Thirty-odd rows on
   * Paradigm, `You retch uncontrollably!` among them; the classifier reads
   * the character's own line of one as `command-fumbled`.
   */
  confusionMessages(): ReadonlySet<number> {
    if (this.confusionRows === null) {
      const rows = new Set<number>();
      for (const spell of this.spells) {
        for (const [id, value] of spell.abilities ?? []) {
          if (id === CONFUSE_MESSAGE_ABILITY && value > 0) rows.add(value);
        }
      }
      this.confusionRows = rows;
    }
    return this.confusionRows;
  }

  /** How many spells the realm named. Zero on a realm built before v4. */
  get spellCount(): number {
    return this.spells.length;
  }

  /**
   * What a room's own spell does to whoever stands in it, or null.
   *
   * The room carries a spell id; the hazard is on the spell, because 159
   * spells cover 13,603 rooms and writing the same answer onto each of the 845
   * Silver River rooms would be a megabyte for nothing. This is the join, and
   * the one place it is made — `Traveller.hazard`, the route's own steps and
   * the room quick view all come through here.
   *
   * Null for a room with no spell, a spell the realm does not hold, and a
   * spell whose chain reaches nothing worth pricing. The last is the ordinary
   * case: two thirds of the realm's room spells are scenery.
   */
  hazardOf(room: WorldRoom, level?: number | null): SpellHazard | null {
    if (room.spell === undefined) return null;
    const hazard = this.spellById(room.spell)?.hazard ?? null;
    /*
     * Narrowed to the character being planned for, where the realm gates an
     * effect on level and the client knows which character it is (todo 01).
     * This is the one join, so it is the one place the narrowing can be made
     * without a reader forgetting to — and `hazardFor` keeps the whole hazard
     * for an unstated level, which is the ordinary refuse-rather-than-guess
     * answer and what every caller got before.
     */
    return hazard === null ? null : hazardFor(hazard, level);
  }

  /** Whether a spell, or what it ends in, takes one of `spells` off the character. */
  killsAny(spell: number, spells: ReadonlySet<number>): boolean {
    return this.killsWithin(spell, spells, 0);
  }

  /** `killsAny` down the `EndCast` chain, `depth` links in; given up past four. */
  private killsWithin(spell: number, spells: ReadonlySet<number>, depth: number): boolean {
    if (depth > 4) return false;
    const row = this.spellById(spell);
    if (row === null) return false;
    for (const [ability, value] of row.abilities ?? []) {
      if (ability === HAZARD_ABILITY.killSpell && spells.has(value)) return true;
      if (
        ability === HAZARD_ABILITY.endCast &&
        value > 0 &&
        this.killsWithin(value, spells, depth + 1)
      )
        return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Races and classes
  // ---------------------------------------------------------------------

  /** The realm's races and classes, in table order. Empty before v10. */
  private races: WorldRace[] = [];
  private classes: WorldClass[] = [];

  /**
   * The race index out of the header. Present from v10 on.
   *
   * A stat range is written as a two-element array and is kept only when both
   * ends are numbers — half a range is not a range, and a maximum drawn against
   * a missing minimum reads as one starting at zero.
   */
  private loadRaces(raw: unknown): void {
    const races: WorldRace[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['n'] ?? '').trim();
      if (!Number.isInteger(id) || name.length === 0) continue;
      const race: WorldRace = { id, name };
      for (const key of ['int', 'wil', 'str', 'hea', 'agl', 'chm'] as const) {
        const pair = record[key];
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const low = Number(pair[0]);
        const high = Number(pair[1]);
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
        race[key] = [low, high];
      }
      const hp = Number(record['hpPerLevel']);
      if (Number.isFinite(hp) && hp > 0) race.hpPerLevel = hp;
      // Read separately from the hit points, and **without the sign filter**:
      // this is a term of `100 + race + class`, and stock MajorMUD prices a
      // Thief at -20. See `indexRaces` in `buildRealm.ts`.
      const exp = Number(record['expTable']);
      if (Number.isFinite(exp) && exp !== 0) race.expTable = exp;
      // What the race grants — format 14.
      const abilities = readAbilities(record);
      if (abilities.length > 0) race.abilities = abilities;
      races.push(race);
    }
    this.races = races;
  }

  /** The class index out of the header. Present from v10 on. */
  private loadClasses(raw: unknown): void {
    const classes: WorldClass[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['n'] ?? '').trim();
      if (!Number.isInteger(id) || name.length === 0) continue;
      const entryOut: WorldClass = { id, name };
      for (const key of ['magery', 'combat'] as const) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value > 0) entryOut[key] = value;
      }
      // Negative is a real price here; see `loadRaces`.
      const exp = Number(record['expTable']);
      if (Number.isFinite(exp) && exp !== 0) entryOut.expTable = exp;
      // What the class grants — format 14.
      const abilities = readAbilities(record);
      if (abilities.length > 0) entryOut.abilities = abilities;
      classes.push(entryOut);
    }
    this.classes = classes;
  }

  /**
   * The realm's class table as `{ id: name }`, for an ability whose value is a
   * class id rather than a magnitude. See `WorldLookup.classNames`.
   *
   * Built per call rather than cached: fifteen entries, and a lookup is a
   * click. A cache here would be a second copy of a table that already exists.
   */
  private classNames(): Record<number, string> {
    return namesById(this.classes);
  }

  /**
   * The class and race tables as `{ id: name }`, for naming a restriction.
   *
   * Public because the equip check needs both: an item restricted to classes
   * 3, 4, 5 and 6 has to be able to say *Paladin, Cleric, Priest or
   * Missionary*, and a bare list of numbers is the half-read `WorldLookup`
   * already carries `classNames` to avoid.
   */
  namedClasses(): Record<number, string> {
    return namesById(this.classes);
  }

  namedRaces(): Record<number, string> {
    return namesById(this.races);
  }

  /**
   * The realm's row id for a race or a class the stat sheet named.
   *
   * The sheet prints the realm's own word — `Race: Halfling`, `Class: Mystic`
   * (capture 007) — and the restrictions on an item are row *ids*, so somebody
   * has to join the two. Here, because this is where the tables are: a
   * renderer doing it would need both tables shipped to it, and a second
   * spelling of `Half-Ogre` deciding whether a helm goes on is exactly the
   * kind of drift this project keeps out of the renderer.
   *
   * Case-insensitive and trimmed. `null` for a word no table has, which is a
   * first-class answer — a realm converted before v10 names no races at all,
   * and the caller treats unknown as *not ruled out* rather than as refused.
   */
  raceId(name: string): number | null {
    return idNamed(this.races, name);
  }

  classId(name: string): number | null {
    return idNamed(this.classes, name);
  }

  /**
   * What the realm says a race grants — its `Abil-n` pairs — by the word the
   * stat sheet prints, or null for a race no table names.
   *
   * Null rather than an empty list, because the two are different facts: a
   * Human carries no abilities and sees by nothing, and a race the realm
   * cannot place is one whose night vision is unknown. `src/shared/light.ts`
   * reads the difference.
   */
  raceAbilities(name: string): Array<[number, number]> | null {
    const found = rowNamed(this.races, name);
    if (!found) return null;
    return found.abilities ?? [];
  }

  /**
   * What the realm says a race's six attributes run between, by the word the
   * stat sheet prints, or null for a race no table names.
   *
   * The floor is what creation rolls and the ceiling is what training reaches
   * — a Kang's strength is 55 to 160 — so a number on its own says nothing and
   * the same number against this says how far up the race's own range this
   * character has come. An attribute the realm states no range for is left
   * out rather than given the table's widest, which would read as a range
   * somebody could act on.
   */
  raceSpans(name: string): AttributeSpans | null {
    const found = rowNamed(this.races, name);
    if (!found) return null;
    const spans: AttributeSpans = {};
    if (found.str) spans.strength = found.str;
    if (found.int) spans.intellect = found.int;
    if (found.wil) spans.willpower = found.wil;
    if (found.agl) spans.agility = found.agl;
    if (found.hea) spans.health = found.hea;
    if (found.chm) spans.charm = found.chm;
    return spans;
  }

  /**
   * What this race and class pay per level, as a percentage of the base table.
   *
   * `100 + race.ExpTable + class.ExpTable`, which is the whole of it: the two
   * columns are *additions* to a base rate of 100, not multipliers of it. Two
   * characters' tables recorded off the wire give it exactly — a Gaunt One
   * Mystic (120 + 420) at 6,400 for level 2 and a Kang Paladin (150 + 490) at
   * 7,400 — and MMUD-Explorer composes its own chart number the same way.
   * `src/shared/experience.ts` has the measurement and what it does not settle.
   *
   * **Null unless the realm names both**, because a missing term is not a zero
   * one: a realm converted before v10 carries no race table at all, and
   * charging such a character the base rate would put a plausible, wrong number
   * where the card should be saying it does not know. A row the realm *has*
   * with no `ExpTable` column contributes nothing, which is what absent means
   * there — the builder writes the column only when it is non-zero.
   */
  experiencePercent(race: string, className: string): number | null {
    const found = rowNamed(this.races, race);
    const taken = rowNamed(this.classes, className);
    if (!found || !taken) return null;
    return 100 + (found.expTable ?? 0) + (taken.expTable ?? 0);
  }

  /**
   * The realm's own row for a class name.
   *
   * `CombatLVL` and `MageryLVL` are inputs to the server's own accuracy, swing
   * and mana-regeneration formulas (`shared/prowess.ts`) and the stat sheet
   * prints neither — the realm is the only place either is stated. Null for a
   * name the realm cannot place, and for a realm converted before v10, which
   * carries no class table at all.
   */
  classNamed(name: string): WorldClass | null {
    return rowNamed(this.classes, name) ?? null;
  }

  // ---------------------------------------------------------------------
  // Across the tables
  // ---------------------------------------------------------------------

  /**
   * Every name the realm knows, for the console to recognise on hover.
   *
   * Shipped once per session rather than looked up per row: a link provider
   * is asked about the row under the pointer, and a round trip to main per
   * hover is a round trip per hover.
   *
   * **Only the spells a player could cast.** The realm's `Spells` table is not
   * a spellbook — it is every *effect* the engine has, and 848 of the shipped
   * realm's 2,094 rows name no level, mana, energy or abbreviation because
   * nobody casts them: a monster's `spits`, `gazes` and `breathes a jet of
   * frost`, an item's `food` and `drink`, and bare engine words like `fall`,
   * `pool` and `sdf`. Linked on sight they turn ordinary prose into a field of
   * false spells — which is how `Encumbrance:` in an inventory listing came to
   * offer a spell card reading "encumbrance · SPELL · Lasts 1" (id 1236, the
   * effect behind being overloaded).
   *
   * The four fields are the discriminator rather than a list of words to
   * refuse, because the table is realm data and the next realm's effect rows
   * are different words. Every castable spell states at least one of them:
   * `harm` and `mend` carry no abbreviation and are kept by their level and
   * mana, and all 1,246 with any signal survive.
   *
   * `lookup` and the Reference card still search the whole table — somebody
   * asking about `encumbrance` by name should get the realm's answer. This
   * governs only what is underlined without being asked.
   *
   * All but the rooms', which `WorldGraph.names` adds.
   */
  names(): Omit<WorldNames, 'rooms'> {
    return {
      /*
       * Every item name the realm has, not only the ones the detail index
       * carries: recognising a thing is a different question from pricing it,
       * and the two shared a list until `You notice large sign, small sign
       * here.` turned out to name nothing the console knew. A realm converted
       * before v11 ships none, and falls back to the detail index's keys.
       */
      items: this.itemNames.length > 0 ? this.itemNames : [...this.itemsByName.keys()],
      mobs: [...this.mobs.keys()],
      spells: this.spells.filter(isCastable).map((spell) => spell.name.toLowerCase()),
      races: this.races.map((race) => race.name.toLowerCase()),
      classes: this.classes.map((entry) => entry.name.toLowerCase())
    };
  }

  /**
   * Everything the realm knows about a name, whatever kind of thing it is.
   *
   * One query across monsters, items and spells, because the person asking has
   * a *name* — off a room listing, a pack, a shop shelf — and should not have
   * to know which table answers it. Prefix matches sort first within each
   * kind; each list is capped separately so eleven "heal" spells cannot crowd
   * out the one monster that also matched.
   *
   * The catalogue's half: each monster is the fold and each item its row, and
   * `WorldGraph.lookup` answers them for a room.
   */
  lookup(query: string, limit = 12): WorldLookup {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return { mobs: [], items: [], spells: [], races: [], classes: [], classNames: {} };
    }

    const rank = (name: string): number =>
      name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : -1;
    const best = <T>(all: Iterable<[string, T]>): T[] => {
      const hits: Array<{ value: T; name: string; rank: number }> = [];
      for (const [name, value] of all) {
        const r = rank(name);
        if (r >= 0) hits.push({ value, name, rank: r });
      }
      return hits
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((hit) => hit.value);
    };

    /*
     * A name the server printed with a modifier on it matches nothing as
     * typed, and the answer to it is one specific monster rather than a list —
     * so the fallback is an exact lookup and never the substring search above.
     * Dropping words *and* matching loosely is how `small rat of doom` comes
     * back confidently as something called `doom`.
     */
    let mobs = best(this.mobs.entries());
    if (mobs.length === 0) {
      const printed = this.mobAsPrinted(needle);
      if (printed) mobs = [printed];
    }

    return {
      mobs,
      items: best(
        [...this.itemsByName.values()].map((item) => [item.name.toLowerCase(), item] as const)
      ),
      spells: this.searchSpells(query, limit),
      /*
       * Two closed vocabularies of thirteen and fifteen, so the same ranking
       * over the whole list costs nothing and needs no separate search method.
       */
      races: best(this.races.map((race) => [race.name.toLowerCase(), race] as const)),
      classes: best(this.classes.map((entry) => [entry.name.toLowerCase(), entry] as const)),
      classNames: this.classNames()
    };
  }
}

/**
 * Whether a spell row is one a player could cast, and so worth linking on
 * sight. See `names()` for why the realm's spell table holds far more than
 * spells; a row stating none of these four is an engine effect, not a spell
 * anybody knows the name of.
 */
function isCastable(spell: WorldSpell): boolean {
  return (
    spell.short !== undefined ||
    spell.level !== undefined ||
    spell.mana !== undefined ||
    spell.energy !== undefined
  );
}

/**
 * What the person behind a counter is called, from the kind of counter.
 *
 * The **only** sound source for an NPC's role: the realm records which shop a
 * room holds and what kind it is, so `mariana` in a room holding shop 202 is a
 * shopkeeper. Nothing else in the data says what a creature *does* —
 * `Monsters.Type` was measured and does not (see `MobEntity.realmType`) — so
 * a room with no shop leaves `npcType` undefined rather than guessing.
 *
 * There is no `guard` and no `quest` here, deliberately, for the reason the
 * Room card's faces have no healer: do not invent a kind the realm cannot
 * distinguish.
 */
const NPC_ROLE_OF: Readonly<Record<ShopKind, NonNullable<NpcEntity['npcType']> | undefined>> = {
  shop: 'shopkeeper',
  bank: 'banker',
  trainer: 'trainer',
  inn: 'innkeeper',
  tavern: 'tavernkeeper',
  temple: 'priest'
};

/**
 * The realm format that first wrote `BuiltMob.pf`, so a name without one can
 * be told apart from a file that never had them. `buildRealm.ts` numbers the
 * formats; this is the one row of that table the reader has to know.
 */
const PROFILES_SINCE = 20;

/** The realm format that states the coin a price is counted in (`BuiltItem.cur`). */
const CURRENCY_SINCE = 47;

/**
 * A monster entity, re-answered by one of the realm's rows rather than by the
 * fold of every row sharing its name.
 *
 * Every magnitude is replaced rather than merged, absences included: a row
 * that states no armour is a row with no armour, and keeping the fold's figure
 * for it would put another row's armour class on this one. Nothing else on the
 * entity is the realm's to say — `charmed` and `rawName` came off the wire.
 */
function overlayRow(entity: MobEntity, row: WorldMobRow | undefined): void {
  if (row === undefined) return;
  entity.row = namedHere(row.id);
  entity.hp = row.hp;
  delete entity.span;
  entity.disposition = row.disposition;
  // One row is certain about itself; the fold's doubt was about its twins.
  entity.uncertain = false;
  entity.armour = row.armour;
  entity.damageResist = row.damageResist;
  entity.magicResist = row.magicResist;
  entity.experience = row.experience;
  entity.regen = row.regen;
  entity.regenHours = row.regenHours;
  entity.follows = row.follows;
  entity.averageDamage = row.averageDamage;
  entity.charmLevel = row.charmLevel;
  entity.undead = row.undead;
  if (entity.profiles !== undefined) entity.profiles = row.profile === null ? [] : [row.profile];
}

/**
 * A row a room names outright — its lair descriptor or its resident.
 *
 * The strongest evidence there is and the only kind that needs no search: the
 * realm states the number, so there is no nearer row and no margin to weigh.
 * `steps: 0` and no radius say exactly that, which is what `MobRowChoice.how`
 * already means by `here`.
 */
function namedHere(id: number): MobRowChoice {
  return { id, how: 'here', steps: 0, beyond: null };
}

/**
 * The fold, answering as one of its rows.
 *
 * `overlayRow`'s twin for the shape the realm's tables are read in, and the
 * reason there are two: a `MobEntity` is built from a name off the wire and
 * filled in on the way out, a `WorldMob` is the shared record every reader
 * holds and must never be written to. Every magnitude the fold took the worst
 * of becomes this row's own, and `span` goes with them — one row is certain
 * about itself, and the doubt was always about its twins.
 */
export function mobAsRow(mob: WorldMob, row: WorldMobRow, choice: MobRowChoice): WorldMob {
  const resolved: WorldMob = {
    ...mob,
    hp: row.hp,
    disposition: row.disposition,
    uncertain: false,
    row: choice
  };
  delete resolved.span;
  resolved.armour = row.armour;
  resolved.damageResist = row.damageResist;
  resolved.magicResist = row.magicResist;
  resolved.experience = row.experience;
  resolved.regen = row.regen;
  resolved.regenHours = row.regenHours;
  resolved.follows = row.follows;
  resolved.averageDamage = row.averageDamage;
  resolved.charmLevel = row.charmLevel;
  resolved.undead = row.undead;
  if (mob.profiles !== undefined) resolved.profiles = row.profile === null ? [] : [row.profile];
  return resolved;
}

/** Every figure in a compact slot is a finite number, or the slot is dropped. */
function figures(slot: unknown): number[] | null {
  return Array.isArray(slot) &&
    slot.every((each): each is number => typeof each === 'number' && Number.isFinite(each))
    ? slot
    : null;
}

/**
 * `BuiltMob.pf` back into profiles — format 20.
 *
 * The boundary rule `readAbilities` follows, one field along: a slot that is
 * not the shape `compactProfile` writes is dropped rather than repaired,
 * because the converter is the only writer of this file and anything else is
 * a bug there. A profile that comes back with nothing in it is not one.
 */
function readProfiles(raw: unknown): MobProfile[] {
  const profiles: MobProfile[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const attacks: MobAttack[] = [];
    for (const slot of Array.isArray(record['a']) ? record['a'] : []) {
      const row = figures(slot);
      if (row === null) continue;
      if (row[0] === 1 && row.length === 7) {
        const attack: MobAttack = {
          kind: 'melee',
          chance: row[1]!,
          accuracy: row[2]!,
          min: row[3]!,
          max: row[4]!,
          energy: row[5]!
        };
        if (row[6]! > 0) attack.onHit = row[6]!;
        attacks.push(attack);
      } else if (row[0] === 2 && row.length === 6) {
        attacks.push({
          kind: 'spell',
          chance: row[1]!,
          spell: row[2]!,
          castChance: row[3]!,
          level: row[4]!,
          energy: row[5]!
        });
      }
    }
    const casts: MobCast[] = [];
    for (const slot of Array.isArray(record['c']) ? record['c'] : []) {
      const row = figures(slot);
      if (row === null || row.length !== 3) continue;
      casts.push({ spell: row[0]!, chance: row[1]!, level: row[2]! });
    }
    if (attacks.length > 0 || casts.length > 0) profiles.push({ attacks, casts });
  }
  return profiles;
}

/**
 * The `[id, value]` effect pairs off a realm record, whatever kind it is.
 *
 * Items have carried these since format 12; monsters, spells, races and
 * classes since format 14. Kept as the realm's own numbers — `shared/abilities.ts`
 * names them where they are shown, because the *reading* is a claim from
 * another client's source and may be corrected.
 *
 * A malformed pair is dropped rather than repaired: a realm file this client
 * wrote is the only source, so a shape that is not a pair of numbers is a bug
 * here and not a derivative being different. An absent field is an empty list,
 * which is what a realm built before the format that added it produces — the
 * same answer as a row the realm states no effects for, and every consumer
 * already draws nothing for it.
 */
function readAbilities(record: Record<string, unknown>): Array<[number, number]> {
  return Array.isArray(record['ab'])
    ? record['ab'].filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === 'number' &&
          typeof pair[1] === 'number'
      )
    : [];
}

/**
 * A `[number, number]` the realm file states, or null.
 *
 * The same boundary rule `readAbilities` follows one field along: a shape that
 * is not a pair of finite numbers is dropped rather than repaired, because the
 * only writer of this file is `buildRealm` and anything else is a bug here. A
 * realm converted before format 16 states none of these, which reads as null —
 * *the realm does not say*, never zero.
 */
function readPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

/**
 * A room spell's hazard, from a record written by `buildRealm` — format 30.
 *
 * The same boundary rule `readPair` follows: a shape that is not what
 * `BuiltSpellHazard` writes is dropped rather than repaired. Absent on every
 * realm converted before this existed, which reads as *no hazard* — the answer
 * the client gave for every room until now.
 */
function readHazard(value: unknown): SpellHazard | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hazard: SpellHazard = {};
  const damage = Number(record['d']);
  if (Number.isFinite(damage) && damage > 0) hazard.damage = damage;
  const avoidedBy = readIdList(record['av']);
  if (avoidedBy.length > 0) hazard.avoidedBy = avoidedBy;
  const avoidedBySpell = readIdList(record['sp']);
  if (avoidedBySpell.length > 0) hazard.avoidedBySpell = avoidedBySpell;
  if (record['tp'] === 1) hazard.relocates = true;
  if (record['sm'] === 1) hazard.summons = true;
  if (record['u'] === 1) hazard.unread = true;
  const levels = readLevelBands(record['lv']);
  if (levels !== null) hazard.levels = levels;
  // Nothing stated at all is nothing to carry: the writer omits a spell whose
  // chain reaches no harm, so an empty object here is a row that says nothing.
  return Object.keys(hazard).length > 0 ? hazard : null;
}

/**
 * The level bands a hazard's own effects sit behind — format 46, `[min, max]`
 * with `null` for unbounded. A band that bounds nothing is not carried: it is
 * the same fact as an absent one and would make `hazardFor` copy the object
 * for no answer.
 */
function readLevelBands(value: unknown): SpellHazard['levels'] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const band = (raw: unknown): LevelBand | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const [min, max] = raw as [unknown, unknown];
    const read: LevelBand = {};
    if (typeof min === 'number' && Number.isFinite(min)) read.min = min;
    if (typeof max === 'number' && Number.isFinite(max)) read.max = max;
    return read.min === undefined && read.max === undefined ? undefined : read;
  };
  const levels: NonNullable<SpellHazard['levels']> = {};
  const damage = band(record['d']);
  if (damage !== undefined) levels.damage = damage;
  const relocates = band(record['tp']);
  if (relocates !== undefined) levels.relocates = relocates;
  const summons = band(record['sm']);
  if (summons !== undefined) levels.summons = summons;
  return Object.keys(levels).length > 0 ? levels : null;
}

/**
 * A list of the realm's own row ids, from a record written by `buildRealm`.
 *
 * Whole-array validation rather than a cast: this is a boundary, and a file on
 * disk is a payload like any other. A non-integer is dropped rather than
 * carried as `NaN`, which would compare false against every class and quietly
 * turn an allow-list into a refusal.
 */
function readIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
}

/** A table as `{ id: name }`. Built per call: fifteen entries, and a lookup is a click. */
function namesById(rows: readonly { id: number; name: string }[]): Record<number, string> {
  const names: Record<number, string> = {};
  for (const row of rows) names[row.id] = row.name;
  return names;
}

/**
 * The row the realm names, or null. Shared by races and classes.
 *
 * Case-insensitive and trimmed, because the two sides are the stat sheet's word
 * and the database's, written by different people years apart.
 */
function rowNamed<T extends { name: string }>(rows: readonly T[], name: string): T | null {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return null;
  return rows.find((row) => row.name.trim().toLowerCase() === key) ?? null;
}

/** The row id of the entry with this name, or null. Shared by races and classes. */
function idNamed(rows: readonly { id: number; name: string }[], name: string): number | null {
  return rowNamed(rows, name)?.id ?? null;
}

/**
 * `BuiltItem.from` as the reader's own words — format 39.
 *
 * The converter writes the owner's kind (`npc`, `room`, `death`, which is what
 * the traversal calls them) and this turns each into the **act**: a word said
 * to a monster, a word said in a room, a monster killed. Parsed rather than
 * trusted, like every other boundary here — a kind the union does not name is
 * dropped, because a handover the client cannot describe is worse than one it
 * does not mention.
 *
 * The room *name* is not read here: it is a join against the room index, made
 * where the lookup is answered (`handoversOf`).
 */
function readHandovers(raw: unknown): ItemHandover[] {
  const KINDS: Record<string, ItemHandover['kind']> = {
    npc: 'asked',
    room: 'said',
    death: 'killed'
  };
  const found: ItemHandover[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = KINDS[String(record['k'])];
    if (kind === undefined) continue;
    const who = String(record['w'] ?? '').trim();
    const room = String(record['at'] ?? '').trim();
    const say = (Array.isArray(record['say']) ? record['say'] : [])
      .map((word) => String(word).trim())
      .filter((word) => word.length > 0);
    found.push({
      kind,
      ...(who.length > 0 ? { who } : {}),
      ...(/^\d+\/\d+$/.test(room) ? { room } : {}),
      ...(say.length > 0 ? { say } : {})
    });
  }
  return found;
}

/**
 * What kind of thing an item is, read off a v6 header record onto the item.
 *
 * The file carries the realm's *numbers* and this turns them into words, so a
 * correction to `shared/items.ts` reaches a realm converted before it without a
 * rebuild. Every field is optional and absent means the realm does not say;
 * a zero in the file was already left out at build time, so nothing here has
 * to decide whether zero is a fact.
 */
function readItemKind(record: Record<string, unknown>, item: WorldItem): void {
  const type = Number(record['type']);
  if (!Number.isInteger(type)) return;
  const kind = itemKind(type);
  if (kind !== null) item.kind = kind;

  const worn = Number(record['worn']);
  if (Number.isInteger(worn) && worn > 0) item.worn = worn;
  const slot = Number.isInteger(worn) ? WORN_SLOT[worn] : undefined;
  if (slot !== undefined) item.slot = slot;

  /*
   * Any non-zero count, so the realm's `-1` — unlimited — comes back as the
   * fact it is rather than as an absence indistinguishable from silence. A
   * realm converted before format 25 states none, which reads as *unstated*
   * and is correct for it: it is not claiming the item is limited either.
   */
  const uses = Number(record['uses']);
  if (Number.isFinite(uses) && uses !== 0) item.uses = uses;

  const wpn = record['wpn'];
  if (kind === 'weapon' && typeof wpn === 'object' && wpn !== null) {
    const raw = wpn as Record<string, unknown>;
    const weapon: NonNullable<WorldItem['weapon']> = {
      min: Number(raw['min']) || 0,
      max: Number(raw['max']) || 0
    };
    const spd = Number(raw['spd']);
    if (Number.isFinite(spd) && spd > 0) weapon.speed = spd;
    const str = Number(raw['str']);
    if (Number.isFinite(str) && str > 0) weapon.strength = str;
    const acc = Number(raw['acc']);
    if (Number.isFinite(acc) && acc > 0) weapon.accuracy = acc;
    const weaponType = Number(raw['kind']);
    const word = Number.isInteger(weaponType) ? WEAPON_TYPE[weaponType] : undefined;
    if (word !== undefined) weapon.type = word;
    // The half of `WeaponType` a reader acts on, kept apart from the word:
    // a two-handed weapon leaves no off-hand slot.
    const held = Number.isInteger(weaponType) ? WEAPON_CLASS[weaponType] : undefined;
    if (held !== undefined) weapon.hands = held.hands;
    item.weapon = weapon;
  }

  const arm = record['arm'];
  if (kind === 'armour' && typeof arm === 'object' && arm !== null) {
    const raw = arm as Record<string, unknown>;
    const armour: NonNullable<WorldItem['armour']> = {};
    const ac = Number(raw['ac']);
    if (Number.isFinite(ac) && ac > 0) armour.ac = ac;
    const dr = Number(raw['dr']);
    if (Number.isFinite(dr) && dr > 0) armour.dr = dr;
    const armourType = Number(raw['kind']);
    const material = Number.isInteger(armourType) ? ARMOUR_TYPE[armourType] : undefined;
    if (material !== undefined) armour.material = material;
    item.armour = armour;
  }
}
