import { describe, expect, it } from 'vitest';

import { loopFor, notableSteps, pickRoom, shapeOf, suggestedName } from '../builder';
import type { LoopDraft, RouteStep } from '@shared/world';

const step = (over: Partial<RouteStep> = {}): RouteStep => ({
  from: '1/1',
  to: '1/2',
  direction: 'n',
  command: 'n',
  name: 'Somewhere',
  requirement: null,
  dark: false,
  ...over
});

const draftOf = (
  waypoints: Array<[string, string]>,
  legs: Array<{ from: string; to: string; blocked?: boolean; steps?: RouteStep[] }>
): LoopDraft => ({
  path: [],
  waypoints: waypoints.map(([id, name]) => ({ id, name })),
  legs: legs.map((leg) => ({
    from: leg.from,
    to: leg.to,
    route: { steps: leg.steps ?? [step()], cost: 1, blocked: leg.blocked ?? false }
  }))
});

describe('clicking a room', () => {
  it('makes the first room the start', () => {
    expect(pickRoom([], '1/1')).toEqual(['1/1']);
  });

  it('unpicks the start when it is clicked again with nothing else picked', () => {
    expect(pickRoom(['1/1'], '1/1')).toEqual([]);
  });

  it('adds any other room as the next pick', () => {
    expect(pickRoom(['1/1'], '1/2')).toEqual(['1/1', '1/2']);
  });

  it('closes the loop when the start is clicked with picks behind it', () => {
    expect(pickRoom(['1/1', '1/2'], '1/1')).toEqual(['1/1', '1/2', '1/1']);
  });

  /* A leg from a room to itself is no steps; recording it would be an undo
     that appears to do nothing. */
  it('changes nothing when the last pick is clicked again', () => {
    expect(pickRoom(['1/1', '1/2'], '1/2')).toBeNull();
  });
});

describe('what the picks add up to', () => {
  it('is empty, then a start, then a route', () => {
    expect(shapeOf([])).toBe('empty');
    expect(shapeOf(['1/1'])).toBe('start');
    expect(shapeOf(['1/1', '1/2'])).toBe('route');
    expect(shapeOf(['1/1', '1/2', '1/3'])).toBe('route');
  });

  it('is a loop when the way ends where it began', () => {
    expect(shapeOf(['1/1', '1/2', '1/1'])).toBe('loop');
    expect(shapeOf(['1/1', '1/2', '1/3', '1/1'])).toBe('loop');
  });
});

describe('the loop a draft saves as', () => {
  it('is nothing while there is only a start', () => {
    expect(loopFor(draftOf([['1/1', 'A']], []), ['1/1'], 'x', true)).toBeNull();
  });

  it('is a preferred there-and-back for a route, with both ends and the coordinates', () => {
    const draft = draftOf(
      [
        ['1/1', 'Town Gates'],
        ['1/9', 'Bank']
      ],
      [{ from: '1/1', to: '1/9' }]
    );
    expect(loopFor(draft, ['1/1', '1/9'], 'To the bank', true)).toEqual({
      name: 'To the bank',
      bounce: true,
      prefer: true,
      stops: [{ room: 'Town Gates 1/1' }, { room: 'Bank 1/9' }]
    });
  });

  it('drops the closing waypoint of a loop, because the runner wraps', () => {
    const draft = draftOf(
      [
        ['1/1', 'A'],
        ['1/5', 'B'],
        ['1/1', 'A']
      ],
      [
        { from: '1/1', to: '1/5' },
        { from: '1/5', to: '1/1' }
      ]
    );
    expect(loopFor(draft, ['1/1', '1/5', '1/1'], 'Round', false)).toEqual({
      name: 'Round',
      stops: [{ room: 'A 1/1' }, { room: 'B 1/5' }]
    });
    // And preferred when the player leaves the toggle on.
    expect(loopFor(draft, ['1/1', '1/5', '1/1'], 'Round', true)).toMatchObject({ prefer: true });
  });

  it('refuses a draft with a blocked leg', () => {
    const draft = draftOf(
      [
        ['1/1', 'A'],
        ['1/2', 'B']
      ],
      [
        { from: '1/1', to: '1/2' },
        { from: '1/2', to: '1/3', blocked: true }
      ]
    );
    expect(loopFor(draft, ['1/1', '1/2', '1/3'], 'x', true)).toBeNull();
  });

  /* The draft is asked for on every pick and arrives later; a save between
     the two would write the previous picks under the new name. */
  it('refuses a draft that is behind the picks', () => {
    const draft = draftOf([['1/1', 'A']], []);
    expect(loopFor(draft, ['1/1', '1/2'], 'x', true)).toBeNull();
  });

  it('refuses a blank name', () => {
    const draft = draftOf(
      [
        ['1/1', 'A'],
        ['1/2', 'B']
      ],
      [{ from: '1/1', to: '1/2' }]
    );
    expect(loopFor(draft, ['1/1', '1/2'], '  ', true)).toBeNull();
  });
});

describe('the name offered', () => {
  const join = (a: string, b: string) => `${a} to ${b}`;
  const round = (a: string) => `Round ${a}`;

  it('names a route by its ends', () => {
    const draft = draftOf(
      [
        ['1/1', 'Gates'],
        ['1/2', 'Bank']
      ],
      [{ from: '1/1', to: '1/2' }]
    );
    expect(suggestedName(draft, ['1/1', '1/2'], join, round)).toBe('Gates to Bank');
  });

  it('names a loop by where it goes round from', () => {
    const draft = draftOf(
      [
        ['1/1', 'Gates'],
        ['1/2', 'Bank'],
        ['1/1', 'Gates']
      ],
      [
        { from: '1/1', to: '1/2' },
        { from: '1/2', to: '1/1' }
      ]
    );
    expect(suggestedName(draft, ['1/1', '1/2', '1/1'], join, round)).toBe('Round Gates');
  });

  it('offers nothing for a start alone', () => {
    expect(suggestedName(draftOf([['1/1', 'A']], []), ['1/1'], join, round)).toBe('');
  });
});

describe('the steps worth listing', () => {
  it('leaves a plain compass step out', () => {
    expect(notableSteps([step(), step({ command: 'ne', direction: 'ne' })])).toEqual([]);
  });

  it('keeps a gated step, a phrase and a portal, with its place in the leg', () => {
    const gated = step({ requirement: { kind: 'door', raw: 'Door' } });
    const phrase = step({ command: 'go vortex' });
    const portal = step({ direction: 'portal', command: 'teleport' });
    expect(notableSteps([step(), gated, phrase, portal])).toEqual([
      { at: 2, step: gated },
      { at: 3, step: phrase },
      { at: 4, step: portal }
    ]);
  });
});
