/**
 * The level the way to a quest's next reward wants, which no script states:
 * the portal into the Dao Lord's plane is a room command gated on level 20,
 * and the crate MerchantCaptain sends you for lies past level 40 and 60 walls.
 * Walked by the navigation engine to each step up to the next that pays
 * (`ranksToPay`), paced one route a turn. See `mudengine-world` ›
 * `parts/quests.md` (todo 132).
 */
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import {
  countersNow,
  questBars,
  questItemsTaken,
  questReading,
  ranksToPay,
  type Quest,
  type QuestMarks,
  type QuestReachAnswer,
  type QuestDoer,
  type QuestStep,
  type QuestWatched,
  type RankAhead
} from '../../shared/quests';
import { roomAddress, type Route, type RoomId } from '../../shared/world';
import type { Traveller } from '../world/WorldGraph';

/** What the reach asks of the navigation engine: one walk at a time (`Errands.legAs`). */
export interface ReachRouter {
  legAs(from: RoomId, to: RoomId, traveller: Traveller): Route | null;
}

/**
 * Where a step happens and where the realm's own scripts hand over what it
 * takes. A shop or a drop is left out: either stands in many rooms, and the
 * plan prices those (`WorldGraph.planStep`).
 */
export function stepRooms(step: QuestStep): RoomId[] {
  const rooms = new Set<RoomId>();
  if (step.room !== undefined) rooms.add(step.room as RoomId);
  const wanted = new Set([
    ...step.takes.map((item) => item.id),
    ...step.needs.flatMap((gate) => (gate.kind === 'carry' ? [gate.item] : []))
  ]);
  for (const source of step.sources ?? []) {
    if (!wanted.has(source.id)) continue;
    for (const handover of source.from ?? []) {
      if (handover.room !== undefined) rooms.add(handover.room as RoomId);
    }
  }
  return [...rooms];
}

/**
 * The lowest level a route's level walls ask for, or null where none stands
 * in it. On a refused route the walls are `blocks`; on a walkable one,
 * `blocks` is what a *cheaper* way needed and only `walls` binds.
 */
function levelWall(route: Route): number | null {
  const shut = route.blocked ? (route.blocks ?? []) : (route.walls ?? []);
  let level: number | null = null;
  for (const block of shut) {
    if (block.kind !== 'level' || block.minLevel === undefined) continue;
    level = level === null ? block.minLevel : Math.min(level, block.minLevel);
  }
  return level;
}

/**
 * The level the way to one room opens at, or null where no level wall stands
 * in it at this character's level. Each level wall met raises the traveller to
 * the lowest one and asks again, so a way past two walls (40, then 60) says
 * the one that opens it; `tries` bounds the climb.
 */
function openingLevel(
  router: ReachRouter,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  tries: number
): number | null {
  if (traveller.level === null || traveller.level === undefined) return null;
  let level = traveller.level;
  let opened: number | null = null;
  for (let tried = 0; tried < tries; tried += 1) {
    const way = router.legAs(from, to, { ...traveller, level });
    const wall = way === null ? null : levelWall(way);
    if (wall === null || wall <= level) return opened;
    level = wall;
    opened = wall;
  }
  return opened;
}

/** One route still to ask, so the session can pace them a turn each. */
export interface ReachLeg {
  quest: number;
  rank: number;
  block: number;
  /** How many steps the rank has: one with no room routed leaves the rank unknown. */
  of: number;
  room: RoomId;
}

/** The legs to route for one quest's span, in rank order. */
export function reachLegs(quest: Quest, span: readonly RankAhead[]): ReachLeg[] {
  return span.flatMap(({ rank, acts }) =>
    acts.flatMap((step) =>
      stepRooms(step).map((room) => ({
        quest: quest.id,
        rank,
        block: step.block,
        of: acts.length,
        room
      }))
    )
  );
}

/**
 * Route every leg, one per turn of the event loop, and answer each quest's
 * first rank whose way wants more levels. `superseded` stops a run a later
 * ask has replaced. A step wants every one of its rooms, so its level is the
 * highest they ask; steps sharing a rank are alternatives, so a rank waits
 * only where every one of them does, at the lowest.
 */
