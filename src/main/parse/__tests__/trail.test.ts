import { describe, expect, it } from 'vitest';

import { worldOf } from '../../world/__tests__/realmFile';
import { EMPTY_CHARACTER, type CharacterState, type Room } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { blockOf } from '../../../shared/__tests__/blocks';
import { CharacterTracker } from '../CharacterTracker';
import { Trail } from '../trail';

/*
 * The order the trail is written and given up in, and what lets go of it
 * (todo 700: *order is a decision*). The tracker's tests walk a room or two
 * and read the trail back, which a bound kept from the wrong end, a back step
 * matched from the oldest entry, or a closed socket that wipes the history
 * would all pass; and a replay never resets, dies or walks to the menu with a
 * trail it then reads. So these drive `Trail` directly, and hand the
 * forgetting to a real tracker.
 */

const T = 1_700_000_000_000;

/** Standing in room `number` of map 1. */
function standingIn(number: number): CharacterState {
  const s = structuredClone(EMPTY_CHARACTER);
  return { ...s, room: { ...s.room, map: 1, number } };
}
const room = (number: number): Room => standingIn(number).room;

describe('the order the trail is written in', () => {
  it('keeps the newest steps when the bound is reached, dropping the oldest first', () => {
    const trail = new Trail();
    const bound = DEFAULT_INTERNAL.tuning.walk.trailSteps;
    for (let at = 1; at <= bound + 1; at += 1) {
      trail.rememberTheWayBack(standingIn(at), room(at + 1), 'e');
    }
    expect(trail.steps).toHaveLength(bound);
    expect(trail.steps[0]).toEqual({ from: '1/2', direction: 'e', to: '1/3' });
    expect(trail.steps.at(-1)).toEqual({
      from: `1/${bound + 1}`,
      direction: 'e',
      to: `1/${bound + 2}`
    });
  });

  it('refuses a move with no direction, an end unplaced, and a room to itself', () => {
    const trail = new Trail();
    trail.rememberTheWayBack(standingIn(1), room(2), null);
    trail.rememberTheWayBack(standingIn(1), { ...room(2), number: null }, 'e');
    trail.rememberTheWayBack({ ...standingIn(1), room: { ...room(1), map: null } }, room(2), 'e');
    trail.rememberTheWayBack(standingIn(1), room(1), 'e');
    expect(trail.steps).toEqual([]);
  });

  it('gives a back step up from the newest match, with everything after it', () => {
    const trail = new Trail();
    trail.rememberTheWayBack(standingIn(1), room(2), 'e');
    trail.rememberTheWayBack(standingIn(2), room(1), 'w');
    trail.rememberTheWayBack(standingIn(1), room(2), 'e');
    trail.rememberTheWayBack(standingIn(2), room(3), 'e');
    trail.retraced({ from: '1/1', direction: 'e', to: '1/2' });
    expect(trail.steps).toEqual([
      { from: '1/1', direction: 'e', to: '1/2' },
      { from: '1/2', direction: 'w', to: '1/1' }
    ]);
  });

  it('answers the way back only where the newest step landed', () => {
    const trail = new Trail();
    trail.rememberTheWayBack(standingIn(1), room(2), 'e');
    trail.rememberTheWayBack(standingIn(2), room(3), 'e');
    expect(trail.wayBackFrom('1/3')).toEqual({ from: '1/2', direction: 'e', to: '1/3' });
    expect(trail.wayBackFrom('1/2')).toBeNull();
  });
});

describe('what lets go of the trail', () => {
  const world = worldOf([
    { m: 1, r: 1, n: 'Shore', x: { e: { m: 1, r: 2 } } },
    { m: 1, r: 2, n: 'East Beach', x: { w: { m: 1, r: 1 } } }
  ]);
  /** A step from the shore to the beach, on the trail. */
  const walked = (): CharacterTracker => {
    const tracker = new CharacterTracker(world);
    tracker.reset();
    tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T));
    tracker.apply(blockOf('room-name', 'Shore', { name: 'Shore' }, T + 1));
    tracker.apply(blockOf('room-exits', 'Obvious exits: east', { exits: 'east' }, T + 2));
    tracker.observeCommand('e');
    tracker.apply(blockOf('room-name', 'East Beach', { name: 'East Beach' }, T + 3));
    tracker.apply(blockOf('room-exits', 'Obvious exits: west', { exits: 'west' }, T + 4));
    return tracker;
  };
  const STEP = { from: '1/1', direction: 'e', to: '1/2' };

  it('holds the step while nothing has let go', () => {
    expect(walked().trail).toEqual([STEP]);
  });

  it('at a new connection', () => {
    const tracker = walked();
    tracker.reset();
    expect(tracker.trail).toEqual([]);
  });

  it('at a death', () => {
    const tracker = walked();
    tracker.apply(blockOf('user-dies', 'You are dead.', {}, T + 5));
    expect(tracker.trail).toEqual([]);
  });

  // The character logs back in where it logged off, so the menu keeps the trail (todo 752).
  it('never at a closed socket or the menu, which keep where the character came from', () => {
    const closed = walked();
    closed.leaveRealm(T + 5);
    expect(closed.trail).toEqual([STEP]);
    const menu = walked();
    menu.apply(blockOf('prompt-character', 'Please select a character:', {}, T + 5));
    expect(menu.current.phase).toBe('authenticating');
    expect(menu.trail).toEqual([STEP]);
  });
});
