import { describe, expect, it } from 'vitest';

import { RepeatedCharacters } from '../repeats';
import { Push } from '../../../shared/ipc';

/* A character push a window already holds is not sent again (todo 836). */
describe('repeated characters', () => {
  const check = (repeats: RepeatedCharacters, channel: string, payload: unknown): boolean =>
    repeats.repeats(channel, payload, JSON.stringify(payload));

  it('holds back a character identical to the last one for that session', () => {
    const repeats = new RepeatedCharacters();
    const same = { session: 's1', payload: { hp: 5 } };
    expect(check(repeats, Push.character, same)).toBe(false);
    expect(check(repeats, Push.character, same)).toBe(true);
    // Another session's, and the same session's changed, still go.
    expect(check(repeats, Push.character, { session: 's2', payload: { hp: 5 } })).toBe(false);
    expect(check(repeats, Push.character, { session: 's1', payload: { hp: 6 } })).toBe(false);
    // And going back to an earlier state is a change from the last one sent.
    expect(check(repeats, Push.character, same)).toBe(false);
  });

  it('never holds back any other push', () => {
    const repeats = new RepeatedCharacters();
    const other = { session: 's1', payload: 'x' };
    expect(check(repeats, Push.characterReset, other)).toBe(false);
    expect(check(repeats, Push.characterReset, other)).toBe(false);
  });
});
