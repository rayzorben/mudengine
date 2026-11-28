/**
 * What the route panel's three views read off a planned way: the ways main
 * planned beside the plan, the way split into legs by area, what each leg
 * holds, where another way leaves this one, and the health a way is expected
 * to cost. Pure, so the views only draw. See `mudengine-ui` › `parts/map.md`,
 * *The route panel has three views*.
 */
import { lairsAlong, type Direction, type Route, type RouteStep } from '@shared/world';
import type { RouteView } from '@shared/config';
import { t } from './i18n';
import { gateWord } from './route';
import { tuning } from './tuning';

/** The view toggle's words, and the setting's. */
export const ROUTE_VIEW_LABEL: Record<RouteView, string> = {
  legs: t('cards.route.view.legs'),
  line: t('cards.route.view.line'),
  forecast: t('cards.route.view.forecast')
};

/** Which of the plan's routes is on screen — see `RoutePanel`'s `chosen`. */
export type Way =
  'plan' | 'round' | 'carrying' | 'viaItem' | 'another' | 'direct' | 'keyed' | 'keptOut';

/**
 * The way round what the player keeps out of, as it would be walked: the way
 * itself, or where there is none without a key the pack lacks, the way once
 * it is fetched (`Route.unlocks`). Null where there is no way round at all.
 */
export function roundWay(route: Route): Route | null {
  const round = route.keptOut?.round;
  if (round === undefined) return null;
  return round.blocked ? (round.unlocks ?? null) : round;
}

/** The route a way names, or the plan where the plan has no such way. */
export function wayRoute(route: Route, way: Way): Route {
  switch (way) {
    case 'plan':
      return route;
    case 'round':
      return route.otherWay ?? route;
    case 'carrying':
      return route.carrying ?? route;
    case 'viaItem':
      return route.viaItem ?? route;
    case 'another':
      return route.another ?? route;
    case 'direct':
      return route.direct ?? route;
    case 'keyed':
      return route.unlocks ?? route;
    case 'keptOut':
      return roundWay(route) ?? route;
    default: {
      const never: never = way;
      return never;
    }
  }
}

/** Every way main planned, the plan first, each once, walkable or not. */
export function plannedWays(route: Route): Array<{ way: Way; route: Route }> {
  const all: Array<{ way: Way; route: Route | undefined }> = [
    { way: 'plan', route },
    { way: 'direct', route: route.direct },
    { way: 'round', route: route.otherWay },
    { way: 'another', route: route.another },
    { way: 'carrying', route: route.carrying },
    { way: 'viaItem', route: route.viaItem },
    { way: 'keyed', route: route.unlocks }
  ];
  return all.flatMap(({ way, route: one }) => (one === undefined ? [] : [{ way, route: one }]));
}

/** The ways a view draws: those with steps to walk. */
export function waysOf(route: Route): Array<{ way: Way; route: Route }> {
  return plannedWays(route).filter(({ route: one }) => !one.blocked && one.steps.length > 0);
}

/** A way's name, as the head's chip, a line and a fork all say it: lower case, as in a sentence. */
export function wayName(way: Way): string {
  switch (way) {
    case 'plan':
      return t('cards.route.showing.plan');
    case 'round':
      return t('cards.route.showing.round');
    case 'carrying':
      return t('cards.route.showing.carrying');
    case 'viaItem':
      return t('cards.route.showing.viaItem');
    case 'another':
      return t('cards.route.showing.another');
    case 'direct':
      return t('cards.route.showing.direct');
    case 'keyed':
      return t('cards.route.showing.keyed');
    case 'keptOut':
      return t('cards.route.showing.keptOut');
    default: {
      const never: never = way;
      return never;
    }
  }
}

/** A stretch of a way in one area: steps `from` to `to`, both included. */
export interface RouteArea {
  name: string;
  from: number;
  to: number;
}

/**
 * The part of a room's name that says where it is: before the first comma,
 * as the realm writes `Darkwood Forest, Main Road`. Null for a room named for
 * its corner (`Intersection of Silver St. & Brass St.`, 1/106 in both shipped
 * worlds, `resources/world/*.jsonl.gz`), which belongs to the street either
 * side of it.
 */
export function areaWord(name: string): string | null {
  if (/^intersection of /i.test(name)) return null;
  const cut = name.indexOf(',');
  const word = (cut === -1 ? name : name.slice(0, cut)).trim();
  return word === '' ? null : word;
}

/**
 * The way split where the area changes, by the rooms' own names. A run of
 * fewer than `tuning().routeAreaRooms` rooms joins the leg before it (or the
 * one after, at the start), so a square or a gate between two streets does
 * not make a leg of one room. A leg is named for the word most of its rooms
 * carry. The world has no area names, so this is a reading of the room names.
 */
export function areasOf(steps: readonly RouteStep[]): RouteArea[] {
  const shortest = tuning().routeAreaRooms;
  // Runs of one word, a corner joining the run it is in.
  const runs: Array<{ word: string | null; from: number; to: number }> = [];
  steps.forEach((step, index) => {
    const word = areaWord(step.name);
    const last = runs.at(-1);
    if (last !== undefined && (word === null || last.word === null || word === last.word)) {
      last.to = index;
      if (last.word === null) last.word = word;
    } else runs.push({ word, from: index, to: index });
  });
  const legs: Array<{ from: number; to: number }> = [];
  for (const run of runs) {
    const last = legs.at(-1);
    const short = (span: { from: number; to: number }) => span.to - span.from + 1 < shortest;
    if (last !== undefined && (short(run) || short(last))) last.to = run.to;
    else legs.push({ from: run.from, to: run.to });
  }
  return legs.map(({ from, to }) => ({ name: nameOf(steps.slice(from, to + 1)), from, to }));
}

