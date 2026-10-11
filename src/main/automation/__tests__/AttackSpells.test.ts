import { describe, expect, it } from 'vitest';

import { AttackSpells, type Action } from '../AttackSpells';
import { t } from '../../app/i18n';
import { notesOf } from '../../app/copyMatch';
import type { Block } from '../../../shared/blocks';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { NO_EFFECTS_KEPT, type InstantSpellLore } from '../../../shared/lore';
import type { RealmFamily } from '../../../shared/realm';
import { statedBasis } from '../../../shared/stated';
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
    () => ({ combat: null, magery: null, crits: 0, family: null })
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
  /** Every notice that says a spell is instant, whichever way it was learned. */
  const INSTANT_VERDICTS = [
    'automation.combat.spellInstant',
    'automation.combat.spellInstantUnkept',
    'automation.combat.spellInstantRemembered'
  ];

  it('does not take the repeat ahead of its Off for the answer', () => {
    const { spells, notices } = unit();
    spells.sent(cast('harm'));
    spells.heard(block('combat-status', { status: 'Engaged' }), null);
    spells.sent(cast('harm'));
    spells.heard(repeat('harm'), null);
    // No instant verdict of any kind, for any spell: the repeat answers nothing.
    expect(notesOf(notices, ...INSTANT_VERDICTS)).toEqual([]);
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
    expect(notices).toContain(t('automation.combat.spellInstantUnkept', { spell: 'hold person' }));
    // And the matcher the test above relies on finds it, and only it.
    expect(notesOf(notices, ...INSTANT_VERDICTS)).toEqual([
      t('automation.combat.spellInstantUnkept', { spell: 'hold person' })
    ]);
  });

  it('reads a confirmation out of a fight as the answer, as before', () => {
    const { spells, notices } = unit();
    spells.sent(cast('hold person'));
    spells.heard(
      block('spell-cast', { caster: 'You', spell: 'hold person', target: 'tall kobold thief' }),
      null
    );
    expect(notices).toContain(t('automation.combat.spellInstantUnkept', { spell: 'hold person' }));
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
      () => ({ combat: null, magery: null, crits: 0, family: null }),
      { ...NO_EFFECTS_KEPT, ...lore }
    );
    return { spells, notices };
  };

  it('keeps nothing under a short word the realm guessed at, and says so', () => {
    const lore = kept();
    const { spells, notices } = withLore(lore);
    answered(spells, 'word', null);
    expect(lore.held.size).toBe(0);
    expect(notices).toContain(t('automation.combat.spellInstantUnkept', { spell: 'word' }));
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
    expect(
      spells.change(state, { name: 'kobold', entity: null, remaining: null }, 'a', 'a')
    ).not.toBe(null);
    expect(notices).toContain(t('automation.combat.spellInstantRemembered', { spell: 'word' }));
    spells.sent(cast('word'));
    spells.heard(block('combat-status', { status: 'Off' }), state);
    spells.heard(block('combat-status', { status: 'Engaged' }), state);
    expect(lore.held.size).toBe(0);
    expect(notices).toContain(t('automation.combat.spellNotInstant', { spell: 'word' }));
  });
});

/*
 * Todo 828: MegaMUD breaks an area spell that has finished the room on stock
 * realms only; GreaterMUD's `DoMagicRound` breaks it itself (`Player.cs:6326`).
 */
