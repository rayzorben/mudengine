import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Classifier } from '../Classifier';
import { CharacterTracker } from '../CharacterTracker';
import { WorldGraph } from '../../world/WorldGraph';
import { Blessings } from '../../automation/Blessings';
import { CommandQueue } from '../../automation/CommandQueue';
import { DEFAULT_CONFIG, type BlessingConfig } from '../../../shared/config';
import {
  parseSpellMessagesCsv,
  SpellMessageBook,
  spellLoreOf,
  type SpellLore
} from '../../../shared/spell-messages';
import fs from 'node:fs';
import path from 'node:path';

/** The table that ships, exactly as `index.ts` loads it. */
function shippedSpellLore(): SpellLore {
  const rows = parseSpellMessagesCsv(
    fs.readFileSync(path.resolve('resources/world/spell-messages.csv'), 'utf8')
  );
  return spellLoreOf(SpellMessageBook.fromRows(rows), new SpellMessageBook());
}

/**
 * The transcript from the bug report, replayed through the real classifier and
 * tracker (todo 01, 2026-09-03).
 *
 * Every line here is verbatim from `logs/2026-09-03_20-27-07_festus.mudcap.jsonl`.
 * Three of them classified as `unknown` before this: the failure, the
 * self-cast confirmation, and the `st` sheet's countdowns — which is why
 * `protection from evil` was recast every 30 seconds while it had 90 left.
 */
function feeder(
  spellLore?: SpellLore,
  world?: WorldGraph
): {
  tracker: CharacterTracker;
  feed: (text: string, terminator?: 'newline' | 'flush') => string;
  ask: (command: string) => void;
  at: () => number;
} {
  const classifier = new Classifier(
    undefined,
    spellLore ? (text) => spellLore.match(text) : undefined
  );
  const tracker = new CharacterTracker(
    world,
    undefined,
    undefined,
    undefined,
    undefined,
    spellLore
  );
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

/*
 * The second transcript (2026-09-04, `logs/2026-09-04_12-28-42_main.mudcap.jsonl`):
 * a mystic's two kai powers recast every thirty seconds — `c pres`, six
 * seconds later `c tige`, and both again thirty seconds on — for the whole
 * session, with `You stop using pressure points.` arriving every 63s
 * regardless. Read from the log as "tiger is recast when pressure points
 * wears off"; it was neither power ever reaching `buffs`, because the kai
 * confirmations say `invoke` and `use your knowledge of`, not `cast`.
 */
describe('the kai powers, replayed through the real tracker and Blessings', () => {
  const base = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(base);
  });
  afterEach(() => vi.useRealTimers());

  const entry = (spell: string): BlessingConfig => ({
    spell,
    target: 'self',
    minMana: 0,
    prioritizeOverHeal: false,
    inCombat: true
  });

  it('casts each once, holds both while the wire says they are up, and recasts on the stop', () => {
    const sent: string[] = [];
    const queue = new CommandQueue(
      { ...DEFAULT_CONFIG.automation, pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 } },
      { send: (command) => sent.push(command) }
    );
    const blessings = new Blessings(
      {
        ...DEFAULT_CONFIG.automation.spells,
        blessings: [entry('pressure points'), entry('way of the tiger')]
      },
      true,
      queue
    );
    const { tracker, feed } = feeder(shippedSpellLore());
    try {
      feed('[HP=334/KAI=9]:', 'flush');
      expect(tracker.current.phase).toBe('in-game');
      blessings.onCharacter(tracker.current);
      expect(sent).toEqual(['c pressure points']);

      expect(feed('You use your knowledge of pressure points!')).toBe('spell-cast');
      // The table's own sentence for the power landing, read as one.
      expect(feed('You are using pressure points!')).toBe('spell-onset');
      feed('[HP=334/KAI=3]:', 'flush');
      blessings.onCharacter(tracker.current);
      // One cast a round: the second power waits out the proposal cooldown.
      vi.advanceTimersByTime(7_000);
      expect(sent).toEqual(['c pressure points', 'c way of the tiger']);

      expect(feed('You invoke the way of the tiger.')).toBe('spell-cast');
      expect(feed('You feel ferocious!')).toBe('spell-onset');
      feed('[HP=334/KAI=8]:', 'flush');
      blessings.onCharacter(tracker.current);
      expect(tracker.current.buffs.map((buff) => buff.spell)).toEqual([
        'pressure points',
        'way of the tiger'
      ]);

      // Twice the retry floor: before the fix this is where both went out again.
      vi.advanceTimersByTime(65_000);
      blessings.onCharacter(tracker.current);
      expect(sent).toHaveLength(2);

      // The positive control — the wire ends one, and only that one is recast.
      expect(feed('You stop using pressure points.')).toBe('user-buff-expired');
      blessings.onCharacter(tracker.current);
      expect(sent).toEqual(['c pressure points', 'c way of the tiger', 'c pressure points']);
      vi.advanceTimersByTime(10_000);
      expect(sent).toHaveLength(3);
    } finally {
      blessings.dispose();
      queue.dispose();
    }
  });
});

