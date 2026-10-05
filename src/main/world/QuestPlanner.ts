/**
 * The quest planner: the realm's quests with their items' sources joined on,
 * the order a step's items are best fetched in, one step of a plan priced
 * from the one before (its way there planned by the navigation engine), and
 * where to go and kill for an item.
 *
 * It reads the router's searches, the catalogue's rows and the rooms
 * (`PlannerRooms`), each through the narrowest part it calls, and never the
 * graph that composes it (todo 712). `WorldGraph` keeps a one-line delegation
 * per public method. See `mudengine-world` › `parts/quests.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import {
  earlierHandover,
  itemsBrought,
  packHolds,
  planAct,
  stepRoll,
  type PlanItem,
  type PlanPlace,
  type PlanSnag,
  type PlanSource,
  type PlanStep
} from '../../shared/quests';
import type { Quest, QuestErrand, QuestSource, QuestStep } from '../../shared/quests';
import {
  asRoomReference,
  counterIn,
  roomId,
  type Dropper,
  type DropSources,
  type RoomId,
  type Route,
  type RouteHazard,
  type RouteStep,
  type WorldRoom
} from '../../shared/world';
import type { Catalogue } from './Catalogue';
import { handoverSource } from './navigation/sources';
import type { PlannerRooms } from './PlannerRooms';
import { plan, leg, type PlanRealm } from './navigation/plan';
import type { Router, Traveller } from './Router';
import {
  fetchAct,
  plannedFetches,
  planRefusalsWords,
  type FetchStep,
  type NavigationOracle,
  type Plan,
  type PlannedFetch
} from '../../shared/navigation';

/** What the planner asks the router: a way, and the sweeps an order or a ring is priced on. */
type PlannerRouter = Pick<Router, 'route' | 'sweepTo' | 'withinSteps'>;

/** What the planner reads of the realm's rows. */
type PlannerCatalogue = Pick<
  Catalogue,
  | 'dropsOf'
  | 'everyItem'
  | 'item'
  | 'mob'
  | 'shop'
  | 'sourcesOf'
  | 'spellById'
  | 'stockedBy'
  | 'stoppersOf'
  | 'summonersOf'
>;

export class QuestPlanner {
  /** The realm's quests, out of the header. See `indexQuests.ts`. */
  private readonly questBook: readonly Quest[];
  /**
   * The book with the item and room joins applied, computed on first ask.
   *
   * Null rather than empty for *not yet computed*: a realm that scripts no
   * quests joins to an empty array, and the two must not be the same state or
   * the join would run again on every mount of the card.
   */
  private questsJoined: Quest[] | null = null;
  /** Every room, by `map/room`: the table the router reads, held rather than asked for. */
  private readonly rooms: ReadonlyMap<RoomId, WorldRoom>;

  constructor(
    private readonly router: PlannerRouter,
    private readonly catalogue: PlannerCatalogue,
    private readonly index: PlannerRooms,
    /** What the navigation engine reads of the realm, for a step's way there. */
    private readonly navigable: PlanRealm,
    quests: unknown
  ) {
    this.rooms = index.roomsById;
    this.questBook = this.loadQuests(quests);
  }

  /**
   * The realm's quests, out of the header. Present from v24 on.
   *
   * Read back defensively rather than trusted: this file is on the player's
   * own disk and may have been converted by any build, so a shape that is not
   * a quest is dropped rather than handed to a card that would then render
   * `undefined`. The same reading every index in the catalogue does.
   */
  private loadQuests(raw: unknown): Quest[] {
    const quests: Quest[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = Number(record['id']);
      const name = String(record['name'] ?? '').trim();
      const steps = Array.isArray(record['steps']) ? (record['steps'] as Quest['steps']) : [];
      // A quest with no steps is a counter nothing advances, which is not a
      // quest anybody can do.
      if (!Number.isInteger(id) || name.length === 0 || steps.length === 0) continue;
      quests.push({ id, name, steps });
    }
    return quests;
  }

  /**
   * Every quest this realm scripts, with what the realm knows about its items
   * and its rooms joined on.
   *
   * Empty for a realm converted before v24 and for one that scripts none —
   * which the card says out loud rather than drawing an empty book.
   *
   * ## Why the join is here and not in the world file
   *
   * `indexQuests` names every item a step demands, and stops there: a quest
   * item is not in `neededItems`, so `indexItems` never gives most of them
   * `shops` or `mobs`. Both halves of the answer are nonetheless already on
   * disk — the shop index stocks ids, and 538 monsters name what they drop —
   * so this is a **join between two indexes the file already holds**, not a
   * third copy of either. Writing it into the header would bump the realm
   * format, invalidate every converted realm on every player's disk, and leave
   * two records of one fact to keep in step.
   *
   * It answers 29 of the shipped realm's 79 item requirements — 24 on a
   * monster and 7 in a shop. The rest name the item and say nothing, which is
   * the refusal `localMap` already makes about a key with no known source.
   *
   * Computed once and held: the book does not change while a realm is loaded,
   * and the card asks for it on every mount.
   */
  quests(): readonly Quest[] {
    this.questsJoined ??= this.questBook.map((quest) => ({
      ...quest,
      steps: quest.steps.map((step) => this.joinStep(step))
    }));
    return this.questsJoined;
  }

