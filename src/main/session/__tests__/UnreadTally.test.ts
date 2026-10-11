import { afterEach, describe, expect, it } from 'vitest';

import { UnreadTally } from '../UnreadTally';
import { setTuning } from '../../app/tuning';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import type { Block, BlockType } from '../../../shared/blocks';

const block = (type: BlockType, text: string, groups: Record<string, string> = {}): Block => ({
  seq: 1,
  at: 1_000,
  type,
  domain: 'unknown',
  groups,
  text,
  terminator: 'newline',
  confidence: 0.8
});

const here = { name: 'Town Square', map: 1, number: 1 };

afterEach(() => setTuning(DEFAULT_INTERNAL.tuning));

describe('UnreadTally', () => {
  it('counts unread lines by shape and keeps the latest sample and room', () => {
    const tally = new UnreadTally();
    tally.observe(block('unknown', 'The wind howls 3 times.'), here, 1);
    const later = { name: 'Dark Alley', map: 1, number: 2 };
    tally.observe(block('unknown', 'The wind  howls 12 times.'), later, 2);
    expect(tally.list()).toEqual([
      {
        kind: 'unknown',
        shape: 'The wind howls # times.',
        sample: 'The wind  howls 12 times.',
        count: 2,
        message: null,
        room: later,
        firstAt: 1,
        lastAt: 2
      }
    ]);
  });

  it('names the message row a realm-message line fits', () => {
    const tally = new UnreadTally();
    tally.observe(
      block('realm-message', 'The kobold thief attacks Vaelor, but Vaelor dodges!', {
        message: '3382',
        role: '1'
      }),
      here,
      1
    );
    expect(tally.list()[0]).toMatchObject({ kind: 'realm-message', message: 3382 });
  });

  it('ignores a line the parser read, with a read line beside it as the control', () => {
    const tally = new UnreadTally();
    tally.observe(block('room-exits', 'Obvious exits: north'), here, 1);
    tally.observe(block('unknown', 'A strange hum.'), here, 2);
    expect(tally.list().map((line) => line.shape)).toEqual(['A strange hum.']);
  });

  it('drops the shape seen longest ago past the bound', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      session: { ...DEFAULT_INTERNAL.tuning.session, unreadShapes: 2 }
    });
    const tally = new UnreadTally();
    tally.observe(block('unknown', 'first'), here, 1);
    tally.observe(block('unknown', 'second'), here, 2);
    tally.observe(block('unknown', 'first'), here, 3);
    tally.observe(block('unknown', 'third'), here, 4);
    expect(tally.list().map((line) => line.shape)).toEqual(['first', 'third']);
  });
});
