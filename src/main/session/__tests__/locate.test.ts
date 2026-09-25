import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { setTuning } from '../../app/tuning';
import { CommandQueue, type Intent } from '../../automation/CommandQueue';
import { Claims } from '../Claims';
import { Locating } from '../Locating';
import { Vocabulary } from '../Vocabulary';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import type { LocateWord } from '../../../shared/locate';

/**
 * The realm's word for where am I, read through (todo 811): the three units
 * that ask — `Vocabulary` choosing the word, `Claims` sending it, `Locating`
 * waiting on it and answering the Room card's button — wired as the session
 * wires them over a real queue, with only the tracker faked.
 */
const UNPLACED: CharacterState = {
  ...EMPTY_CHARACTER,
  phase: 'in-game',
  room: { ...EMPTY_CHARACTER.room, name: 'Dark Corridor', map: null, number: null }
};

/** The queues a rig built, put down after each case. */
const queues: CommandQueue[] = [];

function rig(initial: LocateWord, enabled = true) {
  let word = initial;
  const sent: Intent[] = [];
  const notice = vi.fn();
  const staleProbe = vi.fn((_now: number): string | null => 'n');
  const tracker = {
    current: UNPLACED,
    useFamily: vi.fn(),
    takeSettledByLocate: () => [],
    staleProbe,
    expireStaleClaims: () => [],
    pendingMoves: 0,
    locateRefused: () => []
  };
  let claims: Claims | null = null;
  const vocabulary = new Vocabulary(
    { tracker, errands: { forgetFitness: vi.fn() }, world: undefined, locate: () => word },
    { locateRefused: () => claims?.locateRefused(), notice }
  );
  // The session's wiring: the vocabulary answers the queue's `unavailable`.
  const queue = new CommandQueue(
    { ...DEFAULT_CONFIG.automation, enabled },
    {
      send: (_command, intent) => void sent.push(intent),
      unavailable: (command) => vocabulary.wordUnavailable(command)
    }
  );
  queues.push(queue);
  claims = new Claims(
    { tracker, queue, combat: { noteMovePending: vi.fn() }, vocabulary },
    { notice }
  );
  const locating = new Locating({ tracker, claims }, { notice });
  const set = (next: LocateWord): void => {
    word = next;
  };
  return { vocabulary, claims, locating, sent, notice, staleProbe, set };
}

describe('the realm’s word for where am I', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTuning(DEFAULT_INTERNAL.tuning);
  });
  afterEach(() => {
    for (const queue of queues.splice(0)) queue.dispose();
    vi.useRealTimers();
  });

  it('asks with `rm` where the realm says `rm`, under the one locate key', () => {
    const { claims, sent } = rig('rm');
    expect(claims.askWhereIAm()).toEqual({ asked: 'rm' });
    expect(sent).toContainEqual(
      expect.objectContaining({ command: 'rm', coalesceKey: 'loop-locate' })
    );
  });

  it('asks nothing, and sends nothing, where the realm says `none`', () => {
    const { claims, sent } = rig('none');
    expect(claims.askWhereIAm()).toEqual({ refused: 'unavailable' });
    expect(sent).toEqual([]);
  });

  /*
   * The queue's one gate for a word the realm lacks refuses the entry list's
   * `rm` too, since `onEnterRealm` ships with it (811, review); the player's
   * own typing is not gated there.
   */
  it('refuses any automated `rm` under `none`, and none under `rm`', () => {
    expect(rig('none').vocabulary.wordUnavailable('rm')).toBe(true);
    expect(rig('rm').vocabulary.wordUnavailable('rm')).toBe(false);
    expect(rig('none').vocabulary.wordUnavailable('st')).toBe(false);
  });

  it('probes a stale step with the word, and not at all under `none`', () => {
    const positive = rig('rm');
    vi.advanceTimersByTime(1);
    positive.claims.settle();
    expect(positive.sent).toContainEqual(
      expect.objectContaining({ command: 'rm', coalesceKey: 'stale-probe' })
    );

    const { claims, sent, staleProbe } = rig('none');
    claims.settle();
    expect(sent).toEqual([]);
    // Not even marked probed: a probe that cannot be sent is not one owed.
    expect(staleProbe).not.toHaveBeenCalled();
  });

  it('lets a Goto or a Loop plan at once under `none`, with nothing asked or waited on', async () => {
    const { locating, sent, notice } = rig('none');
    expect(await locating.placed()).toBe(false);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(notice).not.toHaveBeenCalled();
  });

  it('follows the setting as it is reloaded, never a copy taken at the start', () => {
    const { claims, sent, set } = rig('none');
    expect(claims.askWhereIAm()).toEqual({ refused: 'unavailable' });
    set('rm');
    expect(claims.askWhereIAm()).toEqual({ asked: 'rm' });
    expect(sent).toHaveLength(1);
  });

  describe('the Room card’s button', () => {
    it('asks through the one locate ask, as a card asking', () => {
      const { locating, sent, notice } = rig('rm');
      expect(locating.ask()).toBe(true);
      expect(sent).toContainEqual(
        expect.objectContaining({
          command: 'rm',
          coalesceKey: 'loop-locate',
          reason: t('session.probe.askedFromCard')
        })
      );
      expect(notice).not.toHaveBeenCalled();
    });

    it('is refused out loud where the realm says `none`', () => {
      const { locating, sent, notice } = rig('none');
      expect(locating.ask()).toBe(false);
      expect(sent).toEqual([]);
      expect(notice).toHaveBeenCalledWith(t('session.loop.locateNone'));
    });

    it('is refused out loud where the realm refused the word', () => {
      const { vocabulary, locating, sent, notice } = rig('rm');
      vocabulary.noteWordMissing('rm');
      notice.mockClear();
      expect(locating.ask()).toBe(false);
      expect(sent).toEqual([]);
      expect(notice).toHaveBeenCalledWith(t('session.loop.locateNone'));
    });

    /*
     * Todo 767: with Automation off the queue refuses the ask, and the press
     * answered as if it had gone and said nothing. The first case above is the
     * positive control: the same press with Automation on sends `rm`.
     */
    it('is refused out loud where Automation is switched off, and nothing waits', async () => {
      const { locating, sent, notice } = rig('rm', false);
      expect(locating.ask()).toBe(false);
      expect(sent).toEqual([]);
      expect(notice).toHaveBeenCalledWith(t('session.loop.locateSwitchedOff'));
      notice.mockClear();
      expect(await locating.placed()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(notice).toHaveBeenCalledWith(t('session.loop.locateSwitchedOff'));
    });
  });
});