  /**
   * One step, with its room named and its items' sources looked up.
   *
   * The step is copied rather than written through: `questBook` is what the
   * file said, and a join that mutated it would make a second call see its own
   * previous answer as the realm's.
   */
  private joinStep(step: QuestStep): QuestStep {
    const joined: QuestStep = { ...step };
    if (step.room !== undefined) {
      const at = asRoomReference(step.room);
      const name = at === null ? undefined : this.rooms.get(roomId(at.map, at.room))?.name;
      // A room the realm no longer has keeps its address and gains no name,
      // rather than being dropped: the address is still what the realm said.
      if (name !== undefined && name.length > 0) joined.place = name;
    }
    const sources: QuestSource[] = [];
    for (const [id, name] of this.itemsDemanded(step)) {
      const known = this.catalogue.item(id);
      /*
       * Both directions here too, and for the same reason as the monsters:
       * `WorldItem.shops` is filled only for an item `indexItems` was asked
       * for and is capped at six, while the shop index stocks ids outright.
       * A shop named by either is a shop that sells it.
       */
      const shops = new Set(known?.shops ?? []);
      for (const shop of this.catalogue.stockedBy(id)) shops.add(shop);
      /*
       * Both directions, because they cover different items. `WorldItem.mobs`
       * exists only for an item `indexItems` was asked for; the drop lists on
       * the monsters name items by name and cover the rest — which is most of
       * a quest's items. A name the realm gave the step and a name a monster
       * drops are the same string in the same table, so the match is exact
       * rather than fuzzy.
       */
      const mobs = new Set(known?.mobs ?? []);
      if (name !== undefined) for (const mob of this.catalogue.dropsOf(name)) mobs.add(mob);
      /*
       * And the third answer — format 39, the one the two indexes above could
       * not give. A quest component is handed over by a script, not stocked
       * and not on a drop list, so `acid gland`, `unfertilized eggs` and
       * `double-terminated quartz` were three of the four things PhoenixQuest
       * asks for with nothing at all said about where to get them.
       */
      const from = known === undefined ? [] : (this.index.placingHandovers(known).from ?? []);
      if (shops.size === 0 && mobs.size === 0 && from.length === 0) continue;
      const source: QuestSource = { id };
      if (shops.size > 0) source.shops = [...shops];
      if (mobs.size > 0) source.mobs = [...mobs];
      if (from.length > 0) source.from = from;
      sources.push(source);
    }
    if (sources.length > 0) joined.sources = sources;
    return joined;
  }

  /**
   * Every item a step demands, by id, with the name the step gave it.
   *
   * The gates and `takes` overlap almost entirely — a step that consumes an
   * item states `checkitem` beside its `takeitem` — so they are merged here
   * rather than looked up twice. A `lack` gate is deliberately included: *not
   * carrying this* is still a sentence about an item, and knowing where the
   * thing comes from is how somebody avoids picking it up.
   */
  private itemsDemanded(step: QuestStep): Map<number, string | undefined> {
    const wanted = new Map<number, string | undefined>();
    // The step's own, and every route's: a class's route routinely asks for a
    // different thing, and an item placed on one route and not the others is
    // still an item somebody has to go and find.
    for (const way of [step, ...(step.ways ?? [])]) {
      for (const gate of way.needs) {
        if (gate.kind !== 'carry' && gate.kind !== 'lack') continue;
        if (!wanted.has(gate.item) || wanted.get(gate.item) === undefined) {
          wanted.set(gate.item, gate.name);
        }
      }
      for (const item of way.takes) {
        if (!wanted.has(item.id) || wanted.get(item.id) === undefined) {
          wanted.set(item.id, item.name);
        }
      }
    }
    return wanted;
  }

