import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoHeal } from '../AutoHeal';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type SpellsConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const spells = (over: Partial<SpellsConfig> = {}): SpellsConfig => ({
  ...DEFAULT_CONFIG.automation.spells,
  heal: 'minor healing',
  healBelow: 0.5,
  minMana: 0,
  ...over
});
const member = (name: string, health: number | null): PartyMember => ({
  name,
  activity: null,
  className: null,
  health,
  invited: false,
  vitals: null,
  mana: null,
  rank: null
});
function state(
  vitals: Partial<CharacterState['vitals']>,
  members: PartyMember[] = []
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 90, hpMax: 100, mana: 50, manaMax: 50, ...vitals },
    party: { following: null, members, engaged: {}, threatened: {} }
  };
}

let sent: string[];
let queue: CommandQueue;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});
const make = (config: SpellsConfig, enabled = true) => new AutoHeal(config, enabled, queue);
const drain = (): void => void vi.advanceTimersByTime(500);

describe('healing by a number', () => {
  it('heals itself bare — a targetless cast lands on the caster', () => {
    make(spells()).onCharacter(state({ hp: 40 }));
    drain();
    expect(sent).toEqual(['c minor healing']);
  });

  it('casts by the short word when the spellbook or the realm can name it', () => {
    const listed = state({ hp: 40 });
    listed.spellbook = [{ name: 'minor healing', short: 'mihe', level: null, cost: null }];
    make(spells()).onCharacter(listed);
    drain();
    expect(sent).toEqual(['c mihe']);

    sent.length = 0;
    const realm = new AutoHeal(
      spells({ healParty: true, healPartyWith: 'minor healing' }),
      true,
      queue,
      undefined,
      (name) => (name === 'minor healing' ? { id: 7, name: 'minor healing', short: 'mihe' } : null)
    );
    realm.onCharacter(state({}, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual(['c mihe Yang']);
  });

  it('does nothing above it, with no spell, or when unknown', () => {
    make(spells()).onCharacter(state({ hp: 60 }));
    make(spells({ heal: '' })).onCharacter(state({ hp: 10 }));
    make(spells()).onCharacter(state({ hp: 10, hpMax: null }));
    make(spells(), false).onCharacter(state({ hp: 10 }));
    drain();
    expect(sent).toEqual([]);
  });

  it('keeps the mana floor', () => {
    make(spells({ minMana: 0.5 })).onCharacter(state({ hp: 10, mana: 10 }));
    drain();
    expect(sent).toEqual([]);
  });

  it('heals a listed party member, and never one with no listing', () => {
    const auto = make(spells({ healParty: true, healPartyWith: 'minor healing' }));
    auto.onCharacter(state({}, [member('Soul', null), member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual(['c minor healing Yang']);
  });

  it('leaves the party alone unless told', () => {
    make(spells()).onCharacter(state({}, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual([]);
  });

  it('does not ask again while the last cast is in flight', () => {
    const auto = make(spells());
    auto.onCharacter(state({ hp: 40 }));
    drain();
    auto.onCharacter(state({ hp: 41 }));
    drain();
    vi.advanceTimersByTime(7000);
    auto.onCharacter(state({ hp: 41 }));
    drain();
    expect(sent).toEqual(['c minor healing', 'c minor healing']);
  });
  /*
   * The realm marks `way of the swan` castable on the caster alone, so the two
   * heal fields are two spells. A mystic's self heal in the party field used to
   * be the *only* way to configure this, and it armed `c swan <name>` once a
   * round for a refusal the server prints out loud in the room.
   */
  it('casts the party spell at a member and the self spell at itself', () => {
    const auto = make(
      spells({ heal: 'way of the swan', healParty: true, healPartyWith: 'minor healing' })
    );
    auto.onCharacter(state({ hp: 40 }, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual(['c way of the swan']);

    sent.length = 0;
    // Healthy again, so the member is the one under the threshold.
    auto.onCharacter(state({ hp: 100 }, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual(['c minor healing Yang']);
  });

  it('heals nobody in the party until a party spell is named', () => {
    make(spells({ healParty: true })).onCharacter(state({}, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A party-wide spell reaches everybody friendly and the `Cast` command has
   * nowhere to put a name on one, so the target word is dropped — from the
   * realm's own `Targets`, never from the spell's name.
   */
  it('casts a party-wide spell bare, with no member named', () => {
    const auto = new AutoHeal(
      spells({ healParty: true, healPartyWith: 'healing rain' }),
      true,
      queue,
      undefined,
      (name) =>
        name === 'healing rain'
          ? { id: 145, name: 'healing rain', short: 'rain', targets: 13 }
          : null
    );
    auto.onCharacter(state({}, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual(['c rain']);
  });

  describe('the heal ceiling', () => {
    /*
     * `healTo` is what stops a character hovering just under the floor casting
     * one spell a round for the whole fight: once started, healing continues
     * up to the ceiling rather than stopping the moment it clears the floor.
     */
    it('keeps healing above the floor until the ceiling is reached', () => {
      const auto = make(spells({ healBelow: 0.5, healTo: 0.9 }));
      auto.onCharacter(state({ hp: 40 }));
      drain();
      // Above the floor and under the ceiling: still being healed.
      vi.advanceTimersByTime(7000);
      auto.onCharacter(state({ hp: 60 }));
      drain();
      vi.advanceTimersByTime(7000);
      auto.onCharacter(state({ hp: 95 }));
      drain();
      expect(sent).toEqual(['c minor healing', 'c minor healing']);
    });

    /* A ceiling of 0 is the single cast at the threshold, as before the pair. */
    it('stops at the floor when no ceiling is set', () => {
      const auto = make(spells({ healBelow: 0.5, healTo: 0 }));
      auto.onCharacter(state({ hp: 40 }));
      drain();
      vi.advanceTimersByTime(7000);
      auto.onCharacter(state({ hp: 60 }));
      drain();
      expect(sent).toEqual(['c minor healing']);
    });

    /* Unknown is not low, and it does not continue a heal either. */
    it('drops a target whose health stops being stated', () => {
      const auto = make(spells({ healBelow: 0.5, healTo: 0.9 }));
      auto.onCharacter(state({ hp: 40 }));
      drain();
      vi.advanceTimersByTime(7000);
      auto.onCharacter(state({ hp: 60, hpMax: null }));
      drain();
      vi.advanceTimersByTime(7000);
      // Back with a figure, above the floor: the heal is over, not resumed.
      auto.onCharacter(state({ hp: 60 }));
      drain();
      expect(sent).toEqual(['c minor healing']);
    });

    it('carries the ceiling to a party member too', () => {
      const auto = make(
        spells({ healParty: true, healPartyWith: 'minor healing', healBelow: 0.5, healTo: 0.9 })
      );
      auto.onCharacter(state({}, [member('Yang', 0.3)]));
      drain();
      vi.advanceTimersByTime(7000);
      auto.onCharacter(state({}, [member('Yang', 0.7)]));
      drain();
      expect(sent).toEqual(['c minor healing Yang', 'c minor healing Yang']);
    });
  });
});

/*
 * A different floor while fighting — MegaMUD's `HpHealAtt%`, whose own
 * documentation says why: a heal cast at 80% mid-fight is a round spent not
 * hitting anything, and the round is what the fight is made of.
 */
describe('healing in a fight', () => {
  const fighting = (hp: number): CharacterState => ({ ...state({ hp }), inCombat: true });

  it('uses the combat floor while fighting and the ordinary one otherwise', () => {
    const auto = make(spells({ healBelow: 0.8, healBelowInCombat: 0.4 }));
    // 60% and in a fight: above the combat floor, so the round is left alone.
    auto.onCharacter(fighting(60));
    drain();
    expect(sent).toEqual([]);

    // The same 60% out of a fight is under the ordinary floor.
    vi.advanceTimersByTime(7000);
    auto.onCharacter(state({ hp: 60 }));
    drain();
    expect(sent).toEqual(['c minor healing']);
  });

  it('still heals in a fight once it is bad enough', () => {
    const auto = make(spells({ healBelow: 0.8, healBelowInCombat: 0.4 }));
    auto.onCharacter(fighting(30));
    drain();
    expect(sent).toEqual(['c minor healing']);
  });

  /* 0 uses the ordinary floor for both, which is what this module did before
     the field existed — so the default changes nothing. */
  it('falls back to the ordinary floor when none is set', () => {
    const auto = make(spells({ healBelow: 0.8, healBelowInCombat: 0 }));
    auto.onCharacter(fighting(60));
    drain();
    expect(sent).toEqual(['c minor healing']);
  });
});
