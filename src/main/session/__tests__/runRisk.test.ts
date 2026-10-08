import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import type { Odds, Survival } from '../../../shared/survival';
import type { Route, RouteStep, WorldRoom } from '../../../shared/world';
import { runRiskOf, type RunRiskParts } from '../runRisk';
import { chancesOf, withChances } from '../routeChances';

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

const run = (standing: number, survives = 0.5): Odds => ({
  kind: 'run',
  survival: {
    survives,
    horizons: [{ rounds: 1, standing, won: 0, lost: { least: 0, mean: 27, most: 223 } }]
  } as unknown as Survival
});

/** A lair monster that attacks on sight and follows on this often. */
const hostile = (follows?: number): MobEntity =>
  ({
    name: 'orc',
    disposition: 'hostile',
    ...(follows === undefined ? {} : { follows })
  }) as unknown as MobEntity;

/** An empty pack, weighed: GreaterMUD's 1100 ms step. */
const WEIGHED = { ...EMPTY_CHARACTER.inventory, encumbrance: 0, encumbranceMax: 1000 };

const parts = (
  over: Partial<RunRiskParts> = {},
  state: Partial<CharacterState> = {}
): RunRiskParts => ({
  state: { ...EMPTY_CHARACTER, inventory: WEIGHED, ...state },
  movement: { sneak: false },
  family: 'greatermud',
  world: { byId: (id) => ROOMS.get(id), lairEntities: () => [hostile(0)] },
  lairOdds: () => run(0.9),
  roundSeconds: 5,
  stepMs: 1250,
  ...over
});

/** A world whose one lair holds this monster. */
const holding = (mob: MobEntity): Partial<RunRiskParts> => ({
  world: { byId: (id) => ROOMS.get(id), lairEntities: () => [mob] }
});

describe('the risk of running a route', () => {
  it('prices a lair by the banked round a step in five seconds is caught for', () => {
    const risk = runRiskOf(ROUTE, parts());
    // 0.22 of a round, two rounds banked: 0.44 rounds of a fight that kills a tenth in one.
    expect(risk.lairs).toEqual([
      { room: '17/4', name: '17/4', rounds: expect.closeTo(0.44), death: expect.closeTo(0.044) }
    ]);
    expect(risk.death).toBeCloseTo(0.044);
  });

  it('prices a pack nobody has weighed as a full one', () => {
    const unread = parts({}, { inventory: EMPTY_CHARACTER.inventory });
    expect(runRiskOf(ROUTE, unread).lairs[0]!.rounds).toBeCloseTo(1.24);
  });

  it('counts the rooms a follower stays on, and an unread rate as following every move', () => {
    expect(runRiskOf(ROUTE, parts(holding(hostile(100)))).lairs[0]!.rounds).toBeCloseTo(1.76);
    expect(runRiskOf(ROUTE, parts(holding(hostile()))).lairs[0]!.rounds).toBeCloseTo(1.76);
  });

  it('takes a round each tick where the round is shorter than the step', () => {
    expect(runRiskOf(ROUTE, parts({ roundSeconds: 1 })).lairs[0]!.rounds).toBeCloseTo(2.1);
  });

  it('is unknown while the lair has not been run', () => {
    expect(runRiskOf(ROUTE, parts({ lairOdds: () => ({ kind: 'pending' }) })).death).toBeNull();
  });

  it('reads a lair the route carries no price for by its own fight, unknown until run', () => {
    const unpriced: Route = { ...ROUTE, steps: [step('17/3', '17/4', { lair: true })] };
    expect(runRiskOf(unpriced, parts()).death).toBeCloseTo(0.044);
    expect(runRiskOf(unpriced, parts({ lairOdds: () => ({ kind: 'unrun' }) })).death).toBeNull();
    expect(runRiskOf(unpriced, parts({ lairOdds: () => run(1) })).death).toBe(0);
  });

  it('sneaks past monsters that do not see hidden, and not past one that does', () => {
    const sheet = { progress: { ...EMPTY_CHARACTER.progress, stealthSkill: 100 } };
    const sneaking = parts({ movement: { sneak: true } }, sheet);
    expect(runRiskOf(ROUTE, sneaking).death).toBe(0);
    const seer = { ...hostile(0), abilities: [[57, 100]] } as unknown as MobEntity;
    const seen = parts({ movement: { sneak: true }, ...holding(seer) }, sheet);
    expect(runRiskOf(ROUTE, seen).death).toBeCloseTo(0.044);
  });
});

describe('a route’s chances, run and walked', () => {
  it('runs past and fights through every lair that attacks on sight', () => {
    expect(chancesOf(ROUTE, parts())).toEqual({
      run: expect.closeTo(0.956),
      walk: 0.5
    });
  });

  it('walks past a lair whose monsters do not attack on sight', () => {
    const polite = { name: 'trader', disposition: 'passive' } as unknown as MobEntity;
    expect(chancesOf(ROUTE, parts(holding(polite))).walk).toBe(1);
  });

  it('is unread while a fight has not run', () => {
    expect(chancesOf(ROUTE, parts({ lairOdds: () => ({ kind: 'pending' }) }))).toEqual({
      run: null,
      walk: null
    });
  });

  it('lays each way the panel can show with its own', () => {
    const bare: Route = { steps: [step('17/3', '17/5')], cost: 1, blocked: false } as Route;
    const laid = withChances(
      { ...ROUTE, otherWay: bare, keptOut: { words: ['vortex'], round: bare } },
      parts()
    );
    expect(laid.chances?.walk).toBe(0.5);
    expect(laid.otherWay?.chances).toEqual({ run: 1, walk: 1 });
    expect(laid.keptOut?.round.chances).toEqual({ run: 1, walk: 1 });
  });
});
