import { describe, expect, it } from 'vitest';

import type { Block, BlockType } from '../../../shared/blocks';
import { answeringAfter, echoedCommand, EchoSince } from '../echo';

/** A classified line, as much of it as the echo reads. */
const line = (type: BlockType, text: string): Pick<Block, 'type' | 'text'> => ({ type, text });

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

/**
 * `SessionManager.answering`, and the tracker's copy of the same reading: a
 * status line's echo (null when bare), a bare line's echo, and anything else
 * leaving it where it was.
 */
describe('answeringAfter', () => {
  it('moves with the prompt’s echo and a bare line’s, and nothing else', () => {
    expect(answeringAfter(line('status-line', '[HP=34]:aa rat'), null)).toBe('aa rat');
    expect(answeringAfter(line('status-line', '[HP=34]:'), 'aa rat')).toBeNull();
    expect(answeringAfter(line('command-echo', 'bs k '), 'hid')).toBe('bs k');
    expect(answeringAfter(line('command-no-effect', 'Your command had no effect.'), 'aa rat')).toBe(
      'aa rat'
    );
  });
});

/*
 * The pairing `FleeGoto` and a `sys go`'s promise read (todos 766, 769), in
 * the wire's shapes: an answer after a bare prompt
 * (`2026-08-30_20-57-36_main`), glued to the prompt (`2026-08-26_13-44-52_
 * main`), and a typed go whose letters were echoed before it went
 * (`2026-09-01_14-26-16_vaelor2`). Each block is handed `answering` as it
 * stood before it.
 */
describe('EchoSince', () => {
  const NO_EFFECT = line('command-no-effect', 'Your command had no effect.');
  /** Feeds `lines` after the send, as the session does, and answers the reading. */
  const after = (command: string, lines: readonly Pick<Block, 'type' | 'text'>[]): EchoSince => {
    const since = new EchoSince(command);
    let answering: string | null = null;
    for (const block of lines) {
      since.heard(block, answering);
      answering = answeringAfter(block, answering);
    }
    return since;
  };

  it('keeps the echo across a bare prompt', () => {
    const since = after('Sys Go 1 297', [
      line('status-line', '[HP=34]:sys go 1 297'),
      line('status-line', '[HP=34]:'),
      NO_EFFECT
    ]);
    expect(since.echoed).toBe(true);
    expect(since.answers).toBe(true);
  });

  it('does not take a sentence glued to the prompt for an echo', () => {
    const since = after('sys go 1 297', [
      line('status-line', '[HP=34]:Your command had no effect.'),
      NO_EFFECT
    ]);
    expect(since.echoed).toBe(false);
    expect(since.answers).toBe(true);
  });

  it('answers for nothing echoed since, and not for another command’s echo', () => {
    expect(after('sys go 1 297', [line('status-line', '[HP=34]:'), NO_EFFECT]).answers).toBe(true);
    // Positive control: the same answer echoed against an attack is the attack's.
    const since = after('sys go 1 297', [line('status-line', '[HP=34]:aa rat'), NO_EFFECT]);
    expect(since.echoed).toBe(true);
    expect(since.answers).toBe(false);
  });
});
