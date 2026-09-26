import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoHeal } from '../AutoHeal';
import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { DEFAULT_CONFIG, type AutomationConfig, type SpellsConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '../../../shared/character';
import type { WorldSpell } from '../../../shared/world';

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
    expect(sent).toEqual(['minor healing']);
  });

  it('casts by the short word when the spellbook or the realm can name it', () => {
    const listed = state({ hp: 40 });
    listed.spellbook = [{ name: 'minor healing', short: 'mihe', level: null, cost: null }];
    make(spells()).onCharacter(listed);
    drain();
    expect(sent).toEqual(['mihe']);

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
    expect(sent).toEqual(['mihe Yang']);
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
    expect(sent).toEqual(['minor healing Yang']);
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
    expect(sent).toEqual(['minor healing', 'minor healing']);
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
    expect(sent).toEqual(['way of the swan']);

    sent.length = 0;
    // Healthy again, so the member is the one under the threshold.
    auto.onCharacter(state({ hp: 100 }, [member('Yang', 0.3)]));
    drain();
    expect(sent).toEqual(['minor healing Yang']);
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
    expect(sent).toEqual(['rain']);
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
      expect(sent).toEqual(['minor healing', 'minor healing']);
    });

    /* A ceiling of 0 is the single cast at the threshold, as before the pair. */
    it('stops at the floor when no ceiling is set', () => {
      const auto = make(spells({ healBelow: 0.5, healTo: 0 }));
      auto.onCharacter(state({ hp: 40 }));
      drain();
      vi.advanceTimersByTime(7000);
      auto.onCharacter(state({ hp: 60 }));
      drain();
      expect(sent).toEqual(['minor healing']);
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
      expect(sent).toEqual(['minor healing']);
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
      expect(sent).toEqual(['minor healing Yang', 'minor healing Yang']);
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
    expect(sent).toEqual(['minor healing']);
  });

  it('still heals in a fight once it is bad enough', () => {
    const auto = make(spells({ healBelow: 0.8, healBelowInCombat: 0.4 }));
    auto.onCharacter(fighting(30));
    drain();
    expect(sent).toEqual(['minor healing']);
  });

  /* 0 uses the ordinary floor for both, which is what this module did before
     the field existed — so the default changes nothing. */
  it('falls back to the ordinary floor when none is set', () => {
    const auto = make(spells({ healBelow: 0.8, healBelowInCombat: 0 }));
    auto.onCharacter(fighting(60));
    drain();
    expect(sent).toEqual(['minor healing']);
  });
});

/*
 * Choosing the heal — todo 01, 2026-09-13, in the player's own figures.
 *
 * A 150-point bar: five points missing wants the minor heal, sixty wants the
 * major one. The switch is `automation.spells.autoChoose`, the same one the
 * round spell is derived by.
 */
const HEAL_ROWS: Record<string, WorldSpell> = {
  'minor healing': {
    id: 30,
    name: 'minor healing',
    short: 'mihe',
    level: 1,
    mana: 2,
    targets: 2,
    power: [10, 20],
    abilities: [[18, 0]]
  },
  'major healing': {
    id: 31,
    name: 'major healing',
    short: 'mahe',
    level: 8,
    mana: 10,
    targets: 2,
    power: [40, 60],
    abilities: [[18, 0]]
  }
};
const HEAL_BOOK = [
  { name: 'minor healing', short: 'mihe', level: 1, cost: 2 },
  { name: 'major healing', short: 'mahe', level: 8, cost: 10 }
];

