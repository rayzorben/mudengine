import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type Adventurer, type CharacterState } from '../../../shared/character';
import type { Alignment } from '../../../shared/alignment';
import type { MobEntity } from '../../../shared/entities';
import type { Odds, Survival } from '../../../shared/survival';
import { roomId, type Route, type RouteStep, type WorldRoom } from '../../../shared/world';
import type { Traveller } from '../../world/Router';
import { WorldGraph } from '../../world/WorldGraph';
import { lairRunner, runRiskOf, type RunRiskParts } from '../runRisk';
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
  ['17/5', { ...room('17/5'), wanderers: [6, 10] }]
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

/** A world whose one lair holds these, and whose 17/5 group may put these in it. */
const world = (lair: MobEntity[], wanderers: MobEntity[] = []): RunRiskParts['world'] => ({
  byId: (id) => ROOMS.get(id),
  lairEntities: () => lair,
  wandererEntities: (at) => (at.room === 5 ? wanderers : [])
});

const parts = (
  over: Partial<RunRiskParts> = {},
  state: Partial<CharacterState> = {}
): RunRiskParts => ({
  state: { ...EMPTY_CHARACTER, inventory: WEIGHED, ...state },
  movement: { sneak: false },
  family: 'greatermud',
  world: world([hostile(0)]),
  lairOdds: () => run(0.9),
  passOdds: () => run(0.9),
  mobOdds: () => run(0.9),
  roundSeconds: 5,
  stepMs: 1250,
  ...over
});

/** A world whose one lair holds this monster. */
const holding = (mob: MobEntity): Partial<RunRiskParts> => ({ world: world([mob]) });

/** A world whose 17/5 group may put these in it as the character walks in. */
const wandering = (...mobs: MobEntity[]): Partial<RunRiskParts> => ({
  world: world([hostile(0)], mobs)
});

const named = (name: string, mob: MobEntity = hostile(0)): MobEntity => ({ ...mob, name });

/** A Temple Street guard: it attacks an Evil character on sight and leaves the rest alone. */
const guard = (name = 'guardsman'): MobEntity =>
  ({ ...hostile(0), name, disposition: 'hates-evil' }) as unknown as MobEntity;

