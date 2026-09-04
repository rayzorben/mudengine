import { describe, expect, it } from 'vitest';

import { resolveOverride } from '../usePreference';

type Side = 'top' | 'left';
const isSide = (value: unknown): value is Side => value === 'top' || value === 'left';

const stored = (value: string, against: string): string => JSON.stringify({ value, against });

describe('what a remembered toggle is worth', () => {
  it('is nothing at all when nothing was ever chosen', () => {
    expect(resolveOverride(null, 'left', isSide)).toEqual({ keep: null, forget: false });
  });

  it('outranks the file while the file still says what it deviated from', () => {
    expect(resolveOverride(stored('top', 'left'), 'left', isSide)).toEqual({
      keep: 'top',
      forget: false
    });
  });

  it('is spent once the file has been edited to something else', () => {
    expect(resolveOverride(stored('top', 'left'), 'top', isSide)).toEqual({
      keep: null,
      forget: true
    });
  });

  /*
   * The bug this exists for.
   *
   * `ui.tabs` changed its default from `top` to `left`, and the options file
   * was edited to `left` to match. Nothing happened: the first render precedes
   * the config arriving, so it already held `left`, and with nothing recording
   * what the override deviated *from*, an edit to `left` was indistinguishable
   * from no edit at all. A remembered `top` won forever.
   *
   * Recording `against` is what makes the edit answerable across a restart.
   */
  it('is spent when the file catches up with it while the client is closed', () => {
    // Chosen when the file said `top`; the file now says `left`.
    expect(resolveOverride(stored('left', 'top'), 'left', isSide)).toEqual({
      keep: null,
      forget: true
    });
  });

  /*
   * A bare value predates `against` and cannot say what it deviated from.
   * Honouring it reinstates the same trap; falling back to the file is the
   * documented behaviour and costs one palette toggle.
   */
  it('discards a bare value written by an older build', () => {
    expect(resolveOverride('top', 'left', isSide)).toEqual({ keep: null, forget: true });
  });

  /* Untrusted: this is a string a person can edit by hand. */
  it('refuses a value that is not one of the choices', () => {
    expect(resolveOverride(stored('sideways', 'left'), 'left', isSide)).toEqual({
      keep: null,
      forget: true
    });
  });

  it('refuses what does not parse rather than throwing', () => {
    expect(resolveOverride('{not json', 'left', isSide)).toEqual({ keep: null, forget: true });
    expect(resolveOverride('{"value":null}', 'left', isSide)).toEqual({
      keep: null,
      forget: true
    });
  });

  it('refuses an entry with no record of what it deviated from', () => {
    expect(resolveOverride(JSON.stringify({ value: 'top' }), 'left', isSide)).toEqual({
      keep: null,
      forget: true
    });
  });
});