describe('breaking an area spell that has emptied the room', () => {
  const monster = (name: string): RoomOccupant => ({
    name,
    kind: 'mob',
    disposition: null,
    uncertain: false,
    costly: 'never',
    charmed: false,
    hidden: false,
    free: false
  });
  const room = (...occupants: RoomOccupant[]): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: { ...EMPTY_CHARACTER.room, occupants }
  });
  const area: Action = { kind: 'spell', spell: 'fireball', area: true, by: 'module' };

  function repeating(family: RealmFamily | null, action: Action = area): AttackSpells {
    const spells = new AttackSpells(
      { ...DEFAULT_CONFIG.automation.spells, areaAttack: 'fireball', minMana: 0 },
      {},
      () => null,
      () => ({ combat: null, magery: null, crits: 0, family })
    );
    spells.sent(action);
    return spells;
  }

  const two = room(monster('war dog'), monster('war dog'));
  const one = room(monster('war dog'));
  const none = room();

  it('breaks once when the last monster goes on a MajorMUD realm', () => {
    const spells = repeating('majormud');
    expect(spells.breakEmptied(two, one)).toBe(null);
    const stop = spells.breakEmptied(one, none);
    expect(stop?.command).toBe('break');
    expect(stop?.reason).toBe(t('automation.combat.reasonBreakEmptyRoom', { spell: 'fireball' }));
    // The break's send ends what the server repeats.
    spells.fightEnded();
    expect(spells.breakEmptied(one, none)).toBe(null);
  });

  it('sends nothing while a monster is left (the control)', () => {
    const spells = repeating('majormud');
    expect(spells.breakEmptied(two, one)).toBe(null);
    expect(spells.breakWanted(one)).toBe(false);
    expect(spells.breakWanted(none)).toBe(true);
  });

  it('leaves a GreaterMUD realm, an unknown one and a single-target spell alone', () => {
    expect(repeating('greatermud').breakEmptied(one, none)).toBe(null);
    expect(repeating(null).breakEmptied(one, none)).toBe(null);
    expect(repeating('majormud', cast('harm')).breakEmptied(one, none)).toBe(null);
    expect(repeating('majormud', { ...area, by: 'player' }).breakEmptied(one, none)).toBe(null);
    // A move into an empty room: the server ends the fight on its own.
    const elsewhere = { ...none, room: { ...none.room, name: 'Dark Alley' } };
    expect(repeating('majormud').breakEmptied(one, elsewhere)).toBe(null);
  });
});

/*
 * Rayzor, 2026-10-05: `harm` is `AffectsLivingOnly` and every zombie row is
 * `NonLiving`, so the server answers `Your spell has no effect on big zombie.`
 * and breaks the fight. The world database says so before the cast.
 */
describe('a spell the world database says has no effect', () => {
  const harm: WorldSpell = { id: 12, name: 'harm', level: 1, targets: 8, abilities: [[108, 0]] };
  const hammer: WorldSpell = {
    id: 16,
    name: 'spiritual hammer',
    short: 'hamm',
    level: 4,
    targets: 8
  };
  const book = [
    { name: 'harm', short: 'harm', level: 1, cost: 1 },
    { name: 'spiritual hammer', short: 'hamm', level: 4, cost: 2 }
  ];
  const fighting: CharacterState = {
    ...EMPTY_CHARACTER,
    spellbook: book,
    vitals: { ...EMPTY_CHARACTER.vitals, mana: 20, manaMax: 22, manaType: 'MA' }
  };
  const zombie = (nonLiving: boolean | null) => ({
    name: 'big zombie',
    entity: {
      name: 'zombie',
      rawName: 'big zombie',
      source: 'hybrid' as const,
      charmed: false,
      disposition: 'hostile' as const,
      uncertain: false,
      costly: 'never' as const,
      nature: { nonLiving, animal: false, undead: true, spellImmunity: [0, 0] as const }
    },
    remaining: null
  });
  const unit = (fallback: string) => {
    const notices: string[] = [];
    const spells = new AttackSpells(
      {
        ...DEFAULT_CONFIG.automation.spells,
        attack: 'harm',
        attackFallback: fallback,
        autoChoose: false,
        minMana: 0
      },
      { notice: (message) => notices.push(message) },
      (name) =>
        name === 'harm' ? harm : name === 'spiritual hammer' || name === 'hamm' ? hammer : null,
      () => ({ combat: null, magery: null, crits: 0, family: null })
    );
    return { spells, notices };
  };

  it('opens with the attack verb rather than the configured spell, and says why', () => {
    const { spells, notices } = unit('');
    expect(spells.opening(fighting, zombie(true), 'in the room', 'a')).toBeNull();
    expect(notices).toEqual([
      t('automation.combat.spellNoEffectKnown', { spell: 'harm', target: 'big zombie' })
    ]);
    // Said once for the fight, however often it is asked.
    expect(spells.opening(fighting, zombie(true), 'in the room', 'a')).toBeNull();
    expect(notices).toHaveLength(1);
  });

  it('says it once per monster for the connection', () => {
    const { spells, notices } = unit('');
    expect(spells.opening(fighting, zombie(true), 'in the room', 'a')).toBeNull();
    spells.fightEnded();
    // Still ruled out on the next fight with one, without saying it again.
    expect(spells.opening(fighting, zombie(true), 'in the room', 'a')).toBeNull();
    expect(notices).toHaveLength(1);
    // Another monster is said once in its turn.
    expect(
      spells.opening(fighting, { ...zombie(true), name: 'small zombie' }, 'in the room', 'a')
    ).toBeNull();
    expect(notices).toEqual([
      t('automation.combat.spellNoEffectKnown', { spell: 'harm', target: 'big zombie' }),
      t('automation.combat.spellNoEffectKnown', { spell: 'harm', target: 'small zombie' })
    ]);
    // A new connection says it again.
    spells.reset();
    expect(spells.opening(fighting, zombie(true), 'in the room', 'a')).toBeNull();
    expect(notices).toHaveLength(3);
  });

  it('casts the fallback instead where one is set', () => {
    const { spells } = unit('hamm');
    expect(spells.opening(fighting, zombie(true), 'in the room', 'a')?.command).toBe(
      'hamm big zombie'
    );
  });

  it('casts it where the rows disagree, and on the living (the control)', () => {
    expect(unit('').spells.opening(fighting, zombie(null), 'in the room', 'a')?.command).toBe(
      'harm big zombie'
    );
    expect(unit('').spells.opening(fighting, zombie(false), 'in the room', 'a')?.command).toBe(
      'harm big zombie'
    );
  });
});

