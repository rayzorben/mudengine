import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import type { NavigationOracle } from '../../../shared/navigation';
import type { FightOdds, Route, RouteStep } from '../../../shared/world';
import { leg, plan, type PlanRealm } from '../navigation/plan';
import type { ItemSource } from '../navigation/sources';
import type { Traveller } from '../Router';
import { planRealmOf } from '../navigation/realm';
import { WorldGraph } from '../WorldGraph';

const step = (from: string, to: string, key?: number): RouteStep =>
  ({
    from,
    to,
    direction: 'n',
    command: 'n',
    name: to,
    requirement: key === undefined ? null : { kind: 'key', raw: `Key: ${key}`, keyId: key }
  }) as RouteStep;
const way = (from: string, to: string): Route => ({
  steps: [step(from, to)],
  cost: 5,
  blocked: false
});
/* The router's refusal at a keyed door: the door, and the key it names. */
const shut: Route = {
  steps: [],
  cost: 0,
  blocked: true,
  reason: 'locked',
  blocks: [{ kind: 'key', at: 'hall', to: 'goal', name: 'goal', keyId: 1, itemName: 'bone key' }]
};
const KEYS: Record<number, string> = { 1: 'bone key', 2: 'iron key' };

/*
 * A door at the goal wants keys 1 and 2. Key 1 is sold in the open; key 2 is
 * dropped by a monster in a room behind key 1's door.
 */
