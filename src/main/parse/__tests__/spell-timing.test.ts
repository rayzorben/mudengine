import { describe, expect, it } from 'vitest';

import { Classifier } from '../Classifier';
import { CharacterTracker } from '../CharacterTracker';

/**
 * The transcript from the bug report, replayed through the real classifier and
 * tracker (todo 01, 2026-09-03).
 *
 * Every line here is verbatim from `logs/2026-09-03_20-27-07_festus.mudcap.jsonl`.
 * Three of them classified as `unknown` before this: the failure, the
 * self-cast confirmation, and the `st` sheet's countdowns — which is why
 * `protection from evil` was recast every 30 seconds while it had 90 left.
 */
function feeder(): {
  tracker: CharacterTracker;
  feed: (text: string, terminator?: 'newline' | 'flush') => string;
  ask: (command: string) => void;
  at: () => number;
} {
  const classifier = new Classifier();
  const tracker = new CharacterTracker();
  let seq = 0;
  const stamp = (): number => 1_700_000_000_000 + seq * 10;
  const feed = (text: string, terminator: 'newline' | 'flush' = 'newline'): string => {
    seq += 1;
    const { block, batch } = classifier.classify({
      seq,
      at: stamp(),
      text,
      plain: text,
      terminator
    });
    tracker.apply(block);
    if (batch) tracker.apply(batch, batch.rows);
    return block.type;
  };
  return { tracker, feed, ask: (command) => classifier.observeCommand(command), at: stamp };
}

describe('a spell that failed to cast', () => {
  it('is read as a failure rather than as silence', () => {
    const { feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    expect(feed('You attempt to cast bless, but fail.')).toBe('spell-failed');
  });

  it('reads the offensive form, which names its target', () => {
    const { feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    expect(feed('You attempt to cast unholy force at Covenant, but fail.')).toBe('spell-failed');
  });

  it('adds no buff, so the blessing stays due', () => {
    const { tracker, feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('You attempt to cast protection from evil, but fail.');
    expect(tracker.current.buffs).toEqual([]);
  });
});

describe('a self cast with no "on <target>" frame', () => {
  /*
   * The whole of the reported bug: this sentence matched nothing, so the buff
   * was never on the list, so `Blessings` recast it on its 30s retry floor for
   * as long as the character stood there.
   */
  it('establishes the buff', () => {
    const { tracker, feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    expect(feed('You cast protection from evil, and Festus is surrounded in a white glow!')).toBe(
      'spell-cast'
    );
    expect(tracker.current.buffs.map((buff) => buff.spell)).toEqual(['protection from evil']);
  });

  it('reads the corpus’s other flavour too', () => {
    const { tracker, feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('You cast ethereal shield, and a shimmering field forms about you.');
    expect(tracker.current.buffs.map((buff) => buff.spell)).toEqual(['ethereal shield']);
  });

  /* A targeted cast still matches the `on` frame first, with its target. */
  it('leaves the targeted frame alone', () => {
    const { tracker, feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('[HP=86/MA=18]:', 'flush');
    expect(feed('You cast bless on Festus!')).toBe('spell-cast');
    expect(tracker.current.buffs.map((buff) => buff.spell)).toEqual(['bless']);
  });

  /* Somebody else's buff wears off on their screen, not this one's. */
  it('does not take a cast on another player as this character’s buff', () => {
    const { tracker, feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('[HP=86/MA=18]:', 'flush');
    feed('You cast bless on Soul!');
    expect(tracker.current.buffs).toEqual([]);
  });
});

describe('the stat sheet’s countdowns', () => {
  /*
   * The onset sentence names an effect, not a spell, and no realm database on
   * hand exports the table that maps the two — so the pair is learned from the
   * cast it follows, and that is what lets `(90s)` reach the right buff.
   */
  it('are attributed to the buffs whose onset was learned from the cast', () => {
    const { tracker, feed, ask, at } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('[HP=86/MA=18]:', 'flush');
    feed('You cast protection from evil, and Festus is surrounded in a white glow!');
    expect(feed('You feel safe from evil!')).toBe('spell-onset');
    feed('You cast bless on Festus!');
    feed('You feel lucky!');

    ask('st');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('Willpower: 50     Charm:   50          MagicRes:       47');
    feed('You feel safe from evil! (90s)');
    feed('You feel lucky! (174s)');
    feed('[HP=86/MA=6]:', 'flush');

    const now = at();
    const left = Object.fromEntries(
      tracker.current.buffs.map((buff) => [
        buff.spell,
        buff.expiresAt === undefined ? null : Math.round((buff.expiresAt - now) / 1000)
      ])
    );
    expect(left).toEqual({ 'protection from evil': 90, bless: 174 });
  });

  /* An effect nothing has taught is left alone rather than guessed at. */
  it('ignore a countdown for an effect never seen after a cast', () => {
    const { tracker, feed, ask } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('[HP=86/MA=18]:', 'flush');
    feed('You cast bless on Festus!');
    feed('You feel lucky!');

    ask('st');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('You feel invincible! (60s)');
    feed('[HP=86/MA=6]:', 'flush');
    expect(tracker.current.buffs[0]?.expiresAt).toBeUndefined();
  });

  /* An onset long after the cast belongs to something else. */
  it('does not learn an onset that arrives much later', () => {
    const { tracker, feed, ask } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('[HP=86/MA=18]:', 'flush');
    feed('You cast bless on Festus!');
    // 300 lines later, a room effect says something that looks like an onset.
    for (let line = 0; line < 300; line += 1) feed('[HP=86/MA=18]:', 'flush');
    feed('You feel ferocious!');

    ask('st');
    feed('Name: Festus Marcus                    Lives/CP:      9/2');
    feed('You feel ferocious! (60s)');
    feed('[HP=86/MA=6]:', 'flush');
    expect(tracker.current.buffs[0]?.expiresAt).toBeUndefined();
  });
});

describe('the onset pattern stays inside its evidence', () => {
  /*
   * Found by review, reproduced: `You feel …!` is wide enough to swallow a
   * damage line, and it sat above the combat frames. `You feel a stabbing pain
   * for 96 damage!` is `captures/039`, and it is a blow.
   */
  it('leaves a damage line to the combat frames', () => {
    const { feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    expect(feed('You feel a stabbing pain for 96 damage!')).toBe('user-hits');
  });

  it('still reads a real onset', () => {
    const { feed } = feeder();
    feed('[HP=86/MA=18]:', 'flush');
    expect(feed('You feel safe from evil!')).toBe('spell-onset');
    expect(feed('You feel strong-willed!')).toBe('spell-onset');
  });
});
