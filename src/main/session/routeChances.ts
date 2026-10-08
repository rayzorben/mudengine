/**
 * A route's chance of coming through alive, run and walked (todo 23), for the
 * panel's buttons: `Run it (98%)` off `runRiskOf`, `Walk it (3%)` off the odds
 * book's fight of every lair whose monsters attack on sight, as auto-combat
 * fights them. Laid on each way the panel can show.
 */
import type { Route, RouteChances } from '../../shared/world';
import { openingOn, runRiskOf, type RunRiskParts } from './runRisk';

/** The chance of surviving every lair fought on the way; null where one has not run. */
function walkChance(route: Route, parts: RunRiskParts): number | null {
  let lives = 1;
  for (const step of route.steps) {
    if (step.lair !== true) continue;
    const room = parts.world.byId(step.to);
    if (room === undefined) continue;
    const opening = openingOn(parts.world.lairEntities(room), parts.state);
    if (opening !== null && opening.length === 0) continue;
    const odds = parts.lairOdds(room);
    if (odds.kind !== 'run') return null;
    lives *= odds.survival.survives;
  }
  return lives;
}

export function chancesOf(route: Route, parts: RunRiskParts): RouteChances {
  const { death } = runRiskOf(route, parts);
  return { run: death === null ? null : 1 - death, walk: walkChance(route, parts) };
}

/** Every field of a route that is itself a way the panel can show. */
type Alternative = {
  [K in keyof Route]-?: NonNullable<Route[K]> extends Route ? K : never;
}[keyof Route];

/** Each of them, held by the compiler: a way added to `Route` must be named here. */
const ALTERNATIVES: Record<Alternative, true> = {
  otherWay: true,
  carrying: true,
  viaItem: true,
  another: true,
  unlocks: true
};

/** The route and every alternative it carries, each with its own chances. */
export function withChances(route: Route, parts: RunRiskParts): Route {
  const laid: Route = { ...route, chances: chancesOf(route, parts) };
  for (const key of Object.keys(ALTERNATIVES) as Alternative[]) {
    const way = route[key];
    if (way !== undefined) laid[key] = withChances(way, parts);
  }
  if (route.keptOut !== undefined)
    laid.keptOut = { ...route.keptOut, round: withChances(route.keptOut.round, parts) };
  return laid;
}
