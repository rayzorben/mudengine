import { describe, expect, it } from 'vitest';

import { NO_LOOP, type LoopProgress, type LoopStatus } from '../loops';
import { movementOf, NOT_MOVING } from '../movement';
import { IDLE_WALK, type WalkProgress, type WalkStatus } from '../walk';

/** A journey the player asked for, unless said otherwise. */
const walking = (status: WalkStatus, asked = true): WalkProgress => ({
  ...IDLE_WALK,
  status,
  asked
});
const lap = (status: LoopStatus): LoopProgress => ({ ...NO_LOOP, status, name: 'Arena' });

/**
 * One reading of the two progresses, because three surfaces act on it: the
 * Navigation card draws one face, the toolbar draws one transport button, and
 * `walkNotices` withholds a leg's arrival. The ordering is the whole of it.
 */
describe('what a character is doing about going anywhere', () => {
  it('is nothing at all before anything has been walked', () => {
    expect(movementOf(IDLE_WALK, NO_LOOP)).toEqual(NOT_MOVING);
  });

  /* A lap's legs are walks it owns, so while it runs the walk underneath is
     its footwork rather than anything the player asked for. */
  it('is the lap while the lap is running, whatever the walk says', () => {
    expect(movementOf(walking('walking'), lap('running'))).toEqual({
      kind: 'loop',
      moving: true,
      resumable: false
    });
  });

  it('is the route while one is being walked', () => {
    expect(movementOf(walking('walking'), NO_LOOP)).toEqual({
      kind: 'route',
      moving: true,
      resumable: false
    });
  });

  /*
   * The case with two answers, and what decides it: **what the player asked
   * for outranks what the client walked**.
   *
   * Asking for a route is what stopped the lap underneath it, so the route is
   * the movement while it walks *and* after it stops — otherwise a route that
   * ended at a shut door would be drawn as the lap it displaced, with its own
   * reason unreadable and play walking away from where the player was going.
   * The lap is still in the card's picker to start again.
   */
  it('keeps reporting the player’s own route over a lap it displaced', () => {
    expect(movementOf(walking('walking'), lap('stopped'))).toMatchObject({
      kind: 'route',
      moving: true
    });
    expect(movementOf(walking('stopped'), lap('stopped'))).toEqual({
      kind: 'route',
      moving: false,
      resumable: true
    });
    expect(movementOf(walking('arrived'), lap('stopped'))).toMatchObject({ kind: 'route' });
  });

  /*
   * And the other half of that test, which is what makes it work: stopping a
   * lap stops the leg it was walking, so the walker is left holding a stopped
   * route that is the lap's own footwork. Reported as a *route* it would be
   * the card describing the mechanism instead of the thing happening — the
   * whole failure the one-face card exists to fix.
   */
  it('never reports a stopped leg as a stopped route', () => {
    expect(movementOf(walking('stopped', false), lap('stopped'))).toEqual({
      kind: 'loop',
      moving: false,
      resumable: true
    });
  });

  /* And with no lap left to attribute it to, a leg is reported but not offered
     back: nobody asked for it, so there is nothing for play to pick up. */
  it('offers back nothing of a leg with no lap behind it', () => {
    expect(movementOf(walking('stopped', false), NO_LOOP)).toEqual({
      kind: 'route',
      moving: false,
      resumable: false
    });
  });

  /*
   * A stopped route is still the movement the card reports on — "it stopped
   * and I do not know why" is the state this client's decision trace exists to
   * prevent — and it is resumable, which is what makes a stop a pause.
   */
  it('keeps reporting a route that stopped, and offers it back', () => {
    expect(movementOf(walking('stopped'), NO_LOOP)).toEqual({
      kind: 'route',
      moving: false,
      resumable: true
    });
  });

  /* Arrived is the end of a journey: reported, with nothing left to walk. */
  it('reports an arrival with nothing to resume', () => {
    expect(movementOf(walking('arrived'), NO_LOOP)).toEqual({
      kind: 'route',
      moving: false,
      resumable: false
    });
  });
});
