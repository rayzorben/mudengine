/**
 * The level the way to a quest's next reward wants, which no script states:
 * the portal into the Dao Lord's plane is a room command gated on level 20,
 * and the crate MerchantCaptain sends you for lies past level 40 and 60 walls.
 * Walked by the navigation engine to each step up to the next that pays
 * (`ranksToPay`), paced one route a turn. See `mudengine-world` ›
 * `parts/quests.md` (todo 132).
 */
import { t } from '../app/i18n';
import { nextTurn } from '../app/nextTurn';
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

/**
 * What the reach asks of the navigation engine: one walk at a time, held to a
 * time on the thread (`Errands.legWithin`); `spent` where it ran out.
 */
export interface ReachRouter {
  legWithin(from: RoomId, to: RoomId, traveller: Traveller, ms: number): Route | 'spent' | null;
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
 * the one that opens it; `tries` bounds the climb, and `ms` all of the tries.
 */
function openingLevel(
  router: ReachRouter,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  tries: number,
  ms: number
): number | null | 'spent' {
  if (traveller.level === null || traveller.level === undefined) return null;
  const by = performance.now() + ms;
  let level = traveller.level;
  let opened: number | null = null;
  for (let tried = 0; tried < tries; tried += 1) {
    const left = by - performance.now();
    const way = left <= 0 ? 'spent' : router.legWithin(from, to, { ...traveller, level }, left);
    if (way === 'spent') return 'spent';
    const wall = way === null ? null : levelWall(way);
    if (wall === null || wall <= level) return opened;
    level = wall;
    opened = wall;
  }
  return opened;
}

/**
 * The traveller with the risk of the character as they stand taken off: what
 * a lair, a run past one and a room's own spell would cost now. The reach asks
 * which level opens a way, and those prices read the bar and the sheet as they
 * are now, which the level being tried changes neither of. A fight on the way
 * never refuses a plan (`mudengine-world` › *Survival never refuses a plan*),
 * so a way through a lair is a way. They were also the dearest part of every
 * step priced: a leg through the scatter mazes held the socket thread for over
 * a minute on the host (2026-10-29 UTC).
 */
export function levelsOnly(traveller: Traveller): Traveller {
  const {
    danger: _danger,
    runDeath: _runDeath,
    lairDamage: _lairDamage,
    hazard: _hazard,
    ...rest
  } = traveller;
  return rest;
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

/** How a run of the reach goes: its bounds, and where a leg given up is told. */
export interface ReachPace {
  tries: number;
  /** The time one leg may plan, all its tries together. */
  legMs: number;
  /** A later ask replaced this one, or the realm went. */
  superseded(): boolean;
  /** A leg whose planning ran out of time: its rank is unknown. */
  spent(leg: ReachLeg): void;
}

/**
 * Route every leg, one per turn of the event loop, and answer each quest's
 * first rank whose way wants more levels. A step wants every one of its rooms,
 * so its level is the highest they ask; steps sharing a rank are alternatives,
 * so a rank waits only where every one of them does, at the lowest. A leg that
 * runs out of time is not routed, so its rank is unknown.
 */
export async function reachAll(
  router: ReachRouter,
  legs: readonly ReachLeg[],
  from: RoomId,
  traveller: Traveller,
  pace: ReachPace
): Promise<QuestReachAnswer | null> {
  // Keyed by block and rank: the blue and red books are one block at two ranks.
  const steps = new Map<string, { quest: number; rank: number; of: number; level: number }>();
  // A step wants every one of its rooms, so one room given up leaves it unknown.
  const unknown = new Set<string>();
  for (const leg of legs) {
    await nextTurn();
    if (pace.superseded()) return null;
    const key = `${leg.block}/${leg.rank}`;
    const opened = openingLevel(router, from, leg.room, traveller, pace.tries, pace.legMs);
    if (opened === 'spent') {
      pace.spent(leg);
      unknown.add(key);
      continue;
    }
    const level = opened ?? 0;
    const held = steps.get(key);
    if (held === undefined) steps.set(key, { ...leg, level });
    else held.level = Math.max(held.level, level);
  }
  for (const key of unknown) steps.delete(key);
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
  /** Where the reach says the steps it gave up on. */
  notice(message: string): void;
  /** What decides whether a route reaches a room, as one string (`Errands.reachKey`). */
  reachKey(state: CharacterState): string;
}

/** The last answer, and what it was worked out from. */
interface KeptReach {
  readonly world: object;
  readonly tuning: object;
  readonly key: string;
  readonly answer: QuestReachAnswer;
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
  /**
   * Asked again with nothing it reads changed, the answer is the same: a
   * reconnect re-reads the counters and the card asks again, and each run
   * routed every leg afresh (2026-10-29 UTC).
   */
  private kept: KeptReach | null = null;

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
    const key = JSON.stringify([from, legs, this.parts.reachKey(state)]);
    const now = tuning();
    const kept = this.kept;
    if (kept !== null && kept.world === world && kept.tuning === now && kept.key === key) {
      return kept.answer;
    }
    const spent = new Set<string>();
    const { questReachTries, questReachLegMs } = tuning().world;
    const answer = await reachAll(
      this.parts.router,
      legs,
      from,
      levelsOnly(this.parts.traveller(state)),
      {
        tries: questReachTries,
        legMs: questReachLegMs,
        // A later ask, or the realm put down or changed under the run.
        superseded: () => asked !== this.asked || this.parts.world() !== world,
        spent: (leg) =>
          spent.add(quests.find((quest) => quest.id === leg.quest)?.name ?? `${leg.quest}`)
      }
    );
    if (spent.size > 0) {
      this.parts.notice(
        t('automation.quests.reachSpent', {
          quests: [...spent].join(', '),
          seconds: questReachLegMs / 1000
        })
      );
    }
    if (answer !== null) {
      // An answer with a leg given up is asked again: the thread may only have been busy.
      if (spent.size === 0) this.kept = { world, tuning: now, key, answer };
      return answer;
    }
    // Superseded: the later ask's walls. The realm gone: nothing is known.
    return asked !== this.asked ? this.latest : null;
  }
}