export async function reachAll(
  router: ReachRouter,
  legs: readonly ReachLeg[],
  from: RoomId,
  traveller: Traveller,
  tries: number,
  superseded: () => boolean
): Promise<QuestReachAnswer | null> {
  // Keyed by block and rank: the blue and red books are one block at two ranks.
  const steps = new Map<string, { quest: number; rank: number; of: number; level: number }>();
  for (const leg of legs) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (superseded()) return null;
    const level = openingLevel(router, from, leg.room, traveller, tries) ?? 0;
    const key = `${leg.block}/${leg.rank}`;
    const held = steps.get(key);
    if (held === undefined) steps.set(key, { ...leg, level });
    else held.level = Math.max(held.level, level);
  }
  const ranks = new Map<
    string,
    { quest: number; rank: number; of: number; routed: number; level: number }
  >();
  for (const step of steps.values()) {
    const key = `${step.quest}/${step.rank}`;
    const held = ranks.get(key);
    if (held === undefined) ranks.set(key, { ...step, routed: 1 });
    else {
      held.level = Math.min(held.level, step.level);
      held.routed += 1;
    }
  }
  const answer: QuestReachAnswer = {};
  for (const { quest, rank, of, routed, level } of ranks.values()) {
    // An alternative with no room to route to is unknown, and unknown never waits.
    if (level === 0 || routed < of) continue;
    const known = answer[quest];
    if (known === undefined || rank < known.rank) answer[quest] = { rank, level };
  }
  return answer;
}

/** What the reach reads: the realm, the character, what was watched, and how it travels. */
export interface QuestReachParts {
  world(): { quests(): readonly Quest[] } | undefined;
  router: ReachRouter;
  state(): CharacterState;
  watched(): QuestWatched;
  traveller(state: CharacterState): Traveller;
}

/**
 * The quest book's ask: for each quest the script leaves open, the first rank
 * up to the next reward whose way wants more levels. A later ask supersedes an
 * earlier one, as `Errands.questPlan`'s does, and the earlier one answers with
 * the later one's walls: two windows on one character must not wipe each
 * other's. Null where the realm is not loaded or the character cannot be
 * placed, which the card reads as unknown.
 */
export class QuestReach {
  private asked = 0;
  private latest: Promise<QuestReachAnswer | null> = Promise.resolve(null);

  constructor(private readonly parts: QuestReachParts) {}

  ask(marks: QuestMarks): Promise<QuestReachAnswer | null> {
    const asking = this.answer(marks);
    this.latest = asking;
    return asking;
  }

  private async answer(marks: QuestMarks): Promise<QuestReachAnswer | null> {
    const world = this.parts.world();
    if (world === undefined) return null;
    const state = this.parts.state();
    const from = roomAddress(state.room);
    if (from === null) return null;
    this.asked += 1;
    const asked = this.asked;
    const watched = this.parts.watched();
    const counters = countersNow(state.abilities ?? null, watched);
    const quests = world.quests();
    const taken = questItemsTaken(quests);
    const who: QuestDoer = {
      className: state.className,
      race: state.race,
      level: state.progress.level ?? null,
      counters
    };
    const legs = quests.flatMap((quest) => {
      const standing = questReading(quest.id, counters, watched, marks[quest.id] ?? null);
      // A quest the next step shuts already says why; routing it adds nothing.
      if (questBars(quest, who, standing).length > 0) return [];
      return reachLegs(quest, ranksToPay(quest, standing, who.className, taken));
    });
    const answer = await reachAll(
      this.parts.router,
      legs,
      from,
      this.parts.traveller(state),
      tuning().world.questReachTries,
      // A later ask, or the realm put down or changed under the run.
      () => asked !== this.asked || this.parts.world() !== world
    );
    if (answer !== null) return answer;
    // Superseded: the later ask's walls. The realm gone: nothing is known.
    return asked !== this.asked ? this.latest : null;
  }
}