  /**
   * The order a step's several items are best fetched in — todo 01.
   *
   * A step that demands four things states them in the order its own opcodes
   * happen to run, and that is nobody's walk: PhoenixQuest asks for an acid
   * gland, unfertilized eggs, a double-terminated quartz and cave roots, and
   * the realm puts them in four rooms with nothing to do with that list. So
   * this answers the question the list was standing in for — *where do I go
   * first* — as the shortest walk from where the character is standing,
   * through one place for each item, and back to the step's own room.
   *
   * **Exact, not greedy.** Nearest-first is wrong in the ordinary case and
   * wrong in a way nobody can see: it takes the near thing whose neighbour is
   * a long way back. So every order of the items is weighed, over every place
   * each can be got (`errandPlaces`), which is a travelling salesman's path
   * and is solved as one — a subset-and-last table, exponential in the items
   * and bounded by `errandItems` at twice the largest step either shipped
   * world holds.
   *
   * **Chosen in the router's units and reported in moves**, which is
   * `Router.scatterMoves`' rule one card across: the order has to price the
   * lair, the hazard and the door this character cannot force, or it would
   * send somebody through the short way that kills them; the reader wants the
   * number of times they press a direction. The two sweeps carry both.
   *
   * **A plan, not a reading.** It is solved from where the character stood
   * when the card asked, and `QuestErrand.from` says which room that was: it
   * is not re-solved on every step, because the sweeps cost tens of
   * milliseconds each on the thread the socket is on.
   */
  errand(step: QuestStep, from: RoomId, traveller: Traveller): QuestErrand | null {
    const here = this.rooms.get(from);
    if (here === undefined) return null;
    const brought = itemsBrought(step);
    // One thing to fetch is a list and not a walk, and the card draws it the
    // way it always did: there is nothing here for this to add.
    if (brought.length < 2) return null;

    const answer: QuestErrand = {
      block: step.block,
      from,
      ...(here.name.trim().length > 0 ? { fromPlace: here.name } : {}),
      legs: [],
      moves: 0,
      left: []
    };
    const { errandItems, errandPlaces } = tuning().world;

    /*
     * Where each of them can be got, as rooms rather than as the names the
     * card prints. An item the realm places nowhere is not a leg of anything
     * and is never given a position in the walk — the same refusal the card
     * already makes about where it comes from, carried through to the order.
     */
    const placed: Array<{ id: number; name?: string; rooms: RoomId[] }> = [];
    for (const item of brought) {
      const rooms = this.errandRooms(step, item.id);
      const named = item.name === undefined ? {} : { name: item.name };
      if (rooms.length === 0) answer.left.push({ id: item.id, ...named, why: 'unplaced' });
      else placed.push({ id: item.id, ...named, rooms });
    }
    // Fewer than two places to go is not an order, and saying so would be
    // noise on a card that already names where the one of them is.
    if (placed.length < 2) return null;
    if (placed.length > errandItems) {
      return { ...answer, refusal: t('cards.quests.errand.tooMany', { items: placed.length }) };
    }

    const end =
      step.room !== undefined && this.rooms.has(step.room as RoomId) ? (step.room as RoomId) : null;
    const asked = new Set<RoomId>(placed.flatMap((item) => item.rooms));
    if (end !== null) asked.add(end);
    const reach = this.router.sweepTo(from, asked, traveller);

    /*
     * The nearest few places for each, because a monster that drops one of
     * these spawns in up to sixteen rooms and every one of them is a sweep.
     * Nearest **to the start**, which is the one distance already in hand — a
     * place further off than three others is not where the shortest walk goes
     * unless it was going that way anyway, and the ones kept are then weighed
     * against the whole walk rather than picked by this distance.
     */
    const nodes: Array<{ item: number; room: RoomId }> = [];
    const wanted: Array<{ id: number; name?: string }> = [];
    for (const item of placed) {
      const named = item.name === undefined ? {} : { name: item.name };
      const reachable = item.rooms
        .filter((room) => reach.has(room))
        .sort((a, b) => reach.get(a)!.cost - reach.get(b)!.cost)
        .slice(0, errandPlaces);
      if (reachable.length === 0) {
        answer.left.push({ id: item.id, ...named, why: 'unreachable' });
        continue;
      }
      const at = wanted.length;
      wanted.push({ id: item.id, ...named });
      for (const room of reachable) nodes.push({ item: at, room });
    }
    if (wanted.length === 0) return { ...answer, refusal: t('cards.quests.errand.noWay') };

    const kept = new Set<RoomId>(nodes.map((node) => node.room));
    if (end !== null) kept.add(end);
    const between = new Map<RoomId, Map<RoomId, { cost: number; moves: number }>>();
    for (const room of kept) {
      if (room === end && !nodes.some((node) => node.room === end)) continue;
      between.set(room, this.router.sweepTo(room, kept, traveller));
    }

    const order = this.bestOrder(nodes, reach, between, end);
    if (order === null) return { ...answer, refusal: t('cards.quests.errand.noWay') };

    let previous: RoomId | null = null;
    for (const index of order) {
      const node = nodes[index]!;
      const measured = (previous === null ? reach : between.get(previous)!).get(node.room)!;
      answer.legs.push({
        item: wanted[node.item]!,
        ...this.errandLeg(node.room),
        moves: measured.moves
      });
      previous = node.room;
    }
    /*
     * And the way back, where the step names a room and the walk can close on
     * it. A one-way exit is a real thing in this realm — the Rancid Sewer's
     * outflow is one — so the last leg is simply absent where the errand
     * cannot get home from the last thing it picks up, which is what the card
     * reads to decide whether to draw it.
     */
    if (end !== null && previous !== null) {
      const home = between.get(previous)!.get(end);
      if (home !== undefined) answer.legs.push({ ...this.errandLeg(end), moves: home.moves });
    }
    answer.moves = answer.legs.reduce((total, leg) => total + leg.moves, 0);
    return answer;
  }

  /** One leg's address, with the room's own name where the realm has one. */
  private errandLeg(room: RoomId): { room: string; place?: string } {
    const name = this.rooms.get(room)?.name.trim() ?? '';
    return { room, ...(name.length > 0 ? { place: name } : {}) };
  }

