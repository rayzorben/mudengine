import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { setTuning, tuning } from '../../app/tuning';
import type { LocateAsk } from '../Claims';
import { Locating } from '../Locating';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const UNPLACED: CharacterState = {
  ...EMPTY_CHARACTER,
  phase: 'in-game',
  room: { ...EMPTY_CHARACTER.room, name: 'Dark Corridor', map: null, number: null }
};
const PLACED: CharacterState = {
  ...UNPLACED,
  room: { ...UNPLACED.room, map: 1, number: 2149 }
};

/** The ask as `Claims` answers it: the word sent, or why nothing was. */
const asked = (word: string): LocateAsk => ({ asked: word });
const NO_WORD: LocateAsk = { refused: 'unavailable' };

function rig(ask: LocateAsk = asked('rm'), state: CharacterState = UNPLACED) {
  const tracker = { current: state };
  const askWhereIAm = vi.fn((_reason?: string) => ask);
  const notice = vi.fn();
  const locating = new Locating({ tracker, claims: { askWhereIAm } }, { notice });
  /** The character published, as `SessionManager.publishCharacter` does. */
  const publish = (next: CharacterState): void => {
    tracker.current = next;
    locating.onCharacter(next);
  };
  return { locating, askWhereIAm, notice, publish };
}

/** Whether the promise has settled yet, and with what, without waiting on it. */
async function peek(promise: Promise<boolean>): Promise<boolean | 'pending'> {
  return Promise.race([promise, Promise.resolve('pending' as const)]);
}

describe('Locating', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTuning(DEFAULT_INTERNAL.tuning);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks once and proceeds when the answer places the character inside the window', async () => {
    const { locating, askWhereIAm, notice, publish } = rig();
    const first = locating.placed();
    const second = locating.placed();
    expect(askWhereIAm).toHaveBeenCalledTimes(1);
    expect(await peek(first)).toBe('pending');

    vi.advanceTimersByTime(tuning().session.locateResolveMs - 1);
    publish(PLACED);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // Positive control first, then the absence: the window lapsing later says nothing.
    vi.advanceTimersByTime(tuning().session.locateResolveMs);
    expect(notice).not.toHaveBeenCalled();
  });

  it('refuses when the window lapses unplaced, and says so', async () => {
    const { locating, notice, publish } = rig();
    const placed = locating.placed();
    publish(UNPLACED); // A publish that does not place the character does not end the wait.
    expect(await peek(placed)).toBe('pending');
    vi.advanceTimersByTime(tuning().session.locateResolveMs);
    expect(await placed).toBe(false);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      t('session.loop.locateUnresolved', {
        command: 'rm',
        seconds: Math.round(tuning().session.locateResolveMs / 1000)
      })
    );
  });

  it('sends nothing when the room is already placed', async () => {
    const { locating, askWhereIAm } = rig(asked('rm'), PLACED);
    expect(await locating.placed()).toBe(true);
    expect(askWhereIAm).not.toHaveBeenCalled();
  });

  it('refuses at once where the realm has no locate word, as before', async () => {
    const { locating, askWhereIAm, notice } = rig(NO_WORD);
    expect(await locating.placed()).toBe(false);
    // The ask was made and answered "no word"; nothing waits and nothing more is said.
    expect(askWhereIAm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(notice).not.toHaveBeenCalled();
  });

  /*
   * Todo 767: the queue refused the ask (automation off here), and the wait
   * went on as if it had gone, then said *Asked the realm where you are* about
   * nothing. The first case is the positive control: an ask sent is waited on.
   */
  it('waits on nothing the queue refused to send, and says why', async () => {
    const { locating, notice } = rig({ refused: 'switched-off' });
    expect(await locating.placed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(t('session.loop.locateSwitchedOff'));
  });

  it('says why the Room card’s press sent nothing, for each refusal the queue gives', () => {
    const cases: Array<[LocateAsk, string]> = [
      [{ refused: 'held' }, t('session.loop.locateHeld')],
      [{ refused: 'offline' }, t('session.loop.locateOffline')],
      [{ refused: 'switched-off' }, t('session.loop.locateSwitchedOff')],
      [{ refused: 'expired' }, t('session.loop.locateExpired')],
      [NO_WORD, t('session.loop.locateNone')]
    ];
    for (const [ask, said] of cases) {
      const { locating, notice } = rig(ask);
      expect(locating.ask()).toBe(false);
      expect(notice).toHaveBeenCalledWith(said);
    }
    // The positive control: an ask that went is a press that worked, and says nothing.
    const { locating, notice } = rig();
    expect(locating.ask()).toBe(true);
    expect(notice).not.toHaveBeenCalled();
  });

  /*
   * Todo 762: on MajorMUD the first `rm` is refused (`Vocabulary` says so,
   * `locateUnavailable`), and the lapse then said a second thing about the
   * same ask four seconds later. The refusal is the answer.
   */
  it('ends the wait on the refusal, leaving the realm’s own sentence as the only one', async () => {
    const { locating, notice } = rig();
    const placed = locating.placed();
    expect(await peek(placed)).toBe('pending');
    locating.locateRefused();
    expect(await placed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(tuning().session.locateResolveMs);
    expect(notice).not.toHaveBeenCalled();
    // Nothing waiting, a refusal is nothing to answer.
    expect(() => locating.locateRefused()).not.toThrow();
  });

  it('asks nothing outside the realm', async () => {
    const { locating, askWhereIAm } = rig(asked('rm'), { ...UNPLACED, phase: 'authenticating' });
    expect(await locating.placed()).toBe(false);
    expect(askWhereIAm).not.toHaveBeenCalled();
  });

  it('ends the wait quietly when the character leaves the realm mid-wait', async () => {
    const { locating, notice, publish } = rig();
    const placed = locating.placed();
    expect(vi.getTimerCount()).toBe(1);
    publish({ ...UNPLACED, phase: 'unknown' });
    expect(await placed).toBe(false);
    // The lapse that would have spoken is gone with the wait.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(tuning().session.locateResolveMs);
    expect(notice).not.toHaveBeenCalled();
  });

  it('answers a waiting caller and leaves no timer when the session is put down', async () => {
    const { locating, notice } = rig();
    const placed = locating.placed();
    expect(vi.getTimerCount()).toBe(1);
    locating.dispose();
    expect(await placed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(notice).not.toHaveBeenCalled();
  });
});
