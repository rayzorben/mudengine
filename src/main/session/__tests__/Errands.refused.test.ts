import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

/*
 * A room command refused by a check that can pass later is kept
 * out of routes for a while only (todo 65), beside the session-long refusals.
 */

function errands(notices: string[]): Errands {
  return new Errands(
    {
      world: null,
      tracker: { current: EMPTY_CHARACTER, pendingMoves: 0 },
      fightRecord: {},
      lore: {}
    } as unknown as ErrandsParts,
    {
      config: () => DEFAULT_CONFIG.automation,
      family: () => 'greatermud',
      notice: (text: string) => notices.push(text)
    } as unknown as ErrandsSession
  );
}

describe('a room command refused by a check that can pass later', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Mutant: `for-now` written into the session-long set.
  it('is kept out of routes for a while, and a level check for the session', () => {
    const notices: string[] = [];
    const book = errands(notices);
    book.noteRefused('1/1', 'portal', 'for-now');
    book.noteRefused('2/2', 'n', 'checked');
    expect(notices).toHaveLength(2);
    expect([...(book.lapTraveller(EMPTY_CHARACTER).refused ?? [])]).toEqual(
      expect.arrayContaining(['1/1|portal', '2/2|n'])
    );

    vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.walk.refusedForNowMs + 1);
    expect([...(book.lapTraveller(EMPTY_CHARACTER).refused ?? [])]).toEqual(['2/2|n']);
  });
});
