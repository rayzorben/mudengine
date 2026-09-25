import { describe, expect, it } from 'vitest';

import { AttackSpells, type Action } from '../AttackSpells';
import type { Block } from '../../../shared/blocks';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { InstantSpellLore } from '../../../shared/lore';
import type { WorldSpell } from '../../../shared/world';

function block(type: string, groups: Record<string, string> = {}): Block {
  return { seq: 1, at: 0, type, domain: 'combat', groups, text: '', confidence: 1 } as Block;
}

const cast = (spell: string): Action => ({ kind: 'spell', spell, area: false, by: 'module' });

/** One of the server's own repeats of a combat spell, as the wire prints it: a blow. */
const repeat = (spell: string) =>
  block('user-hits', { attacker: 'You', line: `cast ${spell} at tall kobold thief`, damage: '15' });

function unit(): { spells: AttackSpells; notices: string[] } {
  const notices: string[] = [];
  const spells = new AttackSpells(
    { ...DEFAULT_CONFIG.automation.spells, attack: 'harm', autoChoose: false, minMana: 0 },
    { notice: (message) => notices.push(message) },
    () => null,
    () => ({ combat: null, magery: null, family: null })
  );
  return { spells, notices };
}

/*
 * 816's review, taken in 818: every cast into a fight is answered `*Combat
 * Off*` first (`BreakCombat(true)`, `Player.cs:6083`), so a spell re-sent
 * while the server still repeats it has the repeats arriving ahead of its
 * answer. A confirmation there is a repeat, and learning the spell instant
 * from it was the latent misread.
 */
describe('what answers a cast sent while the server repeats a spell', () => {
  it('does not take the repeat ahead of its Off for the answer', () => {
    const { spells, notices } = unit();
    spells.sent(cast('harm'));
    spells.heard(block('combat-status', { status: 'Engaged' }), null);
    spells.sent(cast('harm'));
    spells.heard(repeat('harm'), null);
    expect(notices.some((line) => /instant/.test(line))).toBe(false);
  });

  it('reads what follows the Off as the answer (the control)', () => {
    const { spells, notices } = unit();
    spells.sent(cast('harm'));
    spells.heard(block('combat-status', { status: 'Engaged' }), null);
    spells.sent(cast('hold person'));
    spells.heard(block('combat-status', { status: 'Off' }), null);
    spells.heard(
      block('spell-cast', { caster: 'You', spell: 'hold person', target: 'tall kobold thief' }),
      null
    );
    expect(notices.some((line) => /hold person is an instant spell/.test(line))).toBe(true);
  });

  it('reads a confirmation out of a fight as the answer, as before', () => {
    const { spells, notices } = unit();
    spells.sent(cast('hold person'));
    spells.heard(
      block('spell-cast', { caster: 'You', spell: 'hold person', target: 'tall kobold thief' }),
      null
    );
    expect(notices.some((line) => /hold person is an instant spell/.test(line))).toBe(true);
  });
});

/*
 * Todo 820, on review: what the wire taught is kept for the whole realm, so
 * the name it is kept under is the listing's, or the realm row's only where
 * the row matched the whole name. `word` is exalted, tainted and balanced
 * word in the shipped data, and the realm's lookup answers the first.
 */
describe('the name an instant spell is kept under for the realm', () => {
  const exalted: WorldSpell = { id: 1, name: 'exalted word', short: 'word' };
  const kept = (): InstantSpellLore & { held: Set<string> } => {
    const held = new Set<string>();
    return {
      held,
      isInstantSpell: (spell) => held.has(spell),
      observeInstantSpell: (spell) => void held.add(spell),
      forgetInstantSpell: (spell) => void held.delete(spell)
    };
  };
  const answered = (spells: AttackSpells, spell: string, book: CharacterState['spellbook']) => {
    spells.sent(cast('word'));
    spells.heard(
      block('spell-cast', { caster: 'You', spell, target: 'tall kobold thief' }),
      book === null ? null : { ...EMPTY_CHARACTER, spellbook: book }
    );
  };
  const withLore = (lore: InstantSpellLore) => {
    const notices: string[] = [];
    const spells = new AttackSpells(
      { ...DEFAULT_CONFIG.automation.spells, attack: 'word', autoChoose: false, minMana: 0 },
      { notice: (message) => notices.push(message) },
      (name) => (name === 'word' || name === 'exalted word' ? exalted : null),
      () => ({ combat: null, magery: null, family: null }),
      lore
    );
    return { spells, notices };
  };

  it('keeps nothing under a short word the realm guessed at, and says so', () => {
    const lore = kept();
    const { spells, notices } = withLore(lore);
    answered(spells, 'word', null);
    expect(lore.held.size).toBe(0);
    expect(notices.some((line) => /not kept past the connection/.test(line))).toBe(true);
  });

  it('keeps the listing’s name for the same word (the control)', () => {
    const lore = kept();
    const { spells } = withLore(lore);
    const book = [{ name: 'tainted word', short: 'word', level: 1, cost: 1 }];
    answered(spells, 'tainted word', book);
    expect([...lore.held]).toEqual(['tainted word']);
  });

  it('forgets a spell held instant once its cast is answered with an engagement', () => {
    const lore = kept();
    lore.held.add('tainted word');
    const { spells, notices } = withLore(lore);
    const book = [{ name: 'tainted word', short: 'word', level: 1, cost: 1 }];
    const state = { ...EMPTY_CHARACTER, spellbook: book };
    // The round's cast of a spell held instant, read back and said.
    spells.heard(block('status-line'), state);
    expect(spells.change(state, { name: 'kobold', entity: null, remaining: null }, 'a')).not.toBe(
      null
    );
    expect(notices.some((line) => /answered instantly on this realm/.test(line))).toBe(true);
    spells.sent(cast('word'));
    spells.heard(block('combat-status', { status: 'Off' }), state);
    spells.heard(block('combat-status', { status: 'Engaged' }), state);
    expect(lore.held.size).toBe(0);
    expect(notices.some((line) => /engaged after all/.test(line))).toBe(true);
  });
});