  /**
   * The cheapest order to visit one place for each item in, ending at `end`.
   *
   * Held and Karp's table — the cheapest way to have collected each *subset*
   * of the items and be standing at each place — which is what makes this
   * exact rather than a nearest-first walk. The subset is over **items**
   * while the position is over **places**, so a thing that can be got in
   * three rooms costs three columns and not three items' worth of table.
   *
   * `null` where no order reaches every item: a pair the realm's one-way
   * exits keep apart is a walk nobody can take, and the refusal above says so
   * rather than dropping an item out of a list presented as complete.
   */
  private bestOrder(
    nodes: ReadonlyArray<{ item: number; room: RoomId }>,
    reach: ReadonlyMap<RoomId, { cost: number; moves: number }>,
    between: ReadonlyMap<RoomId, ReadonlyMap<RoomId, { cost: number; moves: number }>>,
    end: RoomId | null
  ): number[] | null {
    const items = new Set(nodes.map((node) => node.item)).size;
    const full = (1 << items) - 1;
    const width = nodes.length;
    const best = new Float64Array((full + 1) * width).fill(Number.POSITIVE_INFINITY);
    const came = new Int32Array((full + 1) * width).fill(-1);

    for (let at = 0; at < width; at += 1) {
      const first = reach.get(nodes[at]!.room);
      if (first !== undefined) best[(1 << nodes[at]!.item) * width + at] = first.cost;
    }
    for (let mask = 1; mask <= full; mask += 1) {
      for (let at = 0; at < width; at += 1) {
        const cost = best[mask * width + at]!;
        if (!Number.isFinite(cost)) continue;
        const onward = between.get(nodes[at]!.room);
        if (onward === undefined) continue;
        for (let next = 0; next < width; next += 1) {
          const bit = 1 << nodes[next]!.item;
          if ((mask & bit) !== 0) continue;
          const leg = onward.get(nodes[next]!.room);
          if (leg === undefined) continue;
          const total = cost + leg.cost;
          const slot = (mask | bit) * width + next;
          if (total >= best[slot]!) continue;
          best[slot] = total;
          came[slot] = at;
        }
      }
    }

    let cheapest = Number.POSITIVE_INFINITY;
    let last = -1;
    for (let at = 0; at < width; at += 1) {
      const cost = best[full * width + at]!;
      if (!Number.isFinite(cost)) continue;
      /*
       * The way home is part of the order and not a figure added after it: the
       * nearest four things to fetch in the wrong order end a long way from
       * the asker. Where the walk cannot close at all — a one-way exit out of
       * the last room — the order is still the right one for the pickups, so
       * the return leg costs nothing here and is left off the plan above.
       */
      const home = end === null ? 0 : (between.get(nodes[at]!.room)?.get(end)?.cost ?? null);
      const total = cost + (home ?? 0);
      if (total >= cheapest) continue;
      cheapest = total;
      last = at;
    }
    if (last === -1) return null;

    const walk: number[] = [];
    let mask = full;
    let cursor = last;
    while (cursor !== -1) {
      walk.unshift(cursor);
      const before = came[mask * width + cursor]!;
      mask &= ~(1 << nodes[cursor]!.item);
      cursor = before;
    }
    return walk;
  }

  /**
   * Every room the realm places one of a step's items in, as addresses.
   *
   * The three answers `QuestSource` already carries, turned from names into
   * places: a handover states its own room, a monster's is `mobPlaces` and a
   * shop's is `shopPlace` — including a shop name in fourteen rooms, because
   * every one of them sells the thing and the walk is free to pick whichever
   * it passes. A room the realm no longer holds is dropped rather than
   * planned to.
   */
  private errandRooms(step: QuestStep, id: number): RoomId[] {
    const source = step.sources?.find((known) => known.id === id);
    if (source === undefined) return [];
    const rooms = new Set<RoomId>();
    for (const handover of source.from ?? []) {
      if (handover.room !== undefined) rooms.add(handover.room as RoomId);
    }
    for (const who of source.mobs ?? []) {
      const mob = this.catalogue.mob(who);
      if (mob === undefined) continue;
      for (const spawn of this.index.mobPlaces(mob)?.spawns ?? []) {
        for (const at of spawn.rooms) rooms.add(roomId(at.map, at.room));
      }
    }
    for (const name of source.shops ?? []) {
      const place = this.index.shopPlace(name);
      if (place === undefined) continue;
      if (place.at === 'one') rooms.add(roomId(place.map, place.room));
      else for (const at of place.rooms) rooms.add(roomId(at.map, at.room));
    }
    return [...rooms].filter((room) => this.rooms.has(room));
  }

