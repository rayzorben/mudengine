import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import type { Odds, Survival } from '../../../shared/survival';
import type { Route, RouteStep, WorldRoom } from '../../../shared/world';
import { runRiskOf, type RunRiskParts } from '../runRisk';

const room = (id: string, lair?: string): WorldRoom =>
  ({
    id,
    map: 17,
    room: Number(id.split('/')[1]),
    name: id,
    ...(lair ? { lair } : {})
  }) as unknown as WorldRoom;

const ROOMS = new Map<string, WorldRoom>([
  ['17/3', room('17/3')],
  ['17/4', room('17/4', 'Max 3: 1,2')],
  ['17/5', room('17/5')]
]);

const step = (from: string, to: string, extra: Partial<RouteStep> = {}): RouteStep =>
  ({
    from,
    to,
    name: to,
    direction: 'n',
    command: 'n',
    requirement: null,
    dark: false,
    ...extra
  }) as RouteStep;

const ROUTE: Route = {
  steps: [step('17/3', '17/4', { lair: true, danger: 1.3 }), step('17/4', '17/5')],
  cost: 2,
  blocked: false
} as Route;

const run = (standing: number): Odds => ({
  kind: 'run',
  survival: {
    horizons: [{ rounds: 1, standing, won: 0, lost: { least: 0, mean: 27, most: 223 } }]
  } as unknown as Survival
});

/** An empty pack, weighed: GreaterMUD's 1100 ms step. */
const WEIGHED = { ...EMPTY_CHARACTER.inventory, encumbrance: 0, encumbranceMax: 1000 };

const parts = (
  over: Partial<RunRiskParts> = {},
  state: Partial<CharacterState> = {}
): RunRiskParts => ({
  state: { ...EMPTY_CHARACTER, inventory: WEIGHED, ...state },
  movement: { sneak: false },
  family: 'greatermud',
  world: { byId: (id) => ROOMS.get(id), lairEntities: () => [] },
  lairOdds: () => run(0.9),
  roundSeconds: 5,
  stepMs: 1250,
  ...over
});

describe('the risk of running a route', () => {
  it('prices a hostile lair by the move against the round and its first round', () => {
    const risk = runRiskOf(ROUTE, parts());
    expect(risk.lairs).toEqual([
      { room: '17/4', name: '17/4', caught: 0.22, kills: expect.closeTo(0.1) }
    ]);
    expect(risk.death).toBeCloseTo(0.022);
  });

  it('prices a pack nobody has weighed as a full one', () => {
    const unread = parts({}, { inventory: EMPTY_CHARACTER.inventory });
    expect(runRiskOf(ROUTE, unread).lairs[0]!.caught).toBeCloseTo(0.62);
  });

  it('is unknown while the lair has not been run', () => {
    expect(runRiskOf(ROUTE, parts({ lairOdds: () => ({ kind: 'pending' }) })).death).toBeNull();
  });

  it('reads a lair the route carries no price for by its own fight, unknown until run', () => {
    const unpriced: Route = { ...ROUTE, steps: [step('17/3', '17/4', { lair: true })] };
    expect(runRiskOf(unpriced, parts()).death).toBeCloseTo(0.022);
    expect(runRiskOf(unpriced, parts({ lairOdds: () => ({ kind: 'unrun' }) })).death).toBeNull();
    expect(runRiskOf(unpriced, parts({ lairOdds: () => run(1) })).death).toBe(0);
  });

  it('sneaks past monsters that do not see hidden, and not past one that does', () => {
    const sheet = { progress: { ...EMPTY_CHARACTER.progress, stealthSkill: 100 } };
    const sneaking = parts({ movement: { sneak: true } }, sheet);
    expect(runRiskOf(ROUTE, sneaking).death).toBe(0);
    const seer = { abilities: [[57, 100]] } as unknown as MobEntity;
    const seen = parts(
      { movement: { sneak: true }, world: { ...sneaking.world, lairEntities: () => [seer] } },
      sheet
    );
    expect(runRiskOf(ROUTE, seen).death).toBeCloseTo(0.022);
  });
});