describe('choosing the heal from the spellbook', () => {
  let said: string[];
  const chooser = (config: SpellsConfig) =>
    new AutoHeal(config, true, queue, undefined, (name) => HEAL_ROWS[name] ?? null, {
      notice: (message) => said.push(message)
    });
  const bar = (hp: number, members: PartyMember[] = []): CharacterState => {
    const at = state({ hp, hpMax: 150, mana: 100, manaMax: 100 }, members);
    at.spellbook = HEAL_BOOK.map((spell) => ({ ...spell, level: spell.level ?? null }));
    at.progress = { ...at.progress, level: 20 };
    return at;
  };
  beforeEach(() => {
    said = [];
  });

  it('mends a scratch with the cheapest spell that covers it', () => {
    chooser(spells({ autoChoose: true, heal: '', healBelow: 1 })).onCharacter(bar(145));
    drain();
    expect(sent).toEqual(['mihe']);
  });

  it('mends a real wound with the most any one cast mends', () => {
    chooser(spells({ autoChoose: true, heal: '', healBelow: 0.7 })).onCharacter(bar(90));
    drain();
    expect(sent).toEqual(['mahe']);
  });

  /* The whole complaint: one configured spell is wrong at one end of the bar. */
  it('outranks the configured spell, which is what is cast with the switch off', () => {
    chooser(spells({ autoChoose: true, heal: 'minor healing', healBelow: 0.7 })).onCharacter(
      bar(90)
    );
    drain();
    expect(sent).toEqual(['mahe']);
    sent.length = 0;
    chooser(spells({ autoChoose: false, heal: 'minor healing', healBelow: 0.7 })).onCharacter(
      bar(90)
    );
    drain();
    expect(sent).toEqual(['mihe']);
  });

  /*
   * A heal not cast is a death, where a round spell not cast is a slower
   * fight — so a derivation that cannot answer falls back to the box.
   */
  it('falls back to the configured spell where the book cannot answer, and says so once', () => {
    const unread = bar(90);
    unread.spellbook = null;
    const healer = chooser(spells({ autoChoose: true, heal: 'minor healing', healBelow: 0.7 }));
    healer.onCharacter(unread);
    drain();
    // The realm names the short word even where this character's book is unread.
    expect(sent).toEqual(['mihe']);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.noChoice', { spell: 'minor healing' }));
    healer.onCharacter(unread);
    expect(said).toHaveLength(1);
  });

  it('casts nothing where neither the book nor the box can answer', () => {
    const unread = bar(90);
    unread.spellbook = null;
    chooser(spells({ autoChoose: true, heal: '', healBelow: 0.7 })).onCharacter(unread);
    drain();
    expect(sent).toEqual([]);
    expect(said).toHaveLength(1);
  });

  it('says the choice when it changes, and not on every status line', () => {
    const healer = chooser(spells({ autoChoose: true, heal: '', healBelow: 1, healTo: 1 }));
    healer.onCharacter(bar(145));
    drain();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('minor healing');
    healer.onCharacter(bar(145));
    drain();
    expect(said).toHaveLength(1);
    // The deficit moves past what a minor heal reaches: a different answer.
    vi.advanceTimersByTime(10_000);
    healer.onCharacter(bar(80));
    drain();
    expect(said).toHaveLength(2);
    expect(said[1]).toContain('major healing');
  });

  /* One member who cannot be chosen for does not stand in front of one who can. */
  it('goes on to the next member where the first states no figures', () => {
    const vague = member('Soul', 0.2);
    const stated = member('Yang', 0.2);
    stated.vitals = { hp: 30, hpMax: 150, mana: null, manaMax: null };
    chooser(
      spells({ autoChoose: true, heal: '', healParty: true, healPartyWith: '', healBelow: 0.5 })
    ).onCharacter(bar(150, [vague, stated]));
    drain();
    expect(sent).toEqual(['mahe Yang']);
  });

  /*
   * The listing gives a percentage, and a percentage cannot say how many hit
   * points a heal must cover: 30% of 4,434 and 30% of 62 are the same bar.
   */
  it('heals a member with the configured spell until their own client says the figures', () => {
    const config = spells({
      autoChoose: true,
      heal: '',
      healParty: true,
      healPartyWith: 'minor healing',
      healBelow: 0.5
    });
    chooser(config).onCharacter(bar(150, [member('Soul', 0.2)]));
    drain();
    expect(sent).toEqual(['mihe Soul']);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.noFiguresParty'));

    sent.length = 0;
    const answered = member('Soul', 0.2);
    answered.vitals = { hp: 30, hpMax: 150, mana: null, manaMax: null };
    chooser(config).onCharacter(bar(150, [answered]));
    drain();
    // 120 missing: the most one cast mends.
    expect(sent).toEqual(['mahe Soul']);
  });
});

/*
 * `@heal` — a member saying they are low. MegaMUD heals a member "when they are
 * low or when they have requested aid", and captures/081 has it answering
 * `Death telepaths: @heal` with `mend death` on the next prompt.
 */