/*
 * The realm's own poison, read from both ends through the shipped table
 * (todo 23).
 *
 * `You feel ill.` is what 22 spells in `spell-messages.csv` print when they
 * land, paired there with `The effects of the poison wear off!`. Unlisted as
 * an onset the start was unread — and the *ending* matched the generic
 * buff-expiry frame, whose pairing asks what the stopped spell's start turns
 * on and got null. `poisoned` stayed `yes` for ever: a lap holding for it
 * stood at full health in a cave until the run was killed.
 *
 * Against the shipped table, because the pairing is the table's and a fixture
 * would be testing the test.
 */
describe("the realm's own poison, through the shipped table", () => {
  it('reads the start and clears it on the ending the table pairs with it', () => {
    const { tracker, feed } = feeder(shippedSpellLore());
    feed('[HP=34]:');
    feed('You feel ill.');
    expect(tracker.current.afflictions.poisoned).toBe('yes');
    feed('The effects of the poison wear off!');
    expect(tracker.current.afflictions.poisoned).toBe('no');
  });
});

/*
 * A knockdown, read from both ends through the shipped table and the shipped
 * realm (todo 24, re-analysed 2026-09-12 after todo 00).
 *
 * The todo reports 52 unread sentences and two broken links: that
 * `spell-onset` only matches `You feel …!` where these say `You are …!`, and
 * that the shipped realm carries no spell message table at all. Both were true
 * when it was written and neither is now — `resources/world/spell-messages.csv`
 * ships, pairing `You are flat on your back!` with `You get back on your
 * feet.`, and the classifier reads the sentence through the table rather than
 * through the frame.
 *
 * Held against the **shipped** table and the **shipped** realm, because the
 * whole chain is data: the sentence names its spells, the realm's row carries
 * `HoldPerson` (74), and `holdsMovement` is the one test.
 */
describe('a knockdown, through the shipped table and realm', () => {
  it('holds the character on the onset and lets go on the release', () => {
    const world = WorldGraph.load('resources/world/paradigm.jsonl.gz');
    const { tracker, feed } = feeder(shippedSpellLore(), world);
    feed('[HP=34]:');
    feed('You are flat on your back!');
    expect(tracker.current.afflictions.held).toBe('yes');
    feed('You get back on your feet.');
    expect(tracker.current.afflictions.held).toBe('no');
  });

  /* The comment's other example, and a net, which pairs a different release. */
  it("reads the realm's other holds the same way", () => {
    const world = WorldGraph.load('resources/world/paradigm.jsonl.gz');
    for (const [onset, release] of [
      ['You are entangled!', 'The effects of entangle wear off!'],
      ['You are entangled in a net!', 'You work yourself free.']
    ] as const) {
      const { tracker, feed } = feeder(shippedSpellLore(), world);
      feed('[HP=34]:');
      feed(onset);
      expect(tracker.current.afflictions.held, onset).toBe('yes');
      feed(release);
      expect(tracker.current.afflictions.held, release).toBe('no');
    }
  });
});
