import { describe, expect, it } from 'vitest';

import {
  areasOf,
  areaWord,
  factsOf,
  forksOf,
  healthAlong,
  runDeathAlong,
  waysOf,
  wayRoute
} from '../routeViews';
import { lairGrade } from '../route';
import type { Route, RouteStep } from '@shared/world';

let room = 0;
const step = (name: string, over: Partial<RouteStep> = {}): RouteStep => {
  room += 1;
  return {
    from: `1/${room}`,
    to: `1/${room + 1}`,
    direction: 'e',
    command: 'e',
    name,
    requirement: null,
    dark: false,
    ...over
  };
};
const route = (steps: RouteStep[], over: Partial<Route> = {}): Route => ({
  steps,
  cost: steps.length,
  blocked: false,
  ...over
});

describe('a room name says where it is', () => {
  it('reads the part before the comma, and leaves a corner to its street', () => {
    expect(areaWord('Darkwood Forest, Main Road')).toBe('Darkwood Forest');
    expect(areaWord('Silver Street')).toBe('Silver Street');
    expect(areaWord('Intersection of Silver St. & Brass St.')).toBeNull();
  });
});

/*
 * Temple Healer to the Refuse Pit on Paradigm, in the shape its names take: a
 * square between two streets, a gate, a forest, a cave.
 */
describe('a way split into legs by area', () => {
  const names = [
    'Sovereign Street, Northern End',
    'Town Square',
    'Silver Street',
    'Intersection of Silver St. & Brass St.',
    'Silver Street',
    'Silver Street',
    'Silver Street, Eastern End',
    'Town Gates',
    'Main Road, Silvermere Gates',
    'Main Road',
    'Main Road',
    'Main Road, Forest Entry',
    'Darkwood Forest, Main Road',
    'Darkwood Forest',
    'Darkwood Forest',
    'Huge Cave, Entrance',
    'Huge Cave, Tunnel',
    'Huge Cave, Refuse Pit'
  ];
  const legs = areasOf(names.map((name) => step(name)));

  it('makes a leg of each area, a square and a gate joining the street beside them', () => {
    expect(legs.map((leg) => leg.name)).toEqual([
      'Silver Street',
      'Main Road',
      'Darkwood Forest',
      'Huge Cave'
    ]);
  });

  it('covers every step once, in order', () => {
    expect(legs[0]!.from).toBe(0);
    legs.slice(1).forEach((leg, index) => expect(leg.from).toBe(legs[index]!.to + 1));
    expect(legs.at(-1)!.to).toBe(names.length - 1);
  });
});

describe('what a leg holds', () => {
  it('counts the lairs and names the worst, the room spells and each gate', () => {
    const facts = factsOf([
      step('Main Road', { lair: true, danger: 0.08 }),
      step('Main Road', { lair: true, danger: 0.49 }),
      step('Main Road', { hazard: 0.02 }),
      step('Main Road', {
        requirement: { kind: 'toll', raw: 'Toll: 5' } as RouteStep['requirement'],
        obstacle: { label: 'toll 5 gold' } as RouteStep['obstacle']
      }),
      step('Main Road', { direction: 'se', command: 'se' })
    ]);
    expect(facts).toMatchObject({
      lairs: 2,
      worst: 0.49,
      deadly: false,
      spells: 1,
      gates: ['toll 5 gold'],
      heading: 'e'
    });
  });
});