describe('a member asking for a heal', () => {
  let said: string[];
  const healer = (over: Partial<SpellsConfig> = {}) => {
    said = [];
    return new AutoHeal(
      spells({ healParty: true, healPartyWith: 'minor healing', ...over }),
      true,
      queue,
      undefined,
      undefined,
      { notice: (message) => said.push(message) }
    );
  };

  it('heals a member who asked, whatever the listing says', () => {
    const auto = healer();
    const now = state({}, [member('Yang', 0.95)]);
    auto.request('Yang', now);
    auto.onCharacter(now);
    drain();
    expect(sent).toEqual(['minor healing Yang']);
  });

  it('takes the request as the number where the listing states none', () => {
    const auto = healer();
    const now = state({}, [member('Yang', null)]);
    auto.request('yang', now);
    auto.onCharacter(now);
    drain();
    expect(sent).toEqual(['minor healing Yang']);
  });

  it('casts once per request, not once per status line', () => {
    const auto = healer();
    const now = state({}, [member('Yang', 0.95)]);
    auto.request('Yang', now);
    auto.onCharacter(now);
    drain();
    vi.advanceTimersByTime(7000);
    auto.onCharacter(now);
    drain();
    expect(sent).toEqual(['minor healing Yang']);
  });

  it('keeps a request the cooldown held back, and casts it once the cooldown is over', () => {
    const auto = healer();
    auto.onCharacter(state({}, [member('Yang', 0.3)]));
    drain();
    vi.advanceTimersByTime(1000);
    const better = state({}, [member('Yang', 0.95)]);
    auto.request('Yang', better);
    auto.onCharacter(better);
    drain();
    expect(sent).toEqual(['minor healing Yang']);

    vi.advanceTimersByTime(6000);
    auto.onCharacter(better);
    drain();
    expect(sent).toEqual(['minor healing Yang', 'minor healing Yang']);
  });

  it('lets a request lapse that nothing could answer in time', () => {
    const auto = healer({ minMana: 0.5 });
    const dry = state({ mana: 10 }, [member('Yang', 0.95)]);
    auto.request('Yang', dry);
    auto.onCharacter(dry);
    vi.advanceTimersByTime(11_000);
    auto.onCharacter(state({}, [member('Yang', 0.95)]));
    drain();
    expect(sent).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.requestLowMana', { from: 'Yang' }));
  });

  it('is one cast, and leaves the ceiling to the thresholds', () => {
    const auto = healer({ healBelow: 0.5, healTo: 0.9 });
    auto.request('Yang', state({}, [member('Yang', 0.7)]));
    auto.onCharacter(state({}, [member('Yang', 0.7)]));
    drain();
    vi.advanceTimersByTime(7000);
    auto.onCharacter(state({}, [member('Yang', 0.8)]));
    drain();
    // 80% is over the floor and the request started no run up to `healTo`.
    expect(sent).toEqual(['minor healing Yang']);
  });

  it('refuses a request with the heal switched off', () => {
    const auto = healer({ healBelow: 0 });
    const now = state({}, [member('Yang', 0.3)]);
    auto.request('Yang', now);
    auto.onCharacter(now);
    drain();
    expect(sent).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.requestHealOff', { from: 'Yang' }));
  });

  /*
   * Spent when the cast leaves, not when it is queued: a heal dropped from the
   * queue unsent — the stat screen, a lost connection, its own expiry — is
   * still owed while the request stands.
   */
  it('spends the request when the cast leaves, not when it is queued', () => {
    const auto = healer();
    const now = state({}, [member('Yang', 0.95)]);
    queue.noteTyping(true);
    auto.request('Yang', now);
    auto.onCharacter(now);
    queue.clear();
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(7000);
    auto.onCharacter(now);
    drain();
    expect(sent).toEqual(['minor healing Yang']);
  });

  it('heals the member who asked ahead of one the listing has low', () => {
    const auto = healer();
    const now = state({}, [member('Brok', 0.3), member('Yang', 0.95)]);
    auto.request('Yang', now);
    auto.onCharacter(now);
    drain();
    auto.onCharacter(now);
    drain();
    expect(sent).toEqual(['minor healing Yang', 'minor healing Brok']);
  });

  it('says a request that lapsed with nothing sent', () => {
    // This character's own heal goes first, every cooldown, for the whole window.
    const auto = healer();
    const hurt = state({ hp: 10 }, [member('Yang', 0.95)]);
    auto.request('Yang', hurt);
    auto.onCharacter(hurt);
    vi.advanceTimersByTime(7000);
    auto.onCharacter(hurt);
    expect(said).toEqual([]);
    vi.advanceTimersByTime(4000);
    auto.onCharacter(hurt);
    drain();
    expect(sent).toEqual(['minor healing', 'minor healing']);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(
      t('automation.heal.requestLapsed', {
        from: 'Yang',
        seconds: Math.round(tuning().spells.healRequestMs / 1000)
      })
    );
  });

  it('refuses out loud, once per asker, where nothing would be cast', () => {
    const off = healer({ healParty: false });
    const now = state({}, [member('Yang', 0.3)]);
    off.request('Yang', now);
    off.request('Yang', now);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.requestPartyOff', { from: 'Yang' }));

    const noSpell = healer({ healPartyWith: '' });
    noSpell.request('Yang', now);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.requestNoSpell', { from: 'Yang' }));

    const stranger = healer();
    stranger.request('Rend', now);
    stranger.onCharacter(state({}, [member('Yang', 0.95)]));
    drain();
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(t('automation.heal.requestNotMember', { from: 'Rend' }));
    expect(sent).toEqual([]);
  });

  it('never takes an invitation for membership', () => {
    const auto = healer();
    const invited = { ...member('Rend', 0.2), invited: true };
    const now = state({}, [invited]);
    auto.request('Rend', now);
    auto.onCharacter(state({}, [{ ...member('Rend', 0.95), invited: true }]));
    drain();
    expect(sent).toEqual([]);
    expect(said[0]).toBe(t('automation.heal.requestNotMember', { from: 'Rend' }));
  });
});
