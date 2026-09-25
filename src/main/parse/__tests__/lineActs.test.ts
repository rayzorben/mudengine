import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Block } from '../../../shared/blocks';
import type { StreamLine } from '../../../shared/types';
import { CharacterTracker } from '../CharacterTracker';
import { Classifier } from '../Classifier';
import { actsOf, applyAct, readLine, replayLine } from '../lineActs';

/*
 * The one sequence the client and `check:reckoning` both feed the tracker
 * through (todo 749). The harness once applied each line with the batch's
 * rows and never the batch, the tails or `collecting`, so a `who` listing
 * never reached the registry there and nothing said so.
 */

const T = 1_700_000_000_000;

/** Numbered lines, a millisecond apart. */
function linesOf(texts: readonly string[]): StreamLine[] {
  return texts.map((text, index) => ({
    seq: index + 1,
    at: T + index,
    text,
    plain: text,
    terminator: 'newline'
  }));
}

const WHO = [
  '[HP=33]:',
  '         Current Adventurers',
  '         ===================',
  '         Rayzor                -  Apprentice S',
  '         Outlaw   Grimjaw     -  Cutpurse',
  '[HP=33]:'
];

/** A tracker that writes down each block it is handed, and how. */
function recorder(): {
  applied: string[];
  tracker: Pick<CharacterTracker, 'apply'>;
} {
  const applied: string[] = [];
  return {
    applied,
    tracker: {
      apply: (block: Block, rows?: Array<Record<string, string>>, collecting = false) => {
        applied.push(
          `${block.type}${rows ? ` rows=${rows.length}` : ''}${collecting ? ' collecting' : ''}`
        );
        return false;
      }
    }
  };
}

describe('feeding one framed line to the tracker', () => {
  it('lands a who listing in the registry: the batch, not only its closing line', () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    for (const line of linesOf(WHO)) {
      for (const act of actsOf(readLine(classifier, line))) applyAct(tracker, act);
    }
    expect(tracker.current.online.map((player) => player.name)).toEqual(['Rayzor', 'Grimjaw']);
  });

  it('applies the line, then the listing it closed, then each tail, all collecting', () => {
    const classifier = new Classifier();
    const { applied, tracker } = recorder();
    const texts = [
      'You are carrying padded helm (Head), quarterstaff (Weapon Hand)',
      'You have no keys.',
      'Wealth: 0 copper farthings',
      'Encumbrance: 500/3360 - None [14%]',
      '[HP=98/MA=50]:Location:            1,1377'
    ];
    for (const line of linesOf(texts)) {
      for (const act of actsOf(readLine(classifier, line))) applyAct(tracker, act);
    }
    // `You have no keys.` is a row of the pack's listing, and says so.
    expect(applied[1]).toMatch(/ collecting$/);
    // The prompt that closed the listing, the listing, then the prompt's tail.
    expect(applied.slice(-3)).toEqual([
      'status-line collecting',
      'user-inventory rows=1',
      'user-profile collecting'
    ]);
  });
});

describe('replaying a recorded line', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** In the realm, with `n` sent at T and nothing answering it. */
  function stepSent(): { classifier: Classifier; tracker: CharacterTracker } {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    replayLine(classifier, tracker, linesOf(['[HP=33]:'])[0]!);
    classifier.observeCommand('n');
    tracker.observeCommand('n');
    return { classifier, tracker };
  }

  it('keeps a step the server may still answer', () => {
    const { classifier, tracker } = stepSent();
    vi.setSystemTime(T + 1_000);
    replayLine(classifier, tracker, linesOf(['[HP=33]:'])[0]!);
    expect(tracker.pendingMoves).toBe(1);
  });

  it('writes off a step nothing answered, as `Claims.settle` does in play', () => {
    const { classifier, tracker } = stepSent();
    vi.setSystemTime(T + 60_000);
    replayLine(classifier, tracker, linesOf(['[HP=33]:'])[0]!);
    expect(tracker.pendingMoves).toBe(0);
  });

  it('withholds the act the caller withholds and applies the rest of the line', () => {
    const classifier = new Classifier();
    const tracker = new CharacterTracker();
    const offered: string[] = [];
    replayLine(
      classifier,
      tracker,
      linesOf(['[HP=98/MA=50]:Location:            1,1377'])[0]!,
      (act) => {
        offered.push(act.block.type);
        return act.block.type !== 'user-profile';
      }
    );
    expect(offered).toEqual(['status-line', 'user-profile']);
    expect(tracker.current.phase).toBe('in-game');
    expect(tracker.current.room.number).toBeNull();
  });
});