  /**
   * One step of a plan, from the room the step before it ends in: what it
   * gathers and how, where it happens, and whether the way there exists
   * (`QuestPlan`, `mudengine-world` › *A plan is steps, and each is priced from
   * the one before*).
   *
   * One step and not the chain, on purpose: a route is an A* per leg (up to
   * 300ms on Paradigm), so the session paces the chain across the event loop
   * between steps rather than holding the socket's thread for the lot. The
   * traveller is handed in with the counters the character *will* hold at this
   * step, which is what opens the ability-gated exits the realm writes on the
   * way into a chain's later rooms.
   */
  planStep(
    quest: Quest,
    step: QuestStep,
    from: RoomId | null,
    carrying: readonly number[] | null,
    traveller: Traveller,
    odds: NavigationOracle,
    supplies: readonly number[] = [],
    lap: Traveller = traveller
  ): PlanStep {
    const at = this.planPlace(step.room);
    const index = quest.steps.indexOf(step);
    const own = itemsBrought(step).map((item) =>
      this.planItem(quest, index, item, from, at?.room ?? null, carrying, traveller, lap)
    );
    const snags: PlanSnag[] = [];
    for (const item of own) {
      if (item.source.how === 'unplaced') {
        snags.push({ kind: 'unplaced', item: item.name ?? `#${item.id}` });
      }
    }
    // What the way wants, gathered before anything the step itself wants:
    // every walk this step makes leaves from `from`, and the hunts leave first.
    const bought: PlanItem[] = [];
    // And the keys the way to the step's room wants, where the navigation
    // engine gets them, gathered after the step's own items.
    const keys: PlanItem[] = [];
    let reachable: boolean | null = null;
    let moves: number | undefined;
    if (from !== null && at !== undefined && this.rooms.has(from) && this.rooms.has(at.room)) {
      /*
       * Priced as if what is in hand were used — the pack, and what earlier
       * legs of this plan bought — which is the premise the plan's own rows
       * state (`Route.carrying` makes the same one). Without it the desert is
       * a wall and the leg's figure is the way round, drawn beside a chip
       * that says the way through is safe (review, 2026-09-21).
       */
      const inHand = [...(carrying ?? []), ...supplies];
      /*
       * The ways this step walks, in the order the run walks them: out to
       * each monster it hunts, each from where the last hunt ends, then the
       * leg from there to the act. A hunt is the errand's loop, planned on
       * the lap's traveller, so it is read on `lap` — the shortest way,
       * straight through the desert — never on the plan's, which prices a
       * way round it and buys nothing for the way the run takes (review,
       * 2026-09-21; `mudengine-automation` › *A quest's plan is carried*).
       */
      const hunts: Route[] = [];
      let cursor: RoomId = from;
      for (const item of own) {
        if (item.source.how !== 'kill' || item.source.at === undefined) continue;
        const to = item.source.at.room as RoomId;
        if (!this.rooms.has(to)) continue;
        const way = leg(this.navigable, odds, cursor, to, this.quietened(lap, inHand));
        if (way.blocked) {
          snags.push({ kind: 'unreachable', reason: way.reason ?? '' });
          continue;
        }
        hunts.push(way);
        cursor = to;
      }
      const towards = (stoppers: readonly number[]): Plan =>
        plan(this.navigable, odds, cursor, at.room, this.quietened(traveller, stoppers));
      const first = towards(inHand);
      if (first.kind === 'refused') {
        reachable = false;
        snags.push({ kind: 'unreachable', reason: planRefusalsWords(first.refusals, t) });
      } else {
        reachable = true;
        let made = first;
        let ways = walksOf(made);
        /*
         * What the ways meet that nothing in hand stops is bought here, once
         * each — two spells the same raft stops are one raft — at the counter
         * least off the way to the *first room casting it*, since a counter
         * the route passes beyond the desert prices at nothing and is no use
         * in it. Then the leg is priced again carrying what was bought, and
         * what that way meets is named but not bought for: one more search,
         * never a chase.
         */
        const spent: number[] = [];
        for (const way of [...hunts, ...ways]) {
          for (const hazard of way.hazards ?? []) {
            if (!this.worthNaming(hazard)) continue;
            if (this.stopperOf(hazard.id, carrying, [...supplies, ...spent]) !== undefined)
              continue;
            const before =
              this.firstCasting(way.steps, hazard.id) ?? way.steps.at(-1)?.to ?? at.room;
            const supply = this.supplyFor(hazard, from, before, carrying, traveller);
            if (supply === undefined) continue;
            bought.push(supply);
            spent.push(supply.id);
          }
        }
        if (spent.length > 0) {
          const again = towards([...inHand, ...spent]);
          if (again.kind === 'plan') {
            made = again;
            ways = walksOf(made);
          }
        }
        keys.push(...plannedFetches(made).map((planned) => this.fetchedItem(planned, carrying)));
        for (const key of keys) {
          if (key.source.how === 'unplaced')
            snags.push({ kind: 'unplaced', item: key.name ?? `#${key.id}` });
        }
        /*
         * Every hazard the router still names is one the pack does not stop:
         * `hazardAvoided` has already silenced the ones it does. A spell that
         * only summons is a lair by another name and not a thing the walk has
         * to survive, so it is not a snag. The rest are named with what
         * settles them, once each across the hunts and the leg, with the most
         * rooms any one way crosses; a timed passage on any of them is named.
         */
        const named = new Map<number, Extract<PlanSnag, { kind: 'hazard' }>>();
        for (const way of [...hunts, ...ways]) {
          for (const hazard of way.hazards ?? []) {
            if (!this.worthNaming(hazard)) continue;
            const seen = named.get(hazard.id);
            if (seen !== undefined) {
              seen.rooms = Math.max(seen.rooms, hazard.rooms);
              continue;
            }
            const safeWith = this.stopperOf(hazard.id, carrying, [...supplies, ...spent]);
            const snag: Extract<PlanSnag, { kind: 'hazard' }> = {
              kind: 'hazard',
              spell: hazard.spell,
              rooms: hazard.rooms,
              unread: hazard.unread,
              moves: hazard.relocates,
              needs: hazard.needs.map((need) => need.name),
              ...(safeWith === undefined ? {} : { safeWith })
            };
            named.set(hazard.id, snag);
            snags.push(snag);
          }
        }
        for (const way of [...hunts, ...ways]) snags.push(...this.corridorsAlong(way.steps));
        // The step is every way it walks and the way out to each counter and
        // back: a figure that left the hunt out, or the tavern's three
        // hundred rooms, would be a plan nobody could keep to. What the fight
        // itself costs is not a number of moves.
        moves = 0;
        for (const way of [...hunts, ...ways]) moves += way.steps.length;
        for (const item of [...bought, ...own]) {
          if (item.source.how === 'buy' && item.source.detour !== undefined)
            moves += item.source.detour;
        }
      }
    }
    // The keys after the step's own items: the run hunts those from `from`
    // first, and the way the keys open is planned from where the hunts end.
    const listed = new Set([...bought, ...own].map((item) => item.id));
    const items = [...bought, ...own, ...keys.filter((key) => !listed.has(key.id))];
    const roll = stepRoll(step);
    return {
      block: step.block,
      ...(step.to === undefined ? {} : { to: step.to }),
      act: planAct(step),
      items,
      ...(at === undefined ? {} : { at }),
      reachable,
      ...(moves === undefined ? {} : { moves }),
      snags,
      ...(roll === null ? {} : { roll })
    };
  }

