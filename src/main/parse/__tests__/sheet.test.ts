import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { CharacterTracker } from '../CharacterTracker';
import { StatusLine } from '../sheet';
import { blockOf } from '../../../shared/__tests__/blocks';

/*
 * The sheet's memories and when they are let go of. `StatusLine` asks `pro`
 * once per report, and the tracker hands the forgetting down — `reset` for a
 * new connection, `leaveRealm` for a closed socket — to the two owners it
 * composes. A replay of a whole session cannot see either: it never resets
 * in the middle, and a flag asked for twice reads the same as once.
 */

const T = 1_700_000_000_000;
const TEMPLATE = '[HP=%h/%H]:';
const prompt = (text: string, at: number): Block => blockOf('status-line', text, {}, at);

describe('the status line’s one ask per report', () => {
  it('arms once for a prompt the reported template refuses, and again after the next report', () => {
    const line = new StatusLine();
    const fresh = structuredClone(EMPTY_CHARACTER);
    let s = line.reported(fresh, TEMPLATE) ?? fresh;
    s = line.prompt(s, prompt('[HP=10/20]:', T)) ?? s;
    expect(line.takeStatlineRequest()).toBe(false);
    s = line.prompt(s, prompt('[HP=10/MA=5]:', T + 1)) ?? s;
    expect(s.vitals.hp).toBe(10);
    expect(line.takeStatlineRequest()).toBe(true);
    s = line.prompt(s, prompt('[HP=10/MA=5]:', T + 2)) ?? s;
    expect(line.takeStatlineRequest()).toBe(false);
    s = line.reported(s, '[HP=%h/%H ]:') ?? s;
    line.prompt(s, prompt('[HP=10/MA=5]:', T + 3));
    expect(line.takeStatlineRequest()).toBe(true);
  });

  it('does not re-arm on the same report twice, or `pro` would be asked in a loop', () => {
    const line = new StatusLine();
    const fresh = structuredClone(EMPTY_CHARACTER);
    const s = line.reported(fresh, TEMPLATE) ?? fresh;
    line.prompt(s, prompt('[HP=10/MA=5]:', T));
    expect(line.takeStatlineRequest()).toBe(true);
    expect(line.reported(s, TEMPLATE)).toBeNull();
    line.prompt(s, prompt('[HP=10/MA=5]:', T + 1));
    expect(line.takeStatlineRequest()).toBe(false);
  });
});

describe('what the tracker forgets, and when', () => {
  /** A tracker that wants an `st`: a line nothing read, shaped like an effect. */
  const wanting = (tracker: CharacterTracker): CharacterTracker => {
    tracker.apply(blockOf('unknown', 'Your skin tingles.', {}, T));
    return tracker;
  };
  /** A tracker whose prompt `pro` has reported, and read by it. */
  const reported = (): CharacterTracker => {
    const tracker = new CharacterTracker();
    tracker.apply(blockOf('user-statline', `Statusline: ${TEMPLATE}`, { statline: TEMPLATE }, T));
    return tracker;
  };

  it('asks for the sheet while nothing has been forgotten', () => {
    expect(wanting(new CharacterTracker()).takeSheetRequest()).toBe(true);
  });

  it('lets a half-learned ending go when the socket closes', () => {
    const tracker = wanting(new CharacterTracker());
    tracker.leaveRealm(T + 1);
    expect(tracker.takeSheetRequest()).toBe(false);
  });

  it('lets it go at a new connection', () => {
    const tracker = wanting(new CharacterTracker());
    tracker.reset();
    expect(tracker.takeSheetRequest()).toBe(false);
  });

  it('keeps the matcher `pro` built through a closed socket, and drops it at a new connection', () => {
    const tracker = reported();
    expect(tracker.readPrompt('[HP=10/20]:')?.exact).toBe(true);
    tracker.leaveRealm(T + 1);
    expect(tracker.readPrompt('[HP=10/20]:')?.exact).toBe(true);
    tracker.reset();
    expect(tracker.readPrompt('[HP=10/20]:')?.exact).toBeNull();
  });
});
