/**
 * The room graph, and A* over it.
 *
 * Ported from `mudengine/src/engine/path.coffee`, which
 * docs/legacy-assessment.md calls the strongest single piece of logic in either
 * reference codebase: a real A* with per-edge *instructions* parsed out of the
 * exit string, so a door costs more than a corridor and a toll you cannot
 * afford prunes the edge entirely.
 *
 * Three changes from the original:
 *
 * - **The full instruction vocabulary.** The original knew seven kinds and
 *   treated the rest as free. `Text:` exits matter most: they are not traversed
 *   by walking a direction at all, so a route that emits `w` there does not
 *   work.
 * - **Loaded once, indexed.** The original issued synchronous SQLite queries
 *   from inside block parsing, per line, on the main thread.
 * - **A real priority queue.** The original re-sorted the entire open list on
 *   every iteration, which is O(n² log n) over 55,806 rooms.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

import { t } from '../app/i18n';
import { describeObstacle } from './obstacle';
import { parseInstruction } from './instructions';
import {
  type WorldLair,
  DIRECTIONS,
  DIRECTION_COMMAND,
  describeBlock,
  mobKey,
  roomId,
  type RouteBlock,
  type Direction,
  type Requirement,
  type Route,
  type RouteStep,
  type RoomId,
  type WorldExit,
  type WorldItem,
  type WorldLookup,
  type ShopPlace,
  type WorldShop,
  type WorldShopItem,
  type WorldSpell,
  type WorldRace,
  type WorldClass,
  type WorldMob,
  type MobAttack,
  type MobCast,
  type MobProfile,
  type WorldNames,
  type RoomCommand,
  type WorldRoom,
  type ShopKind,
  shopKind
} from '../../shared/world';
import { dispositionFromCode, mobNameCandidates } from '../../shared/mobs';
import { ARMOUR_TYPE, WEAPON_CLASS, WEAPON_TYPE, WORN_SLOT, itemKind } from '../../shared/items';
import { tuning } from '../app/tuning';
import { spellTargeting } from '../../shared/spellcraft';
import type { ExitEntity, ItemEntity, MobEntity, NpcEntity } from '../../shared/entities';
import type { RoomExit } from '../../shared/character';
import type { SpellOption } from '../../shared/ipc';

/**
 * A room-script teleport the router may walk — `dive pool`, `go vortex`.
 *
 * Shaped like a `WorldExit` so the A* relaxes both through one loop, with the
 * one honest difference stated in the type: it has no compass direction,
 * because the realm moves the character by coordinates rather than through an
 * exit, and a fabricated direction would be resolved against an exit that
 * does not exist. The requirement carries the phrase in `commands` (so the
 * route step's command is the phrase, exactly as a `Text:` exit's is) and the
 * level gate when the script states one.
 */
interface PortalExit {
  direction: 'portal';
  map: number;
  room: number;
  requirement: Requirement;
}

/** What the traveller can and cannot do, for edge evaluation. */
export interface Traveller {
  /**
   * Edges the live server refused this session, as `from|direction`.
   *
   * The realm data promised them and the wire said no — 1/615 s is the
   * measured case. Priced as a wall rather than pruned, the same shape as an
   * unbashable door: still walkable when there is no other way, never
   * preferred while there is. Session-scoped by the caller, deliberately —
   * the permanent record (`WorldMemory`) observes and never reaches the
   * pathfinder, and a server restart may open what this session saw shut.
   */
  refused?: ReadonlySet<string>;
  level?: number | null;
  /** Copper farthings, for tolls. */
  wealth?: number | null;
  /** Item ids carried, for keyed doors. */
  keys?: number[];
  /** Picklocks, for a door the realm lets that skill open. */
  pickSkill?: number | null;
  /** Strength, for the same doors — the realm accepts either. */
  strength?: number | null;
}

/**
 * Cost added by an edge's requirement, or `null` to prune it entirely.
 *
 * The numbers are relative and only have to order routes sensibly: a plain
 * corridor is 1, so a door at 12 means "worth a dozen extra rooms to avoid".
 * The original used −500 for a door, which is a *negative* cost and makes A*
 * prefer doors while breaking admissibility; that looks like a bug rather than
 * an intent, and it is not reproduced.
 */

/**
 * What a door costs to force, graded against the character.
 *
 * The realm states the difficulty a barrier yields to, and in two shapes:
 * `Door [1000 picklocks/strength]` takes either skill, `Key: 2126 [or 157
 * picklocks]` takes only the lock-pick (`any` is 0 in both). Forcing one is a
 * numbers game — bash, rest, bash — and every attempt below the minimum can
 * cost the character, so the grading is deliberately lopsided: below the
 * minimum the door is priced as a wall that can still be walked through when
 * there is no other way at all (`tuning.world.wallCost`, never `null`); at the
 * minimum it is close to a plain door; and the further the skill stands above
 * it the cheaper it gets, down to `base`. A character whose sheet nobody has
 * read is priced as if it could not force anything, which is the safe reading.
 *
 * **The two channels are graded separately and the best one wins** (see
 * `forcedDoorCost`). Taking the higher of the two skills against one number
 * credited a warrior's strength against a lock the realm says only picklocks
 * open.
 */
function gradedCost(skill: number | null | undefined, difficulty: number, base: number): number {
  if (difficulty <= 0) return base;
  const ratio = (skill ?? 0) / difficulty;
  const wall = tuning().world.wallCost;
  if (ratio < 1) return wall + Math.round(wall * (1 - ratio));
  // Neutral-ish at the minimum (a door's price several times over), easing to
  // `base` once the skill is five times what the door asks.
  const eased = Math.max(0, Math.min(1, (5 - ratio) / 4));
  return base + Math.round(base * 4 * eased);
}