  /** A key the way to a step wants, fetched where the navigation engine plans it. */
  private fetchedItem({ step }: PlannedFetch, carrying: readonly number[] | null): PlanItem {
    return {
      id: step.item.id,
      name: step.item.name,
      held: packHolds(carrying, step.item.id),
      hand: false,
      source: this.fetchSource(step)
    };
  }

  /**
   * Where the plan gets a key, as a quest plan's row says it: a counter the
   * realm no longer lists is unplaced, and a summoned dropper's row names the
   * summoner, whose death in that room is what the run does.
   */
  private fetchSource(step: FetchStep): PlanSource {
    const place = this.planPlace(step.room);
    const at = place === undefined ? {} : { at: place };
    const act = fetchAct(step);
    switch (act.kind) {
      case 'buy': {
        const room = this.rooms.get(step.room);
        const counter =
          room === undefined ? undefined : counterIn(room, (shop) => this.catalogue.shop(shop));
        return counter === undefined
          ? { how: 'unplaced' }
          : { how: 'buy', shops: [counter.shop], ...at };
      }
      case 'say':
        return { how: 'said', say: act.say, ...at };
      case 'kill':
        return { how: 'kill', mob: act.summoner ?? act.dropper, ...at };
      default: {
        const never: never = act;
        return never;
      }
    }
  }

  /** A room the realm names, with its name where the graph holds it. */
  private planPlace(room: string | undefined): PlanPlace | undefined {
    if (room === undefined) return undefined;
    const name = this.rooms.get(room as RoomId)?.name.trim();
    return name === undefined || name.length === 0 ? { room } : { room, place: name };
  }

  /**
   * Whether a hazard the router names is one the plan should: a spell that
   * does something the reader would want to survive — a figure, a chain that
   * could not be read, a teleport. Read off the spell's own facts and never
   * off `RouteHazard.share`, which is null for *unknown health* as well as
   * for *no figure*, and non-null for a summons the session prices as a
   * discouragement (review, 2026-09-21: the swamp's summons on every leg, and
   * the river dropped before the first status line).
   */
  private worthNaming(hazard: RouteHazard): boolean {
    // A passage the way in opens is the route's own entry for what
    // `corridorsAlong` names on the plan; naming it here would say it twice
    // and buy nothing for it, since nothing carried stops one.
    if (hazard.corridor !== undefined) return false;
    const facts = this.catalogue.spellById(hazard.id)?.hazard;
    if (facts === undefined) return true;
    return facts.damage !== undefined || facts.unread === true || facts.relocates === true;
  }

  /**
   * The traveller with every room spell that `stoppers` stop priced at
   * nothing — `Router.holding`'s wrapper, over both halves of what stops a spell
   * (the item the script names and the item whose use casts the spell it
   * names). One answer per spell, kept for the search's thousands of asks.
   */
  private quietened(traveller: Traveller, stoppers: readonly number[]): Traveller {
    const priced = traveller.hazard;
    if (priced === undefined || stoppers.length === 0) return traveller;
    const settled = new Map<number, boolean>();
    const stopped = (spell: number): boolean => {
      const known = settled.get(spell);
      if (known !== undefined) return known;
      const answer = this.catalogue.stoppersOf(spell).some((item) => stoppers.includes(item.id));
      settled.set(spell, answer);
      return answer;
    };
    return {
      ...traveller,
      hazard: (room) => (room.spell !== undefined && stopped(room.spell) ? null : priced(room))
    };
  }

  /** The first room on the way that casts the spell, where a supply must be in hand by. */
  private firstCasting(steps: readonly RouteStep[], spell: number): RoomId | undefined {
    return steps.find(
      (step) => step.scatter === undefined && this.rooms.get(step.to)?.spell === spell
    )?.to;
  }

  /**
   * The name of a stopper already in hand: in the pack, or on a `Get` row of
   * an earlier leg of the same plan. Undefined where the walk would meet the
   * spell with nothing against it — which is what `supplyFor` then answers.
   */
  private stopperOf(
    spell: number,
    carrying: readonly number[] | null,
    supplies: readonly number[]
  ): string | undefined {
    for (const item of this.catalogue.stoppersOf(spell)) {
      if (supplies.includes(item.id) || packHolds(carrying, item.id) === true) return item.name;
    }
    return undefined;
  }

