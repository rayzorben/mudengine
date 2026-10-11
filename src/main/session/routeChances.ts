/**
 * A route's chance of coming through alive, run and walked (todo 23), for the
 * panel's buttons: `Run it (98%)` off `runRiskOf`, `Walk it (3%)` off the odds
 * book's fight of every lair whose monsters attack on sight, as auto-combat
 * fights them, and of each wanderer that does at its chance (todo 25). Laid on
 * each way the panel can show.
 */
import type { Odds } from '../../shared/survival';
import type { Route, RouteChances, WorldRoom } from '../../shared/world';
import { noneOpens, opensOn, runRiskOf, type RunRiskParts } from './runRisk';
import { wanderersOf } from './wanderersIn';

/** The chance of dying fighting what is met in one room; null where a fight has not run. */
function fightDeath(room: WorldRoom, parts: RunRiskParts): number | null {
  const lost = (odds: Odds): number | null =>
    odds.kind === 'run' ? 1 - odds.survival.survives : null;
  if (room.lair !== undefined) {
    return noneOpens(parts.world.lairEntities(room), parts.state) ? 0 : lost(parts.lairOdds(room));
  }
  let death = 0;
  for (const { entity, chance } of wanderersOf(room, parts.world)) {
    if (!opensOn(entity, parts.state)) continue;
    const each = lost(parts.mobOdds(entity.name));
    if (each === null) return null;
    // One of them is met on a pass, so the deaths add at their chances.
    death += chance * each;
  }
  return death;
}

/** The chance of surviving every lair and wanderer fought on the way; null where one has not run. */
function walkChance(route: Route, parts: RunRiskParts): number | null {
  let lives = 1;
  for (const step of route.steps) {
    const room = parts.world.byId(step.to);
    if (room === undefined) continue;
    const death = fightDeath(room, parts);
    if (death === null) return null;
    lives *= 1 - death;
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
