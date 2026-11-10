import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../character';
import {
  carriedForward,
  comparable,
  identityOf,
  resetSignals,
  type CharacterIdentity
} from '../reset';

const NOW = 1_757_000_000_000;

function who(over: Partial<CharacterIdentity> = {}): CharacterIdentity {
  return { race: 'Human', className: 'Battlemage', level: 34, exp: 1_000_000, at: NOW, ...over };
}

describe('who the wire says this is', () => {
  it('says nothing at all before anything has been read', () => {
    expect(identityOf(EMPTY_CHARACTER, NOW)).toBeNull();
  });

  it('is worth keeping the moment one fact lands', () => {
    const state: CharacterState = { ...EMPTY_CHARACTER, race: 'Gnome' };
    const identity = identityOf(state, NOW);
    expect(identity).not.toBeNull();
    expect(comparable(identity!)).toBe(true);
    // And the rest stays unknown rather than becoming zero.
    expect(identity?.level).toBeNull();
  });
});

/*
 * The four signals, and the rule that governs all of them: unknown never
 * signals. A stat sheet nobody has read looks exactly like a class that changed
 * unless every comparison refuses on a null.
 */
describe('what says a character was reset', () => {
  it('notices a race that changed', () => {
    expect(resetSignals(who(), who({ race: 'Gnome' }), 0.3)).toEqual(['race']);
  });

  it('notices a class that changed', () => {
    expect(resetSignals(who(), who({ className: 'Thief' }), 0.3)).toEqual(['class']);
  });

  it('reads case and spacing as the realm\u2019s, not as a change', () => {
    expect(resetSignals(who(), who({ className: ' battlemage ' }), 0.3)).toEqual([]);
  });

  it('notices level 1 after higher, and not the way up', () => {
    expect(resetSignals(who({ level: 34 }), who({ level: 1 }), 0.3)).toEqual(['level']);
    expect(resetSignals(who({ level: 1 }), who({ level: 2 }), 0.3)).toEqual([]);
    // A level that merely fell is not this signal: nothing walks a character
    // back one level, but 1 is the number a new one starts at.
    expect(resetSignals(who({ level: 34 }), who({ level: 20 }), 0.3)).toEqual([]);
  });

  it('notices experience falling by more than the share, and not a death', () => {
    expect(resetSignals(who({ exp: 1000 }), who({ exp: 100 }), 0.3)).toEqual(['experience']);
    // A death costs experience; that is the innocent explanation this share is
    // set to sit above.
    expect(resetSignals(who({ exp: 1000 }), who({ exp: 900 }), 0.3)).toEqual([]);
    expect(resetSignals(who({ exp: 1000 }), who({ exp: 2000 }), 0.3)).toEqual([]);
  });

  it('is switched off for experience at a share of zero', () => {
    expect(resetSignals(who({ exp: 1000 }), who({ exp: 1 }), 0)).toEqual([]);
  });

  it('refuses every comparison against an unknown', () => {
    const nothing = who({ race: null, className: null, level: null, exp: null });
    expect(resetSignals(nothing, who(), 0.3)).toEqual([]);
    expect(resetSignals(who(), nothing, 0.3)).toEqual([]);
  });

  it('reports all of them, in a fixed order', () => {
    const after = who({ race: 'Gnome', className: 'Thief', level: 1, exp: 0 });
    expect(resetSignals(who(), after, 0.3)).toEqual(['race', 'class', 'level', 'experience']);
  });

  it('says nothing about the same character', () => {
    expect(resetSignals(who(), who({ at: NOW + 1000, exp: 1_200_000, level: 35 }), 0.3)).toEqual(
      []
    );
  });
});

/*
 * Soul, 2026-11-10: the prompt's `Exp=` was a quest reward short of what `exp`
 * stated, and read as the character's it was a 30% drop.
 */
describe('experience a prompt printed and nothing has checked', () => {
  const read = (expBehind: number | null): CharacterState => ({
    ...EMPTY_CHARACTER,
    progress: { ...EMPTY_CHARACTER.progress, level: 15, exp: 1_713_069 + (expBehind ?? 0) },
    statline: { ...EMPTY_CHARACTER.statline, exp: 1_713_069, expBehind }
  });

  it('is unknown until exp or the sheet has stated the figure', () => {
    expect(identityOf(read(null), NOW)).toMatchObject({ level: 15, exp: null });
  });

  it('is the corrected figure once one has', () => {
    expect(identityOf(read(750_000), NOW)?.exp).toBe(2_463_069);
    expect(identityOf(read(0), NOW)?.exp).toBe(1_713_069);
  });

  it('is the figure as it stands where the prompt carries no Exp=', () => {
    const state: CharacterState = {
      ...EMPTY_CHARACTER,
      progress: { ...EMPTY_CHARACTER.progress, exp: 34_603 }
    };
    expect(identityOf(state, NOW)?.exp).toBe(34_603);
  });
});

describe('the identity kept from one look to the next', () => {
  it('keeps what was remembered for each fact not known yet', () => {
    const now = who({ race: null, className: null, level: null, exp: null, at: NOW + 1 });
    expect(carriedForward(who(), now)).toEqual(who({ at: NOW + 1 }));
  });

  it('takes every fact that is known', () => {
    const now = who({ className: 'Thief', exp: 5, at: NOW + 1 });
    expect(carriedForward(who(), now)).toEqual(now);
  });

  it('is the character as it stands when nothing was remembered', () => {
    expect(carriedForward(null, who())).toEqual(who());
  });
});