function forcedDoorCost(requirement: Requirement, traveller: Traveller, base: number): number {
  const { pickDifficulty, bashDifficulty } = requirement;
  // Neither stated: the realm asks for no skill, so the barrier is whatever a
  // plain one costs. That is what `Door` with no bracket has always meant.
  if (pickDifficulty === undefined && bashDifficulty === undefined) return base;
  const costs: number[] = [];
  if (pickDifficulty !== undefined)
    costs.push(gradedCost(traveller.pickSkill, pickDifficulty, base));
  if (bashDifficulty !== undefined)
    costs.push(gradedCost(traveller.strength, bashDifficulty, base));
  return Math.min(...costs);
}

/**
 * Why this edge is impassable for this traveller, or `null` when it is not.
 *
 * The mirror of {@link edgePenalty}'s three `null`s, and deliberately a separate
 * function rather than a richer return from that one: `edgePenalty` is called
 * once per exit per expansion in the hot loop of an A* over 55,806 rooms, and
 * this is called only along a single already-found path. Same decisions, so the
 * two are asserted against each other in the tests — a penalty of `null` with no
 * block, or a block with a finite penalty, is a disagreement about whether the
 * character can walk somewhere.
 */
export function edgeBlock(
  requirement: Requirement | null,
  traveller: Traveller
): { kind: 'key' | 'level' | 'toll'; requirement: Requirement } | null {
  if (!requirement) return null;
  switch (requirement.kind) {
    case 'key': {
      const has = requirement.keyId !== undefined && traveller.keys?.includes(requirement.keyId);
      if (has || requirement.pickDifficulty !== undefined) return null;
      return { kind: 'key', requirement };
    }
    case 'level': {
      const level = traveller.level;
      if (level === null || level === undefined) return null;
      if (requirement.minLevel !== undefined && level < requirement.minLevel) {
        return { kind: 'level', requirement };
      }
      if (requirement.maxLevel !== undefined && level > requirement.maxLevel) {
        return { kind: 'level', requirement };
      }
      return null;
    }
    case 'toll': {
      const purse = traveller.wealth;
      // Nobody has said what the character has. Unknown never blocks — the
      // reassuring answer is the dangerous one only when it *permits* harm,
      // and refusing to route on an unread purse would strand every character
      // whose inventory has not been listed yet.
      if (purse === null || purse === undefined) return null;
      const price = requirement.tollCopper;
      // A gate whose price the realm did not record: the old behaviour, which
      // is all that can be said without a number.
      if (price === undefined) return purse <= 0 ? { kind: 'toll', requirement } : null;
      return purse < price ? { kind: 'toll', requirement } : null;
    }
    default:
      return null;
  }
}

export function edgePenalty(requirement: Requirement | null, traveller: Traveller): number | null {
  if (!requirement) return 0;

  switch (requirement.kind) {
    case 'text':
      // Not an obstacle, just a different command. No penalty at all.
      return 0;

    case 'door':
      return forcedDoorCost(requirement, traveller, 12);

    case 'key': {
      const has = requirement.keyId !== undefined && traveller.keys?.includes(requirement.keyId);
      if (has) return 4;
      // No key, and no skill the realm accepts instead: a wall, full stop.
      if (requirement.pickDifficulty === undefined) return null;
      // Otherwise the lock is picked or the door forced, at the graded cost.
      return forcedDoorCost(requirement, traveller, 30);
    }

    case 'level': {
      const level = traveller.level;
      if (level === null || level === undefined) return 20;
      if (requirement.minLevel !== undefined && level < requirement.minLevel) return null;
      if (requirement.maxLevel !== undefined && level > requirement.maxLevel) return null;
      return 0;
    }

    case 'toll': {
      /*
       * The data **does** carry the amount, and the comment here used to say it
       * did not — so a toll was pruned only for a character with exactly zero,
       * and a character 495 copper short of a 5-gold gate was routed straight
       * into it. That is the reported failure: the walk stopped at the gate,
       * the refusal went unread, and the pending move it left disabled
       * retaliation while a wild dog beat on a character that never swung back.
       *
       * `tollCopper` is the realm's own figure in copper (see `instructions.ts`
       * for why it is gold on the way in). Unaffordable is a wall; affordable
       * costs the small penalty a gate deserves for taking money.
       */
      const purse = traveller.wealth;
      if (purse === null || purse === undefined) return 8;
      const price = requirement.tollCopper;
      if (price === undefined) return purse <= 0 ? null : 8;
      return purse < price ? null : 8;
    }

    case 'hidden':
      // Searchable costs the search; anything else needs actions we cannot
      // derive from the data, so it is expensive rather than impossible.
      return requirement.searchable ? 25 : 200;

    case 'trap':
      // Proportional to the hurt, floored so any trap is worth avoiding.
      return 20 + (requirement.damage ?? 0);

    case 'class':
    case 'race':
    case 'alignment':
    case 'ability':
    case 'cast':
    case 'spell':
    case 'item':
    case 'timed':
      // Conditions we cannot evaluate from the realm data alone. Passable in
      // principle, heavily discouraged in practice — a route through one is
      // better than no route, and the UI shows the requirement so the player
      // can judge.
      return 60;

    case 'unknown':
    default:
      return 40;
  }
}

/** Binary min-heap. The original re-sorted the open list every iteration. */
class MinHeap<T> {
  private readonly items: Array<{ key: number; value: T }> = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, value: T): void {
    this.items.push({ key, value });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.key <= this.items[i]!.key) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.items[left]!.key < this.items[smallest]!.key) {
          smallest = left;
        }
        if (right < this.items.length && this.items[right]!.key < this.items[smallest]!.key) {
          smallest = right;
        }
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i]!, this.items[smallest]!];
        i = smallest;
      }
    }
    return top.value;
  }
}

