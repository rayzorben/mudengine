import { describe, expect, it } from 'vitest';

import { worldOf } from '../../world/__tests__/realmFile';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import {
  effectKey,
  SpellMessageBook,
  spellLoreOf,
  unnamedEffect,
  type EffectLedger,
  type LearnedEffect,
  type SpellLore,
  type SpellMessageRow
} from '../../../shared/spell-messages';
import { EffectTracker } from '../effects';
import { blockOf } from '../../../shared/__tests__/blocks';

/*
 * The order the buffs' memory is spent in is a decision (todo 700: *order is
 * a decision*), and the tracker's tests cannot see it: they drive whole blocks
 * and assert the state that comes out. So these hand `EffectTracker` a spell
 * lore, an effect ledger, a queue and a record that write down each reach into
 * them, and pin the sequence `mudengine-wire` › *A buff's own sentences are
 * data, read from a table, and learned where the table is silent* relies on —
 * and what `forget` lets go of, which no replay of a whole session can see.
 */

const T = 1_700_000_000_000;
/** Neither a listing nor the stat sheet: a line on its own. */
const ALONE = { listing: false, sheet: false };

/** Five spells as a realm states them: `entangle` holds (74), `flash` is instant. */
const world = worldOf([], {
  v: 43,
  spells: [
    { id: 40, n: 'entangle', dur: 6, ab: [[74, 1]] },
    { id: 41, n: 'ward', dur: 60, ab: [[3, 5]] },
    { id: 42, n: 'haste', dur: 60, ab: [[3, 5]] },
    { id: 43, n: 'flash', ab: [[3, 5]] },
    { id: 8, n: 'bless', dur: 90, ab: [[3, 10]] }
  ]
});

/** Their sentences as the shipped table would hold them; four have no stop. */
const ROWS = [
  { spell: 'entangle', start: 'You are entangled!', stop: null },
  { spell: 'ward', start: 'You are warded!', stop: null },
  { spell: 'haste', start: 'You feel quick!', stop: null },
  { spell: 'flash', start: 'You are dazzled!', stop: null },
  { spell: 'bless', start: 'You feel lucky!', stop: 'The effects of bless wear off!' }
];

/**
 * An effect tracker whose every write through what it was handed is logged, in
 * order. The ledger remembers nothing it is told, answering from `known`, what
 * an earlier session is taken to have written down, so each verdict is the
 * tracker's own decision and never an echo of the last one; the learned book
 * is a real one, seeded from `learned`.
 */
function rig(
  earlier: { known?: readonly LearnedEffect[]; learned?: readonly SpellMessageRow[] } = {}
): { log: string[]; effects: EffectTracker } {
  const { known = [], learned = [] } = earlier;
  const log: string[] = [];
  const ledger: EffectLedger = {
    seen: (text) => known.find((entry) => effectKey(entry.text) === effectKey(text)) ?? null,
    lasting: (text, lasting) => log.push(`lasting ${lasting} "${text}"`),
    causes: (text, condition, verdict) => log.push(`causes ${condition} ${verdict} "${text}"`)
  };
  const inner = spellLoreOf(SpellMessageBook.fromRows(ROWS), SpellMessageBook.fromRows(learned), {
    effects: ledger
  });
  const spellLore: SpellLore = {
    match: (text) => inner.match(text),
    startOf: (spell) => inner.startOf(spell),
    stopOf: (spell) => inner.stopOf(spell),
    learn: (spell, kind, text, at) => {
      log.push(`learn ${kind} ${spell} "${text}"`);
      inner.learn(spell, kind, text, at);
    },
    unlearn: (spell, kind) => {
      log.push(`unlearn ${kind} ${spell}`);
      inner.unlearn(spell, kind);
    },
    effects: ledger
  };
  const effects = new EffectTracker({
    world,
    spellLore,
    claims: {
      shiftHeldMove: () => {
        log.push('shiftHeldMove');
        return true;
      }
    },
    belongings: () => ({
      rememberSpellDuration: (spell, seconds) => log.push(`duration ${spell} ${seconds}`)
    })
  });
  return { log, effects };
}

const onset = (text: string, spells: string, at: number): Block =>
  blockOf('spell-onset', text, { spells }, at);

