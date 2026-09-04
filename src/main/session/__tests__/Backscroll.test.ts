import { describe, expect, it } from 'vitest';

import { Backscroll } from '../Backscroll';

describe('Backscroll', () => {
  it('replays what it was given, verbatim', () => {
    const scroll = new Backscroll();
    scroll.write('one\r\n');
    // Escape sequences are kept exactly: the in-place status repaint only
    // replays correctly because nothing here normalises it away.
    scroll.write('\x1b[79D\x1b[K[HP=30]:');
    expect(scroll.text).toBe('one\r\n\x1b[79D\x1b[K[HP=30]:');
  });

  it('drops the oldest output once it is over its cap', () => {
    const scroll = new Backscroll(64);
    for (let i = 0; i < 40; i += 1) scroll.write(`line ${i}\n`);
    expect(scroll.bytes).toBeLessThanOrEqual(64);
    expect(scroll.text).toContain('line 39');
    expect(scroll.text).not.toContain('line 0\n');
  });

  it('starts the replay at a line boundary rather than inside a sequence', () => {
    // One chunk larger than the cap, so trimming has to cut inside it.
    const written = 'aaaa\n\x1b[31mbbbb\n\x1b[0mcccc\n';
    const scroll = new Backscroll(12);
    scroll.write(written);

    const kept = scroll.text;
    expect(written.endsWith(kept)).toBe(true);
    // Whatever survived begins immediately after a newline, so replaying it
    // into a fresh terminal can never resume halfway through an escape
    // sequence. Beginning with a *complete* sequence is fine and expected.
    expect(written[written.length - kept.length - 1]).toBe('\n');
  });

  it('keeps the newest output rather than emptying itself', () => {
    const scroll = new Backscroll(16);
    scroll.write('old\n');
    // One chunk bigger than the entire budget, ending in a newline: trimming to
    // the boundary used to discard all of it, which loses the live screen to
    // save memory. The cap protects memory, not correctness.
    const newest = 'a much longer line than the cap allows\n';
    scroll.write(newest);

    expect(scroll.text.length).toBeGreaterThan(0);
    expect(newest.endsWith(scroll.text)).toBe(true);
  });

  it('clears', () => {
    const scroll = new Backscroll();
    scroll.write('something');
    scroll.clear();
    expect(scroll.text).toBe('');
    expect(scroll.bytes).toBe(0);
  });
});
