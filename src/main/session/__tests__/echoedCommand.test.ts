import { describe, expect, it } from 'vitest';

import { echoedCommand } from '../SessionManager';

/**
 * The status line's echo is what `Your command had no effect.` is attributed
 * to. Shapes are the wire's: the mystic's `med` that was refused every three
 * seconds (2026-09-04), a bare prompt, and the resting flag the prompt
 * pattern already consumes — which must never read as a typed word.
 */
describe('echoedCommand', () => {
  it('reads the command the prompt echoed', () => {
    expect(echoedCommand('[HP=334/KAI=0]:med')).toBe('med');
    expect(echoedCommand('[HP=86/MA=18]:aa big carrion beast')).toBe('aa big carrion beast');
  });

  it('answers null for a bare prompt', () => {
    expect(echoedCommand('[HP=334/KAI=0]:')).toBeNull();
    expect(echoedCommand('[HP=334/KAI=0]: ')).toBeNull();
  });

  it('does not mistake the resting flag for a command', () => {
    expect(echoedCommand('[HP=34 (Resting) ]:')).toBeNull();
    expect(echoedCommand('[HP=48/KAI=5]: (Resting)')).toBeNull();
  });

  it('answers null for a line that is not a prompt', () => {
    expect(echoedCommand('Your command had no effect.')).toBeNull();
  });
});
