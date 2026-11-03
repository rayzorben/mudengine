import { describe, expect, it, vi } from 'vitest';

import { t } from '../../../app/i18n';
import { EMPTY_CHARACTER, type CharacterState } from '../../../../shared/character';
import type { Route } from '../../../../shared/world';
import { at, moves, routeOf, stepOf, useRigs } from './walking';

/*
 * A way whose landing the world database names and the server puts somewhere else
 * (todo 20261103-0045-01): orohost's `dig grave` landed in 1/9478, a Musty
 * Grottos 44 rooms share a name with, where gmud.zip's spell 5078 names
 * 1/9462. Each test is red under the mutation named beside it.
 */

const walkerOn = useRigs();

/** `dig grave` out of 1/1, which the world database lands in 1/2 on half the tries. */
const DIG: Route = routeOf(
  stepOf(1, 2, 'e', {
    direction: 'portal',
    command: 'dig grave',
    name: 'Musty Grottos, Portal',
    requirement: {
      kind: 'text',
      raw: 'dig grave',
      gates: [{ kind: 'carry', item: 1415, name: 'shovel' }],
      tries: 2
    }
  })
);

/** On from the room the server gives: one step north to the old destination. */
const ONWARD: Route = routeOf(stepOf(9, 2, 'n', { name: 'Musty Grottos, Portal' }));

/** A room block the client cannot place: named, and `rooms` rooms share it. */
const unplaced = (rooms: number): CharacterState =>
  at(null, null, { room: { ...structuredClone(EMPTY_CHARACTER.room), ambiguous: rooms } });

describe('a landing the client cannot place', () => {
  // Mutant: `Landings.ask` for a draw only, as before the fix, so the walk stops ambiguous.
  it('asks rm once and walks on from the room the server gives', () => {
    let asks = 0;
    const replans: string[] = [];
    const { walker, sent, notices } = walkerOn({
      stateNow: () => at(1, 1),
      locate: () => {
        asks += 1;
      },
      replan: (to) => {
        replans.push(to);
        return ONWARD;
      }
    });
    walker.start(DIG, at(1, 1));
    vi.advanceTimersByTime(50);
    expect(moves(sent)).toEqual(['dig grave']);

    walker.onCharacter(unplaced(44));
    expect(asks).toBe(1);
    expect(walker.progress.status).toBe('walking');
    expect(notices).toContain(t('automation.walk.landingUnplaced', { command: 'dig grave' }));
    // A status line before the answer neither asks again nor stops.
    walker.onCharacter(unplaced(44));
    expect(asks).toBe(1);
    expect(walker.progress.status).toBe('walking');

    // `rm` answers: not the room the world database names.
    const located = at(1, 9, {
      room: { ...structuredClone(EMPTY_CHARACTER.room), map: 1, number: 9, name: 'Musty Grottos' }
    });
    walker.onCharacter(located);
    vi.advanceTimersByTime(2_000);
    expect(replans).toEqual(['1/2']);
    expect(walker.progress.status).toBe('walking');
    expect(moves(sent).at(-1)).toBe('n');
    expect(notices).toContain(
      t('automation.walk.landedElsewhere', {
        command: 'dig grave',
        stepName: 'Musty Grottos, Portal',
        roomName: 'Musty Grottos'
      })
    );
  });

  // Positive control for the ask: a plain step into a room 44 share stops as before.
  it('stops a plain step into a room several share, as before', () => {
    let asks = 0;
    const { walker } = walkerOn({
      stateNow: () => at(1, 1),
      locate: () => {
        asks += 1;
      }
    });
    walker.start(routeOf(stepOf(1, 2, 'e')), at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(unplaced(44));
    expect(asks).toBe(0);
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(t('automation.walk.reasonAmbiguous'));
  });
});

describe('a portal the client cannot place', () => {
  // Mutant: `movesByScript` without the portal, so the walk stops ambiguous unasked.
  it('asks rm once, and stops as a wrong room when it landed elsewhere', () => {
    let asks = 0;
    const replans: string[] = [];
    const { walker } = walkerOn({
      stateNow: () => at(1, 1),
      locate: () => {
        asks += 1;
      },
      replan: (to) => {
        replans.push(to);
        return ONWARD;
      }
    });
    walker.start(
      routeOf(stepOf(1, 2, 'e', { direction: 'portal', command: 'climb ladder' })),
      at(1, 1)
    );
    vi.advanceTimersByTime(50);
    walker.onCharacter(unplaced(3));
    expect(asks).toBe(1);
    expect(walker.progress.status).toBe('walking');
    // A landing the plan promised and missed is the route lost, not a replan.
    walker.onCharacter(
      at(1, 9, {
        room: { ...structuredClone(EMPTY_CHARACTER.room), map: 1, number: 9, name: 'Musty Grottos' }
      })
    );
    expect(replans).toEqual([]);
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(
      t('automation.walk.reasonWrongRoom', { roomName: 'Musty Grottos' })
    );
  });
});