/** The word most rooms of a leg carry, the first of equals. */
function nameOf(steps: readonly RouteStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const word = areaWord(step.name);
    if (word !== null) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [word, count] of counts) if (best === null || count > counts.get(best)!) best = word;
  return best ?? steps[0]?.name ?? '';
}

/** What a stretch of way holds, in the figures a leg's one line states. */
export interface StretchFacts {
  /** Lairs the router weighed. */
  lairs: number;
  /**
   * Lairs with no figure for the fight (`danger`), whether main marked them
   * `lairUnweighed` or only priced the run past them: unknown, never none.
   */
  unweighed: number;
  /** The largest share of health a weighed lair on it is expected to take; null where none was. */
  worst: number | null;
  /** Whether main expects a room on it to kill (`RouteStep.deadly`). */
  deadly: boolean;
  /** Rooms whose own spell touches whoever stands in them. */
  spells: number;
  /** Each gate's word, in walking order: a door, a toll, a typed exit. */
  gates: string[];
  /** The most common direction, for *13 rooms · east*. */
  heading: Direction | null;
}

export function factsOf(steps: readonly RouteStep[]): StretchFacts {
  const lairs = lairsAlong(steps);
  const headings = new Map<Direction, number>();
  for (const step of steps)
    if (step.direction !== 'portal')
      headings.set(step.direction, (headings.get(step.direction) ?? 0) + 1);
  let heading: Direction | null = null;
  for (const [dir, count] of headings)
    if (heading === null || count > headings.get(heading)!) heading = dir;
  return {
    lairs: lairs.count,
    unweighed: steps.filter(
      (step) => step.lairUnweighed === true || (step.lair === true && step.danger === undefined)
    ).length,
    worst: lairs.worst,
    deadly: lairs.deadly !== null,
    spells: steps.filter((step) => step.hazard !== undefined).length,
    gates: steps.flatMap((step) => {
      const word = gateWord(step);
      return word === null ? [] : [word];
    }),
    heading
  };
}

/**
 * Where another way leaves this one and comes back: the rooms it walks
 * between two rooms both ways share, against the ones this way walks there.
 * `from` is the first step of ours it replaces; `to` the last (from − 1 where
 * it replaces none).
 */
export interface Fork {
  way: Way;
  from: number;
  to: number;
  theirs: readonly RouteStep[];
}

export function forksOf(base: Route, way: Way, other: Route): Fork[] {
  const ours = new Map<string, number>();
  base.steps.forEach((step, index) => {
    if (!ours.has(step.to)) ours.set(step.to, index);
  });
  const out: Fork[] = [];
  let left = -1;
  let start: number | null = null;
  other.steps.forEach((step, index) => {
    const at = ours.get(step.to);
    if (at === undefined) {
      if (start === null) start = index;
      return;
    }
    if (start !== null) {
      out.push({ way, from: left + 1, to: at - 1, theirs: other.steps.slice(start, index) });
      start = null;
    }
    left = at;
  });
  if (start !== null)
    out.push({ way, from: left + 1, to: base.steps.length - 1, theirs: other.steps.slice(start) });
  return out.filter((fork) => worthSaying(base, fork));
}

/** A fork of a room or two through the same kind of rooms is not a choice worth a line. */
function worthSaying(base: Route, fork: Fork): boolean {
  const ours = base.steps.slice(fork.from, fork.to + 1);
  const theirs = factsOf(fork.theirs);
  const mine = factsOf(ours);
  return (
    Math.abs(fork.theirs.length - ours.length) >= tuning().routeForkRooms ||
    theirs.gates.join() !== mine.gates.join() ||
    theirs.worst !== mine.worst ||
    theirs.unweighed !== mine.unweighed
  );
}

/** Health after each step, as a share of the bar, and whether a rest came first. */
export interface HealthPoint {
  share: number;
  rested: boolean;
}

/**
 * The health a way is expected to leave, step by step, from a full bar: each
 * room's own spell takes its share (`RouteStep.hazard`) walking or running,
 * and walking fights each lair for its share (`RouteStep.danger`), resting to
 * full first when under `tuning().routeRestShare`. Running passes lairs with
 * combat off, so a lair costs it a chance of dying (`runDeath`) rather than
 * health, which `runDeathAlong` adds up. A lair nobody weighed has no figure
 * to take, so the line leaves it out and the view says how many there are.
 */
export function healthAlong(steps: readonly RouteStep[], running: boolean): HealthPoint[] {
  const restBelow = tuning().routeRestShare;
  let share = 1;
  return steps.map((step) => {
    let rested = false;
    if (step.hazard !== undefined && step.hazardKind === undefined) share -= step.hazard;
    if (!running && step.lair === true && step.danger !== undefined) {
      if (share < restBelow) {
        share = 1;
        rested = true;
      }
      share -= step.danger;
    }
    return { share, rested };
  });
}

/**
 * The chance of dying on the way, running: one less the product of surviving
 * each pass the router priced (`runDeath`), and how many lairs and rooms of
 * wanderers it passes with no figure — a fight not yet run — which the chance
 * leaves out and must be said beside it, never folded in as safe.
 */
export function runDeathAlong(steps: readonly RouteStep[]): {
  chance: number;
  unweighed: number;
  wanderers: number;
} {
  let alive = 1;
  let unweighed = 0;
  let wanderers = 0;
  for (const step of steps) {
    if (step.runDeath !== undefined) alive *= 1 - step.runDeath;
    else if (step.lair === true) unweighed += 1;
    else if (step.wanderersUnweighed === true) wanderers += 1;
  }
  return { chance: 1 - alive, unweighed, wanderers };
}
