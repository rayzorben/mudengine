import { describe, expect, it } from 'vitest';

import { CLASS_TITLES, titleReading } from '../titles';

describe('titleReading', () => {
  /*
   * The corpus and the live realm, which are the only two places this table has
   * ever been checked against. `Monk` is the capture the `who` pattern cites as
   * proof that a rank title is not a class name — read here as the Mystic band
   * it actually is.
   */
  it('reads the titles both realms have printed', () => {
    expect(titleReading('Monk')).toEqual({ classes: ['Mystic'], from: 20, to: 24 });
    expect(titleReading('Kai Warrior')).toEqual({ classes: ['Mystic'], from: 25, to: 29 });
    expect(titleReading('Squire')).toEqual({ classes: ['Paladin'], from: 10, to: 14 });
    expect(titleReading('Acolyte')).toEqual({ classes: ['Cleric'], from: 15, to: 19 });
    expect(titleReading('Spellslinger')).toEqual({ classes: ['Warlock'], from: 10, to: 14 });
  });

  it('keeps every class that wears a shared title, rather than picking one', () => {
    const reading = titleReading('Apprentice');
    expect(reading?.classes).toHaveLength(15);
    expect(reading?.from).toBe(1);
    expect(reading?.to).toBe(1);
  });

  /* A `who` row is read out of a fixed-width column and the chains carry
     trailing spaces of their own; neither side's spacing is trusted. */
  it('ignores the spacing and the case on either side', () => {
    expect(titleReading('  kai   warrior ')).toEqual(titleReading('Kai Warrior'));
    expect(titleReading('venerator')?.classes).toEqual(['Cleric']);
  });

  it('answers null for anything this table does not carry', () => {
    expect(titleReading('Dread Pirate')).toBeNull();
    expect(titleReading('')).toBeNull();
    expect(titleReading(null)).toBeNull();
    expect(titleReading(undefined)).toBeNull();
  });

  it('is fifteen chains of ascending, non-overlapping-per-name bands', () => {
    expect(Object.keys(CLASS_TITLES)).toHaveLength(15);
    for (const [className, bands] of Object.entries(CLASS_TITLES)) {
      expect(bands.length, className).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const [title, from, to] of bands) {
        expect(from, `${className} ${title}`).toBeGreaterThanOrEqual(1);
        expect(to, `${className} ${title}`).toBeGreaterThanOrEqual(from);
        expect(to, `${className} ${title}`).toBeLessThanOrEqual(100);
        // A name appears once per class: a chain that repeated one would make
        // the band a lie about which levels wear it.
        expect(seen.has(title), `${className} ${title}`).toBe(false);
        seen.add(title);
      }
      // Level 1 is `Apprentice` in every chain, and the chains start there.
      expect(bands[0]?.[1]).toBe(1);
    }
  });
});
