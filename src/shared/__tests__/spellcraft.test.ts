import { describe, expect, it } from 'vitest';

import {
  castWord,
  castsBare,
  castsOnOthers,
  castsOnSelf,
  cureGates,
  resolveSpell,
  spellCost,
  spellTargeting,
  type AbilityPairs,
  type CastableSpell
} from '../spellcraft';

/* The live `powers` listing's own rows (2026-09-01), quoted rather than invented. */
const book: CastableSpell[] = [
  { name: 'way of the tiger', short: 'tige' },
  { name: 'pressure points', short: 'pres' },
  { name: 'way of the mantis', short: 'mant' },
  { name: 'freshly learned', short: null }
];

describe('castWord', () => {
  it('resolves a whole name to the listing’s short word, whatever the case', () => {
    expect(castWord('pressure points', book)).toBe('pres');
    expect(castWord('Way of the Tiger', book)).toBe('tige');
  });

  it('keeps a configured abbreviation, spelled as the listing spells it', () => {
    expect(castWord('PRES', book)).toBe('pres');
  });

  it('asks the realm table when the listing has not arrived or names no short', () => {
    const realm = (name: string): string | null =>
      name.toLowerCase() === 'minor healing' ? 'mihe' : null;
    expect(castWord('minor healing', null, realm)).toBe('mihe');
    // Known to the listing but unabbreviated there — the level-up append.
    const taught = (name: string): string | null =>
      name.toLowerCase() === 'freshly learned' ? 'fres' : null;
    expect(castWord('freshly learned', book, taught)).toBe('fres');
  });

  it('sends a name neither source can shorten as typed — the server’s refusal is the honest failure', () => {
    expect(castWord('unheard of', book)).toBe('unheard of');
    expect(castWord('freshly learned', book)).toBe('freshly learned');
    expect(castWord('  pres  ', null)).toBe('pres');
  });
});

/* The shipped realm's own rows, quoted rather than invented. */
const curePoison: AbilityPairs = [
  [20, 0],
  [73, 19],
  [122, 794],
  [122, 798]
];
const cureBlindness: AbilityPairs = [[73, 107]];
const cureDisease: AbilityPairs = [
  [122, 992],
  [122, 294],
  [122, 362]
];
const magicMissile: AbilityPairs = [[17, 0]];
const minorHealing: AbilityPairs = [
  [18, 0],
  [108, 0]
];

describe('cureGates', () => {
  it('marks poison from CurePoison or DispellMagic→Poison, blindness from DispellMagic→BlindUser', () => {
    expect(cureGates([curePoison, magicMissile])).toEqual({
      poison: true,
      blindness: false,
      disease: true
    });
    expect(cureGates([cureBlindness])).toEqual({ poison: false, blindness: true, disease: false });
    // antidote's marks without the direct CurePoison row still say poison.
    expect(cureGates([[[73, 19]]])).toEqual({ poison: true, blindness: false, disease: false });
  });

  it('opens disease only through the negative gate — any RemovesSpell carrier', () => {
    expect(cureGates([cureDisease]).disease).toBe(true);
    expect(cureGates([magicMissile, minorHealing]).disease).toBe(false);
  });

  it('closes every gate on an empty book and opens them all for a spell the realm cannot name', () => {
    expect(cureGates([])).toEqual({ poison: false, blindness: false, disease: false });
    // One unnameable spell means the realm cannot say, and unknown never disables.
    expect(cureGates([magicMissile, undefined])).toEqual({
      poison: true,
      blindness: true,
      disease: true
    });
  });
});

/*
 * Everything is an entity: what crosses to a caster is the realm's row, not a
 * field off it. Three callbacks used to carry three projections of one row, so
 * a module that needed a fourth fact — what the cast costs — could not ask.
 */
describe('resolveSpell', () => {
  const book: CastableSpell[] = [
    { name: 'pressure points', short: 'pres' },
    { name: 'freshly learned', short: null }
  ];
  const owl = { id: 37, name: 'way of the owl', short: 'owl', mana: 2, level: 3 };
  const realm = (name: string) => (name.toLowerCase() === 'way of the owl' ? owl : null);

  it('carries the realm row, not just the word off it', () => {
    const found = resolveSpell('way of the owl', book, realm);
    expect(found.word).toBe('owl');
    expect(found.realm?.mana).toBe(2);
    expect(found.realm?.level).toBe(3);
  });

  /* The listing is this character's own word on what it can cast; the realm
     table is what the shipped data says about everybody's. Both, or neither. */
  it('carries the listing entry where the character knows the spell', () => {
    expect(resolveSpell('pres', book, realm).known?.name).toBe('pressure points');
    expect(resolveSpell('pres', book, realm).realm).toBeNull();
  });

  it('knows nothing about a name neither source has, and sends it as typed', () => {
    const found = resolveSpell('unheard of', book, realm);
    expect(found.word).toBe('unheard of');
    expect(found.known).toBeNull();
    expect(found.realm).toBeNull();
  });

  it('resolves the same word castWord does', () => {
    for (const name of ['pressure points', 'PRES', 'freshly learned', 'unheard of', '  pres  ']) {
      expect(resolveSpell(name, book, realm).word).toBe(
        castWord(name, book, (n) => realm(n)?.short ?? null)
      );
    }
  });

  it('asks the realm nothing for an empty configuration', () => {
    let asked = 0;
    const found = resolveSpell('   ', book, (name) => {
      asked += 1;
      return realm(name);
    });
    expect(found.word).toBe('');
    expect(found.realm).toBeNull();
    expect(asked).toBe(0);
  });
});

