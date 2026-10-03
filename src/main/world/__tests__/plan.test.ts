import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import type { FightOdds, NavigationOracle } from '../../../shared/navigation';
import type { Route, RouteStep } from '../../../shared/world';
import { plan, type PlanRealm } from '../navigation/plan';
import type { ItemSource } from '../navigation/sources';
import type { Traveller } from '../Router';
import { standing } from '../navigation/standing';
import { WorldGraph } from '../WorldGraph';

const step = (from: string, to: string): RouteStep =>
  ({ from, to, direction: 'n', command: 'n', name: to, requirement: null }) as RouteStep;
const way = (from: string, to: string): Route => ({
  steps: [step(from, to)],
  cost: 5,
  blocked: false
});
const shut: Route = { steps: [], cost: 0, blocked: true, reason: 'locked' };

/*
 * A door at the goal wants keys 1 and 2. Key 1 is sold in the open; key 2 is
 * dropped by a monster in a room behind key 1's door.
 */
const realm: PlanRealm = {
  route: (from, to, traveller: Traveller, options) => {
    const keys = traveller.keys ?? [];
    if (to === 'goal') {
      if (keys.includes(1) && keys.includes(2)) return way(from, to);
      return options?.unlocks === true
        ? {
            ...shut,
            unlocks: {
              ...way(from, to),
              needs: [
                { id: 2, name: 'iron key' },
                { id: 1, name: 'bone key' }
              ]
            }
          }
        : shut;
    }
    if (to === 'cave' && !keys.includes(1)) return shut;
    return way(from, to);
  },
  sweep(from, rooms, traveller) {
    const reached = new Map<string, { cost: number }>();
    for (const room of rooms) {
      const route = this.route(from, room, traveller);
      if (!route.blocked) reached.set(room, { cost: route.cost });
    }
    return reached;
  },
  sources: (item): ItemSource[] =>
    item === 1
      ? [{ kind: 'buy', room: 'shop' }]
      : item === 2
        ? [{ kind: 'kill', monster: 'troll', room: 'cave' }]
        : [],
  standing: () => [],
  roomName: (room) => room
};
const odds = (fight: FightOdds, purse: boolean | null = true): NavigationOracle => ({
  fight: () => fight,
  affords: () => purse
});
const nobody: Traveller = { keys: [], packKnown: true };

describe('a plan made whole before the first step', () => {
  it("fetches a key behind another key's door after the first", () => {
    const made = plan(realm, odds({ kind: 'win' }), 'here', 'goal', nobody);
    expect(made.kind).toBe('plan');
    const acts = made.kind === 'plan' ? made.steps.filter((s) => s.kind !== 'walk') : [];
    expect(acts).toEqual([
      { kind: 'buy', item: { id: 1, name: 'bone key' }, room: 'shop' },
      { kind: 'kill', item: { id: 2, name: 'iron key' }, monster: 'troll', room: 'cave' }
    ]);
  });

  it('names the fight it cannot win, and the purse it cannot pay', () => {
    expect(plan(realm, odds({ kind: 'lose', survives: 0.4 }), 'here', 'goal', nobody)).toEqual({
      kind: 'refused',
      refusals: [
        { kind: 'fight', item: { id: 2, name: 'iron key' }, monster: 'troll', survives: 0.4 }
      ]
    });
    const poor = plan(realm, odds({ kind: 'win' }, false), 'here', 'goal', nobody);
    expect(poor.kind === 'refused' && poor.refusals).toContainEqual({
      kind: 'purse',
      item: { id: 1, name: 'bone key' }
    });
  });

  it('waits on a fight the simulator has not finished', () => {
    const made = plan(realm, odds({ kind: 'unread' }), 'here', 'goal', nobody);
    expect(made.kind === 'refused' && made.refusals[0]).toMatchObject({
      kind: 'odds-unread',
      monster: 'troll'
    });
  });
});

/* The cases that sent soul the wrong way, on the realm that ships (2026-10-02). */
const file = path.resolve('resources/world/paradigm.jsonl.gz');
const graph = fs.existsSync(file) ? WorldGraph.load(file) : null;

describe.skipIf(graph === null)('the trainers soul was sent to, on the shipped realm', () => {
  const world = (): PlanRealm => ({
    route: (from, to, traveller, options) => graph!.route(from, to, traveller, options),
    sweep: (from, rooms, traveller) => graph!.sweepTo(from, rooms, traveller),
    sources: (item) => graph!.itemSources(item),
    standing: (room) => standing(graph!, room),
    roomName: (room) => graph!.byId(room)?.name ?? room
  });
  const soul = (): Traveller => ({
    level: 10,
    classId: graph!.classNamed('Mystic')?.id ?? null,
    raceId: graph!.raceId('Nekojin'),
    wealth: 5395,
    packKnown: true,
    keys: []
  });
  const losesTo = (beaten: readonly string[]): NavigationOracle => ({
    fight: (monster) =>
      beaten.includes(monster) ? { kind: 'lose', survives: 0.3 } : { kind: 'win' },
    affords: () => true
  });

  /* The Super Mystic Trainer: the iron and bone keys, and no ogre behind a one-way wall. */
  it("gets the Super Mystic Trainer's keys on the way, with no ogre", () => {
    const made = plan(world(), losesTo(['ogre']), '1/834', '1/2240', soul());
    expect(made.kind).toBe('plan');
    const kills =
      made.kind === 'plan' ? made.steps.flatMap((s) => (s.kind === 'kill' ? [s.monster] : [])) : [];
    expect(kills).not.toContain('ogre');
    expect(made.kind === 'plan' && made.steps.at(-1)).toMatchObject({ kind: 'walk' });
  });

  /* The Hydra Trainer wants the manscorpion king's key and the hydra dead. */
  it('refuses the Hydra Trainer by the manscorpion king, and plans the hydra when it can', () => {
    expect(plan(world(), losesTo(['manscorpion king']), '1/834', '12/2249', soul())).toMatchObject({
      kind: 'refused',
      refusals: [{ kind: 'fight', monster: 'manscorpion king', item: { name: 'hydra key' } }]
    });
    const made = plan(world(), losesTo([]), '1/834', '12/2249', soul());
    expect(made.kind === 'plan' && made.steps).toContainEqual(
      expect.objectContaining({ kind: 'clear', monsters: ['hydra'] })
    );
  });
});