  /**
   * The stopper to buy for a leg, as a `Get` row: of every item the realm
   * says stops the spell, the one whose counter is least off this leg
   * (`buyingPlaces`, the petrol-station price), with how many
   * (`tuning.world.hazardSupplyCount` for a thing that is spent, one for a
   * thing that is not). Undefined where no counter stocks any of them, and
   * the snag then says what it would have taken.
   */
  private supplyFor(
    hazard: RouteHazard,
    from: RoomId,
    to: RoomId,
    carrying: readonly number[] | null,
    traveller: Traveller
  ): PlanItem | undefined {
    const stoppers = this.catalogue.stoppersOf(hazard.id);
    const place = this.index.stockingPlaces(
      stoppers.map((item) => item.id),
      from,
      to,
      traveller
    )[0];
    const item = place === undefined ? undefined : stoppers.find((each) => each.id === place.item);
    if (place === undefined || item === undefined) return undefined;
    const at = this.planPlace(roomId(place.map, place.room));
    const spent = item.uses !== undefined && item.uses > 0;
    return {
      id: item.id,
      name: item.name,
      held: packHolds(carrying, item.id),
      hand: false,
      source: {
        how: 'buy',
        shops: [place.shop],
        ...(at === undefined ? {} : { at }),
        detour: place.detour
      },
      ...(spent ? { count: tuning().world.hazardSupplyCount } : {}),
      stops: hazard.spell
    };
  }

  /**
   * The timed passages a route walks into: a text exit whose room command
   * puts a spell on the character (`RoomCommand.casts`, format 43) that ends
   * in another (`EndCast`) — *holding breath* into *drowning* — counted from
   * the room it lands in to the exit whose own cast kills it (`killSpell`,
   * on the spell or on what it ends in), else to the route's end with `ends`
   * false, since a leg that stops underwater is a fact the next leg does not
   * carry. Nothing carried stops one; the plan says how many rooms and how
   * many ticks.
   */
  private corridorsAlong(steps: readonly RouteStep[]): PlanSnag[] {
    return this.index
      .corridorsOn(steps)
      .map(({ id: _id, ...snag }) => ({ kind: 'corridor', ...snag }));
  }

  /**
   * How one item a step wants is got, cheapest act first: it is in the pack;
   * an earlier step of this chain hands it over, so the plan already has it;
   * a counter sells it, chosen by how far off the road it is (`buyingPlaces`);
   * a script hands it over for a word; a monster drops it, at the first place
   * the realm spawns one. Nothing named is `unplaced`, which the plan says
   * rather than guesses about.
   */
  private planItem(
    quest: Quest,
    index: number,
    item: { id: number; name?: string; hand: boolean },
    from: RoomId | null,
    to: RoomId | null,
    carrying: readonly number[] | null,
    traveller: Traveller,
    lap: Traveller
  ): PlanItem {
    const held = packHolds(carrying, item.id);
    const base = {
      id: item.id,
      ...(item.name === undefined ? {} : { name: item.name }),
      held,
      hand: item.hand
    };
    if (held === true) return { ...base, source: { how: 'carried' } };
    const earlier = earlierHandover(quest, index, item.id);
    if (earlier !== null) return { ...base, source: { how: 'earlier', rank: earlier } };
    const source = quest.steps[index]?.sources?.find((known) => known.id === item.id);
    const shops = source?.shops ?? [];
    if (shops.length > 0) {
      const origin = from ?? to;
      const best =
        origin === null ? undefined : this.index.buyingPlaces(item.id, origin, to, traveller)[0];
      const at = best === undefined ? undefined : this.planPlace(roomId(best.map, best.room));
      return {
        ...base,
        source: {
          how: 'buy',
          shops,
          ...(at === undefined ? {} : { at }),
          ...(best === undefined ? {} : { detour: best.detour })
        }
      };
    }
    for (const handover of source?.from ?? []) {
      const asks = handoverSource(handover);
      if (asks === null) continue;
      const at = this.planPlace(handover.room);
      const placed = at === undefined ? {} : { at };
      switch (asks.kind) {
        case 'kill':
          return { ...base, source: { how: 'kill', mob: asks.monster, ...placed } };
        case 'ask':
          return {
            ...base,
            source: {
              how: 'ask',
              who: asks.who,
              ...(asks.word === undefined ? {} : { say: asks.word }),
              ...placed
            }
          };
        case 'said':
          return { ...base, source: { how: 'said', say: asks.word, ...placed } };
        default: {
          const never: never = asks;
          return never;
        }
      }
    }
    const who = source?.mobs?.[0];
    if (who !== undefined) {
      const start = this.huntStart(item, who, from, lap);
      return {
        ...base,
        source: {
          how: 'kill',
          mob: start?.mob ?? who,
          ...(start === undefined ? {} : { at: start.at })
        }
      };
    }
    return { ...base, source: { how: 'unplaced' } };
  }

