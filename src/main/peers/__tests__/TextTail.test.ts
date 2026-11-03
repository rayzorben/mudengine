import { describe, expect, it } from 'vitest';

import { TextTail } from '../TextTail';

describe('the text kept for a remote controller', () => {
  it('keeps everything while it fits', () => {
    const tail = new TextTail(() => 100);
    tail.append('one\r\n');
    tail.append('');
    tail.append('two\r\n');
    expect(tail.text()).toBe('one\r\ntwo\r\n');
  });

  it('starts at a whole line once it is past its size', () => {
    const tail = new TextTail(() => 12);
    tail.append('\x1b[1;31mfirst\r\n');
    tail.append('second\r\nthird\r\n');
    // Cut inside "first"'s colour and text, and started at the next line.
    expect(tail.text()).toBe('third\r\n');
  });

  it('gives nothing where the last stretch holds no line start', () => {
    const tail = new TextTail(() => 4);
    tail.append('abcdefgh');
    expect(tail.text()).toBe('');
  });

  it('counts every character appended, the ones let go included', () => {
    const tail = new TextTail(() => 10);
    tail.append('line one\n');
    tail.append('line two\n');
    expect(tail.text()).toBe('line two\n');
    expect(tail.end()).toBe(18);
  });

  it('lets old chunks go, and holds at most its size and one chunk', () => {
    const tail = new TextTail(() => 10);
    for (let i = 0; i < 100; i += 1) tail.append(`line ${i}\n`);
    expect(tail.text()).toBe('line 99\n');
    expect((tail as unknown as { chunks: string[] }).chunks.length).toBeLessThanOrEqual(2);
  });
});