/*
 * Todo 54: the server runs one attack type a round, so a spell cast at a
 * monster the round's melee is expected to finish is mana spent on a kill the
 * swing makes anyway.
 */
describe('a spell held back while the melee round is expected to finish the monster', () => {
  const harm: WorldSpell = { id: 12, name: 'harm', level: 1, targets: 8, power: [5, 10] };
  const base: CharacterState = {
    ...EMPTY_CHARACTER,
    spellbook: [{ name: 'harm', short: 'harm', level: 1, cost: 1 }],
    vitals: { ...EMPTY_CHARACTER.vitals, mana: 20, manaMax: 22, manaType: 'MA' }
  };
  // `st a`'s row for the plain attack: two blows of 10 that every armour lets through.
  const armed: CharacterState = {
    ...base,
    stated: [
      {
        against: null,
        healthRegen: null,
        restingRegen: null,
        baseManaRegen: null,
        manaRegen: null,
        rounds: { attack: { swings: 2, accuracy: 200, min: 10, max: 10, crits: null } },
        basis: statedBasis(base)
      }
    ]
  };
  const kobold = (remaining: number | null) => ({ name: 'kobold', entity: null, remaining });
  const unit = (family: RealmFamily | null = 'greatermud') => {
    const notices: string[] = [];
    const spells = new AttackSpells(
      { ...DEFAULT_CONFIG.automation.spells, attack: 'harm', autoChoose: false, minMana: 0 },
      { notice: (message) => notices.push(message) },
      (name) => (name === 'harm' ? harm : null),
      () => ({ combat: null, magery: null, crits: 0, family })
    );
    return { spells, notices };
  };

  it('opens with the attack verb on a monster one round finishes, and says why once', () => {
    const { spells, notices } = unit();
    expect(spells.opening(armed, kobold(5), 'in the room', 'a')).toBeNull();
    expect(spells.opening(armed, kobold(5), 'in the room', 'a')).toBeNull();
    expect(notesOf(notices, 'automation.spells.heldForMelee')).toHaveLength(1);
  });

  it('swaps the repeated spell for the attack verb once the monster is that low', () => {
    const { spells } = unit();
    spells.sent(cast('harm'));
    expect(spells.change(armed, kobold(5), 'a', 'a')?.command).toBe('a kobold');
  });

  it('casts at a monster the round leaves standing (the control)', () => {
    const { spells, notices } = unit();
    expect(spells.opening(armed, kobold(500), 'in the room', 'a')?.command).toBe('harm kobold');
    expect(notesOf(notices, 'automation.spells.heldForMelee')).toEqual([]);
  });

  it('casts where the health, the swing or the verb is unknown', () => {
    expect(unit().spells.opening(armed, kobold(null), 'in the room', 'a')?.command).toBe(
      'harm kobold'
    );
    expect(unit().spells.opening(base, kobold(5), 'in the room', 'a')?.command).toBe('harm kobold');
    expect(unit('majormud').spells.opening(base, kobold(5), 'in the room', 'a')?.command).toBe(
      'harm kobold'
    );
    expect(unit().spells.opening(armed, kobold(5), 'in the room', '')?.command).toBe('harm kobold');
  });
});

/*
 * Todo 54, the second half: a monster worth less a point of mana than the
 * next one the room lists, where the pool cannot pay for both kills, is fought
 * with the attack verb so the mana goes on the better one.
 */