/** A character in the realm with no buff up and every condition unknown. */
function character(): CharacterState {
  return { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game' };
}

/** `s` after own casts of `spells`, a millisecond apart from `at`. */
function cast(
  effects: EffectTracker,
  s: CharacterState,
  at: number,
  ...spells: string[]
): CharacterState {
  return spells.reduce(
    (state, spell, i) => effects.cast(state, { spell, caster: 'You' }, at + i) ?? state,
    s
  );
}

describe('the order the buffs spend what they are handed', () => {
  it('a hold spends the move it refused before a buff back unprompted takes a lesson back', () => {
    const { log, effects } = rig();
    let s = effects.onset(character(), onset('You are entangled!', 'entangle', T)) ?? character();
    expect(s.afflictions.held).toBe('yes');
    expect(log).toEqual(['shiftHeldMove']);
    // The one buff whose ending nothing knows: this sentence is taken to be it.
    s = effects.unread(s, 'You can move again.', T + 100, ALONE) ?? s;
    expect(s.buffs).toEqual([]);
    // And the onset again, with no cast in front of it: the lesson was wrong.
    s = effects.onset(s, onset('You are entangled!', 'entangle', T + 200)) ?? s;
    expect(s.buffs.map((buff) => buff.spell)).toEqual(['entangle']);
    expect(log).toEqual([
      'shiftHeldMove',
      'learn stop entangle "You can move again."',
      'shiftHeldMove',
      'unlearn stop entangle'
    ]);
  });

  it('a line after its own cast is that cast’s start, and a candidate for nothing else', () => {
    const { log, effects } = rig();
    const s = cast(effects, character(), T, 'ward');
    expect(effects.unread(s, 'A blue shimmer surrounds you.', T + 100, ALONE)).toBeNull();
    expect(log).toEqual(['learn start ward "A blue shimmer surrounds you."']);
    expect(effects.takeSheetRequest()).toBe(false);
  });

  it('a line of a listing is refused before it is looked at', () => {
    const { log, effects } = rig();
    const s = cast(effects, character(), T, 'ward');
    const open = { listing: true, sheet: false };
    expect(effects.unread(s, 'You have no keys.', T + 10_000, open)).toBeNull();
    expect(log).toEqual([]);
    expect(effects.takeSheetRequest()).toBe(false);
  });

  it('a line of the sheet is a candidate onset, and ends nothing', () => {
    const { log, effects } = rig();
    const s = cast(effects, character(), T, 'ward');
    const open = { listing: false, sheet: true };
    expect(effects.unread(s, 'Your skin tingles.', T + 10_000, open)).toBeNull();
    expect(log).toEqual([]);
    expect(effects.takeSheetRequest()).toBe(true);
  });

  it('the sheet names what it prints before it settles the endings still pending', () => {
    const { log, effects } = rig();
    let s = cast(effects, character(), T, 'ward', 'haste');
    // Two buffs whose ending nothing knows, so each sentence waits for a sheet.
    s = effects.unread(s, 'Something fades away.', T + 10_000, ALONE) ?? s;
    s = effects.unread(s, 'You are coated in slime.', T + 11_000, ALONE) ?? s;
    expect(log).toEqual([]);
    expect(effects.takeSheetRequest()).toBe(true);

    const listed = effects.listed(s, 'You are warded!\nYou are coated in slime.', T + 12_000);
    const slime = unnamedEffect('You are coated in slime.');
    expect(listed.buffs.map((buff) => buff.spell)).toEqual(['ward', slime]);
    expect(log).toEqual([
      // What the sheet printed and nothing named is a lasting effect — and so
      // not the ending it was held as a candidate for.
      'lasting yes "You are coated in slime."',
      `learn start ${slime} "You are coated in slime."`,
      'lasting no "Something fades away."',
      // And the one suspect the sheet stopped printing is what the other ended.
      'learn stop haste "Something fades away."'
    ]);
  });

  it('a sentence acted on as an ending and then printed by the sheet takes the ending back', () => {
    const { log, effects } = rig();
    let s = cast(effects, character(), T, 'ward');
    s = effects.unread(s, 'The shimmer fades.', T + 10_000, ALONE) ?? s;
    expect(s.buffs).toEqual([]);
    effects.listed(s, 'The shimmer fades.', T + 11_000);
    expect(log).toEqual([
      'learn stop ward "The shimmer fades."',
      'lasting yes "The shimmer fades."',
      `learn start ${unnamedEffect('The shimmer fades.')} "The shimmer fades."`,
      'unlearn stop ward'
    ]);
  });

  it('a recognised wear-off ends what its start turned on and measures the cast', () => {
    const { log, effects } = rig();
    const s = cast(effects, character(), T, 'bless');
    const ended = effects.expired(s, { spells: 'bless' }, T + 90_000);
    expect(ended?.buffs).toEqual([]);
    expect(log).toEqual(['duration bless 90']);
  });

  it('a line taken for the one unknown ending asks for the sheet, though the realm settled it', () => {
    // No lasting effect, this realm said: so it is no candidate onset, and
    // only the ending it was taken for can ask.
    const { log, effects } = rig({ known: [{ text: 'The shimmer fades.', at: T, lasting: 'no' }] });
    const s = cast(effects, character(), T, 'ward');
    expect(effects.unread(s, 'The shimmer fades.', T + 10_000, ALONE)?.buffs).toEqual([]);
    expect(log).toEqual(['learn stop ward "The shimmer fades."']);
    expect(effects.takeSheetRequest()).toBe(true);
  });

  it('what the sheet prints is named before the keeping, so a buff it restates keeps its clocks', () => {
    // The sentence is an unnamed effect's start and, by another lesson, haste's
    // stop: the table cannot say which, so only the sheet's own naming keeps it.
    const AIR = 'The air hums.';
    const { effects } = rig({
      learned: [
        { spell: unnamedEffect(AIR), start: AIR, stop: null },
        { spell: 'haste', start: null, stop: AIR }
      ]
    });
    const humming = { spell: unnamedEffect(AIR), by: null, appliedAt: T, expiresAt: T + 90_000 };
    const s = { ...character(), buffs: [humming] };
    expect(effects.listed(s, AIR, T + 50_000).buffs).toEqual([humming]);
  });

  describe('an unnamed effect and a condition', () => {
    const SLIME = 'You are coated in slime.';
    const coated = {
      ...character(),
      buffs: [{ spell: unnamedEffect(SLIME), by: null, appliedAt: T }]
    };
    const blind = (s: CharacterState, blind: 'yes' | 'no'): CharacterState => ({
      ...s,
      afflictions: { ...s.afflictions, blind }
    });

    it('is suspected when the condition begins while the effect is up', () => {
      const { log, effects } = rig();
      effects.deduceCauses(coated, blind(coated, 'yes'), T);
      expect(log).toEqual([`causes blind suspected "${SLIME}"`]);
    });

    it('is confirmed when the effect ends and the condition a breath later', () => {
      const { log, effects } = rig({
        known: [{ text: SLIME, at: T, lasting: 'yes', causes: { blind: 'suspected' } }]
      });
      const blinded = blind(coated, 'yes');
      const lapsed = { ...blinded, buffs: [] };
      effects.deduceCauses(blinded, lapsed, T + 1_000);
      effects.deduceCauses(lapsed, blind(lapsed, 'no'), T + 1_500);
      expect(log).toEqual([`causes blind confirmed "${SLIME}"`]);
    });
  });
});

describe('what a cast is remembered for', () => {
  it('an instant cast is still remembered, so the onset the table says lasts dates from it', () => {
    const { effects } = rig();
    const s = character();
    // The realm's row calls `flash` instant, so the cast frame puts up nothing.
    expect(effects.cast(s, { spell: 'flash', caster: 'You' }, T)).toBeNull();
    const landed = effects.onset(s, onset('You are dazzled!', 'flash', T + 100));
    expect(landed?.buffs).toEqual([{ spell: 'flash', by: null, appliedAt: T }]);
  });

  it('somebody else’s cast is not remembered as this character’s', () => {
    const { log, effects } = rig();
    const theirs = { spell: 'ward', caster: 'Soul', target: 'thug' };
    expect(effects.cast(character(), theirs, T)).toBeNull();
    expect(effects.unread(character(), 'A blue shimmer surrounds you.', T + 100, ALONE)).toBeNull();
    expect(log).toEqual([]);
    // Held for a sheet instead, as any line nothing accounts for is.
    expect(effects.takeSheetRequest()).toBe(true);
  });
});

describe('what a new connection forgets', () => {
  it('the cast: a line after it is nobody’s start any more', () => {
    const { log, effects } = rig();
    cast(effects, character(), T, 'ward');
    effects.forget();
    expect(effects.unread(character(), 'A blue shimmer surrounds you.', T + 100, ALONE)).toBeNull();
    expect(log).toEqual([]);
  });

  it('the onset map: the sheet no longer names a spell by the word a cast taught', () => {
    const { effects } = rig();
    const s = cast(effects, character(), T, 'haste');
    effects.onset(s, blockOf('spell-onset', 'You feel zippy!', { effect: 'zippy' }, T + 100));
    const named = (at: number): string[] =>
      effects.listed(s, 'You feel zippy!', at).buffs.map((buff) => buff.spell);
    expect(named(T + 200)).toEqual(['haste']);
    effects.forget();
    expect(named(T + 300)).toEqual([unnamedEffect('You feel zippy!')]);
  });
});
