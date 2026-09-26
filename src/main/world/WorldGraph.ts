/**
 * The room graph, and the realm's catalogue joined onto it.
 *
 * Ported from `mudengine/src/engine/path.coffee`, which
 * docs/legacy-assessment.md calls the strongest single piece of logic in either
 * reference codebase. **Loaded once, indexed**: the original issued
 * synchronous SQLite queries from inside block parsing, per line, on the main
 * thread. The catalogue is `Catalogue.ts`, read out of the header first; A*
 * is `Router.ts`, over a `RoomIndex` composed of both; the quest planner is
 * `QuestPlanner.ts`, over the router, the catalogue and `PlannerRooms`. What
 * stays here is the rooms and every join that has to find one; the rest delegates.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

import { describeObstacle } from './obstacle';
import { parseInstruction } from './instructions';
import type { BuiltExit } from './buildRealm';
import type { PlanStep, Quest, QuestErrand, QuestStep } from '../../shared/quests';
import {
  type WorldLair,
  type AbilityGate,
  readAbilityGate,
  asRoomReference,
  DIRECTIONS,
  roomId,
  type Requirement,
  type ItemUseGate,
  type Route,
  type RouteStep,
  type RoomId,
  type WorldExit,
  type WorldItem,
  type WardRule,
  type ApproachGate,
  type WorldLookup,
  type BankChoice,
  type CashPlace,
  type ShopPlace,
  type BuyingPlace,
  type DropSources,
  type ItemAsk,
  type MobPlaces,
  type MobSpawn,
  type ItemPlaces,
  type PlaceGroup,
  type RequirementAction,
  parseLair,
  type WorldShop,
  type RouteInvocation,
  type Landing,
  landingRooms,
  sameLanding,
  scatters,
  type SpellHazard,
  type WorldSpell,
  type WorldClass,
  type WorldMob,
  type WorldMobRow,
  type MobRowChoice,
  type WorldNames,
  type RoomCommand,
  type Corridor,
  type RemoteLever,
  type WorldRoom,
  type ShopKind
} from '../../shared/world';
import { trainersFor, type TrainerRow } from '../../shared/training';
import { HAZARD_ABILITY, abilityShape } from '../../shared/abilities';
import { tuning } from '../app/tuning';
import type { ExitEntity, ItemEntity, MobEntity, NpcEntity } from '../../shared/entities';
import {
  balanceOf,
  type AttributeSpans,
  type BankBalance,
  type RoomExit
} from '../../shared/character';
import type { SpellOption } from '../../shared/ipc';
import {
  asRealmFamily,
  familyOfBuild,
  readRealmBuild,
  type RealmBuild,
  type RealmFamily
} from '../../shared/realm';
import {
  asShippedWorld,
  readArchiveIdentity,
  type ArchiveIdentity,
  type ShippedWorld
} from '../../shared/worlds';
import { Router, type RouteOptions, type Traveller } from './Router';
import type { Passage, PortalExit, RoomIndex } from './RoomIndex';
import { Catalogue, mobAsRow } from './Catalogue';
import { headerOf, NO_HEADER, type RealmHeader } from './realmHeader';
import { QuestPlanner } from './QuestPlanner';
import type { PlannerRooms } from './PlannerRooms';

// Read only by `WorldGraph.test.ts`, which todo 710 kept unchanged; goes when a router-only test exists.
export { dangerPenalty, edgeBlock, edgePenalty, edgeWall } from './Router';
export type { RouteOptions, Traveller } from './Router';

/**
 * How a lever is filed and looked up: the exit it opens, not the room that
 * holds it.
 *
 * One spelling, used by the index and by every question put to it, because two
 * spellings of a key agree exactly until one of them is edited — the same
 * reason `refusedEdges` keys through one expression.
 */
function leverKey(room: RoomId, direction: string): string {
  return `${room}|${direction}`;
}

/** Handed back for an exit nothing opens, so no caller allocates to say "none". */
const NO_LEVERS: readonly RemoteLever[] = [];

/**
 * The abilities that take hit points off whoever a spell lands on.
 *
 * The damaging quarter of `menace.hazardOf`'s switch and nothing else: a spell
 * trap's price is what it costs to walk through, and being held or blinded for
 * a round costs a fight rather than a corridor. `Heal` is not in the set
 * because only a *negative* one is a wound, which is a value test rather than
 * an id test.
 */
const HURTS: ReadonlySet<number> = new Set([
  HAZARD_ABILITY.damage,
  HAZARD_ABILITY.damageWithMr,
  HAZARD_ABILITY.drain,
  HAZARD_ABILITY.poison
]);

/**
 * Where one spell's `TeleportRoom` puts the character, as the server works it out.
 *
 * `Spell.cs` `ApplySpellAbilities`, `GMUDAbilityType.TeleportRoom`:
 *
 * ```
 * int tempTeleportRoomID = abil.Modifiers[0].Modifier;
 * if (tempTeleportRoomID == 0) tempTeleportRoomID = inMainValue;
 * ```
 *
 * `inMainValue` is `Globals.Rand.GetRandomNumber(GetSpellMin, GetSpellMax)` —
 * the spell's own `MinBase`–`MaxBase` (`RollAndApplySpellAbilities`). So a
 * stated modifier is an address and a zero is a draw, and the *shape* of the
 * answer is the same either way: a range, which is a room when it is one wide.
 *
 * The map is `TeleportMap` where the row states one and the character's own
 * map where it does not (`plyrTarget.Room.Map.MapID`) — which for an exit's
 * cast is the map the exit table names, because `TryMoveThroughExit` moves
 * first and casts second.
 *
 * `null` for a row this cannot turn into a room: a zero modifier with no
 * power range is a draw between room 0 and room 0, and room 0 is not a room.
 * That is unread rather than harmless, and the caller prices it as a script.
 */
function landingOf(spell: WorldSpell, stated: number, onMap: number): Landing | null {
  const [min, max] = spell.power ?? [0, 0];
  const low = stated > 0 ? stated : min;
  const high = stated > 0 ? stated : max;
  if (low <= 0 || high < low) return null;
  const map = spell.abilities?.find(([id]) => id === HAZARD_ABILITY.teleportMap)?.[1];
  return {
    spell: spell.id,
    name: spell.name,
    map: map !== undefined && map > 0 ? map : onMap,
    low,
    high
  };
}

/**
 * What a counter is worth stopping at — lower is better, and nothing else.
 *
 * `detour + dearerSteps × log2(100 + markup)`: the steps of going out of the
 * way, plus what the price is worth in steps of going out of the way.
 *
 * **A logarithm, because only the ratio is stated.** The realm's base figure
 * belongs to the item and is identical at every counter that stocks it, so
 * between two of them `(100 + markup)` *is* the price, in whatever unit the
 * base is written in — a unit the client has settled it must not pretend is
 * copper (`ShopFace`). Taking its logarithm makes the gap between two counters
 * exactly the number of doublings between their prices, which is a real
 * quantity, and stops Paradigm's 32,760% shop from being ranked three hundred
 * maps' worth of walking behind its 100% one.
 *
 * The constant term that leaves in every rank is the point of writing it this
 * way: it is the same for every candidate, so it cancels in the ordering and
 * the figure stays independent of which counters happen to be in the list.
 */
function buyingRank(place: BuyingPlace, dearerSteps: number): number {
  return place.detour + dearerSteps * Math.log2(100 + place.markup);
}

export interface WorldMeta {
  version: number;
  source: string;
  rooms: number;
  generatedAt: string;
  /**
   * Which lineage's arithmetic this realm data belongs to — format 21.
   *
   * `null` on a realm converted by an older build, and on one whose `Info`
   * table does not name a lineage. Never guessed at: see `shared/realm.ts`.
   */
  family: RealmFamily | null;
  /** The database's own `Info` row, whole. `null` before format 21. */
  build: RealmBuild | null;
  /**
   * Which bundled world this is — format 27, written only by `build-world.mjs`.
   * `null` for a realm a player converted, which is theirs and named after its
   * file. See `shared/worlds.ts`.
   */
  world: ShippedWorld | null;
  /** The archive a bundled world was built from; `null` for a player's realm. */
  archive: ArchiveIdentity | null;
}

/**
 * The header's own fields, every one parsed rather than trusted: the header is
 * a file on the player's disk, and one converted by an older build carries
 * fewer of them. `asRealmFamily` is what stops a hand-edited header naming a
 * third family that every calculator would then fall through; `asShippedWorld`
 * and `readArchiveIdentity` do the same for format 27's two.
 */