export interface WorldMeta {
  version: number;
  source: string;
  rooms: number;
  generatedAt: string;
}

export class WorldGraph {
  private readonly rooms = new Map<RoomId, WorldRoom>();
  /**
   * The room-script teleports the router may walk, keyed by the room whose
   * script offers them — `dive pool`, `go vortex`. Built by `linkPortals` once
   * the rooms are loaded, and deliberately only from scripts whose every
   * condition the router can genuinely evaluate against the traveller
   * (`minlevel`/`maxlevel`, or none): a `nomonsters` or `roomitem` portal is a
   * fact the Room card states and a person judges, because routing through a
   * condition the client cannot read is how a character is walked somewhere it
   * cannot get back from — the reason mme.md §6 deferred this half.
   *
   * A refused portal walls at `from|portal`, which is one key per *room*: a
   * room offering two routable portals (exactly one on the shipped realm,
   * 15/740) has both avoided when either is refused. Coarse on purpose — a
   * refusal cannot say which phrase it answered, and over-avoiding for a
   * session is the safe direction.
   */
  private readonly portals = new Map<RoomId, PortalExit[]>();
  /** Lowercased name -> every room that bears it. Names are far from unique. */
  private readonly byName = new Map<string, WorldRoom[]>();
  private meta: WorldMeta = { version: 0, source: 'none', rooms: 0, generatedAt: '' };
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
   * Every monster the realm names, keyed by lowercased name.
   *
   * By name because that is all the wire gives — the combat lines carry `the
   * giant rat` and never a record id — and the whole table rather than a
   * referenced subset, because any monster can walk into the room.
   */
  private readonly mobs = new Map<string, WorldMob>();
  /** By the realm's own number, for lairs. Empty on a realm built before v9. */
  private readonly mobsById = new Map<number, WorldMob>();
  /** Shops that stock something, by the number `Rooms.Shop` holds. */
  private readonly shops = new Map<number, WorldShop>();
  /**
   * Shop name → the rooms holding it, built on the first ask. Null until then:
   * most sessions never open a Reference card, and 55,806 rooms is not a scan
   * to pay for on load.
   */
  private shopRoomsByName: Map<string, WorldRoom[]> | null = null;
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

  /** Every spell the realm names, in table order. */
  private spells: WorldSpell[] = [];
  /** The realm's races and classes, in table order. Empty before v10. */
  private races: WorldRace[] = [];
  private classes: WorldClass[] = [];
  /**
   * Every item name the realm has, for recognising one in a line of text.
   * Empty before v11, where the console recognised only the ~100 items some
   * exit needs and whatever the shops stock.
   */
  private itemNames: string[] = [];

  get size(): number {
    return this.rooms.size;
  }

  /**
   * An item an exit asks for, if the realm data can name it.
   *
   * Undefined for anything no exit references — the index is deliberately
   * small — and for a realm built before the index existed.
   */
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