describe('where another way leaves this one', () => {
  const shared = [step('Bank of Godfrey'), step('Silver Street'), step('Town Gates')];
  const ours = [step('Main Road'), step('Main Road'), step('Main Road')];
  const theirs = [
    step('Dark Alley'),
    step('Sewer Tunnel', {
      requirement: { kind: 'text', raw: 'go manhole' } as RouteStep['requirement']
    }),
    step('Underground Tunnel'),
    step('Grassy Cart Path'),
    step('Grassy Cart Path'),
    step('Grassy Cart Path')
  ];
  const end = [step('Darkwood Forest'), step('Darkwood Forest')];
  const plan = route([...shared, ...ours, ...end]);
  const other = route([...shared, ...theirs, ...end]);

  it('finds the stretch it walks instead, between two rooms both walk', () => {
    const forks = forksOf(plan, 'another', other);
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ way: 'another', from: 3, to: 5 });
    expect(forks[0]!.theirs.map((one) => one.name)).toEqual(theirs.map((one) => one.name));
  });

  it('leaves out a detour of a room or two through nothing different', () => {
    const corner = route([...shared, step('Main Road'), ...end]);
    expect(forksOf(plan, 'another', corner)).toEqual([]);
  });
});

describe('the ways the panel can show', () => {
  it('lists the plan first and every walkable way once', () => {
    const direct = route([step('Direct')]);
    const blocked = route([step('Shut')], { blocked: true });
    const plan = route([step('Plan')], { direct, otherWay: blocked });
    expect(waysOf(plan).map(({ way }) => way)).toEqual(['plan', 'direct']);
    expect(wayRoute(plan, 'direct')).toBe(direct);
    expect(wayRoute(plan, 'another')).toBe(plan);
  });
});

describe('the health a way is expected to leave', () => {
  const steps = [
    step('Darkwood Forest', { hazard: 0.02 }),
    step('Crystal Lake', { lair: true, danger: 0.6, runDeath: 0.1 }),
    step('Crystal Lake', { lair: true, danger: 0.6, runDeath: 0.1 }),
    step('Crystal Lake', { lair: true, danger: 1.7, runDeath: 0.2 })
  ];

  it('walking, takes each lair and rests to full under half', () => {
    const walking = healthAlong(steps, false);
    expect(walking.map((point) => Math.round(point.share * 100))).toEqual([98, 38, 40, -70]);
    expect(walking.map((point) => point.rested)).toEqual([false, false, true, true]);
  });

  it('running, takes only the room spells, and adds up the chance of dying', () => {
    expect(healthAlong(steps, true).map((point) => Math.round(point.share * 100))).toEqual([
      98, 98, 98, 98
    ]);
    const dying = runDeathAlong(steps);
    expect(Math.round(dying.chance * 1000)).toBe(352);
    expect(dying.unweighed).toBe(0);
  });

  it('counts a lair with no run figure as not weighed, never as a safe pass', () => {
    const dying = runDeathAlong([...steps, step('Huge Cave', { lair: true })]);
    expect(Math.round(dying.chance * 1000)).toBe(352);
    expect(dying.unweighed).toBe(1);
  });
});

describe('how a lair is graded', () => {
  it('is deadly only where main said so, and unknown where nothing was weighed', () => {
    expect(lairGrade(step('Crystal Lake', { lair: true, danger: 1.7 }))).toBe('heavy');
    expect(lairGrade(step('Crystal Lake', { lair: true, danger: 1.7, deadly: true }))).toBe(
      'deadly'
    );
    expect(lairGrade(step('Main Road', { lair: true, danger: 0.08 }))).toBe('light');
    expect(lairGrade(step('Huge Cave', { lair: true, lairUnweighed: true }))).toBeNull();
  });

  it('keeps a lair nobody weighed out of the worst and in its own count', () => {
    const facts = factsOf([
      step('Huge Cave', { lair: true, lairUnweighed: true }),
      // Priced for the run past it, with no figure for the fight.
      step('Huge Cave', { lair: true, runDeath: 0.1 })
    ]);
    expect(facts).toMatchObject({ lairs: 0, unweighed: 2, worst: null });
  });

  it('counts rooms of wanderers nobody fought beside the run chance', () => {
    expect(runDeathAlong([step('Road', { wanderersUnweighed: true })])).toEqual({
      chance: 0,
      unweighed: 0,
      wanderers: 1
    });
  });
});