function metaOf(parsed: RealmHeader): WorldMeta {
  const build = readRealmBuild(parsed['build']);
  return {
    version: parsed.v,
    source: String(parsed['source'] ?? 'unknown'),
    rooms: Number(parsed['rooms'] ?? 0),
    generatedAt: String(parsed['generatedAt'] ?? ''),
    family: asRealmFamily(parsed['family']) ?? familyOfBuild(build),
    build,
    world: asShippedWorld(parsed['world']),
    archive: readArchiveIdentity(parsed['archive'])
  };
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
  /**
   * Every lever the realm says opens an exit, keyed by the exit it opens —
   * `map/room|direction`. Built by `linkLevers` once the rooms are loaded.
   *
   * Indexed by the exit and not by the room holding the lever, because that is
   * the direction the question is asked from: a walk refused at a gate asks
   * *is there anything anywhere that opens this*, and the room it is standing
   * in is the one place the answer is not.
   */
  private readonly levers = new Map<string, RemoteLever[]>();
  /** Lowercased name -> every room that bears it. Names are far from unique. */
  private readonly byName = new Map<string, WorldRoom[]>();
  /**
   * Item id -> every room the realm places one in, in load order: the other
   * direction of `WorldRoom.placed`, built as the rooms arrive so the file
   * states the fact once (format 42).
   */
  private readonly placedIn = new Map<number, RoomId[]>();
  private meta: WorldMeta = {
    version: 0,
    source: 'none',
    rooms: 0,
    generatedAt: '',
    family: null,
    build: null,
    world: null,
    archive: null
  };
  /**
   * The rooms a way in leaves under a timed spell (todo 104), by the passage
   * that puts them there — the eleven Muddy Underwater Passage rooms under
   * *holding breath*. Built by `linkPortals`; read by `spellOver`.
   */
  private readonly underSpell = new Map<RoomId, Corridor>();
  /**
   * `roomId|name` → the row that room resolves the name to. Bounded.
   *
   * The search behind it is a breadth-first sweep that can reach the whole map
   * for a name nothing spawns nearby, and the questions repeat exactly: every
   * status line re-weighs the same occupants standing in the same room. Keyed
   * on the pair because the answer is about both.
   */
  private readonly resolvedRows = new Map<string, MobRowChoice | null>();
  /**
   * Shop name → the rooms holding it, built on the first ask. Null until then:
   * most sessions never open a Reference card, and 55,806 rooms is not a scan
   * to pay for on load.
   */
  private shopRoomsByName: Map<string, WorldRoom[]> | null = null;
  /**
   * Monster number → the rooms the realm spawns it in, built on the first ask.
   *
   * Null until then, for `shopRoomsByName`'s reason exactly: most sessions
   * never open a Reference card, and this is the same 55,806-room scan. One
   * scan answers every monster, so the alternative — a filter per clicked name
   * — is the N+1 this layer exists to refuse.
   */
  private mobRoomsById: Map<number, MobSpawnRoom[]> | null = null;
  /**
   * Item id -> the **rooms** whose counter stocks it, built on the first ask.
   *
   * `Catalogue.stockedBy` answers by name because that is what `WorldItem.shops`
   * holds and what a card prints. A name is not somewhere to walk to — `Boat
   * Launch` is one shop row standing in two rooms — so choosing where to buy
   * needs the rooms, and re-deriving them per ask is the scan over 57,511
   * rooms this file refuses everywhere else.
   */
  private stocking: Map<number, WorldRoom[]> | null = null;
  /** Monster row → the room scripts that summon it and nothing else — `itemAsks`. */
  private summonScripts: Map<number, Array<{ room: RoomId; say: string }>> | null = null;
  /**
   * The items that are themselves a way through, as edges — built once.
   *
   * An item that teleports is an edge from **everywhere** to one room, which
   * is why it is a flat list rather than a map keyed by where it is used:
   * `WorldItem.lands` is a fixed address and drinking the potion works
   * wherever the character is standing. The exit objects are shared across
   * every search and never mutated, like the portal table beside them.
   */
  private landings: ReadonlyArray<PortalExit> | null = null;
  /**
   * What each of those edges spends, keyed by the edge — see `Router.buildRoute`.
   *
   * Everything but `at`, which is the one part that is not a property of the
   * item: the edge is shared across every room it could be used in, and where
   * it *was* used is the step's own fact.
   */
  private readonly spends = new Map<PortalExit, Omit<RouteInvocation, 'at'>>();
  /** The header's monsters, items, shops, spells, races and classes (`Catalogue.ts`). */
  private readonly catalogue: Catalogue;
  /** A* over these rooms; the routing methods below are its façade. */
  private readonly router: Router;
  /**
   * The quests and the plans made from them (`QuestPlanner.ts`, todo 712);
   * the planning methods below are its façade.
   */
  private readonly planner: QuestPlanner;

  constructor(catalogue: Catalogue, quests?: unknown) {
    this.catalogue = catalogue;
    // Here rather than beside the field, so every table the router holds
    // exists whatever order the fields above are declared in.
    this.router = new Router(this.roomIndex());
    this.planner = new QuestPlanner(this.router, catalogue, this.plannerRooms(), quests);
  }

  /**
   * What the router reads (`RoomIndex`): this graph's tables and room
   * lookups and the catalogue's rows, composed here rather than implemented,
   * so the port's members are not this class's public face.
   */
  private roomIndex(): RoomIndex {
    const catalogue = this.catalogue;
    return {
      roomsById: this.rooms,
      portalsByRoom: this.portals,
      spendsByEdge: this.spends,
      itemLandings: () => this.itemLandings(),
      leversHere: (from, direction) => this.leversHere(from, direction),
      hazardOf: (room, level) => catalogue.hazardOf(room, level),
      corridorsOn: (steps) => this.corridorsOn(steps),
      sourceRooms: (item) => this.sourceRooms(item),
      item: (id) => catalogue.item(id),
      spellById: (id) => catalogue.spellById(id),
      byId: (id) => this.byId(id),
      landingCount: (landing) => this.landingCount(landing),
      namedClasses: () => catalogue.namedClasses(),
      namedRaces: () => catalogue.namedRaces()
    };
  }

  /**
   * What the planner reads of these rooms (`PlannerRooms`): the router's
   * table and passages, and the joins that find a room, composed here for
   * `roomIndex`'s reason.
   */
  private plannerRooms(): PlannerRooms {
    return {
      roomsById: this.rooms,
      corridorsOn: (steps) => this.corridorsOn(steps),
      mobPlaces: (mob) => this.mobPlaces(mob),
      spawnRoomsOf: (mob) => this.spawnRoomsOf(mob),
      shopPlace: (name) => this.shopPlace(name),
      placingHandovers: (item) => this.placingHandovers(item),
      buyingPlaces: (item, from, to, traveller) => this.buyingPlaces(item, from, to, traveller),
      stockingPlaces: (items, from, to, traveller) =>
        this.stockingPlaces(items, from, to, traveller)
    };
  }

  get size(): number {
    return this.rooms.size;
  }

  // ---------------------------------------------------------------------
  // The catalogue's accessors, each a one-line delegation (todo 711): what
  // each reads, and why, is `Catalogue.ts`, under the section it belongs to.
  // ---------------------------------------------------------------------

  itemIdsCarried(items: Parameters<Catalogue['itemIdsCarried']>[0]): number[] {
    return this.catalogue.itemIdsCarried(items);
  }

  itemIdNamed(name: string): number | null {
    return this.catalogue.itemIdNamed(name);
  }

  itemsNamed(names: readonly string[]): Record<string, WorldItem> {
    return this.catalogue.itemsNamed(names);
  }

  item(id: number): WorldItem | undefined {
    return this.catalogue.item(id);
  }

  itemsServing(condition: Parameters<Catalogue['itemsServing']>[0], limit?: number): WorldItem[] {
    return this.catalogue.itemsServing(condition, limit);
  }

  itemsCasting(spell: number): readonly WorldItem[] {
    return this.catalogue.itemsCasting(spell);
  }

  sourcesOf(item: Parameters<Catalogue['sourcesOf']>[0]): ReturnType<Catalogue['sourcesOf']> {
    return this.catalogue.sourcesOf(item);
  }

  mob(name: string): WorldMob | undefined {
    return this.catalogue.mob(name);
  }

  mobNames(): string[] {
    return this.catalogue.mobNames();
  }

  get mobCount(): number {
    return this.catalogue.mobCount;
  }

  mobAsPrinted(name: string): WorldMob | undefined {
    return this.catalogue.mobAsPrinted(name);
  }

  mobById(id: number): WorldMob | undefined {
    return this.catalogue.mobById(id);
  }

  mobRow(id: number): WorldMobRow | undefined {
    return this.catalogue.mobRow(id);
  }

  lair(room: WorldRoom, family: RealmFamily | null): WorldLair | null {
    return this.catalogue.lair(room, family);
  }

  lairOf(room: WorldRoom): WorldMob[] {
    return this.catalogue.lairOf(room);
  }

  lairEntities(room: WorldRoom): MobEntity[] {
    return this.catalogue.lairEntities(room);
  }

  residentEntities(room: WorldRoom): MobEntity[] {
    return this.catalogue.residentEntities(room);
  }

  summonersOf(mob: WorldMob): WorldMob[] {
    return this.catalogue.summonersOf(mob);
  }

  buildItemEntity(
    rawName: string,
    observed?: Parameters<Catalogue['buildItemEntity']>[1]
  ): ItemEntity {
    return this.catalogue.buildItemEntity(rawName, observed);
  }

  itemPlacedHere(item: ItemEntity, room: WorldRoom): ItemEntity {
    return this.catalogue.itemPlacedHere(item, room);
  }

  buildNpcEntity(room: WorldRoom): NpcEntity | null {
    return this.catalogue.buildNpcEntity(room);
  }

  shop(id: number): WorldShop | undefined {
    return this.catalogue.shop(id);
  }

  priceAt(item: number, shop: number): number | null {
    return this.catalogue.priceAt(item, shop);
  }

  spellById(id: number): WorldSpell | null {
    return this.catalogue.spellById(id);
  }

  spellNamed(word: string): WorldSpell | null {
    return this.catalogue.spellNamed(word);
  }

  searchSpells(query: string, limit?: number): WorldSpell[] {
    return this.catalogue.searchSpells(query, limit);
  }

  castableSpells(): SpellOption[] {
    return this.catalogue.castableSpells();
  }

  spellsByMessage(ability: number): ReadonlyMap<number, readonly string[]> {
    return this.catalogue.spellsByMessage(ability);
  }

  get spellCount(): number {
    return this.catalogue.spellCount;
  }

  hazardOf(room: WorldRoom, level?: number | null): SpellHazard | null {
    return this.catalogue.hazardOf(room, level);
  }

  namedClasses(): Record<number, string> {
    return this.catalogue.namedClasses();
  }

  namedRaces(): Record<number, string> {
    return this.catalogue.namedRaces();
  }

  raceId(name: string): number | null {
    return this.catalogue.raceId(name);
  }

  classId(name: string): number | null {
    return this.catalogue.classId(name);
  }

  raceAbilities(name: string): Array<[number, number]> | null {
    return this.catalogue.raceAbilities(name);
  }

  raceSpans(name: string): AttributeSpans | null {
    return this.catalogue.raceSpans(name);
  }

  experiencePercent(race: string, className: string): number | null {
    return this.catalogue.experiencePercent(race, className);
  }

  classNamed(name: string): WorldClass | null {
    return this.catalogue.classNamed(name);
  }

  // ---------------------------------------------------------------------
  // Entity builders that need a room. The rest, and the rule every one of
  // them keeps, are `Catalogue.ts` › Entity builders.
  // ---------------------------------------------------------------------

  /**
   * A monster, joined to the realm's row.
   *
   * The name is looked up through `mobNameCandidates` — least stripping first,
   * because `MobNameModifierType` hangs a word off either end and a shorter
   * name is a *different monster* whose disposition decides whether the client
   * swings. `rawName` keeps what the server printed, because that is what a
   * command has to name.
   */
  buildMobEntity(
    rawName: string,
    observed: { charmed?: boolean; at?: RoomId | null } = {}
  ): MobEntity {
    const raw = rawName.trim();
    /*
     * Least stripping first (`mobAsPrinted`, inside `mobAt`).
     * `MobNameModifierType` hangs a whole run of words off either end, so
     * `small elite guardsman` has to reach `guardsman` — and the ladder is
     * ordered so the *longest* name that matches wins, because a shorter one
     * is a different monster whose disposition decides whether the client
     * swings. One rule, shared with the classifier, or the two ends of the
     * client disagree about what the realm knows.
     *
     * `at` is the room the name was printed in, where the caller has one: it
     * resolves a name holding several of the realm's rows to the one that
     * spawns here rather than to the worst of them. See `resolveMobRow`.
     */
    return this.catalogue.mobEntity(
      raw,
      this.mobAt(raw, observed.at ?? null),
      observed.charmed ?? false
    );
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
          entity.obstacle = describeObstacle(
            match.requirement,
            this,
            from === null || from === undefined
              ? []
              : this.leversHere(roomId(from.map, from.room), match.direction)
          );
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
   * Which of a name's rows is standing in this room, and on what evidence.
   *
   * The wire carries no row number, so a name has always folded every row
   * sharing it and taken the worst of them: `gnoll scout` is row 224, a
   * 100-HP scout, and row 2204, an 830-HP one, and the card answered
   * `100–830 hp` and priced the fight at 2,161 hp of chewing. But the *room*
   * is evidence, and a strong one — the realm says which rows it spawns, and
   * a monster does not walk far from where it spawned.
   *
   * Two rungs, and a refusal under both:
   *
   * 1. **Here.** The room's own lair or resident names exactly one of the
   *    rows. Nothing beats this and nothing is searched.
   * 2. **Nearest.** Breadth-first from the room over walkable exits, keeping
   *    the first distance at which each row is reached, and stopping once the
   *    answer can no longer change: past `mobRowMargin` times the nearest hit
   *    there is no runner-up that could still be called close. The nearest row
   *    wins only by that margin, so five steps against a thousand resolves and
   *    five against seven does not.
   *
   * Otherwise null, which leaves the fold and its stated range exactly as they
   * were — an ambiguous room is one to report rather than one to guess at.
   * Doors, keys and level gates are walked through here: a monster that spawns
   * behind a locked door is still the one in front of you, and refusing to
   * count it would make the wrong row look nearest.
   */
  resolveMobRow(name: string, from: RoomId | null): MobRowChoice | null {
    const mob = this.mobAsPrinted(name);
    const ids = mob?.ids;
    // One row is not a choice, and a realm with no per-row records has nothing
    // to resolve *to*: the fold is already every answer the file holds.
    if (mob === undefined || ids === undefined || ids.length < 2) return null;
    if (from === null || !this.rooms.has(from)) return null;
    const wanted = new Set(ids.filter((id) => this.catalogue.mobRow(id) !== undefined));
    if (wanted.size < 2) return null;

    const key = `${from}|${mob.name}`;
    const held = this.resolvedRows.get(key);
    if (held !== undefined) return held;
    const answer = this.searchMobRow(from, wanted);
    // Bounded like any per-session cache: a character walks through rooms and
    // meets names, and the pair is what would otherwise grow without end.
    if (this.resolvedRows.size >= RESOLVED_ROW_CACHE) this.resolvedRows.clear();
    this.resolvedRows.set(key, answer);
    return answer;
  }

  /** The two rungs of `resolveMobRow`, once the candidates are known. */
  private searchMobRow(from: RoomId, wanted: ReadonlySet<number>): MobRowChoice | null {
    const here = this.rooms.get(from);
    if (here === undefined) return null;

    /*
     * Rung one: what the realm says spawns in this very room. A resident and a
     * lair are both claims about *this* room, and one of them naming exactly
     * one candidate ends the question — there is nothing a distance could add.
     */
    const named = new Set<number>();
    if (here.npcId !== undefined && wanted.has(here.npcId)) named.add(here.npcId);
    if (here.lair !== undefined) {
      for (const id of parseLair(here.lair).ids) if (wanted.has(id)) named.add(id);
    }
    if (named.size === 1) {
      const [id] = [...named];
      return { id: id!, how: 'here', steps: 0, beyond: null };
    }
    // Two of the name's rows spawn in this room: the room cannot tell them
    // apart, and neither can anything downstream of it.
    if (named.size > 1) return null;

    /*
     * Rung two. The reverse index is already built for the Reference card's
     * *spawns in* list, so the target set is a lookup rather than a scan, and
     * the sweep tests each room against a handful of addresses.
     */
    const targets = new Map<RoomId, number>();
    const spawns = this.mobRooms();
    for (const id of wanted) {
      for (const entry of spawns.get(id) ?? []) {
        const at = roomId(entry.room.map, entry.room.room);
        // First writer wins, so a room two rows both spawn in resolves to
        // neither: it is added under the first and read back as a tie below.
        if (!targets.has(at)) targets.set(at, id);
        else if (targets.get(at) !== id) targets.set(at, TIED_ROW);
      }
    }
    if (targets.size === 0) return null;

    /*
     * The margin is what makes this a resolution rather than a coin toss.
     * Nearest-wins on its own would answer *row 224* for a room one step
     * nearer 224 than 2204, which is evidence of nothing — a monster wanders,
     * and it is dragged. So the sweep runs out to `mobRowMargin` times the
     * first hit's distance and the answer stands only if nothing else of the
     * name turned up inside it: a second row found anywhere in that ring is a
     * refusal, and the sweep past it would be spent learning by how much.
     */
    const { mobRowMargin, mobRowRooms } = tuning().world;
    const found = new Map<number, number>();
    const seen = new Set<RoomId>([from]);
    let queue: RoomId[] = [from];
    let closest: number | null = null;
    let reached = 0;
    for (let depth = 0; queue.length > 0 && seen.size <= mobRowRooms; depth += 1) {
      if (closest !== null && depth > closest * mobRowMargin) break;
      reached = depth;
      const next: RoomId[] = [];
      for (const id of queue) {
        const hit = targets.get(id);
        // A room two of the rows share says both are here and neither is
        // nearer, which is a tie at this distance rather than a resolution.
        if (hit === TIED_ROW) return null;
        if (hit !== undefined && !found.has(hit)) {
          if (found.size > 0) return null;
          found.set(hit, depth);
          closest = depth;
        }
        for (const exit of this.rooms.get(id)?.exits ?? []) {
          const to = roomId(exit.map, exit.room);
          if (seen.has(to)) continue;
          seen.add(to);
          next.push(to);
        }
      }
      queue = next;
    }
    const [best] = [...found.entries()];
    if (best === undefined) return null;
    return { id: best[0], how: 'nearest', steps: best[1], beyond: reached };
  }

  /**
   * A monster by name, answering as the row this room resolves it to.
   *
   * The one overlay point. Everything that asks the realm what a name is worth
   * — the card, the appraisal auto-combat ranks on, the health bar's maximum —
   * comes through here, so a room that can tell two rows apart tells all of
   * them at once and none of them can disagree about it. A room that cannot,
   * or a name the realm places once, gets the fold it always got.
   */
  mobAt(name: string, from: RoomId | null): WorldMob | undefined {
    const mob = this.mobAsPrinted(name);
    if (mob === undefined) return undefined;
    const choice = this.resolveMobRow(name, from);
    if (choice === null) return mob;
    const row = this.catalogue.mobRow(choice.id);
    return row === undefined ? mob : mobAsRow(mob, row, choice);
  }

  /** Every room within `steps` moves of `from`, pricing nothing — `Router.withinSteps`. */
  withinSteps(from: RoomId, steps: number, traveller?: Traveller): Map<RoomId, number> {
    return this.router.withinSteps(from, steps, traveller);
  }

  /**
   * Every room the realm says holds a shop, for walking to the nearest one.
   *
   * A shop is a property of a room, so "where can I buy something" is a walk
   * the world graph can plan without asking the server anything.
   */
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

  /**
   * Where to buy a thing on the way to somewhere — best first (2026-09-16).
   *
   * Reported: a character in the Alchemist's Hut, asked to fetch a `log raft`
   * for the Silver River, was told *nowhere to buy log raft: 2 rooms hold a
   * shop called Boat Launch* — while standing on a route that walks **through**
   * one of the two. Three separate mistakes met there, and this answers all
   * three: the client ranked shops it could only address by **name**, priced
   * that name at infinity the moment it stood in two rooms, and then asked
   * `shopPlace` to resolve it and was refused for the ambiguity it had created.
   *
   * **The detour is the quantity.** Not the distance from here, which is what
   * this replaced: with the character's real pack, the nearest raft counter by
   * distance is unreachable altogether and the two that are reachable sit 47
   * and 318 steps off the way. What a person asking where to stop for petrol
   * wants is how far off the road it is, and that is
   * `here → counter → there` less `here → there`, priced by this traveller like
   * every other plan main makes. Zero for a counter the route already passes.
   *
   * **The way on is walked carrying what was bought**, which is the whole point
   * of the errand: the raft is being fetched *because* it quietens the river,
   * so pricing the second leg without it would rank every counter by a journey
   * nobody is going to take. `Router.holding` is that traveller.
   *
   * **Price breaks the tie and never more than that** — see
   * `tuning.supplies.dearerSteps`. A counter the realm places nowhere reachable
   * is left out rather than ranked last: there is no walk to it to price.
   *
   * `to` is null for the supply list's own errand, which has no destination —
   * then the trip *is* the detour and this ranks by what it costs to get there.
   */
  buyingPlaces(item: number, from: RoomId, to: RoomId | null, traveller: Traveller): BuyingPlace[] {
    return this.buyingPlacesFor([item], from, to, traveller);
  }

  /**
   * The same for a whole stock list on one pair of sweeps — what topping each
   * row up would add to *this* leg, so a plan can put the shopping on the leg
   * that passes nearest the counter. `buyingPlacesFor`'s reason exactly: a
   * sweep pair per row over a nine-step chain is Dijkstras on the socket's
   * thread for a handful of torches.
   */
  stockingPlaces(
    items: readonly number[],
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): Array<BuyingPlace & { item: number }> {
    return this.buyingPlacesFor(items, from, to, traveller);
  }

  /**
   * The same for several items at once, on one pair of sweeps: every counter
   * stocking any of them, priced together, each place saying which item it
   * is for. `QuestPlanner.supplyFor` asks about the two to four things the
   * realm says stop one spell, and a sweep pair per item was eight Dijkstras
   * on the socket's thread for a river crossing (review, 2026-09-21).
   */
  private buyingPlacesFor(
    items: readonly number[],
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): Array<BuyingPlace & { item: number }> {
    const candidates: Array<{ item: number; room: WorldRoom }> = [];
    for (const item of items) {
      for (const room of this.stockRooms(item)) candidates.push({ item, room });
    }
    if (candidates.length === 0) return [];
    const wanted = new Set(candidates.map(({ room }) => roomId(room.map, room.room)));
    const head = this.router.sweepTo(from, wanted, traveller);
    /*
     * One sweep backwards from the destination answers both halves at once:
     * what each counter costs to leave from, and — by asking about `from` in
     * the same sweep — the journey the detour is measured against. Two Dijkstras
     * in total, whatever the realm holds counters for, rather than a route per
     * candidate.
     */
    const back =
      to === null
        ? null
        : this.router.sweepBack(
            new Map([[to, 0]]),
            new Set([...wanted, from]),
            items.reduce((held, item) => this.router.holding(held, item), traveller),
            true
          );
    /*
     * The journey the detour is measured against. Undefined is a destination
     * nothing reaches from here, which is not this question's to answer and not
     * a reason to say the thing is sold nowhere: the trip to the counter is
     * then the whole of what stopping costs, exactly as when there is no
     * destination at all.
     */
    const base = back?.get(from);
    const places: Array<BuyingPlace & { item: number }> = [];
    for (const { item, room } of candidates) {
      const id = roomId(room.map, room.room);
      const reach = head.get(id);
      // Nothing the router can walk leads there, so there is no detour to
      // state. Left out rather than ranked last: a figure would be a fiction.
      if (reach === undefined) continue;
      const shop = room.shop === undefined ? undefined : this.catalogue.shop(room.shop);
      if (shop === undefined) continue;
      let detour = reach.cost;
      if (back !== null && base !== undefined) {
        const tail = back.get(id);
        // Reachable, but the journey cannot go on from it. Left out for the
        // same reason: stopping here would end the trip rather than delay it.
        if (tail === undefined) continue;
        detour = reach.cost + tail - base;
      }
      places.push({
        map: room.map,
        room: room.room,
        roomName: room.name,
        shop: shop.name,
        markup: shop.markup ?? 0,
        /*
         * Never negative, and the two legs are deliberately priced on
         * *different* graphs: the way there without the thing, the way on with
         * it. Carrying it can only ever make a step cheaper, so the way there
         * costs at least what it would carrying it, and that plus the way on is
         * at least the whole journey carrying it — which is the baseline. A
         * rounded zero is the counter the route already walks through.
         */
        detour: Math.max(0, Math.round(detour)),
        moves: reach.moves,
        item
      });
    }
    const dearer = tuning().supplies.dearerSteps;
    return places.sort(
      (a, b) =>
        buyingRank(a, dearer) - buyingRank(b, dearer) ||
        a.moves - b.moves ||
        a.map - b.map ||
        a.room - b.room
    );
  }

  /**
   * Item id -> the rooms whose counter stocks it, built once.
   *
   * By **id**, like `Catalogue.stockedBy` and for the same reason: a shop
   * stocks rows, and the realm repeats item names across rows.
   */
  private stockRooms(item: number): readonly WorldRoom[] {
    if (this.stocking === null) {
      const index = new Map<number, WorldRoom[]>();
      for (const room of this.rooms.values()) {
        if (room.shop === undefined) continue;
        const shop = this.catalogue.shop(room.shop);
        if (shop === undefined) continue;
        // A shelf may list one row twice; the room is still one place to go.
        const seen = new Set<number>();
        for (const line of shop.items) {
          if (seen.has(line.id)) continue;
          seen.add(line.id);
          const held = index.get(line.id);
          if (held === undefined) index.set(line.id, [room]);
          else held.push(room);
        }
      }
      this.stocking = index;
    }
    return this.stocking.get(item) ?? [];
  }

  /**
   * Every room where this item can be had: a counter that stocks it, a room
   * the realm places a monster that drops it, or where saying something gets
   * it — what `Router.fetchPrice` prices the walk to the nearest of.
   */
  private sourceRooms(item: number): ReadonlySet<RoomId> {
    const rooms = new Set<RoomId>(this.stockRooms(item).map((room) => roomId(room.map, room.room)));
    for (const name of this.sourcesOf({ id: item }).mobs) {
      const mob = this.mob(name);
      if (mob === undefined) continue;
      // And, for a dropper only ever summoned, whatever summons it (todo 806).
      for (const who of [mob, ...this.summonersOf(mob)]) {
        for (const { room } of this.spawnRoomsOf(who)) rooms.add(roomId(room.map, room.room));
      }
    }
    // And where saying something gets it.
    for (const { room } of this.askPlaces(item)) rooms.add(room);
    return rooms;
  }

  /**
   * Where the realm spawns a monster, grouped by the name of the room.
   *
   * The reverse of the two columns the world file has always carried and only
   * ever read forwards — `Rooms.NPC` and `Rooms.Lair`. The Room card could say
   * *this lair holds a snow cat*; nothing could answer *where is a snow cat*,
   * which is the question somebody asking about a monster actually has, and
   * MMUD Explorer's own monster page has answered it for twenty years.
   *
   * **Grouped by room name, and the addresses kept underneath.** `snow cat` is
   * in 236 rooms bearing 25 names: a list of addresses is not somewhere a
   * person can decide to go, and a button that walked to one of the 236 would
   * be the guess `shopPlace` refuses. So a group of one is a place, a group of
   * several is a choice, and the count is stated either way.
   *
   * Undefined for a monster the realm places in no room — 153 of the shipped
   * realm's 1,514 names — rather than an empty list, which reads as a claim
   * that it is nowhere when what the data says is that it is summoned or
   * scripted in.
   */
  mobPlaces(mob: WorldMob, groups = 12, perGroup = 12): MobPlaces | undefined {
    const found = this.spawnRoomsOf(mob);
    if (found.length === 0) return undefined;

    /*
     * One room may be reached both ways — a lair in a room that also has a
     * resident — and `npc` wins, because it is the more specific claim: the
     * realm saying this creature lives here, not that it is one candidate for
     * a regeneration slot.
     */
    const byRoom = new Map<RoomId, MobSpawnRoom>();
    for (const entry of found) {
      const key = roomId(entry.room.map, entry.room.room);
      const already = byRoom.get(key);
      if (already === undefined || (already.via === 'lair' && entry.via === 'npc')) {
        byRoom.set(key, entry);
      }
    }

    /*
     * In the realm's own room order, not in the order the index happened to
     * reach them. A name resolving to several of the realm's rows — `snow cat`
     * is ids 70 and 71 — is walked one row at a time, so the addresses under a
     * group came out interleaved by whichever row placed each: `2/1, 2/3, 2/2`.
     * The list is read and clicked, and the cap decides which of them survive
     * it, so the order has to be the map's rather than the table's.
     */
    const ordered = [...byRoom.values()].sort(
      (a, b) => a.room.map - b.room.map || a.room.room - b.room.room
    );

    const grouped = new Map<string, MobSpawn>();
    for (const entry of ordered) {
      const name = entry.room.name.trim();
      // `via` is part of the key: *lives here* and *may spawn here* are two
      // different answers, and folding them would state the weaker as the
      // stronger for any room that is both.
      const key = `${entry.via}:${name.toLowerCase()}`;
      const group = grouped.get(key);
      if (group === undefined) {
        grouped.set(key, {
          via: entry.via,
          roomName: name,
          count: 1,
          rooms: [{ map: entry.room.map, room: entry.room.room }],
          max: entry.max
        });
        continue;
      }
      group.count += 1;
      if (group.rooms.length < perGroup) {
        group.rooms.push({ map: entry.room.map, room: entry.room.room });
      }
      // A figure the rows disagree about is no figure. Folding to either end
      // would publish a maximum the realm never stated for any of them.
      if (group.max !== entry.max) group.max = null;
    }

    const all = [...grouped.values()].sort(
      (a, b) =>
        // The resident first — it is the specific answer — then the widest
        // spread, which is where the thing is most likely to be found.
        (a.via === b.via ? 0 : a.via === 'npc' ? -1 : 1) ||
        b.count - a.count ||
        a.roomName.localeCompare(b.roomName)
    );
    return {
      spawns: all.slice(0, groups),
      rooms: byRoom.size,
      more: Math.max(0, all.length - groups)
    };
  }

  /**
   * Every placement of this monster, one entry per room and slot, uncapped.
   *
   * A name can hold several of the realm's rows — five `cocoon`s — and each
   * row is placed separately, so every id behind the name contributes. The
   * mob index is keyed by name and `Catalogue.mobById` maps the ids onto it, so this
   * asks the id index which of its entries *is* this mob rather than keeping
   * a third index of name → ids.
   *
   * Through the fold and not through the argument, because `mobAt` hands
   * back a *copy* re-answered by one row and an identity test against that
   * copy matches nothing: the card lost its whole `spawns in` list the day
   * the room began resolving the name. And where one row was resolved, only
   * that row's rooms are places this monster is — the other row's are where
   * its namesake lives, which is the confusion the resolution exists to end.
   */
  private spawnRoomsOf(mob: WorldMob): MobSpawnRoom[] {
    const found: MobSpawnRoom[] = [];
    const fold = this.catalogue.mob(mob.name);
    const only = mob.row?.id;
    for (const [id, rooms] of this.mobRooms()) {
      if (only !== undefined ? id !== only : this.catalogue.mobById(id) !== fold) continue;
      found.push(...rooms);
    }
    return found;
  }

  /** The reverse index, built on the first ask. See `mobPlaces`. */
  private mobRooms(): Map<number, MobSpawnRoom[]> {
    if (this.mobRoomsById !== null) return this.mobRoomsById;
    const index = new Map<number, MobSpawnRoom[]>();
    const put = (id: number, entry: MobSpawnRoom): void => {
      const bucket = index.get(id);
      if (bucket === undefined) index.set(id, [entry]);
      else bucket.push(entry);
    };
    for (const room of this.rooms.values()) {
      if (room.npcId !== undefined) put(room.npcId, { room, via: 'npc', max: null });
      if (room.lair === undefined) continue;
      const { max, ids } = parseLair(room.lair);
      for (const id of ids) put(id, { room, via: 'lair', max });
    }
    this.mobRoomsById = index;
    return index;
  }

  private shopsByName(): Map<string, WorldRoom[]> {
    if (this.shopRoomsByName !== null) return this.shopRoomsByName;
    const index = new Map<string, WorldRoom[]>();
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const name = this.catalogue.shop(room.shop)?.name.trim().toLowerCase();
      if (name === undefined || name.length === 0) continue;
      const bucket = index.get(name);
      if (bucket === undefined) index.set(name, [room]);
      else bucket.push(room);
    }
    this.shopRoomsByName = index;
    return index;
  }

  /**
   * Every bank counter the realm places, for the settings picker (todo 00).
   *
   * The join `trainersTaking` makes, without the filtering: a bank takes every
   * character and charges nothing, so there is no eligibility to work out —
   * the question is only *which vault*, and every counter is an answer.
   *
   * A row placed in several rooms is several entries, all valid, and the
   * player picks: the balance is the row's, so two rooms holding the same row
   * are two doors onto one vault. Sorted by name then room so the same realm
   * answers the same way twice.
   */
  banks(): BankChoice[] {
    const found: BankChoice[] = [];
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const shop = this.catalogue.shop(room.shop);
      if (shop === undefined || shop.kind !== 'bank') continue;
      found.push({
        shop: room.shop,
        name: shop.name,
        map: room.map,
        room: room.room,
        roomName: room.name
      });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.map - b.map || a.room - b.room);
  }

  /**
   * The vaults holding at least `need` copper by this character's own record,
   * best first by what stopping at each adds to the way to `to` (todo 00).
   *
   * `buyingPlacesFor`'s arithmetic over bank rooms instead of counters, on the
   * same two sweeps: the detour, not the distance, since the cash is wanted at
   * the counter and a vault the way already passes costs nothing. A vault
   * nobody has asked is not a candidate — a walk to learn a balance is a guess
   * at one — and the one the record overstates is found out at its counter,
   * where the errand asks `bank` before it withdraws.
   */
  cashPlaces(
    balances: readonly BankBalance[],
    need: number,
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): CashPlace[] {
    const candidates: Array<{ choice: BankChoice; copper: number }> = [];
    for (const choice of this.banks()) {
      const held = balanceOf({ id: choice.shop, name: choice.name }, balances);
      if (held === null || held.copper < need) continue;
      candidates.push({ choice, copper: held.copper });
    }
    if (candidates.length === 0) return [];
    const wanted = new Set(candidates.map(({ choice }) => roomId(choice.map, choice.room)));
    const head = this.router.sweepTo(from, wanted, traveller);
    const back =
      to === null
        ? null
        : this.router.sweepBack(new Map([[to, 0]]), new Set([...wanted, from]), traveller, true);
    const base = back?.get(from);
    const places: CashPlace[] = [];
    for (const { choice, copper } of candidates) {
      const id = roomId(choice.map, choice.room);
      const reach = head.get(id);
      if (reach === undefined) continue;
      let detour = reach.cost;
      if (back !== null && base !== undefined) {
        const tail = back.get(id);
        if (tail === undefined) continue;
        detour = reach.cost + tail - base;
      }
      places.push({
        ...choice,
        copper,
        detour: Math.max(0, Math.round(detour)),
        moves: reach.moves
      });
    }
    return places.sort(
      (a, b) => a.detour - b.detour || a.moves - b.moves || a.map - b.map || a.room - b.room
    );
  }

  /**
   * Every trainer that will take this character, with the room it is in.
   *
   * The join the levelling errand and the settings screen both need: the
   * realm states a band, a class restriction and a markup per shop row
   * (format 35), and the rooms name the shop they hold. `trainersFor` is the
   * rule — cheapest first, never one whose ceiling this level has reached —
   * and this is the part that knows where the rooms are.
   *
   * **Keyed by the shop's row, not by its name.** `shopPlace` answers by name
   * and reports several rooms as an ambiguity, which is right for *the shop
   * that sells torches* and wrong here: two rows may share a name (Paradigm
   * has `Ninja Training Room` twice) and they are different trainers with
   * different bands. A row placed in several rooms is several entries, all
   * eligible, and the caller picks — which for this feature is the player.
   *
   * Empty on a realm with no class read where a trainer restricts by class,
   * and on one built before format 35, where no row states a band at all: a
   * client that cannot tell which trainer takes this character must not walk
   * to one, which is `trainsLevel`'s refusal doing exactly its job.
   */
  trainersTaking(
    level: number,
    classId: number | null
  ): Array<{ trainer: TrainerRow; map: number; room: number; roomName: string }> {
    const taking = trainersFor(this.catalogue.trainerRows(), level, classId);
    if (taking.length === 0) return [];

    const wanted = new Map(taking.map((row, at) => [row.id, at]));
    const found: Array<{ trainer: TrainerRow; map: number; room: number; roomName: string }> = [];
    for (const room of this.rooms.values()) {
      if (room.shop === undefined) continue;
      const at = wanted.get(room.shop);
      if (at === undefined) continue;
      const trainer = taking[at];
      if (trainer === undefined) continue;
      found.push({ trainer, map: room.map, room: room.room, roomName: room.name });
    }
    // Back into the rule's order, which the room scan does not preserve.
    return found.sort(
      (a, b) =>
        (wanted.get(a.trainer.id) ?? 0) - (wanted.get(b.trainer.id) ?? 0) ||
        a.map - b.map ||
        a.room - b.room
    );
  }

  /** The closest room satisfying `want`, by unobstructed steps, as a route — `Router.nearest`. */
  nearest(
    from: RoomId,
    want: (room: WorldRoom) => boolean,
    limit?: number,
    through?: (requirement: Requirement) => boolean
  ): Route | null {
    return this.router.nearest(from, want, limit, through);
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
      const shop = room.shop === undefined ? undefined : this.catalogue.shop(room.shop);
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
   * Every name the realm knows, for the console to recognise on hover:
   * `Catalogue.names`, and the rooms'.
   */
  names(): WorldNames {
    return {
      ...this.catalogue.names(),
      /*
       * Multi-word room names only — see `WorldNames.rooms` for why the short
       * ones are kept out rather than merely outranked. `byName` is already
       * keyed lower-cased, so this is the keys it holds, filtered.
       */
      rooms: [...this.byName.keys()].filter((name) => name.includes(' '))
    };
  }

  /**
   * Everything the realm knows about a name (`Catalogue.lookup`), answered
   * for the room the reader stands in, with the rooms each item is in.
   */
  lookup(query: string, limit = 12, at: RoomId | null = null): WorldLookup {
    const found = this.catalogue.lookup(query, limit);
    return {
      ...found,
      /*
       * And answered as the row the reader's own room resolves each name to,
       * where it can — the card is where the fold was read as a claim about one
       * monster, and `100–830 hp` is what a name holding two rows looks like
       * when nothing has been asked about the room it was clicked in. Unresolved
       * names come back untouched, span and all.
       */
      mobs: found.mobs.map((mob) => this.mobAt(mob.name, at) ?? mob),
      items: found.items.map((item) => this.withPlacements(this.placingHandovers(item)))
    };
  }

  /**
   * An item with each of its handovers' rooms named — format 39.
   *
   * The join `shopPlaces` and `QuestStep.place` are: the file carries the
   * `map/room` because that is what the realm states, and `9/146` is not
   * somewhere anybody can picture. Made here rather than at load, because the
   * rooms arrive line by line *after* the header the items are in.
   *
   * A copy, never a write into the cached row — the map holds one object per
   * item and every lookup shares it. Untouched where the realm names no
   * handover, which is the great majority, so this costs nothing per query.
   */
  private placingHandovers(item: WorldItem): WorldItem {
    if (item.from === undefined || item.from.length === 0) return item;
    return {
      ...item,
      from: item.from.map((handover) => {
        if (handover.room === undefined || handover.place !== undefined) return handover;
        const name = this.rooms.get(handover.room as RoomId)?.name.trim();
        return name === undefined || name.length === 0 ? handover : { ...handover, place: name };
      })
    };
  }

  /**
   * An item with the rooms the realm puts it in — format 42.
   *
   * Joined at the lookup for `placingHandovers`' reason: the rooms arrive
   * after the header the items are in. A copy, never a write into the shared
   * row. **Every row the name holds**, as `mobPlaces` takes every row behind
   * a monster's: the lookup answers one row per name, and `nightblack
   * portal`'s first is placed nowhere while its others stand in 26 rooms.
   */
  private withPlacements(item: WorldItem): WorldItem {
    const rows = this.catalogue.itemRowsNamed(item.name) ?? [item.id];
    const placed = this.itemPlaces(rows);
    return placed === undefined ? item : { ...item, placed };
  }

  /**
   * Every room the realm puts an item in, grouped the way `mobPlaces` groups
   * a monster's: by room name, in the map's own order, the widest spread
   * first, and capped with the counts beside — a coffin stands in 77 rooms
   * and a list of them is a scan, not a lead.
   */
  itemPlaces(rows: readonly number[], groups = 12, perGroup = 12): ItemPlaces | undefined {
    const placedRows = rows.filter((row) => (this.placedIn.get(row) ?? []).length > 0);
    const ids = new Set(placedRows.flatMap((row) => this.placedIn.get(row) ?? []));
    const rooms = [...ids]
      .map((id) => this.rooms.get(id))
      .filter((room): room is WorldRoom => room !== undefined)
      .sort((a, b) => a.map - b.map || a.room - b.room);
    if (rooms.length === 0) return undefined;
    const grouped = new Map<string, PlaceGroup>();
    for (const room of rooms) {
      const name = room.name.trim();
      const group = grouped.get(name.toLowerCase());
      if (group === undefined) {
        grouped.set(name.toLowerCase(), {
          roomName: name,
          count: 1,
          rooms: [{ map: room.map, room: room.room }]
        });
        continue;
      }
      group.count += 1;
      if (group.rooms.length < perGroup) group.rooms.push({ map: room.map, room: room.room });
    }
    const all = [...grouped.values()].sort(
      (a, b) => b.count - a.count || a.roomName.localeCompare(b.roomName)
    );
    // Whether what stands there can be taken is the placed rows' question,
    // not the name's first row's: `wooden box` is loot and furniture both.
    const fixed = placedRows.every((row) => this.catalogue.item(row)?.gettable === false);
    return {
      groups: all.slice(0, groups),
      more: Math.max(0, all.length - groups),
      ...(fixed ? { fixed: true as const } : {})
    };
  }

  get info(): WorldMeta {
    return this.meta;
  }

  /**
   * The header of a realm file, without indexing the realm behind it.
   *
   * For a question about *which* world a file is — its name, the archive it
   * came from — asked before deciding whether to load it at all. The whole
   * file is still inflated (gzip cannot skip), which is tens of milliseconds
   * against the seconds a full index costs. `null` when the file is missing,
   * unreadable or carries no header.
   */
  static meta(file: string): WorldMeta | null {
    let text: string;
    try {
      text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    } catch {
      return null;
    }
    const end = text.indexOf('\n');
    const header = headerOf(end === -1 ? text : text.slice(0, end));
    return header === null ? null : metaOf(header);
  }

  /** Loads the gzipped JSON-lines file produced by `scripts/build-world.mjs`. */
  static load(file: string): WorldGraph {
    // A realm with no file states nothing, and every table answers so.
    if (!fs.existsSync(file)) return new WorldGraph(Catalogue.read(NO_HEADER));

    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const lines = text.split('\n');

    /*
     * The header first, and the catalogue out of it, before any room: a cast
     * exit is resolved against the spell table as its room is read
     * (`resolveSpells`), and the router is built over both.
     */
    const header = headerOf(lines[0] ?? '');
    // v24. A realm converted before quests were indexed states none, which
    // reads as "this realm scripts no quests" — the same honest absence
    // every index in the catalogue already answers with.
    const graph = new WorldGraph(Catalogue.read(header ?? NO_HEADER), header?.['quests']);
    if (header !== null) graph.meta = metaOf(header);

    for (const [index, line] of lines.entries()) {
      if (line.length === 0 || (index === 0 && header !== null)) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // One malformed line should cost one room, not the whole realm.
        continue;
      }

      const room = graph.toRoom(parsed);
      if (room) graph.add(room);
    }

    graph.linkPortals();
    graph.linkItemLandings();
    graph.linkLevers();
    return graph;
  }

  /**
   * Gives the router every room-script teleport, priced by what it can read.
   *
   * The scripts have been on `WorldRoom.commands` since format 13, card-only,
   * with the routing half deferred (mme.md §6). The first tranche linked only
   * the commands whose every guard was `minlevel`/`maxlevel` and **dropped the
   * edge entirely** for the rest, on the reasoning that a route through a
   * guess walks a character somewhere it cannot get back from.
   *
   * That is the one place in this router that prunes an edge it cannot price,
   * and it is the opposite of what `REQUIREMENT_KINDS` says about an
   * instruction nothing recognises — *passable-but-suspect rather than
   * silently dropped: an exit we do not understand is still an exit, and
   * pruning it strands routes*. It stranded 19,108 of Paradigm's 57,511 rooms
   * and 3,277 of stock's 26,694, measured from the Newhaven Common Room: 186
   * of Paradigm's 255 scripted landings and 106 of stock's 165 were dropped,
   * and with them the only way in to whole regions — Dragon's Fang Hills (766
   * rooms), the Undermountain Caverns (336), the Ancient Darkwood Tree and
   * Morukai behind it, which the realm reaches by `go portal` at 9/1291 under
   * a `checkability 133 5` this client cannot evaluate on Paradigm.
   *
   * So every landing the dataset holds is an edge now, and the guards decide
   * the price rather than whether it exists: `minlevel`/`maxlevel` become the
   * `level` gate they already were, and everything else — `nomonsters`,
   * `roomitem`, `testskill`, `checkability` — goes on `Requirement.unread`,
   * which `edgePenalty` charges the unevaluable figure for. A guarded portal
   * therefore costs about sixty steps of detour: taken when it is the only way
   * there, never preferred while a corridor exists.
   */
  /**
   * An item that teleports **from a particular room** is a portal out of it.
   *
   * Which is all it ever was: the realm gates the potion of levitation's block
   * on `roomitem 993`, item 993 is the `waterfall` standing in `3/1`, and
   * using it anywhere else runs a block that fails on its first step. So the
   * way into the Catacombs is *walk to the pool under the waterfall and drink
   * it there* — one edge out of one room, which every reader that already
   * understands a portal understands for free: the map draws it, `withinSteps`
   * counts the landing as one move from `3/1` (true, unlike *one move from
   * anywhere*), and the router walks to the room and uses it.
   *
   * The requirement is `item`, so `edgePenalty`'s own rung decides the pack —
   * carried free, listed and lacking a wall, never listed discouraged — and
   * the same `spends` entry carries what using it costs.
   */
  private linkItemLandings(): void {
    for (const item of this.catalogue.everyItem()) {
      if (item.lands === undefined || item.usableIn === undefined) continue;
      if (item.name.length === 0) continue;
      const target = this.rooms.get(item.lands);
      if (target === undefined) continue;
      const command = `use ${item.name}`;
      for (const at of item.usableIn) {
        // A guard room outside the dataset is a hole in the data, not a way.
        if (!this.rooms.has(at)) continue;
        const edge: PortalExit = {
          direction: 'portal',
          map: target.map,
          room: target.room,
          requirement: {
            kind: 'item',
            raw: `Item: ${item.id}`,
            keyId: item.id,
            commands: [command],
            ...useGateOf(item)
          }
        };
        this.spends.set(edge, {
          id: item.id,
          name: item.name,
          command,
          uses: item.uses === undefined || item.uses < 0 ? null : item.uses
        });
        const held = this.portals.get(at);
        if (held) held.push(edge);
        else this.portals.set(at, [edge]);
      }
    }
  }

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
        const unread: string[] = [];
        /*
         * And the ability gates among them, read into the comparison the
         * server makes. Still `unread` as well — the chip states every
         * condition in the realm's words — because this is what the client can
         * *answer* once `abil` has stated the counters, not a different fact.
         */
        const gates: AbilityGate[] = [];
        for (const entry of command.need ?? []) {
          const [verb, value] = entry.trim().split(/\s+/);
          const figure = Number(value);
          if (verb === 'minlevel' && Number.isInteger(figure)) minLevel = figure;
          else if (verb === 'maxlevel' && Number.isInteger(figure)) maxLevel = figure;
          // The realm's own words, kept whole: the price is the same for every
          // one of them and the chip is what a person reads to decide.
          else {
            unread.push(entry.trim());
            const gate = readAbilityGate(entry);
            if (gate !== null) gates.push(gate);
          }
        }

        const gated = minLevel !== undefined || maxLevel !== undefined;
        const corridor = this.corridorFrom(command, command.to);
        const requirement: Requirement = {
          // A level gate prices and blocks exactly as an exit's `Level:` does;
          // an unguarded portal is a `Text:` exit in everything but the table
          // it came from — a different command, no obstacle.
          kind: gated ? 'level' : 'text',
          raw: [phrase, ...(command.need ?? [])].join('; '),
          commands: [...command.say],
          ...(minLevel !== undefined ? { minLevel } : {}),
          ...(maxLevel !== undefined ? { maxLevel } : {}),
          ...(unread.length > 0 ? { unread } : {}),
          ...(gates.length > 0 ? { abilities: gates } : {}),
          ...(corridor === null ? {} : { corridor })
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
   * The timed passage a room command opens, or null (todo 104).
   *
   * The command's own `cast` puts a spell on the character; where that spell,
   * or what it ends in (`EndCast`), carries harm the passage is one to run
   * through. From the landing the rooms are swept breadth-first over their
   * exits, up to the spell's duration in moves, until an exit whose own cast
   * kills the chain (`Catalogue.killsAny`) — that is the way out, and the rooms before
   * it are written into `underSpell`. No duration, or no way out within it,
   * is `ends: false`, which `corridorCost` walls.
   *
   * Sixty-odd ways in on the shipped realm cast something; the dive is the
   * one whose chain reaches harm. A bless off a portal casts and ends in
   * nothing that hurts, and is not a passage at all.
   */
  private corridorFrom(command: RoomCommand, landing: RoomId): Corridor | null {
    if (command.casts === undefined) return null;
    const first = this.spellById(command.casts);
    if (first === null) return null;
    const chain: WorldSpell[] = [];
    const seen = new Set<number>();
    for (let next: number | undefined = first.id; next !== undefined && next > 0;) {
      if (seen.has(next) || chain.length > 4) break;
      seen.add(next);
      const spell = this.spellById(next);
      if (spell === null) break;
      chain.push(spell);
      next = spell.abilities?.find(([ability]) => ability === HAZARD_ABILITY.endCast)?.[1];
    }
    const harms = chain.some((spell) =>
      (spell.abilities ?? []).some(([ability, value]) => HURTS.has(ability) && value !== 0)
    );
    if (!harms) return null;
    const lifts = new Set(chain.map((spell) => spell.id));
    const ticks = first.duration;
    // Bounded by the ticks where the realm states them, and by a stride
    // beyond any passage the shipped realms hold where it does not.
    const reach = ticks ?? 64;
    const depth = new Map<RoomId, number>([[landing, 0]]);
    const queue: RoomId[] = [landing];
    let endAt = Infinity;
    while (queue.length > 0) {
      const id = queue.shift()!;
      const here = depth.get(id) ?? 0;
      if (here >= endAt) break;
      const room = this.rooms.get(id);
      if (room === undefined) continue;
      for (const exit of room.exits) {
        const requirement = exit.requirement;
        const casts = [requirement?.castPre, requirement?.castPost].filter(
          (spell): spell is number => spell !== undefined && spell > 0
        );
        if (casts.some((spell) => this.catalogue.killsAny(spell, lifts))) {
          endAt = Math.min(endAt, here + 1);
          continue;
        }
        const to = roomId(exit.map, exit.room);
        if (depth.has(to) || here + 1 >= reach) continue;
        depth.set(to, here + 1);
        queue.push(to);
      }
    }
    const ends = endAt !== Infinity;
    const rooms = ends ? endAt : depth.size;
    const corridor: Corridor = {
      spell: first.id,
      name: first.name,
      rooms,
      ends,
      ...(ticks === undefined ? {} : { ticks }),
      ...(chain[1] === undefined ? {} : { then: chain[1].name })
    };
    for (const [id, at] of depth) {
      if (at < rooms && !this.underSpell.has(id)) this.underSpell.set(id, corridor);
    }
    return corridor;
  }

  /**
   * Every ward this realm writes, for the settings screen to draw (todo 02).
   *
   * The join is the one `Wards` makes at each step, made once over the whole
   * realm instead: a room spell whose hazard names a spell that stops it, and
   * an item whose use casts that spell. A rule with no such item is left out,
   * because what the screen is drawing is the rules this client can act on —
   * the sunstone wristband stops the desert too and no `use` casts it, so it
   * is a thing to go and find rather than a rule to switch on.
   *
   * **Counted over the rooms**, because the count is what says whether the
   * rule matters: the shipped realms each hold exactly one, and it guards 945
   * rooms of desert. One scan of the room table per call, and the call is one
   * settings section opening.
   */
  wards(): WardRule[] {
    const casting = new Map<number, number>();
    for (const room of this.rooms.values()) {
      if (room.spell === undefined) continue;
      casting.set(room.spell, (casting.get(room.spell) ?? 0) + 1);
    }
    const rules: WardRule[] = [];
    for (const [id, rooms] of casting) {
      const cast = this.spellById(id);
      if (cast === null) continue;
      for (const ward of cast.hazard?.avoidedBySpell ?? []) {
        const casts = this.spellById(ward);
        for (const item of this.catalogue.itemsCasting(ward)) {
          rules.push({
            item: item.name,
            ward: casts?.name ?? String(ward),
            hazard: cast.name,
            rooms
          });
        }
      }
    }
    // Widest first: the one that guards a realm's worth of rooms is the one
    // somebody is deciding about.
    return rules.sort((a, b) => b.rooms - a.rooms || a.item.localeCompare(b.item));
  }

  /**
   * The timed passage a room is under, or null: what the session reads to
   * stand every routine down and keep the character moving (todo 104).
   */
  spellOver(room: RoomId): Corridor | null {
    return this.underSpell.get(room) ?? null;
  }

  /**
   * Joins every lever to the exit it opens.
   *
   * The realm keeps a lever in the room it is *pulled in* (`RoomCommand.opens`
   * names the exit) and the exit itself is under no obligation to mention it:
   * `1/1331` north out of Inner Gate reads `Door [301 picklocks/strength]`,
   * and the lever that raises that gate is in the Guardroom next door. So the
   * only way to answer *what opens this step* is to have walked every room's
   * commands once, which is what this does — after the rooms are loaded, for
   * `linkPortals`' reason: the lever's own room and the exit's are two
   * different rows and neither is finished while the file is being read.
   *
   * Measured over the shipped realm: 225 exits have at least one lever, 171
   * with every lever in the exit's own room, 35 with every lever in one other
   * room, 14 spread over several rooms and 5 naming an exit the room does not
   * have. `Walker` serves the first two shapes and refuses the rest out loud;
   * this index states all of them, because refusing needs the same answer as
   * acting.
   */
  private linkLevers(): void {
    for (const [id, room] of this.rooms) {
      for (const command of room.commands ?? []) {
        const opens = command.opens;
        if (opens === undefined) continue;
        // The realm's own spelling, as `Requirement.commands` and
        // `Requirement.actions` are both read: the rest are synonyms for one
        // lever, and the client sends one command.
        const phrase = command.say[0]?.trim();
        if (!phrase) continue;
        const key = leverKey(opens.room, opens.direction);
        const lever: RemoteLever = {
          at: id,
          roomName: room.name,
          say: phrase,
          ...(opens.item === undefined ? {} : { item: opens.item })
        };
        const held = this.levers.get(key);
        if (held) held.push(lever);
        else this.levers.set(key, [lever]);
      }
    }
  }

  /**
   * Every lever the realm says opens this exit, in the order the rooms were
   * read.
   *
   * Empty for the ordinary exit, which is 225 of the shipped realm's exits
   * away from all of them. The caller decides what to do with several: all in
   * one room is an errand, spread over rooms is a journey this client does not
   * plan.
   */
  leversFor(room: RoomId, direction: string): readonly RemoteLever[] {
    return this.levers.get(leverKey(room, direction)) ?? NO_LEVERS;
  }

  /**
   * The levers that open this step **without leaving the room**, and nothing
   * where any of them is elsewhere.
   *
   * `openableHere`'s question asked of a step rather than of a requirement,
   * because a door's levers are never on its requirement: `buildRealm` writes
   * `Requirement.actions` only for an exit that states `Needs N Actions`, and
   * a `Door` states nothing of the kind. Public because the *chip* has to ask
   * it too — a plan that says `Door, pick/bash 1000` about a door the client
   * knows opens to `use crowbar` sends a player after a skill nobody has.
   */
  leversHere(from: RoomId, direction: string): readonly RemoteLever[] {
    const levers = this.leversFor(from, direction);
    // Levers **elsewhere** leave the wall standing: this planner does not plan
    // the detour, `Levers.fetchLever` makes it when the server refuses.
    return levers.length > 0 && levers.every((lever) => lever.at === from) ? levers : NO_LEVERS;
  }

  /** Every quest this realm scripts, with its items and rooms joined on — `QuestPlanner.quests`. */
  quests(): readonly Quest[] {
    return this.planner.quests();
  }

  /** The order a step's several items are best fetched in — `QuestPlanner.errand`. */
  errand(step: QuestStep, from: RoomId, traveller: Traveller): QuestErrand | null {
    return this.planner.errand(step, from, traveller);
  }

  /** One step of a quest's plan, priced from where the last ends — `QuestPlanner.planStep`. */
  planStep(
    quest: Quest,
    step: QuestStep,
    from: RoomId | null,
    carrying: readonly number[] | null,
    traveller: Traveller,
    supplies?: readonly number[],
    lap?: Traveller
  ): PlanStep {
    return this.planner.planStep(quest, step, from, carrying, traveller, supplies, lap);
  }

  /**
   * The passages a route walks into, with the spell's id, for the plan's
   * snag and the route's hazard alike — one reading, so the two cannot count
   * the rooms differently: the router asks it through `RoomIndex`, the
   * planner through `PlannerRooms`.
   */
  private corridorsOn(steps: readonly RouteStep[]): Passage[] {
    const found: Passage[] = [];
    for (const [index, step] of steps.entries()) {
      if (step.requirement?.kind !== 'text') continue;
      // The phrase the walker will send, not any phrase to that room: two
      // words into one pool may cast two different things or nothing.
      const command = this.rooms
        .get(step.from)
        ?.commands?.find((each) => each.casts !== undefined && each.say.includes(step.command));
      const held = command?.casts === undefined ? null : this.spellById(command.casts);
      if (held === null || held === undefined) continue;
      const next = held.abilities?.find(([ability]) => ability === HAZARD_ABILITY.endCast)?.[1];
      if (next === undefined || next <= 0) continue;
      const then = this.spellById(next);
      const lifts = new Set([held.id, next]);
      let rooms = steps.length - index;
      let ends = false;
      for (let ahead = index + 1; ahead < steps.length; ahead += 1) {
        const exit = steps[ahead]?.requirement;
        if (exit?.kind !== 'cast' || exit.castPre === undefined) continue;
        if (this.catalogue.killsAny(exit.castPre, lifts)) {
          rooms = ahead - index;
          ends = true;
          break;
        }
      }
      found.push({
        id: held.id,
        spell: held.name,
        rooms,
        ends,
        ...(held.duration === undefined ? {} : { ticks: held.duration }),
        ...(then === null ? {} : { then: then.name })
      });
    }
    return found;
  }

  /**
   * Where saying something gets this item, nearest first from `from` (todo
   * 806): a script's handover the realm places (`WorldItem.from`, asked or
   * said), and a room script that summons a monster which drops it. Only a
   * place this traveller can walk to; `steps` in moves, for the sentence.
   */
  itemAsks(item: number, from: RoomId, traveller: Traveller): ItemAsk[] {
    const places = this.askPlaces(item);
    if (places.length === 0) return [];
    const reach = this.router.sweepTo(from, new Set(places.map(({ room }) => room)), traveller);
    return places
      .flatMap((place) => {
        const priced = reach.get(place.room);
        return priced === undefined ? [] : [{ place, priced }];
      })
      .sort((a, b) => a.priced.cost - b.priced.cost || a.place.room.localeCompare(b.place.room))
      .map(({ place, priced }) => ({ ...place, steps: priced.moves }));
  }

  /**
   * Every place saying something gets this item, unpriced.
   *
   * A summoning script counts only where summoning is all it asks: most also
   * want an item in the pack or on the floor, or a price (`checkitem`,
   * `roomitem`, `price`), and saying the phrase without them does nothing —
   * refused rather than guessed at.
   */
  private askPlaces(item: number): Array<Omit<ItemAsk, 'steps'>> {
    const found: Array<Omit<ItemAsk, 'steps'>> = [];
    const add = (room: RoomId, say: string, summons?: string): void => {
      const known = this.rooms.get(room);
      if (known === undefined || found.some((entry) => entry.room === room && entry.say === say)) {
        return;
      }
      found.push({
        room,
        roomName: known.name,
        say,
        ...(summons === undefined ? {} : { summons })
      });
    };
    for (const handover of this.catalogue.item(item)?.from ?? []) {
      const word = handover.say?.[0];
      const at = handover.room === undefined ? null : asRoomReference(handover.room);
      if (at === null || word === undefined) continue;
      const room = roomId(at.map, at.room);
      if (handover.kind === 'asked' && handover.who !== undefined) {
        add(room, `ask ${handover.who} ${word}`);
      } else if (handover.kind === 'said') {
        add(room, word);
      }
    }
    if (this.summonScripts === null) {
      const index = new Map<number, Array<{ room: RoomId; say: string }>>();
      for (const [room, known] of this.rooms) {
        for (const command of known.commands ?? []) {
          const say = command.say[0];
          const need = command.need ?? [];
          if (say === undefined || need.length === 0) continue;
          const summons = need.map((line) => /^summon\s+(\d+)$/i.exec(line.trim()));
          if (summons.some((match) => match === null)) continue;
          for (const match of summons) {
            const id = Number(match![1]);
            const held = index.get(id);
            if (held === undefined) index.set(id, [{ room, say }]);
            else held.push({ room, say });
          }
        }
      }
      this.summonScripts = index;
    }
    for (const name of this.sourcesOf({ id: item }).mobs) {
      const mob = this.mob(name);
      for (const id of mob?.ids ?? []) {
        for (const script of this.summonScripts.get(id) ?? []) add(script.room, script.say, name);
      }
    }
    return found;
  }

  /** Where to go and kill for an item, the nearest ring — `QuestPlanner.droppingPlaces`. */
  droppingPlaces(
    item: { id: number; name?: string },
    from: RoomId,
    traveller: Traveller,
    ring: { rooms: number; radius: number }
  ): DropSources {
    return this.planner.droppingPlaces(item, from, traveller, ring);
  }

  /**
   * Every item that is a way through, as an edge the router can relax.
   *
   * **`WorldItem.lands` was read in one direction only** and that was the whole
   * bug: `QuestPlanner`'s `waysIn` feeds `approachItems`, which walks
   * *backwards* to answer what the way into a place wants, so the client could
   * tell a player the Amethyst Cave needs a potion of levitation, a titanium
   * fork and a magical quartz rod and then answer *the realm data joins no
   * path* when asked to walk there. No exit or portal in either database enters
   * the 173 rooms behind the potion — measured both ways, the cave reaches Town
   * Gates and nothing reaches the cave — so for the router those rooms did not
   * exist at all.
   *
   * Modelled as a `PortalExit` because that is what it is: the realm moves the
   * character by coordinates, no compass reasoning applies, and everything
   * downstream that already treats a portal as its own thing is correct about
   * this without being told. The requirement is `item`, which is not a
   * decoration — `edgePenalty`'s `item` rung is exactly the three answers the
   * pack can give, so *carried is free, listed and lacking is a wall, never
   * listed is discouraged* comes out right without a second implementation of
   * a rule this file already states once.
   */
  private itemLandings(): ReadonlyArray<PortalExit> {
    if (this.landings !== null) return this.landings;
    const built: PortalExit[] = [];
    for (const item of this.catalogue.everyItem()) {
      if (item.lands === undefined) continue;
      /*
       * **A landing bound to a room is not one of these.** It is an ordinary
       * way out of that room and `linkItemLandings` has already made it a
       * portal there, so relaxing it from wherever the character stands as
       * well would put the bug back: the potion of levitation used in the
       * Alchemist's Hut is a block that fails on its first step and a server
       * that answers nothing at all.
       */
      if (item.usableIn !== undefined) continue;
      const target = this.rooms.get(item.lands);
      // A landing outside the dataset is a hole in the data, not a way, by the
      // same rule the exit loop applies to an exit pointing nowhere.
      if (target === undefined || item.name.length === 0) continue;
      const command = `use ${item.name}`;
      const exit: PortalExit = {
        direction: 'portal',
        map: target.map,
        room: target.room,
        requirement: {
          kind: 'item',
          raw: `Item: ${item.id}`,
          keyId: item.id,
          commands: [command],
          // Who may use it, so a token the character has not grown into is
          // refused here rather than by the server (`edgePenalty`).
          ...useGateOf(item)
        }
      };
      built.push(exit);
      this.spends.set(exit, {
        id: item.id,
        name: item.name,
        command,
        // `-1` is the realm's word for *for ever* and absent is the same
        // silence format 25 exists to tell apart from it; both are null here,
        // because this field answers *how many* and neither states a number.
        uses: item.uses === undefined || item.uses < 0 ? null : item.uses
      });
    }
    this.landings = built;
    return built;
  }

  /** What the way into a room demands be carried — `QuestPlanner.approachItems`. */
  approachItems(room: RoomId): ApproachGate[] {
    return this.planner.approachItems(room);
  }

  /**
   * Reads what the spells on a `cast` or `spell` exit do to whoever walks it,
   * and writes the answer onto the requirement.
   *
   * Both exit kinds let everybody through — `CastExit.CanMoveThroughExit` and
   * `SpellTrapExit.CanMoveThroughExit` each return `true` unconditionally — so
   * the instruction string says nothing about whether the character arrives.
   * The realm's own spell table does, in two ways worth telling apart:
   *
   * - A spell carrying `TeleportRoom`/`TeleportMap` puts the character in a
   *   room the exit table does not name, and it is not even a fixed one: the
   *   server rolls `Rand(min, max)` over the spell's own `MinBase`–`MaxBase`
   *   and teleports there (`Spell.RollAndApplySpellAbilities`, then case
   *   `TeleportRoom`). Measured on the shipped realm: 217 of the 293 cast
   *   exits fire one, and of the 157 whose spell is `gloomy teleport`,
   *   `hallway teleport` or `thievry teleport`, **not one** states a
   *   destination inside its own spell's range. The exit's destination is not
   *   where the character ends up.
   * - A spell carrying `TextBlock` hands the character a realm script this
   *   client does not convert, so what it does is genuinely unread — and so is
   *   a spell the realm's table does not hold at all, which used to fall
   *   through to *harmless*.
   * - `EndCast` names another spell to fire when this one ends, so the chain is
   *   followed rather than ignored: `holding breath` says nothing itself and
   *   ends in `drowning`, and `timer` ends in a script.
   *
   * Everything else is an effect on the character rather than on where it is
   * standing, and for a spell trap the size of that effect is the price: the
   * hurt is taken from the spell's own power the way `menace.ts` takes it — the
   * ability's figure where it states one, the mean of the power range where it
   * states zero — without menace's duration and resistance arithmetic, which
   * needs the character and belongs at the decision rather than in the graph.
   */
  private resolveSpells(requirement: Requirement, onMap: number): void {
    if (requirement.kind !== 'cast' && requirement.kind !== 'spell') return;
    const named = [requirement.castPre, requirement.castPost, requirement.spellId].filter(
      (id): id is number => id !== undefined
    );
    if (named.length === 0) {
      // `Cast: pre-0, post-0` names no spell at all, and the server builds a
      // plain exit for it. Left unmarked, which the price reads as plain.
      return;
    }

    /*
     * The chain, not the spell. `EndCast` hands the character *another* spell
     * when this one ends, and `holding breath` (512) is `EndCast 513` —
     * `drowning`. Following it is a reading of the realm's own table, the same
     * reading as looking the exit's own spell up; not following it left three
     * exits priced as plain corridors because the row in front of them said
     * nothing on its own.
     */
    const pending = [...named];
    const seen = new Set<number>();
    let effect: 'script' | 'plain' = 'plain';
    let harm = 0;
    /*
     * Where the chain puts the character, and whether it says so twice over.
     * Two different landings are two answers to one question and there is no
     * honest way to choose between them, so an ambiguous chain is *unread* —
     * which is what the flag this replaced could never express.
     */
    let landing: Landing | null = null;
    let ambiguous = false;
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const spell = this.spellById(id);
      /*
       * **A spell the realm's table does not hold is unread, not harmless.**
       * This defaulted to `plain` — cost nothing — so a realm converted before
       * the spell index existed would have dropped all 293 cast exits from
       * discouraged to free in silence. Unknown is never the reassuring
       * answer, and here the reassuring answer is *walk through it*.
       */
      if (!spell) {
        if (effect === 'plain') effect = 'script';
        continue;
      }
      const [low, high] = spell.power ?? [0, 0];
      const mean = Math.abs(low + high) / 2;
      for (const [ability, value] of spell.abilities ?? []) {
        /*
         * The map half of a teleport says nothing on its own — `landingOf`
         * reads it off the same row when it needs it.
         */
        if (ability === HAZARD_ABILITY.teleportMap) continue;
        if (ability === HAZARD_ABILITY.teleportRoom) {
          /*
           * **Where it puts you, not merely that it does.** This read the pair
           * as one flag and threw the address away, so 49 exits that land in
           * exactly one known room were priced as walls to a room the
           * character never sees, and the 168 that draw one were walked as
           * though the exit table's room were the answer. `landingOf` is
           * `Spell.cs`'s own arithmetic; `null` is a row this reader cannot
           * turn into a room, which is unread and not harmless.
           */
          const where = landingOf(spell, value, onMap);
          if (where === null) {
            if (effect === 'plain') effect = 'script';
            continue;
          }
          if (landing !== null && !sameLanding(landing, where)) ambiguous = true;
          landing = where;
          continue;
        }
        if (ability === HAZARD_ABILITY.textBlock) {
          if (effect === 'plain') effect = 'script';
          continue;
        }
        if (ability === HAZARD_ABILITY.endCast) {
          if (value > 0) pending.push(value);
          continue;
        }
        /*
         * Every other ability that names a *row* rather than a magnitude:
         * `KillSpell`, `Summon`, `%Spell`, `RemovesSpell` and their kin. The
         * teleport pair and `EndCast` are the two this reader looks up, and
         * they are handled above; the rest are numbers it holds and has not
         * looked up, which is the honest definition of unread.
         *
         * It costs one exit on the shipped realm — `pyramid 1 exit temp` ends
         * in `pyramid 1 exit`, whose whole content is `KillSpell 685`, and
         * whether killing a timer fires the teleport that timer was going to
         * fire is not something this client can read. Sixty rooms of
         * discouragement is the cheap side of that question.
         */
        if (abilityShape(ability, 'spell') === 'reference') {
          if (effect === 'plain') effect = 'script';
          continue;
        }
        // A negative heal is a wound by another name — `menace.hazardOf` reads
        // it the same way, and `damnation` is the spell that taught it.
        const hurts = HURTS.has(ability) || (ability === HAZARD_ABILITY.heal && value < 0);
        if (!hurts) continue;
        // `abil.Sum == 0 ? rolledPower : abil.Sum`, the server's own choice of
        // which figure to use.
        const magnitude = value !== 0 ? Math.abs(value) : mean;
        if (magnitude > harm) harm = magnitude;
      }
    }
    /*
     * A landing outranks everything else the chain said — a spell that both
     * hurts and moves you is priced by the move, because where the character
     * is standing decides what every later step means. An ambiguous pair is
     * the one case that falls back, and it falls back to *unread*.
     */
    if (landing !== null && !ambiguous) {
      requirement.spellEffect = scatters(landing) ? 'scatters' : 'teleports';
      requirement.landing = landing;
    } else {
      requirement.spellEffect = landing === null ? effect : 'script';
    }
    if (harm > 0) requirement.damage = Math.round(harm);
  }

  private toRoom(raw: Record<string, unknown>): WorldRoom | null {
    const map = raw['m'];
    const room = raw['r'];
    if (typeof map !== 'number' || typeof room !== 'number') return null;

    const exits: WorldExit[] = [];
    const rawExits = (raw['x'] ?? {}) as Record<string, BuiltExit>;
    for (const direction of DIRECTIONS) {
      const exit = rawExits[direction];
      if (!exit) continue;
      const requirement = parseInstruction(exit.i);
      /*
       * The levers the build joined onto this exit — format 23. On the
       * requirement rather than beside it, because everything that acts on an
       * exit's condition already reads the requirement: `edgePenalty` prices
       * it, `describeObstacle` names it and `Walker` sends it, and none of the
       * three is handed the room.
       */
      const levers = readActions(exit.a);
      if (requirement !== null && levers.length > 0) requirement.actions = levers;
      // What the realm's spell table says a cast or trap exit does, joined here
      // for the reason the levers are joined in the build: once, where the
      // table is, and never in the A*.
      if (requirement !== null) this.resolveSpells(requirement, exit.m);
      exits.push({ direction, map: exit.m, room: exit.r, requirement });
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
    /*
     * A descriptor that names no monster at all is not a lair. GreaterMUD
     * writes a single space into `Rooms.Lair` for every ordinary room — all
     * 55,806 of them — and the converter's emptiness test is `!== ''`, which a
     * space passes. The map's glyph is `room.lair !== undefined`, so on that
     * realm every room in the world was drawn as a lair and `lair()` answered
     * *a lair of nothing* for each. Refused here rather than in the converter
     * so a realm a player has already converted is fixed too: `REALM_FORMAT` is
     * in the cache key and this changes no column.
     *
     * A descriptor naming ids this table lacks is a different answer and is
     * kept — that is a derivative adding monsters, which the lair face reports.
     */
    if (typeof raw['lair'] === 'string' && parseLair(raw['lair']).ids.length > 0) {
      result.lair = raw['lair'];
    }
    if (typeof raw['li'] === 'number') result.light = raw['li'];
    // The lair's respawn clock as the realm states it — format 33.
    if (typeof raw['dl'] === 'number' && raw['dl'] !== 0) result.delay = raw['dl'];
    if (typeof raw['sp'] === 'number' && raw['sp'] > 0) result.spell = raw['sp'];
    // What the realm puts on the floor — format 42. Before it the column was
    // the raw string under another key, which nothing read and this does not.
    const placed = Array.isArray(raw['pl'])
      ? raw['pl'].filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
      : [];
    if (placed.length > 0) result.placed = placed;
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
    const id = roomId(room.map, room.room);
    for (const item of room.placed ?? []) {
      const rooms = this.placedIn.get(item);
      if (rooms === undefined) this.placedIn.set(item, [id]);
      else if (!rooms.includes(id)) rooms.push(id);
    }
  }

  get(map: number, room: number): WorldRoom | undefined {
    return this.rooms.get(roomId(map, room));
  }

  /** The scripted teleports a room offers, as the router walks them — `Router.portalsFrom`. */
  portalsFrom(id: RoomId): readonly PortalExit[] {
    return this.router.portalsFrom(id);
  }

  byId(id: RoomId): WorldRoom | undefined {
    return this.rooms.get(id);
  }

  /**
   * How many of a draw's rooms the realm holds — what the chip says *one of*.
   *
   * The range as stated is not the count: `landingRooms` cannot filter,
   * because `src/shared` holds no realm. This is the one place that join is
   * made for a sentence, and it is the same join `Router.scatterDoors` makes
   * for the arithmetic.
   */
  landingCount(landing: Landing): number {
    return landingRooms(landing).filter((id) => this.rooms.has(id)).length;
  }

  /** The room an edge actually reaches, which is not always the one it names — `Router.beyond`. */
  beyond(exit: WorldExit | PortalExit): RoomId {
    return this.router.beyond(exit);
  }

  /**
   * Every room, in the order the file listed them.
   *
   * A read-only sweep, beside `byId` and `findByName` because it answers the
   * one question neither can: *does anything in this realm still look like
   * that*. What reads it is the shipped-realm survey in the tests — the
   * assertions that say 293 exits carry a cast and 217 of them scatter you —
   * and those exist because every price in `edgePenalty` is a claim about a
   * file, and a file that changes underneath a claim should fail loudly rather
   * than quietly reroute somebody.
   */
  everyRoom(): IterableIterator<WorldRoom> {
    return this.rooms.values();
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

  /** A* from one room to another — `Router.route`. */
  route(from: RoomId, to: RoomId, traveller?: Traveller, options?: RouteOptions): Route {
    return this.router.route(from, to, traveller, options);
  }
}

/**
 * The levers on one exit, parsed rather than cast — format 23.
 *
 * Every other field in `parseRoom` is type-checked and this one was taken
 * wholesale, while `describeObstacle` and `Levers.pullLevers` both reach
 * `act.say[0]!` behind a non-null assertion. A realm whose `Action …` cell has
 * a shape this build does not expect would put `undefined` into the obstacle
 * chip and give the walker a rung that sends nothing, returns true and spends
 * a lever budget. Parse, do not validate — the reviewer's find, 2026-09-06.
 *
 * A member that will not parse drops the **whole** list rather than shortening
 * it: `openableHere` counts what is left against nothing, so half a lever set
 * would read as a passage this room can open when it cannot.
 */
function readActions(raw: unknown): RequirementAction[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const actions: RequirementAction[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const say = record['say'];
    if (!Array.isArray(say) || say.length === 0) return [];
    if (!say.every((phrase): phrase is string => typeof phrase === 'string' && phrase.length > 0)) {
      return [];
    }
    const action: RequirementAction = { say: [...say] };
    const item = record['item'];
    if (item !== undefined) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return [];
      action.item = item;
    }
    const at = record['at'];
    if (at !== undefined) {
      if (typeof at !== 'object' || at === null) return [];
      const place = at as Record<string, unknown>;
      if (typeof place['map'] !== 'number' || typeof place['room'] !== 'number') return [];
      action.at = { map: place['map'], room: place['room'] };
    }
    actions.push(action);
  }
  return actions;
}