  item(id: number): WorldItem | undefined {
    return this.items.get(id);
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

  /** How many monsters the realm named. Zero on a realm built before v3. */
  get mobCount(): number {
    return this.mobs.size;
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
   * A monster, joined to the realm's row.
   *
   * The name is looked up through `mobNameCandidates` — least stripping first,
   * because `MobNameModifierType` hangs a word off either end and a shorter
   * name is a *different monster* whose disposition decides whether the client
   * swings. `rawName` keeps what the server printed, because that is what a
   * command has to name.
   *
   * `drops` is resolved to entities rather than left as names: choosing a
   * target by what it carries is the question `WorldMob.drops` could not
   * answer, since a bare name has no price and no weight.
   */
  buildMobEntity(rawName: string, observed: { charmed?: boolean } = {}): MobEntity {
    const raw = rawName.trim();
    /*
     * Least stripping first. `MobNameModifierType` hangs a whole run of words
     * off either end, so `small elite guardsman` has to reach `guardsman` —
     * and the ladder is ordered so the *longest* name that matches wins,
     * because a shorter one is a different monster whose disposition decides
     * whether the client swings. One rule, shared with the classifier, or the
     * two ends of the client disagree about what the realm knows.
     */
    let known: WorldMob | undefined;
    for (const candidate of mobNameCandidates(raw)) {
      known = this.mob(candidate);
      if (known !== undefined) break;
    }
    const entity: MobEntity = {
      name: known?.name ?? raw,
      rawName: raw,
      source: known === undefined ? 'wire' : 'hybrid',
      charmed: observed.charmed ?? false,
      // A monster the realm cannot place is `null`, and null is never safe —
      // the same three-state `RoomOccupant` has always carried.
      disposition: known?.disposition ?? null,
      uncertain: known?.uncertain ?? false,
      costly: known?.costly ?? 'never'
    };
    if (known === undefined) return entity;

    entity.hp = known.hp;
    if (known.span !== undefined) entity.span = known.span;
    if (known.armour !== undefined) entity.armour = known.armour;
    if (known.damageResist !== undefined) entity.damageResist = known.damageResist;
    if (known.magicResist !== undefined) entity.magicResist = known.magicResist;
    if (known.experience !== undefined) entity.experience = known.experience;
    if (known.regen !== undefined) entity.regen = known.regen;
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
    const entity: NpcEntity = {
      name: known.name,
      source: 'mdb',
      id: room.npcId,
      disposition: known.disposition,
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

  /**
   * The room's ways out, joined to where each one goes.
   *
   * The wire's directions lead: an exit the server printed is real whatever the
   * realm says, and one the realm knows that the server did not print is not
   * added — the server is the authority on what is *there now*. What the join
   * adds is the destination, its name, what the passage demands and the item
   * that opens it, which is what lets a card draw an obstacle badge and name a
   * key without a round trip.
   */
  buildExitEntities(exits: ReadonlyArray<RoomExit>, from?: WorldRoom | null): ExitEntity[] {
    const known = new Map<string, WorldExit>();
    for (const exit of from?.exits ?? []) known.set(exit.direction.toLowerCase(), exit);
    return exits.map((exit) => {
      const match = known.get(exit.direction.toLowerCase());
      const entity: ExitEntity = {
        direction: exit.direction,
        note: exit.note,
        targetMap: match?.map ?? null,
        targetRoom: match?.room ?? null,
        targetName: null,
        requirement: match?.requirement ?? null
      };
      if (match !== undefined) {
        const destination = this.get(match.map, match.room);
        if (destination !== undefined) {
          entity.targetName = destination.name;
          // The realm's own light level, which is a different claim from the
          // phrase the server prints on arrival. Negative is dark; nothing
          // here encodes a threshold beyond that sign.
          if (destination.light !== undefined) entity.dark = destination.light < 0;
        }
        if (match.requirement !== null) {
          entity.obstacle = describeObstacle(match.requirement, this);
          const key = match.requirement.keyId;
          if (key !== undefined) {
            const item = this.item(key);
            entity.keyItem = item === undefined ? null : this.buildItemEntity(item.name);
          }
        }
      }
      return entity;
    });
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
   * Every room the realm says holds a shop, for walking to the nearest one.
   *
   * A shop is a property of a room, so "where can I buy something" is a walk
   * the world graph can plan without asking the server anything.
   */
  /** A monster by the realm's own number. Undefined on a realm built before v9. */
  mobById(id: number): WorldMob | undefined {
    return this.mobsById.get(id);
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
    return this.lair(room)?.mobs ?? [];
  }

  /**
   * The lair whole: how many at once, and what. Null only for a room the
   * realm does not mark as one — the same test the map's glyph makes, so the
   * two cannot disagree. A descriptor naming no monster this table knows
   * (a derivative that added monsters after this data was built) comes back
   * with an empty list rather than null, so the face can say *that* instead
   * of the map promising a lair the card silently declines to show.
   */
  lair(room: WorldRoom): WorldLair | null {
    if (!room.lair) return null;
    const ids = [...room.lair.matchAll(/\d+/g)].map((match) => Number(match[0]));
    // The first number is the "Max" count, not a monster.
    const max = /\(Max\s+(\d+)\)/i.exec(room.lair);
    const mobs: WorldMob[] = [];
    for (const id of ids.slice(1)) {
      const mob = this.mobsById.get(id);
      if (mob && !mobs.includes(mob)) mobs.push(mob);
    }
    return { max: max ? Number(max[1]) : null, mobs };
  }

  shopRooms(): WorldRoom[] {
    return [...this.rooms.values()].filter((room) => room.shop !== undefined);
  }

  /**
   * Where a shop of this name is, by the name the item index states.
   *
   * `WorldItem.shops` names shops; a shop is a property of a *room*; and there
   * was no join between the two, so `Sold by: General Store` was a lead the
   * client could print and not act on. This is the join.
   *
   * **Built once, lazily, and keyed by name.** A scan of 55,806 rooms per
   * clicked shop is the N+1 this codebase already refuses elsewhere, and the
   * index is the same shape `byName` already keeps for room names.
   *
   * Undefined for a name the realm places in no room — 11 of the shipped
   * realm's 242 shops — which is the honest answer rather than an empty room.
   */
  shopPlace(name: string): ShopPlace | undefined {
    const key = name.trim().toLowerCase();
    if (key.length === 0) return undefined;
    const rooms = this.shopsByName().get(key);
    if (rooms === undefined || rooms.length === 0) return undefined;
    const only = rooms.length === 1 ? rooms[0] : undefined;
    /*
     * One room is a place; several is an ambiguity, and it is *reported* with
     * its count rather than resolved by taking the first. Picking would send a
     * character to whichever of six trainers the file happened to list first,
     * which is the confidently wrong answer this project refuses everywhere a
     * location is concerned.
     */
    return only === undefined
      ? {
          at: 'several',
          count: rooms.length,
          rooms: rooms
            .slice(0, 24)
            .map((room) => ({ map: room.map, room: room.room, roomName: room.name }))
        }
      : { at: 'one', map: only.map, room: only.room, roomName: only.name };
  }

  private shopsByName(): Map<string, WorldRoom[]> {
    if (this.shopRoomsByName !== null) return this.shopRoomsByName;
    const index = new Map<string, WorldRoom[]>();
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const name = this.shops.get(room.shop)?.name.trim().toLowerCase();
      if (name === undefined || name.length === 0) continue;
      const bucket = index.get(name);
      if (bucket === undefined) index.set(name, [room]);
      else bucket.push(room);
    }
    this.shopRoomsByName = index;
    return index;
  }

  /**
   * The closest room satisfying `want`, by unobstructed steps, as a route.
   *
   * Breadth-first over exits with no requirement — a door, a key, a level gate
   * or a `Text:` phrasing is a step this deliberately does not plan through —
   * so what comes back is walkable as it stands, or null within `limit` steps.
   * For "the nearest shop", which `route` cannot answer without a destination.
   */
  nearest(
    from: RoomId,
    want: (room: WorldRoom) => boolean,
    limit = 30,
    through: (requirement: Requirement) => boolean = () => false
  ): Route | null {
    if (!this.rooms.has(from)) return null;
    const cameFrom = new Map<RoomId, { prev: RoomId; exit: WorldExit }>();
    const depth = new Map<RoomId, number>([[from, 0]]);
    const queue: RoomId[] = [from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const room = this.rooms.get(id);
      if (!room) continue;
      const here = depth.get(id) ?? 0;
      if (id !== from && want(room)) return this.buildRoute(cameFrom, id, here);
      if (here >= limit) continue;
      for (const exit of room.exits) {
        if (exit.requirement !== null && !through(exit.requirement)) continue;
        const next = `${exit.map}/${exit.room}`;
        if (depth.has(next)) continue;
        depth.set(next, here + 1);
        cameFrom.set(next, { prev: id, exit });
        queue.push(next);
      }
    }
    return null;
  }

  /**
   * What kind of place every room bearing a name is, when they agree.
   *
   * For decorating a room's name the moment it is printed — before the room
   * has resolved, because the name line arrives first. Thirteen Town Gates
   * with no shop agree on nothing worth drawing; two Banks that are both
   * banks agree on a bank. Disagreement, or no such room, is undefined: a
   * glyph beside a name is a claim, and this does not guess.
   */
  placeNamed(name: string): { kind: ShopKind; shop: string } | undefined {
    const rooms = this.findByName(name);
    if (rooms.length === 0) return undefined;
    let found: { kind: ShopKind; shop: string } | undefined;
    for (const room of rooms) {
      const shop = room.shop === undefined ? undefined : this.shops.get(room.shop);
      if (!shop?.kind) return undefined;
      if (found && found.kind !== shop.kind) return undefined;
      found = { kind: shop.kind, shop: shop.name };
    }
    return found;
  }

  /**
   * The commands the exits of a room *named* this take, where every room of
   * that name agrees.
   *
   * The same discipline as `placeNamed`, and for the same reason: the console
   * asks on the room's *name* line, before `Obvious exits:` has completed the
   * room and resolved which of the thirteen Town Gates this is. A name shared
   * by several rooms has several exit sets, and offering one of them would put
   * a button on screen that sends a command the room does not take — which on
   * this server is not a button that does nothing, it is one that says the text
   * out loud to everybody standing there.
   *
   * So: undefined unless every room bearing the name offers exactly the same
   * set of `Text:` commands. In practice that is a uniquely-named room, which
   * is what a `go manhole` room almost always is.
   */
  exitCommandsNamed(name: string): string[] | undefined {
    const rooms = this.findByName(name);
    if (rooms.length === 0) return undefined;
    let agreed: string[] | undefined;
    for (const room of rooms) {
      const commands: string[] = [];
      for (const exit of room.exits) {
        const command = exit.requirement?.commands?.[0]?.trim();
        if (command && !commands.includes(command)) commands.push(command);
      }
      if (agreed === undefined) agreed = commands;
      else if (agreed.length !== commands.length || agreed.some((c, i) => c !== commands[i])) {
        return undefined;
      }
    }
    return agreed !== undefined && agreed.length > 0 ? agreed : undefined;
  }

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
   */
  names(): WorldNames {
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
      classes: this.classes.map((entry) => entry.name.toLowerCase()),
      /*
       * Multi-word room names only — see `WorldNames.rooms` for why the short
       * ones are kept out rather than merely outranked. `byName` is already
       * keyed lower-cased, so this is the keys it holds, filtered.
       */
      rooms: [...this.byName.keys()].filter((name) => name.includes(' '))
    };
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
        targeting: spellTargeting(spell.targets)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The realm's row for a spell id, or null.
   *
   * The room's own `Spell` column holds an id, not a word, so `spellNamed`
   * cannot answer it — a room that heals you and a room that drowns you are
   * the same column and only the row tells them apart.
   */
  spellById(id: number): WorldSpell | null {
    return this.spells.find((spell) => spell.id === id) ?? null;
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
   * Everything the realm knows about a name, whatever kind of thing it is.
   *
   * One query across monsters, items and spells, because the person asking has
   * a *name* — off a room listing, a pack, a shop shelf — and should not have
   * to know which table answers it. Prefix matches sort first within each
   * kind; each list is capped separately so eleven "heal" spells cannot crowd
   * out the one monster that also matched.
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

  /** How many spells the realm named. Zero on a realm built before v4. */
  get spellCount(): number {
    return this.spells.length;
  }

  get info(): WorldMeta {
    return this.meta;
  }

  /** Loads the gzipped JSON-lines file produced by `scripts/build-world.mjs`. */
  static load(file: string): WorldGraph {
    const graph = new WorldGraph();
    if (!fs.existsSync(file)) return graph;

    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // One malformed line should cost one room, not the whole realm.
        continue;
      }

      if (index === 0 && typeof parsed['v'] === 'number') {
        graph.meta = {
          version: parsed['v'] as number,
          source: String(parsed['source'] ?? 'unknown'),
          rooms: Number(parsed['rooms'] ?? 0),
          generatedAt: String(parsed['generatedAt'] ?? '')
        };
        graph.loadMobs(parsed['mobs']);
        // Only present from v2 on; an older realm file simply names no items.
        for (const entry of Array.isArray(parsed['items']) ? parsed['items'] : []) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const id = Number(record['id']);
          if (!Number.isInteger(id)) continue;
          const item: WorldItem = { id, name: String(record['n'] ?? '') };
          if (Array.isArray(record['shops'])) item.shops = record['shops'].map(String);
          if (Array.isArray(record['mobs'])) item.mobs = record['mobs'].map(String);
          const price = Number(record['price']);
          if (Number.isFinite(price) && price > 0) item.price = price;
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
          graph.items.set(id, item);
          const key = item.name.trim().toLowerCase();
          if (key.length > 0 && !graph.itemsByName.has(key)) graph.itemsByName.set(key, item);
        }
        // Both only from v4 on; an older realm names no shops and no spells,
        // and every consumer already has to answer "the realm does not say".
        graph.loadShops(parsed['shops']);
        graph.loadSpells(parsed['spells']);
        // v10. A realm converted by an older build names no races or classes,
        // and every consumer already answers "the realm does not say".
        graph.loadRaces(parsed['races']);
        graph.loadClasses(parsed['classes']);
        graph.itemNames = (Array.isArray(parsed['itemNames']) ? parsed['itemNames'] : [])
          .map((name) => String(name).trim().toLowerCase())
          .filter((name) => name.length > 0);
        continue;
      }

      const room = graph.toRoom(parsed);
      if (room) graph.add(room);
    }

    graph.linkPortals();
    return graph;
  }

  /**
   * Gives the router the room-script teleports it can honestly price.
   *
   * The scripts have been on `WorldRoom.commands` since format 13, card-only,
   * with the routing half deferred (mme.md §6). What is linked now is the
   * tranche whose conditions the router can genuinely evaluate against the
   * traveller: a destination the dataset holds, and guards that are nothing
   * but `minlevel`/`maxlevel` — 60 of the shipped realm's 249 teleport
   * commands. The rest (`nomonsters`, `roomitem`, `testskill`, …) are
   * conditions about the moment or the pack that this client cannot read at
   * plan time, and a route through a guess is how a character is walked
   * somewhere it cannot get back from; they stay facts the Room card states.
   */
  private linkPortals(): void {
    for (const [id, room] of this.rooms) {
      for (const command of room.commands ?? []) {
        if (command.to === undefined) continue;
        const destination = this.rooms.get(command.to);
        // A teleport out of the dataset is a hole in the data, not a route.
        if (!destination) continue;
        const phrase = command.say[0]?.trim();
        if (!phrase) continue;

        let minLevel: number | undefined;
        let maxLevel: number | undefined;
        let readable = true;
        for (const entry of command.need ?? []) {
          const [verb, value] = entry.trim().split(/\s+/);
          const figure = Number(value);
          if (verb === 'minlevel' && Number.isInteger(figure)) minLevel = figure;
          else if (verb === 'maxlevel' && Number.isInteger(figure)) maxLevel = figure;
          else {
            readable = false;
            break;
          }
        }
        if (!readable) continue;

        const gated = minLevel !== undefined || maxLevel !== undefined;
        const requirement: Requirement = {
          // A level gate prices and blocks exactly as an exit's `Level:` does;
          // an unguarded portal is a `Text:` exit in everything but the table
          // it came from — a different command, no obstacle.
          kind: gated ? 'level' : 'text',
          raw: [phrase, ...(command.need ?? [])].join('; '),
          commands: [...command.say],
          ...(minLevel !== undefined ? { minLevel } : {}),
          ...(maxLevel !== undefined ? { maxLevel } : {})
        };
        const edge: PortalExit = {
          direction: 'portal',
          map: destination.map,
          room: destination.room,
          requirement
        };
        const held = this.portals.get(id);
        if (held) held.push(edge);
        else this.portals.set(id, [edge]);
      }
    }
  }

  /**
   * The monster index out of the header. Present from v3 on, with a
   * disposition from v5 on.
   *
   * A realm file built before this existed simply names no monsters, and every
   * consumer already has to handle a name the realm cannot place — so an older
   * file degrades to exactly that case rather than failing to load.
   */
  private loadMobs(raw: unknown): void {
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
      else if (this.meta.version >= PROFILES_SINCE) mob.profiles = [];
      // What it resists and ignores — format 14, the worst of the rows sharing
      // this name. See `BuiltMob.ab`.
      const abilities = readAbilities(record);
      if (abilities.length > 0) mob.abilities = abilities;
      this.mobs.set(mobKey(name), mob);
      for (const id of Array.isArray(record['i']) ? record['i'] : []) {
        if (typeof id === 'number') this.mobsById.set(id, mob);
      }
    }
  }

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
      this.shops.set(id, shop);
    }
  }

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
      spells.push(spell);
    }
    this.spells = spells;
  }

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

  private toRoom(raw: Record<string, unknown>): WorldRoom | null {
    const map = raw['m'];
    const room = raw['r'];
    if (typeof map !== 'number' || typeof room !== 'number') return null;

    const exits: WorldExit[] = [];
    const rawExits = (raw['x'] ?? {}) as Record<string, { m: number; r: number; i?: string }>;
    for (const direction of DIRECTIONS) {
      const exit = rawExits[direction];
      if (!exit) continue;
      exits.push({
        direction,
        map: exit.m,
        room: exit.r,
        requirement: parseInstruction(exit.i)
      });
    }

    const result: WorldRoom = {
      map,
      room,
      name: String(raw['n'] ?? ''),
      exits
    };
    if (typeof raw['s'] === 'number') result.shop = raw['s'];
    // Written since the file began and read by nothing until format 18.
    if (typeof raw['npc'] === 'number' && raw['npc'] > 0) result.npcId = raw['npc'];
    if (typeof raw['lair'] === 'string') result.lair = raw['lair'];
    if (typeof raw['li'] === 'number') result.light = raw['li'];
    if (typeof raw['sp'] === 'number' && raw['sp'] > 0) result.spell = raw['sp'];
    /*
     * The words the room answers — format 13. A malformed entry is dropped
     * rather than repaired: this file is written by this client, so a shape
     * that is not a `RoomCommand` is a bug here and not a derivative differing.
     */
    const answers = Array.isArray(raw['cmd'])
      ? raw['cmd'].filter(
          (entry): entry is RoomCommand =>
            typeof entry === 'object' &&
            entry !== null &&
            Array.isArray((entry as RoomCommand).say) &&
            (entry as RoomCommand).say.length > 0
        )
      : [];
    if (answers.length > 0) result.commands = answers;
    return result;
  }

  private add(room: WorldRoom): void {
    this.rooms.set(roomId(room.map, room.room), room);
    /*
     * Trimmed on the way *in* as well as on the way out.
     *
     * `findByName` has always trimmed its query, and the index had not — so a
     * realm record whose name carried trailing padding was indexed under a key
     * no lookup could ever produce, and the room was unfindable by name. Access
     * stores fixed-width text padded, and sixteen rooms in the shipped realm
     * arrived that way; a realm file a player chooses can carry any amount of
     * it. The reader strips the padding now, and this makes it not matter.
     */
    const key = room.name.trim().toLowerCase();
    const bucket = this.byName.get(key);
    if (bucket) bucket.push(room);
    else this.byName.set(key, [room]);
  }

  get(map: number, room: number): WorldRoom | undefined {
    return this.rooms.get(roomId(map, room));
  }

  byId(id: RoomId): WorldRoom | undefined {
    return this.rooms.get(id);
  }

  /** Every room with this exact name. Names repeat constantly — 14 "Newhaven…". */
  findByName(name: string): WorldRoom[] {
    return this.byName.get(name.trim().toLowerCase()) ?? [];
  }

  /** Substring search, for a room picker. Capped so a short query cannot hang. */
  searchByName(query: string, limit = 25): WorldRoom[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];

    const results: WorldRoom[] = [];
    for (const [name, bucket] of this.byName) {
      if (!name.includes(needle)) continue;
      for (const room of bucket) {
        results.push(room);
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  /**
   * A* from one room to another.
   *
   * The heuristic is deliberately weak: rooms carry no coordinates, only
   * `map/room` identifiers, so there is no geometry to exploit. Same-map is
   * nearer than cross-map and that is all that can honestly be claimed —
   * anything stronger would be a guess that breaks admissibility and returns
   * routes that are not shortest.
   */
  route(from: RoomId, to: RoomId, traveller: Traveller = {}): Route {
    const start = this.rooms.get(from);
    const goal = this.rooms.get(to);

    if (!start) {
      return {
        steps: [],
        cost: 0,
        blocked: true,
        reason: t('cards.route.reasons.unknownStartRoom', { roomId: from })
      };
    }
    if (!goal) {
      return {
        steps: [],
        cost: 0,
        blocked: true,
        reason: t('cards.route.reasons.unknownDestinationRoom', { roomId: to })
      };
    }
    if (from === to) return { steps: [], cost: 0, blocked: false };

    const found = this.search(from, to, goal, traveller, false);
    if (found) return this.buildRoute(found.cameFrom, to, found.cost);

    /*
     * Nothing walkable, so ask again with the gates open — and report the gates
     * on *that* path.
     *
     * Which pruned edges are worth naming was the open question here, and the
     * answer that is honest rather than merely cheap is: the ones standing on
     * the route this character would otherwise have had. Every pruned edge in a
     * 55,806-room realm is noise — most of them are nowhere near the
     * destination — and a list of forty locked doors says less than none.
     *
     * The second search costs nothing in the common case because it only runs
     * when the first has already failed, which is the case where there is
     * nothing else to spend the time on.
     */
    const ignoring = this.search(from, to, goal, traveller, true);
    const blocks = ignoring ? this.blocksAlong(ignoring.cameFrom, to, traveller) : [];
    const reasons = blocks.length > 0 ? blocks : ([{ kind: 'unreachable' }] as RouteBlock[]);
    return {
      steps: [],
      cost: 0,
      blocked: true,
      // Still a sentence, because everything that already reads `reason` goes
      // on working; the facts are beside it for anything that wants more.
      reason: reasons.map(describeBlock).join('; '),
      blocks: reasons
    };
  }

  /**
   * One A* pass. `openGates` prices the three impassable conditions instead of
   * pruning them, which is how the failed case finds a path to explain itself.
   */
  private search(
    from: RoomId,
    to: RoomId,
    goal: WorldRoom,
    traveller: Traveller,
    openGates: boolean
  ): {
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>;
    cost: number;
  } | null {
    const heuristic = (room: WorldRoom): number => (room.map === goal.map ? 0 : 1);

    const cameFrom = new Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>();
    const best = new Map<RoomId, number>([[from, 0]]);
    const open = new MinHeap<RoomId>();
    open.push(heuristic(this.rooms.get(from)!), from);

    while (open.size > 0) {
      const currentId = open.pop()!;
      if (currentId === to) return { cameFrom, cost: best.get(to) ?? 0 };

      const current = this.rooms.get(currentId);
      if (!current) continue;
      const currentCost = best.get(currentId) ?? Infinity;

      // The room's exits, and any scripted teleports the router may walk —
      // one relaxation, because a portal is priced like any other gated edge.
      const scripted = this.portals.get(currentId);
      const ways: ReadonlyArray<WorldExit | PortalExit> = scripted
        ? [...current.exits, ...scripted]
        : current.exits;
      for (const exit of ways) {
        const nextId = roomId(exit.map, exit.room);
        const next = this.rooms.get(nextId);
        // An exit pointing outside the dataset is a hole in the data, not a
        // route; following it would produce a step that cannot be walked.
        if (!next) continue;

        const priced = edgePenalty(exit.requirement, traveller);
        // A gate held open is still the worst edge on the map, so the path this
        // finds is the one that was *nearly* walkable rather than a detour
        // through every locked door in the realm.
        const penalty = priced === null ? (openGates ? tuning().world.wallCost : null) : priced;
        if (penalty === null) continue;

        // A portal costs its penalty over a plain step, so the router prefers
        // ordinary corridors unless the teleport genuinely shortens the way.
        const surcharge = exit.direction === 'portal' ? tuning().world.portalPenalty : 0;
        const wall = traveller.refused?.has(`${currentId}|${exit.direction}`) ? 100_000 : 0;
        const tentative = currentCost + 1 + penalty + surcharge + wall;
        if (tentative >= (best.get(nextId) ?? Infinity)) continue;

        best.set(nextId, tentative);
        cameFrom.set(nextId, { prev: currentId, exit });
        open.push(tentative + heuristic(next), nextId);
      }
    }
    return null;
  }

  /** Every gate on a found path this traveller cannot pass, in walking order. */
  private blocksAlong(
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>,
    to: RoomId,
    traveller: Traveller
  ): RouteBlock[] {
    const blocks: RouteBlock[] = [];
    let cursor = to;
    while (cameFrom.has(cursor)) {
      const { prev, exit } = cameFrom.get(cursor)!;
      const blocked = edgeBlock(exit.requirement, traveller);
      if (blocked) {
        const name = this.rooms.get(cursor)?.name ?? cursor;
        const requirement = blocked.requirement;
        if (blocked.kind === 'key') {
          blocks.unshift({
            kind: 'key',
            at: prev,
            to: cursor,
            name,
            ...(requirement.keyId === undefined ? {} : { keyId: requirement.keyId })
          });
        } else if (blocked.kind === 'level') {
          blocks.unshift({
            kind: 'level',
            at: prev,
            to: cursor,
            name,
            level: traveller.level ?? null,
            ...(requirement.minLevel === undefined ? {} : { minLevel: requirement.minLevel }),
            ...(requirement.maxLevel === undefined ? {} : { maxLevel: requirement.maxLevel })
          });
        } else {
          /*
           * The price and the purse, so the sentence can state the shortfall
           * rather than assert the character has nothing. Both omitted when
           * genuinely unknown — a gate the realm priced at nothing recorded, and
           * a purse no listing has stated — because absent and zero are
           * different answers and this sentence is read to decide what to do.
           */
          blocks.unshift({
            kind: 'toll',
            at: prev,
            to: cursor,
            name,
            ...(requirement.tollCopper === undefined ? {} : { tollCopper: requirement.tollCopper }),
            ...(traveller.wealth === null || traveller.wealth === undefined
              ? {}
              : { purseCopper: traveller.wealth })
          });
        }
      }
      cursor = prev;
    }
    return blocks;
  }

  private buildRoute(
    cameFrom: Map<RoomId, { prev: RoomId; exit: WorldExit | PortalExit }>,
    to: RoomId,
    cost: number
  ): Route {
    const steps: RouteStep[] = [];
    let cursor = to;

    while (cameFrom.has(cursor)) {
      const { prev, exit } = cameFrom.get(cursor)!;
      const destination = this.rooms.get(cursor);
      steps.unshift({
        from: prev,
        to: cursor,
        direction: exit.direction,
        // A `Text:` exit is not walked with a direction; it needs its own
        // command, and the first listed phrasing is the canonical one.
        command: exit.requirement?.commands?.[0] ?? DIRECTION_COMMAND[exit.direction as Direction],
        name: destination?.name ?? '',
        requirement: exit.requirement,
        /*
         * The same sentences the map draws, on the step. `requirement.kind`
         * alone put `toll` beside a room name with the price it charges sitting
         * unread in the same object — the exact asymmetry `RouteBlock` already
         * records for a route that was refused outright.
         */
        ...(exit.requirement ? { obstacle: describeObstacle(exit.requirement, this) } : {}),
        // Absent is not dark: `buildRealm` writes a level only when the realm
        // recorded a non-zero one.
        dark: destination?.light !== undefined && destination.light < 0,
        // And the level itself, for the light arithmetic: how dark decides
        // whether a torch is worth lighting, and `dark` alone cannot say.
        ...(destination?.light !== undefined && destination.light < 0
          ? { light: destination.light }
          : {})
      });
      cursor = prev;
    }

    return { steps, cost, blocked: false };
  }
}

/**
 * Whether a spell row is one a player could cast, and so worth linking on
 * sight. See `names()` for why the realm's spell table holds far more than
 * spells; a row stating none of these four is an engine effect, not a spell
 * anybody knows the name of.
 */
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

function isCastable(spell: WorldSpell): boolean {
  return (
    spell.short !== undefined ||
    spell.level !== undefined ||
    spell.mana !== undefined ||
    spell.energy !== undefined
  );
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
/**
 * The realm format that first wrote `BuiltMob.pf`, so a name without one can
 * be told apart from a file that never had them. `buildRealm.ts` numbers the
 * formats; this is the one row of that table the reader has to know.
 */
const PROFILES_SINCE = 20;

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

function readItemKind(record: Record<string, unknown>, item: WorldItem): void {
  const type = Number(record['type']);
  if (!Number.isInteger(type)) return;
  const kind = itemKind(type);
  if (kind !== null) item.kind = kind;

  const worn = Number(record['worn']);
  if (Number.isInteger(worn) && worn > 0) item.worn = worn;
  const slot = Number.isInteger(worn) ? WORN_SLOT[worn] : undefined;
  if (slot !== undefined) item.slot = slot;

  const uses = Number(record['uses']);
  if (Number.isFinite(uses) && uses > 0) item.uses = uses;

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