  /**
   * Where a hunt for this item would start, and for which dropper: the
   * ring's first stop from where the character stands — `droppingPlaces` on
   * the **lap's** traveller, the errand's own choice priced the errand's own
   * way, so the plan names the room the run will walk to — else the
   * monster's first placement in the realm's order, for a character nobody
   * has placed. Undefined where the realm places none.
   */
  private huntStart(
    item: { id: number; name?: string },
    mob: string,
    from: RoomId | null,
    lap: Traveller
  ): { mob: string; at: PlanPlace } | undefined {
    if (from !== null && this.rooms.has(from)) {
      const first = this.droppingPlaces(item, from, lap, { rooms: 1, radius: 0 }).lairs[0];
      const at = first === undefined ? undefined : this.planPlace(first.id);
      if (first !== undefined && at !== undefined) return { mob: first.mob, at };
    }
    const known = this.catalogue.mob(mob);
    const spawn =
      known === undefined ? undefined : this.index.mobPlaces(known)?.spawns[0]?.rooms[0];
    const at = spawn === undefined ? undefined : this.planPlace(roomId(spawn.map, spawn.room));
    return at === undefined ? undefined : { mob, at };
  }

  /**
   * Where to go and kill for an item, from one room: the realm's every
   * placement of a dropper, priced from `from` with `Router.sweepTo` — the
   * router's units for the choice, moves for the sentence, a wall walked as the
   * errand solver walks one — and the ring nearest: the cheapest placement to reach
   * and the placements within `ring.radius` of it, `ring.rooms` at most, in
   * the order a lap walks out from the first. Cheapest-eight-from-here was a
   * march: five maps for an item five monsters drop.
   *
   * Realm-wide, on the index `mobPlaces` reads: the errand's bounded sweep
   * called a raider 88 moves off *nowhere* (2026-09-21; `mudengine-automation`
   * › *A route that needs an item goes and gets it*). The droppers ride along,
   * each with its own placement count, so an empty `lairs` can say which of
   * two it is without welding one dropper's name to another's rooms.
   */
  droppingPlaces(
    item: { id: number; name?: string },
    from: RoomId,
    traveller: Traveller,
    ring: { rooms: number; radius: number }
  ): DropSources {
    // The kills the table lists (`navigation/sources.ts`): where the realm
    // places a dropper, where a death hands the item over, and, for a dropper
    // the realm places nowhere, where the monster that summons it on dying
    // lives (todo 806). A summons by words is an ask, found by `itemAsks`.
    const kills = this.index
      .itemSources(item.id)
      .flatMap((source) =>
        source.kind === 'kill' && (source.summon === undefined || 'by' in source.summon)
          ? [source]
          : []
      );
    const placedAt = new Map<string, Set<RoomId>>();
    for (const kill of kills) {
      if (kill.summon !== undefined || kill.certain === true) continue;
      placedAt.set(kill.monster, (placedAt.get(kill.monster) ?? new Set()).add(kill.room));
    }
    // Keyed by the monster's own name, which the table carries; a drop list
    // may spell it otherwise (`Catalogue.mob` reads either).
    const droppers: Dropper[] = this.catalogue.sourcesOf(item).mobs.map((mob) => {
      const own = this.catalogue.mob(mob)?.name ?? mob;
      return { mob, placed: placedAt.get(own)?.size ?? 0 };
    });
    const spawns = new Map<RoomId, { room: WorldRoom; mob: string; via?: string }>();
    const summoned = new Map<RoomId, { room: WorldRoom; mob: string; via: string }>();
    for (const kill of kills) {
      const room = this.index.roomsById.get(kill.room);
      if (room === undefined) continue;
      if (kill.summon === undefined) {
        if (!spawns.has(kill.room)) spawns.set(kill.room, { room, mob: kill.monster });
      } else if ('by' in kill.summon && (placedAt.get(kill.monster)?.size ?? 0) === 0) {
        if (!summoned.has(kill.room)) {
          summoned.set(kill.room, { room, mob: kill.monster, via: kill.summon.by });
        }
      }
    }
    for (const [id, place] of summoned) if (!spawns.has(id)) spawns.set(id, place);
    if (spawns.size === 0) return { droppers, lairs: [] };
    const priced = [...this.router.sweepTo(from, new Set(spawns.keys()), traveller)].sort(
      (a, b) => a[1].cost - b[1].cost || a[1].moves - b[1].moves || a[0].localeCompare(b[0])
    );
    const first = priced[0];
    if (first === undefined) return { droppers, lairs: [] };
    const around = this.router.withinSteps(first[0], ring.radius, traveller);
    const lairs = priced
      .filter(([id]) => around.has(id))
      .sort(
        (a, b) => around.get(a[0])! - around.get(b[0])! || priced.indexOf(a) - priced.indexOf(b)
      )
      .slice(0, Math.max(1, ring.rooms))
      .map(([id, { moves }]) => {
        const place = spawns.get(id)!;
        return {
          id,
          name: place.room.name,
          mob: place.mob,
          steps: moves,
          ...('via' in place ? { via: place.via } : {})
        };
      });
    return { droppers, lairs };
  }
}

/** The walks of a plan, in order. */
function walksOf(made: Extract<Plan, { kind: 'plan' }>): Route[] {
  return made.steps.flatMap((step) => (step.kind === 'walk' ? [step.route] : []));
}