const realm: PlanRealm = {
  route: (from, to, traveller: Traveller) => {
    const keys = traveller.keys ?? [];
    if (to === 'goal') {
      if (!keys.includes(1) || !keys.includes(2)) return shut;
      return { steps: [step(from, 'hall', 2), step('hall', to, 1)], cost: 10, blocked: false };
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
  roomName: (room) => room,
  keysNamed: () => [1, 2],
  itemName: (item) => KEYS[item]
};
const odds = (fight: FightOdds, purse: boolean | null = true): NavigationOracle => ({
  fight: () => fight,
  affords: () => purse
});
const nobody: Traveller = { keys: [], packKnown: true };
const WON: FightOdds = { kind: 'win', survives: 0.99 };

describe('a plan made whole before the first step', () => {
  it("fetches a key behind another key's door after the first", () => {
    const made = plan(realm, odds(WON), 'here', 'goal', nobody);
    expect(made.kind).toBe('plan');
    const acts = made.kind === 'plan' ? made.steps.filter((s) => s.kind !== 'walk') : [];
    expect(acts).toEqual([
      { kind: 'buy', item: { id: 1, name: 'bone key' }, room: 'shop' },
      {
        kind: 'kill',
        item: { id: 2, name: 'iron key' },
        monster: 'troll',
        room: 'cave',
        roomName: 'cave',
        odds: WON
      }
    ]);
  });

  /*
   * Survival never refuses a plan (the user, 2026-10-03): a fight the
   * character would lose, or one not worked out yet, is planned with its odds
   * on the step, and whether to go is the player's.
   */
  it('plans a fight it would lose, carrying the odds, and names the purse it cannot pay', () => {
    const lose: FightOdds = { kind: 'lose', survives: 0.4 };
    const made = plan(realm, odds(lose), 'here', 'goal', nobody);
    expect(made.kind === 'plan' && made.steps).toContainEqual(
      expect.objectContaining({ kind: 'kill', monster: 'troll', odds: lose })
    );
    const poor = plan(realm, odds(WON, false), 'here', 'goal', nobody);
    expect(poor.kind === 'refused' && poor.refusals).toContainEqual({
      kind: 'purse',
      item: { id: 1, name: 'bone key' }
    });
  });

  it('plans a fight the simulator has not finished, marked unread', () => {
    const made = plan(realm, odds({ kind: 'unread' }), 'here', 'goal', nobody);
    expect(made.kind === 'plan' && made.steps).toContainEqual(
      expect.objectContaining({ kind: 'kill', odds: { kind: 'unread' } })
    );
  });

  /* A source whose fight opens comes before a nearer one whose does not. */
  it('takes the winnable source over a nearer losing one', () => {
    const two: PlanRealm = {
      ...realm,
      sources: (item): readonly ItemSource[] =>
        item === 2
          ? [
              { kind: 'kill', monster: 'ogre', room: 'cave' },
              { kind: 'kill', monster: 'troll', room: 'far' }
            ]
          : realm.sources(item),
      sweep: (_from, rooms) =>
        new Map([...rooms].map((room) => [room, { cost: room === 'far' ? 50 : 5 }]))
    };
    const ogreLoses: NavigationOracle = {
      fight: (monster) => (monster === 'ogre' ? { kind: 'lose', survives: 0.2 } : WON),
      affords: () => true
    };
    const made = plan(two, ogreLoses, 'here', 'goal', nobody);
    expect(made.kind === 'plan' && made.steps).toContainEqual(
      expect.objectContaining({ kind: 'kill', monster: 'troll' })
    );
  });
});

describe('a walk with what is held now', () => {
  it("is the router's own route where nothing is fetched", () => {
    const asked: Array<boolean | undefined> = [];
    const direct = way('here', 'shop');
    const watched: PlanRealm = {
      ...realm,
      route: (from, to, traveller, options) => {
        asked.push(options?.alternatives);
        return to === 'shop' ? direct : realm.route(from, to, traveller, options);
      }
    };
    expect(leg(watched, odds(WON), 'here', 'shop', nobody, { alternatives: true })).toBe(direct);
    // One search: the planned walk is the direct route, not asked twice.
    expect(asked).toEqual([true]);
  });

  it('is refused where keys come first, carrying the planned way, its keys and its fights', () => {
    const walked = leg(realm, odds(WON), 'here', 'goal', nobody);
    expect(walked).toMatchObject({ blocked: true, steps: [], reason: 'locked' });
    expect(walked.unlocks?.needs).toEqual([
      { id: 1, name: 'bone key' },
      { id: 2, name: 'iron key' }
    ]);
    expect(walked.unlocks?.fights).toEqual([
      { monsters: ['troll'], roomName: 'cave', item: 'iron key', odds: WON }
    ]);
  });

  it('carries a losing fight on the keyed way rather than refusing it', () => {
    const lose: FightOdds = { kind: 'lose', survives: 0.4 };
    const walked = leg(realm, odds(lose), 'here', 'goal', nobody);
    expect(walked.unlocks?.fights?.[0]?.odds).toEqual(lose);
  });

  it('walks into a room that wants emptying, won or lost, carrying the fight there', () => {
    const emptied: Route = {
      steps: [
        {
          ...step('pit', 'tunnel'),
          requirement: { kind: 'text', raw: 'go tunnel', gates: [{ kind: 'empty-room' }] }
        } as RouteStep
      ],
      cost: 5,
      blocked: false
    };
    const pit: PlanRealm = { ...realm, route: () => emptied, standing: () => ['hydra'] };
    const lose: FightOdds = { kind: 'lose', survives: 0.1 };
    for (const fight of [WON, lose]) {
      const walked = leg(pit, odds(fight), 'pit', 'tunnel', nobody);
      expect(walked).toMatchObject({ blocked: false, steps: emptied.steps });
      expect(walked.fights).toEqual([
        { monsters: ['hydra'], roomName: 'pit', item: null, odds: fight }
      ]);
    }
  });
});

/* The cases that sent soul the wrong way, on the realm that ships (2026-10-02). */
const file = path.resolve('resources/world/paradigm.jsonl.gz');
const graph = fs.existsSync(file) ? WorldGraph.load(file) : null;

describe.skipIf(graph === null)('the trainers soul was sent to, on the shipped realm', () => {
  const world = (): PlanRealm => planRealmOf(graph!);
  const soul = (): Traveller => ({
    level: 10,
    classId: graph!.classNamed('Mystic')?.id ?? null,
    raceId: graph!.raceId('Nekojin'),
    wealth: 5395,
    packKnown: true,
    keys: []
  });
  const losesTo = (beaten: readonly string[]): NavigationOracle => ({
    fight: (monster) => (beaten.includes(monster) ? { kind: 'lose', survives: 0.3 } : WON),
    affords: () => true
  });

  /* The Super Mystic Trainer: the iron and bone keys, and no ogre behind a one-way wall. */
  /*
   * The reported failure (2026-10-03): a naked level 10 Soul was told no
   * trainer is reached, because every key's dropper was a fight below 95%.
   * The plan is made whatever the odds, and carries them.
   */
  it('plans the Super Mystic Trainer when every fight on the way would be lost', () => {
    const naked: NavigationOracle = {
      fight: () => ({ kind: 'lose', survives: 0.4 }),
      affords: () => true
    };
    const made = plan(world(), naked, '1/520', '1/2240', soul());
    expect(made.kind).toBe('plan');
    const kills = made.kind === 'plan' ? made.steps.filter((s) => s.kind === 'kill') : [];
    expect(kills.length).toBeGreaterThan(0);
    expect(kills.every((s) => s.kind === 'kill' && s.odds.kind === 'lose')).toBe(true);
  });

  it("gets the Super Mystic Trainer's keys on the way, with no ogre", () => {
    const made = plan(world(), losesTo(['ogre']), '1/834', '1/2240', soul());
    expect(made.kind).toBe('plan');
    const kills =
      made.kind === 'plan' ? made.steps.flatMap((s) => (s.kind === 'kill' ? [s.monster] : [])) : [];
    expect(kills).not.toContain('ogre');
    expect(made.kind === 'plan' && made.steps.at(-1)).toMatchObject({ kind: 'walk' });
  });

  /*
   * The Amethyst Cave (todo 02, 2026-09-15): the potion of levitation is the
   * only way into the Catacombs, the fork opens their doors, and the rod is
   * Morukai's, inside them, so it comes last.
   */
  it('gets the three things the Amethyst Cave wants, the rod from inside last', () => {
    const able: Traveller = { ...soul(), level: 40, strength: 60, pickSkill: 60, wealth: 1e7 };
    const made = plan(world(), losesTo([]), '1/834', '9/1431', able);
    const fetched =
      made.kind === 'plan'
        ? made.steps.flatMap((s) => (s.kind === 'ask' ? [s.item.name] : []))
        : [];
    expect(fetched).toHaveLength(3);
    expect(fetched.slice(0, 2).sort()).toEqual(['potion of levitation', 'titanium fork']);
    expect(fetched[2]).toBe('magical quartz rod');
  });

  /* The Hydra Trainer wants the manscorpion king's key and the hydra dead. */
  it('plans the Hydra Trainer through the manscorpion king, with the odds, and the hydra', () => {
    const lost = plan(world(), losesTo(['manscorpion king']), '1/834', '12/2249', soul());
    expect(lost.kind === 'plan' && lost.steps).toContainEqual(
      expect.objectContaining({
        kind: 'kill',
        monster: 'manscorpion king',
        odds: { kind: 'lose', survives: 0.3 }
      })
    );
    const made = plan(world(), losesTo([]), '1/834', '12/2249', soul());
    expect(made.kind === 'plan' && made.steps).toContainEqual(
      expect.objectContaining({ kind: 'clear', monsters: ['hydra'] })
    );
  });
});