/**
 * One room the realm spawns a monster in, before the grouping.
 *
 * The room itself rather than its address, because the group is keyed on the
 * room's *name* and re-reading it out of the index per entry would be a lookup
 * per room in a scan built to avoid exactly that.
 */
interface MobSpawnRoom {
  room: WorldRoom;
  via: MobSpawn['via'];
  /** The lair's slot count; null for a resident, which has no such figure. */
  max: number | null;
}

/**
 * How many `room|name` resolutions are kept before the table is dropped whole.
 *
 * A character walks through rooms and meets names, so the pair is what grows;
 * a thousand of them is more rooms than a loop visits and a few tens of
 * kilobytes. Cleared rather than evicted one at a time: the next room re-asks
 * for what it needs, and the answer is a breadth-first sweep that has already
 * been paid for once — an LRU here would be bookkeeping for a table that is
 * cheap to refill and never hot after a walk has moved on.
 */
const RESOLVED_ROW_CACHE = 1000;

/** A room two of a name's rows both spawn in: it tells them apart for nobody. */
const TIED_ROW = -1;

/**
 * The item's own gate on who may use it, for the edge that spends it —
 * `Requirement.usableBy`, or nothing where the realm gates it on nobody.
 */
function useGateOf(item: WorldItem): { usableBy: ItemUseGate } | Record<never, never> {
  const gate: ItemUseGate = {
    ...(item.classes === undefined ? {} : { classes: item.classes }),
    ...(item.races === undefined ? {} : { races: item.races }),
    ...(item.minLevel === undefined ? {} : { minLevel: item.minLevel })
  };
  return Object.keys(gate).length === 0 ? {} : { usableBy: gate };
}
