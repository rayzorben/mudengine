import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { playPlaced, refusesToPlay, type PlaySession } from '../Play';
import type { Loop } from '../../../shared/loops';
import { NOT_MOVING, type Movement, type MovementStart } from '../../../shared/movement';

const STILL: Movement = NOT_MOVING;
const LAP: Loop = { name: 'lap', stops: [{ room: 'Arena' }] };

/** A session as the press finds it: what it is doing, and whether it waits. */
function session(movement: Movement, stopped: string | null = null) {
  const placed = vi.fn(async () => true);
  const startMoving = vi.fn((): MovementStart => ({ started: true }));
  const found: PlaySession = {
    movement,
    loops: { progress: { name: stopped } },
    loopNamed: (name) => (name === LAP.name ? LAP : undefined),
    locating: { placed },
    startMoving
  };
  return { found, placed, startMoving };
}

/*
 * Todo 762: play's own refusals cost an `rm` and up to the locate window
 * first, for an answer no room could change.
 */
describe('play, placed first', () => {
  it('refuses a character already moving without asking where it is', async () => {
    const { found, placed, startMoving } = session({
      kind: 'route',
      moving: true,
      resumable: false
    });
    expect(await playPlaced(() => found, null, null)).toEqual({
      refused: t('session.move.alreadyMoving')
    });
    expect(placed).not.toHaveBeenCalled();
    expect(startMoving).not.toHaveBeenCalled();
  });

  it('refuses nothing to resume, and a loop that is no loop, without asking', async () => {
    const { found, placed } = session(STILL);
    expect(await playPlaced(() => found, null, null)).toEqual({
      refused: t('session.move.nothingToResume')
    });
    expect(await playPlaced(() => found, 'nowhere', null)).toEqual({
      refused: t('session.move.noSuchLoop', { name: 'nowhere' })
    });
    expect(placed).not.toHaveBeenCalled();
  });

  // The positive control: what the room does decide waits to be placed first.
  it('places first, then plays, for a lap to start or one to resume', async () => {
    const starting = session(STILL);
    expect(await playPlaced(() => starting.found, 'lap', 7)).toEqual({ started: true });
    expect(starting.placed).toHaveBeenCalledTimes(1);
    expect(starting.startMoving).toHaveBeenCalledWith('lap', 7);
    expect(starting.placed.mock.invocationCallOrder[0]).toBeLessThan(
      starting.startMoving.mock.invocationCallOrder[0]!
    );

    const resuming = session({ kind: 'loop', moving: false, resumable: true }, 'lap');
    expect(await playPlaced(() => resuming.found, null, null)).toEqual({ started: true });
    expect(resuming.placed).toHaveBeenCalledTimes(1);
  });

  it('answers nothing for a session gone before or during the wait', async () => {
    expect(await playPlaced(() => undefined, 'lap', null)).toBeNull();
    const { found, startMoving } = session(STILL);
    let there = true;
    found.locating.placed = async () => {
      there = false;
      return false;
    };
    expect(await playPlaced(() => (there ? found : undefined), 'lap', null)).toBeNull();
    expect(startMoving).not.toHaveBeenCalled();
  });

  it('reads a stopped lap named again as a resume, not a new lap', () => {
    const { found } = session({ kind: 'loop', moving: false, resumable: true }, 'lap');
    expect(refusesToPlay(found, 'lap')).toBeNull();
  });
});