describe('a spell held back for a monster worth more of the mana', () => {
  const harm: WorldSpell = { id: 12, name: 'harm', level: 1, targets: 8, power: [5, 10] };
  const mob = (name: string, experience: number, hp: number): RoomOccupant => ({
    name,
    kind: 'mob',
    disposition: 'hostile',
    uncertain: false,
    costly: 'never',
    charmed: false,
    hidden: false,
    free: false,
    mob: {
      name,
      rawName: name,
      source: 'hybrid',
      charmed: false,
      disposition: 'hostile',
      uncertain: false,
      costly: 'never',
      experience,
      hp
    }
  });
  const rat = mob('rat', 5, 40);
  const at = (mana: number, ...others: RoomOccupant[]): CharacterState => ({
    ...EMPTY_CHARACTER,
    progress: { ...EMPTY_CHARACTER.progress, level: 5 },
    spellbook: [{ name: 'harm', short: 'harm', level: 1, cost: 2 }],
    vitals: { ...EMPTY_CHARACTER.vitals, mana, manaMax: 100, manaType: 'MA' },
    room: { ...EMPTY_CHARACTER.room, occupants: [rat, ...others] }
  });
  const target = { name: 'rat', entity: rat.mob ?? null, remaining: 40 };
  const unit = () => {
    const notices: string[] = [];
    const spells = new AttackSpells(
      { ...DEFAULT_CONFIG.automation.spells, attack: 'harm', autoChoose: false, minMana: 0 },
      { notice: (message) => notices.push(message) },
      (name) => (name === 'harm' ? harm : null),
      () => ({ combat: null, magery: null, crits: 0, family: 'greatermud' })
    );
    return { spells, notices };
  };

  it('fights with the attack verb when the pool pays for one kill and the orc is worth more', () => {
    const { spells, notices } = unit();
    expect(spells.opening(at(20, mob('orc', 500, 40)), target, 'in the room', 'a')).toBeNull();
    expect(spells.opening(at(20, mob('orc', 500, 40)), target, 'in the room', 'a')).toBeNull();
    expect(notesOf(notices, 'automation.spells.heldForWorth')).toHaveLength(1);
  });

  it('casts where the pool pays for both, or nothing better stands here (the controls)', () => {
    const rich = unit();
    expect(
      rich.spells.opening(at(100, mob('orc', 500, 40)), target, 'in the room', 'a')?.command
    ).toBe('harm rat');
    const alone = unit();
    expect(
      alone.spells.opening(at(20, mob('mouse', 1, 40)), target, 'in the room', 'a')?.command
    ).toBe('harm rat');
    expect(notesOf(alone.notices, 'automation.spells.heldForWorth')).toEqual([]);
  });

  it('casts where no swing lands, or the mana is unknown', () => {
    expect(
      unit().spells.opening(at(20, mob('orc', 500, 40)), target, 'in the room', '')?.command
    ).toBe('harm rat');
    const known = at(20, mob('orc', 500, 40));
    const blind = { ...known, vitals: { ...known.vitals, mana: null } };
    expect(unit().spells.opening(blind, target, 'in the room', 'a')?.command).toBe('harm rat');
  });
});

/*
 * Todo 55: with Auto Choose Best Spell on, the book's room spells follow
 * `areaAttack` by damage per mana, and the next takes over when the first
 * cannot be paid for.
 */
