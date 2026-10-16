import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, NO_PARTY, type CharacterState } from '../../../shared/character';
import { MessageBook, parseMessagesCsv } from '../../../shared/messages';
import type { StreamLine } from '../../../shared/types';
import { Classifier } from '../Classifier';
import { listedVitals, withMemberBars } from '../memberBars';
import { member } from '../presence';

/*
 * The user, 2026-10-10: Rayzor leading Brakkle, and Brakkle's bar on the Party
 * card stood still between listings while the room said every blow. Lines from
 * Rayzor's session log of that evening.
 */

const MONSTERS = new Set(['fierce zombie', 'crypt chanter', 'small lesser devourer']);
const classifier = new Classifier({
  present: () => ['fierce zombie', 'crypt chanter', 'small lesser devourer', 'Brakkle'],
  mob: (name: string) =>
    MONSTERS.has(name.toLowerCase())
      ? { disposition: 'hostile', uncertain: false, costly: 'never' }
      : undefined
} as never);

const after = (state: CharacterState, text: string): CharacterState => {
  const line = { seq: 1, at: 1, text, plain: text, terminator: 'newline' } as unknown as StreamLine;
  return withMemberBars(state, classifier.classify(line).block);
};

const leading = (vitals: { hp: number; hpMax: number } | null): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  name: 'Rayzor',
  party: {
    ...NO_PARTY,
    members: [
      member('Rayzor', { health: 1 }),
      member('Brakkle', {
        health: vitals === null ? 1 : vitals.hp / vitals.hpMax,
        vitals: vitals === null ? null : { ...vitals, mana: null, manaMax: null }
      })
    ]
  }
});

const brakkle = (state: CharacterState) => state.party.members.find((m) => m.name === 'Brakkle')!;

describe("a member's bar between listings", () => {
  it('takes every blow the room sees land on a member off their health', () => {
    let state = leading({ hp: 134, hpMax: 134 });
    for (const line of [
      'The fierce zombie bludgeons Brakkle for 4 damage!',
      'The crypt chanter touches Brakkle with a ghostly hand for 24 damage!',
      'The small lesser devourer slashes Brakkle for 12 damage!',
      'Brakkle is chilled for 1 damage!'
    ]) {
      state = after(state, line);
    }
    // The ghostly hand comes after Brakkle, and is taken off the end (todo 142).
    expect(brakkle(state).vitals?.hp).toBe(134 - 41);
    expect(brakkle(state).health).toBeCloseTo(93 / 134);
  });

  it("leaves the member's own blows and other people's alone", () => {
    const state = leading({ hp: 134, hpMax: 134 });
    expect(after(state, 'Brakkle critically impales fierce zombie for 68 damage!')).toBe(state);
    expect(after(state, 'The fierce zombie bludgeons Maude for 4 damage!')).toBe(state);
  });

  it('puts a heal cast on a member back, up to their maximum', () => {
    const state = leading({ hp: 100, hpMax: 134 });
    const healed = after(state, 'Rayzor casts minor healing on Brakkle, healing 16 damage!');
    expect(brakkle(healed).vitals?.hp).toBe(116);
    const full = after(healed, 'You cast minor healing on Brakkle, healing 40 damage!');
    expect(brakkle(full).vitals?.hp).toBe(134);
    expect(brakkle(full).health).toBe(1);
  });

  it('waits for the listing where no @health answer gave a maximum', () => {
    const state = leading(null);
    expect(after(state, 'The fierce zombie bludgeons Brakkle for 4 damage!')).toBe(state);
  });

  it("lays a listing's share over the figures, keeping them where the share still reads as them", () => {
    const held = { hp: 133, hpMax: 134, mana: null, manaMax: null };
    // 133/134 lists as 99%, rounded down: the figures stand.
    expect(listedVitals(held, 0.99, null)?.hp).toBe(133);
    // 58% is not 133/134: the bar moves to what the listing says.
    expect(listedVitals(held, 0.58, null)?.hp).toBe(78);
    expect(listedVitals(null, 0.58, null)).toBeNull();
  });

  /* Todo 142: Brackle rejoined with no figures on his row; his last answer said 693. */
  it("seeds a member with no figures from the registry's maximum and the listing's share", () => {
    const recalled = { hp: 673, hpMax: 693, mana: 31, manaMax: 51 };
    expect(listedVitals(null, 0.31, 0.05, recalled)).toEqual({
      hp: 215,
      hpMax: 693,
      mana: 3,
      manaMax: 51
    });
    expect(listedVitals(null, 0.31, null, recalled)).toMatchObject({ mana: null, manaMax: null });
    expect(listedVitals(null, null, null, recalled)).toBeNull();
    // Figures already held are the ones the share is laid over.
    const held = { hp: 600, hpMax: 600, mana: null, manaMax: null };
    expect(listedVitals(held, 0.5, null, recalled)?.hpMax).toBe(600);
  });

  it('reads a drain on a member, and the weapon after their name', () => {
    let state = leading({ hp: 134, hpMax: 134 });
    state = after(state, "Brakkle's life is drained for 6 damage!");
    state = after(state, 'Brakkle is drained of 4 life!');
    state = after(state, 'The fierce zombie smashes Brakkle with its arm for 10 damage!');
    expect(brakkle(state).vitals?.hp).toBe(134 - 20);
  });

  /*
   * captures/045: `You cast healing rain on your party, healing 12 damage!` is
   * the realm's message 15 (`messages.csv`, shipped), and the caster's own
   * line is the only one with a figure.
   */
  it('puts a party rain back on every member standing here', () => {
    const book = MessageBook.fromRows(
      parseMessagesCsv(
        [
          'number,kind,line1,line2,line3',
          '15,cast,"You cast %s on %s, healing %d damage!","%s casts %s on you!","%s casts %s on %s!"'
        ].join('\n')
      )
    );
    const tabled = new Classifier(
      { present: () => ['Brakkle'], mob: () => undefined } as never,
      undefined,
      undefined,
      undefined,
      (text) => book.match(text)
    );
    const text = 'You cast healing rain on your party, healing 12 damage!';
    const line = {
      seq: 1,
      at: 1,
      text,
      plain: text,
      terminator: 'newline'
    } as unknown as StreamLine;
    const rain = tabled.classify(line).block;
    expect(rain).toMatchObject({ type: 'spell-cast', groups: { target: 'your party' } });
    const state = leading({ hp: 100, hpMax: 134 });
    const here = { ...state, room: { ...state.room, occupants: [{ name: 'Brakkle' }] } };
    expect(brakkle(withMemberBars(here as CharacterState, rain)).vitals?.hp).toBe(112);
    // Somebody not standing here is out of its reach.
    expect(withMemberBars(state, rain)).toBe(state);
  });
});