/*
 * What a cast costs, so a caster can refuse one it cannot pay for rather than
 * having the server say so out loud in the room.
 */
describe('spellCost', () => {
  const owl = { id: 37, name: 'way of the owl', short: 'owl', mana: 2, level: 3 };
  const realm = (name: string) => (name.toLowerCase().startsWith('way') ? owl : null);

  it("prefers the character's own listing to the realm table", () => {
    const book: CastableSpell[] = [{ name: 'way of the owl', short: 'owl', cost: 9 }];
    expect(spellCost(resolveSpell('way of the owl', book, realm))).toBe(9);
  });

  /* A row learned from the level-up line has only a name, so its cost is null
     and the realm table answers behind it. */
  it('falls through to the realm when the listing states no cost', () => {
    const book: CastableSpell[] = [{ name: 'way of the owl', short: 'owl', cost: null }];
    expect(spellCost(resolveSpell('way of the owl', book, realm))).toBe(2);
  });

  it('answers null for a spell neither source has priced', () => {
    expect(spellCost(resolveSpell('unheard of', [], realm))).toBeNull();
  });
});

/*
 * Who a spell may be cast on, from `Spells.Targets`.
 *
 * The readings are stated in `spellTargeting`'s own comment, derived from the
 * learnable rows of both engines. These are the two decisions that fall out of
 * it — which field offers a spell, and whether a cast names its target.
 */
describe('spellTargeting', () => {
  it('reads the realm’s own numbers', () => {
    // `way of the swan` / `magic armour` — the caster alone.
    expect(spellTargeting(1)).toBe('self');
    // `minor healing` / `bless` — self or another.
    expect(spellTargeting(2)).toBe('friendly');
    // `healing rain` / `holy aura` — everyone friendly at once.
    expect(spellTargeting(13)).toBe('party');
    expect(spellTargeting(8)).toBe('enemy');
    expect(spellTargeting(12)).toBe('enemies');
    expect(spellTargeting(4)).toBe('creature');
  });

  /*
   * Absent is `unknown` and never `self`. Three things arrive as absent — the
   * realm's own zero, a pre-v17 conversion, and a spell the realm cannot name
   * — and reading any of them as `self` would make `castsBare` true, so a
   * party heal would go out with the member's name dropped and land on the
   * caster instead of the person who is dying.
   */
  it('answers unknown for anything it cannot read, absence included', () => {
    expect(spellTargeting(undefined)).toBe('unknown');
    expect(spellTargeting(null)).toBe('unknown');
    expect(spellTargeting(0)).toBe('unknown');
    expect(spellTargeting(97)).toBe('unknown');
  });

  /* A picker must never empty itself on the client's own ignorance. */
  it('offers an unreadable spell to both fields', () => {
    expect(castsOnSelf('unknown')).toBe(true);
    expect(castsOnOthers('unknown')).toBe(true);
  });

  it('keeps a self-only spell out of the party field and nowhere else', () => {
    expect(castsOnSelf('self')).toBe(true);
    expect(castsOnOthers('self')).toBe(false);
    expect(castsOnSelf('friendly')).toBe(true);
    expect(castsOnOthers('friendly')).toBe(true);
  });

  it('offers neither field a spell aimed at something hostile', () => {
    for (const targeting of ['enemy', 'enemies', 'creature', 'other'] as const) {
      expect(castsOnSelf(targeting)).toBe(false);
      expect(castsOnOthers(targeting)).toBe(false);
    }
  });

  /*
   * `healing rain` reaches everybody friendly in the room and the `Cast`
   * command has nowhere to put a name on one; a single-target friendly spell
   * takes the name.
   */
  it('drops the target word only where the realm says the spell is room-wide', () => {
    expect(castsBare('party')).toBe(true);
    expect(castsBare('self')).toBe(true);
    expect(castsBare('friendly')).toBe(false);
    expect(castsBare('unknown')).toBe(false);
  });
});
