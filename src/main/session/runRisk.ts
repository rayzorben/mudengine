/**
 * A route's risk when it is run (todo 15): each hostile lair on it, the chance
 * a round lands while passing (the move delay against the round, nothing
 * where a sneak holds past monsters that do not see hidden) and the chance
 * that round kills (the odds book's first round of the lair). See
 * `src/shared/runPass.ts` for the server's rules it rests on.
 */
import { SEE_HIDDEN_ABILITY, carriesAbility } from '../../shared/abilities';
import type { CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import type { RealmFamily } from '../../shared/realm';
import { passCaught, runDeath, sneakHolds, type RunLair, type RunRisk } from '../../shared/runPass';
import type { Odds } from '../../shared/survival';
import { parseLair, type RoomId, type Route, type WorldRoom } from '../../shared/world';

export interface RunRiskParts {
  state: CharacterState;
  movement: Pick<MovementConfig, 'sneak'>;
  family: RealmFamily | null;
  world: {
    byId(id: RoomId): WorldRoom | undefined;
    lairEntities(room: WorldRoom): MobEntity[];
  };
  lairOdds(room: WorldRoom): Odds;
  /** `tuning.hunting`: the round, and the step where the family states no move delay. */
  roundSeconds: number;
  stepMs: number;
}

/** The monsters a lair holds at its cap; none where the room has no lair. */
function heldIn(room: WorldRoom | undefined): number {
  if (room?.lair === undefined) return 0;
  return parseLair(room.lair).max ?? 0;
}

/** The chance one caught round in this lair kills, from full health; null where the fight has not run. */
function killsOf(odds: Odds): number | null {
  if (odds.kind !== 'run') return null;
  const first = odds.survival.horizons.find((horizon) => horizon.rounds === 1);
  return first === undefined ? null : 1 - first.standing;
}

export function runRiskOf(route: Route, parts: RunRiskParts): RunRisk {
  const { state, world } = parts;
  const { encumbrance, encumbranceMax } = state.inventory;
  const exposed = passCaught(
    encumbrance,
    encumbranceMax,
    parts.family,
    parts.stepMs,
    parts.roundSeconds * 1000
  );
  const stealth = state.progress.stealthSkill;
  // The walker sneaks before each step where the setting asks and the sheet allows (`walk/Sneak.ts`).
  const sneaks = parts.movement.sneak && stealth !== null && stealth > 0;
  const lairs: RunLair[] = [];
  for (const step of route.steps) {
    if (step.lair !== true) continue;
    /*
     * Every lair, read by its own fight: a route planned without lair pricing
     * (a lap's) carries no `danger` on a hostile lair either, so its absence
     * is no answer. Monsters that do not open on the character kill nobody in
     * the simulated first round.
     */
    const room = world.byId(step.to);
    if (room === undefined) continue;
    const seen = world
      .lairEntities(room)
      .some((mob) => carriesAbility(mob.abilities, SEE_HIDDEN_ABILITY));
    // The sneak is rolled on the room left (`Exits.cs:144`); players there are not counted, being unknown.
    const hidden = sneaks && !seen ? sneakHolds(stealth, heldIn(world.byId(step.from))) : 0;
    lairs.push({
      room: step.to,
      name: step.name,
      caught: exposed * (1 - hidden),
      kills: killsOf(parts.lairOdds(room))
    });
  }
  return { death: runDeath(lairs), lairs };
}