describe('the next room spell in the book', () => {
  const fireball: WorldSpell = {
    id: 1,
    name: 'fireball',
    level: 15,
    mana: 34,
    energy: 1000,
    targets: 12,
    abilities: [[17, 0]],
    power: [26, 40]
  };
  const swarm: WorldSpell = {
    id: 2,
    name: 'swarm',
    level: 12,
    mana: 28,
    energy: 1000,
    targets: 12,
    abilities: [[17, 0]],
    power: [17, 28]
  };
  const realm: Record<string, WorldSpell> = { fireball, swarm };

  function crowded(mana: number): CharacterState {
    return {
      ...EMPTY_CHARACTER,
      vitals: { ...EMPTY_CHARACTER.vitals, mana, manaMax: 100 },
      progress: { ...EMPTY_CHARACTER.progress, level: 30 },
      spellbook: [
        { name: 'fireball', short: 'fbal', level: 15, cost: 34 },
        { name: 'swarm', short: 'swar', level: 12, cost: 28 }
      ],
      combat: { ...EMPTY_CHARACTER.combat, attackers: ['orc', 'orc', 'orc'] }
    };
  }

  function unit(autoChoose: boolean): { spells: AttackSpells; notices: string[] } {
    const notices: string[] = [];
    const spells = new AttackSpells(
      {
        ...DEFAULT_CONFIG.automation.spells,
        autoChoose,
        areaAttack: 'fireball',
        areaMinMobs: 2,
        areaMinMana: 0,
        minMana: 0
      },
      { notice: (message) => notices.push(message) },
      (name) => realm[name] ?? null,
      () => ({ combat: null, magery: null, crits: 0, family: null })
    );
    return { spells, notices };
  }

  const target = { name: 'orc', entity: null, remaining: null };

  it('casts the typed room spell while the pool pays for it (the control)', () => {
    const { spells } = unit(true);
    expect(spells.change(crowded(60), target, 'a', 'a')?.command).toBe('fbal');
  });

  it('casts swarm when fireball cannot be paid for, and says so', () => {
    const { spells, notices } = unit(true);
    expect(spells.change(crowded(30), target, 'a', 'a')?.command).toBe('swar');
    expect(notices).toContain(
      t('automation.spells.roomTakeover', { first: 'fireball', spell: 'swarm' })
    );
  });

  it('keeps to the typed spell with Auto Choose Best Spell off', () => {
    const { spells } = unit(false);
    expect(spells.change(crowded(30), target, 'a', 'a')).toBe(null);
  });

  /*
   * Corrosion lowers the room's M.R. by 10 for 58 rounds at level 30; three
   * M.R. 80 monsters of 1,000 hit points hold out long enough for it to pay
   * (`roomspells.test.ts` has the arithmetic).
   */
  describe('with a debuff in the book', () => {
    const corrosion: WorldSpell = {
      id: 5,
      name: 'corrosion',
      level: 24,
      mana: 15,
      targets: 12,
      duration: 1,
      durationGrowth: [1, 4],
      cap: 40,
      abilities: [
        [2, 0],
        [36, -10],
        [7, -50]
      ],
      power: [-8, -8]
    };
    const withCorrosion: Record<string, WorldSpell> = { ...realm, corrosion };
    const resists = (name: string): RoomOccupant => ({
      name,
      kind: 'mob',
      disposition: 'hostile',
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false,
      mob: {
        name,
        rawName: name,
        source: 'hybrid',
        charmed: false,
        disposition: 'hostile',
        uncertain: false,
        costly: 'never',
        magicResist: 80,
        hp: 1000
      }
    });
    const tough = (magicResist: number | null): CharacterState => {
      const base = crowded(100);
      return {
        ...base,
        spellbook: [
          ...(base.spellbook ?? []),
          { name: 'corrosion', short: 'corr', level: 24, cost: 15 }
        ],
        room: {
          ...base.room,
          occupants: [resists('orc'), resists('goblin'), resists('kobold')].map((who) =>
            magicResist === null ? { ...who, mob: { ...who.mob!, magicResist: undefined } } : who
          )
        },
        combat: { ...base.combat, attackers: ['orc', 'goblin', 'kobold'] }
      };
    };
    const orc = (magicResist: number | null) => ({
      name: 'orc',
      entity: tough(magicResist).room.occupants[0]!.mob ?? null,
      remaining: 1000
    });
    const debuffing = (): { spells: AttackSpells; notices: string[] } => {
      const notices: string[] = [];
      const spells = new AttackSpells(
        {
          ...DEFAULT_CONFIG.automation.spells,
          autoChoose: true,
          areaAttack: 'fireball',
          areaMinMobs: 2,
          areaMinMana: 0,
          minMana: 0
        },
        { notice: (message) => notices.push(message) },
        (name) => withCorrosion[name] ?? null,
        () => ({ combat: null, magery: null, crits: 0, family: null })
      );
      return { spells, notices };
    };

    it('casts corrosion once, then the room spell on the next round', () => {
      const { spells, notices } = debuffing();
      const first = spells.change(tough(80), orc(80), 'a', 'a');
      expect(first?.command).toBe('corr');
      expect(notesOf(notices, 'automation.spells.debuffFirst')).toHaveLength(1);
      spells.sent(first!.action);
      expect(spells.change(tough(80), orc(80), 'a', 'a')?.command).toBe('fbal');
      // A new fight may cast it again.
      spells.fightEnded();
      expect(spells.change(tough(80), orc(80), 'a', 'a')?.command).toBe('corr');
    });

    it('casts the room spell straight away where no resistance was read (the control)', () => {
      const { spells, notices } = debuffing();
      expect(spells.change(tough(null), orc(null), 'a', 'a')?.command).toBe('fbal');
      expect(notesOf(notices, 'automation.spells.debuffFirst')).toEqual([]);
    });
  });
});
