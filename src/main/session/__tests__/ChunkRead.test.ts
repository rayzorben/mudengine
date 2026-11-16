import { describe, expect, it } from 'vitest';

import { ChunkRead } from '../ChunkRead';
import { LineTokenizer } from '../../net/LineTokenizer';
import { PROMPT_REPAINT } from '../../net/stream-quirks';

/** A read over a real tokenizer, with every call it makes written down in order. */
function reading(onLine: (chunk: ChunkRead, plain: string) => void = () => {}): {
  chunk: ChunkRead;
  calls: string[];
} {
  const calls: string[] = [];
  const tokenizer = new LineTokenizer();
  const chunk: ChunkRead = new ChunkRead(
    {
      tokenizer,
      feed: { partial: (tail) => calls.push(`partial ${tail}`) },
      paint: { afterChunk: () => calls.push('paint') }
    },
    {
      arrived: () => calls.push('arrived'),
      publish: (framed) => {
        const plain = framed.text.replace(PROMPT_REPAINT, '').trimEnd();
        calls.push(`line ${plain}`);
        onLine(chunk, plain);
      },
      settle: () => calls.push('settle')
    }
  );
  return { chunk, calls };
}

describe('reading one chunk off the socket', () => {
  it('publishes every framed line, then hands over the tail and paints', () => {
    const { chunk, calls } = reading();
    chunk.read(`[HP=40]:${PROMPT_REPAINT}The rat bites you!\r\n[HP=30]:`, 0);
    expect(calls).toEqual([
      'arrived',
      'line [HP=40]:',
      'line The rat bites you!',
      'partial [HP=30]:',
      'paint'
    ]);
  });

  it('is not over while its lines are published, and is once it has been read', () => {
    const answers: boolean[] = [];
    const { chunk } = reading((read) => answers.push(read.over()));
    expect(chunk.over()).toBe(true);
    chunk.read('one\r\ntwo\r\n', 0);
    expect(answers).toEqual([false, false]);
    expect(chunk.over()).toBe(true);
  });

  it('settles once after the paint when a line was refused, and not when none asked', () => {
    const asking = reading((read) => read.over());
    asking.chunk.read('one\r\ntwo\r\n', 0);
    expect(asking.calls.slice(-2)).toEqual(['paint', 'settle']);

    const silent = reading();
    silent.chunk.read('one\r\ntwo\r\n', 0);
    expect(silent.calls).not.toContain('settle');
  });

  it('settles once for the chunk that refused, and owes nothing to the next', () => {
    const { chunk, calls } = reading((read) => read.over());
    chunk.read('one\r\n', 0);
    chunk.read('', 0);
    expect(calls.filter((call) => call === 'settle')).toHaveLength(1);
  });

  it('is read through again after a line that threw', () => {
    const { chunk } = reading(() => {
      throw new Error('a line that broke');
    });
    expect(() => chunk.read('one\r\n', 0)).toThrow('a line that broke');
    expect(chunk.over()).toBe(true);
  });
});