/** The character on the who list at this standing; null where it has not been listed. */
const standing = (alignment: Alignment | null): Partial<CharacterState> =>
  alignment === null
    ? { name: 'Rayzor' }
    : { name: 'Rayzor', online: [{ name: 'Rayzor', alignment } as Adventurer] };

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
    expect(runRiskOf(ROUTE, parts({ passOdds: () => ({ kind: 'pending' }) })).death).toBeNull();
  });

  it('reads a lair the route carries no price for by its own fight, unknown until run', () => {
    const unpriced: Route = { ...ROUTE, steps: [step('17/3', '17/4', { lair: true })] };
    expect(runRiskOf(unpriced, parts()).death).toBeCloseTo(0.044);
    expect(runRiskOf(unpriced, parts({ passOdds: () => ({ kind: 'unrun' }) })).death).toBeNull();
    expect(runRiskOf(unpriced, parts({ passOdds: () => run(1) })).death).toBe(0);
  });

  /*
   * Todo 31: Rayzor, Good, routed 41 steps round the Temple Street guards
   * (all `hates-evil`), priced off a hunt in which he strikes them and they
   * fight back. Walking past, nobody is struck.
   */
  it('runs past a lair whose monsters all wait to be struck for nothing', () => {
    const guards = { world: world([guard(), guard('templar')]) };
    const good = runRiskOf(ROUTE, parts(guards, standing('Good')));
    expect(good).toEqual({
      death: 0,
      lairs: [{ room: '17/4', name: '17/4', rounds: 0, death: 0 }]
    });
    // The same lair for a Villain, and for a character not yet listed, is priced.
    expect(runRiskOf(ROUTE, parts(guards, standing('Villain'))).death).toBeCloseTo(0.044);
    expect(runRiskOf(ROUTE, parts(guards, standing(null))).death).toBeCloseTo(0.044);
  });

  it('reads a lair where some wait off its pass', () => {
    const mixed = { world: world([guard(), hostile(0)]), lairOdds: () => run(0.1) };
    expect(runRiskOf(ROUTE, parts(mixed, standing('Good'))).death).toBeCloseTo(0.044);
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

describe('the risk of running past a room’s wanderers', () => {
  // One pass is 0.44 rounds (see above); a wanderer's fight kills a tenth in one round.
  const lair = 0.044;

  it('prices each of the group’s rows at its share of the one draw a pass', () => {
    const risk = runRiskOf(ROUTE, parts(wandering(named('thug'), named('orc rogue'))));
    expect(risk.lairs[1]).toEqual({
      room: '17/5',
      name: '17/5',
      rounds: expect.closeTo(0.044),
      death: expect.closeTo(0.1 * lair)
    });
    expect(risk.death).toBeCloseTo(1 - (1 - lair) * (1 - 0.1 * lair));
  });

  it('counts the rooms a wanderer follows on', () => {
    const follower = runRiskOf(ROUTE, parts(wandering(named('thug', hostile(100)))));
    expect(follower.lairs[1]!.rounds).toBeCloseTo(0.176);
  });

  it('prices a wanderer that waits to be struck at nothing', () => {
    const polite = { name: 'trader', disposition: 'passive' } as unknown as MobEntity;
    expect(runRiskOf(ROUTE, parts(wandering(polite))).lairs[1]).toMatchObject({
      rounds: 0,
      death: 0
    });
  });

  it('is unknown while a wanderer’s fight has not run', () => {
    const pending = parts({ ...wandering(named('thug')), mobOdds: () => ({ kind: 'pending' }) });
    expect(runRiskOf(ROUTE, pending).death).toBeNull();
  });

  it('leaves a room whose rows the realm file lacks unpriced, never safe', () => {
    expect(runRiskOf(ROUTE, parts()).lairs).toHaveLength(1);
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

  it('fights a wanderer at its chance', () => {
    const walk = chancesOf(ROUTE, parts({ ...wandering(named('thug')), mobOdds: () => run(0.9) }));
    expect(walk.walk).toBeCloseTo(0.5 * (1 - 0.1 * 0.5));
  });

  it('is unread while a fight has not run', () => {
    const pending = (): Odds => ({ kind: 'pending' });
    expect(chancesOf(ROUTE, parts({ lairOdds: pending, passOdds: pending }))).toEqual({
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

const REALM = path.resolve('resources/world/paradigm.jsonl.gz');
const paradigm = fs.existsSync(REALM) ? WorldGraph.load(REALM) : null;

/*
 * Todo 31, on the shipped realm: Rayzor at the Bank of Godfrey asked for the
 * Temple Spell Store, n, 6w, s past the Temple Street guards, and was routed
 * 41 steps round them. Every lair's pass here is one fight, so only which of
 * its monsters attack on sight decides the way.
 */
describe.skipIf(paradigm === null)('the way past the Temple Street guards', () => {
  const routeAs = (alignment: Alignment): Route => {
    const runner = lairRunner(
      parts({ world: paradigm!, passOdds: () => run(0.7) }, standing(alignment))
    );
    const traveller: Traveller = {
      keys: [],
      packKnown: true,
      runDeath: (room, from) => runner(room, from)?.death ?? null
    };
    return paradigm!.route(roomId(1, 297), roomId(1, 522), traveller);
  };

  it('walks a Good character the plain eight steps', () => {
    expect(routeAs('Good').steps.map((each) => each.direction)).toEqual([
      'n',
      'w',
      'w',
      'w',
      'w',
      'w',
      'w',
      's'
    ]);
  });

  it('takes a Villain round them', () => {
    expect(routeAs('Villain').steps.length).toBeGreaterThan(8);
  });
});
