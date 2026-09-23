import { describe, expect, it } from 'vitest';

import {
  lairPass,
  passShare,
  lairPassage,
  appraiseRoom,
  prowessSheetOf,
  rankByPriority,
  rankByVerdict,
  roomVerdictKey,
  targetOf,
  verdictFor,
  wieldedWeapon,
  type Verdict
} from '../verdict';
import type { Menace, MenacePlayer, MenaceWeights } from '../menace';
import type { ProwessSheet } from '../prowess';
import type { MobEntity } from '../entities';
import type { MobRule, MobTreatment } from '../config';
import type { MobAttack } from '../world';
import { EMPTY_CHARACTER } from '../character';

const SHEET: ProwessSheet = {
  level: 10,
  agility: 60,
  intellect: 50,
  charm: 55,
  willpower: 50,
  health: 60,
  strength: 55,
  spellcasting: 40,
  combatLevel: 4,
  mageryLevel: null,
  encumbrancePercent: 20
};

const SWORD = { min: 5, max: 12, speed: 20, strength: 30 };

function menace(perRound: number, hp: number): Menace {
  return {
    perRound,
    blows: perRound,
    onDeath: 0,
    hp,
    weight: perRound / hp,
    hazards: [],
    wide: false
  };
}

describe('a verdict is both halves or it is honest about the missing one', () => {
  it('prices the fight in health, not in the monster’s numbers', () => {
    const result = verdictFor(
      menace(8, 120),
      { armourClass: 30, damageResist: 2, dodge: 10 },
      SHEET,
      SWORD,
      'greatermud'
    );
    expect(result.rounds?.from).toBe('bound');
    // The answer: what taking it on takes off this character.
    expect(result.cost?.value).toBeCloseTo(8 * result.rounds!.value, 6);
    expect(result.cost?.from).toBe('bound');
  });

  it('answers no cost when only one half is known', () => {
    // Half a product is not an estimate of it.
    const noRounds = verdictFor(menace(8, 120), {}, SHEET, null, 'greatermud');
    expect(noRounds.rounds).toBeNull();
    expect(noRounds.cost).toBeNull();
    expect(noRounds.menace).not.toBeNull();

    const noMenace = verdictFor(null, { hp: 120 }, SHEET, SWORD, 'greatermud');
    expect(noMenace.cost).toBeNull();
  });

  it('takes the health from the menace, which is the realm’s high end', () => {
    const tough = verdictFor(menace(8, 400), { armourClass: 30 }, SHEET, SWORD, 'greatermud');
    const easy = verdictFor(menace(8, 40), { armourClass: 30 }, SHEET, SWORD, 'greatermud');
    expect(tough.rounds!.value).toBeGreaterThan(easy.rounds!.value);
  });

  it('answers no rounds at all on a family with no formulas', () => {
    const other = verdictFor(menace(8, 120), { armourClass: 30 }, SHEET, SWORD, 'majormud');
    expect(other.rounds).toBeNull();
    expect(other.menace).not.toBeNull();
  });
});

describe('ranking on rounds rather than on health', () => {
  function verdict(perRound: number, hp: number, rounds: number | null): Verdict {
    return {
      menace: menace(perRound, hp),
      rounds: rounds === null ? null : { value: rounds, from: 'bound' },
      cost: rounds === null ? null : { value: perRound * rounds, from: 'bound' }
    };
  }

  it('reverses the order health alone would have given', () => {
    /*
     * The case health cannot see: two monsters with the same health and the
     * same damage, one of which takes four times as long to kill because this
     * character can barely hit it. `rankByMenace` calls them equal and takes
     * the first; the rounds say the quick one comes off the board first.
     */
    const slow = verdict(10, 100, 20);
    const quick = verdict(10, 100, 5);
    expect(slow.menace!.weight).toBe(quick.menace!.weight);
    expect(rankByVerdict([slow, quick])).toEqual([1, 0]);
  });

  it('still prefers the small nuisance over the big slow one', () => {
    // Smith's rule, unchanged: 30 a round over two rounds beats 50 a round
    // over thirty.
    const nuisance = verdict(30, 100, 2);
    const ogre = verdict(50, 3000, 30);
    expect(rankByVerdict([ogre, nuisance])).toEqual([1, 0]);
  });

  it('puts a monster it cannot cost after every one it can', () => {
    // Not a monster to open on. The two scales are not comparable, so the
    // fallbacks are ordered among themselves and placed last.
    const known = verdict(5, 100, 10);
    const unknown = verdict(90, 100, null);
    expect(rankByVerdict([unknown, known])).toEqual([1, 0]);
  });

  it('orders the uncostable ones among themselves by menace over health', () => {
    const worse = verdict(40, 100, null);
    const better = verdict(5, 100, null);
    expect(rankByVerdict([better, worse])).toEqual([1, 0]);
  });

  it('keeps a monster the realm cannot place first at all', () => {
    // `rankByMenace`'s own answer, and for its own reason: a monster nothing is
    // known about is the one this client has least right to walk past.
    const unplaced: Verdict = { menace: null, rounds: null, cost: null };
    expect(rankByVerdict([verdict(5, 100, 10), unplaced])).toEqual([1, 0]);
  });

  it('is stable where nothing separates two monsters', () => {
    const a = verdict(10, 100, 5);
    const b = verdict(10, 100, 5);
    expect(rankByVerdict([a, b])).toEqual([0, 1]);
  });
});

describe('what is being swung', () => {
  const sword = { equipped: true, kind: 'weapon', weapon: SWORD };
  const helm = { equipped: true, kind: 'armour', weapon: undefined };
  const spare = { equipped: false, kind: 'weapon', weapon: { min: 1, max: 2 } };

  it('is the equipped weapon and nothing else', () => {
    expect(wieldedWeapon([helm, sword, spare])).toBe(SWORD);
  });

  it('is nothing for a character fighting unarmed', () => {
    // Honest rather than convenient: martial arts is on the sheet and its
    // conversion to a damage range is not in hand.
    expect(wieldedWeapon([helm, spare])).toBeNull();
    expect(wieldedWeapon([])).toBeNull();
  });

  it('takes the first of two rather than choosing between them', () => {
    const second = { equipped: true, kind: 'weapon', weapon: { min: 50, max: 60 } };
    expect(wieldedWeapon([sword, second])).toBe(SWORD);
  });
});

describe('the monster’s side of the roll', () => {
  const thug: MobEntity = {
    name: 'thug',
    rawName: 'thug',
    source: 'hybrid',
    charmed: false,
    disposition: 'hostile',
    uncertain: false,
    costly: 'never',
    hp: 60,
    armour: 400,
    damageResist: 30,
    abilities: [
      [1, 5],
      [34, 12]
    ]
  };

  /* `PlayerAttackType.GetDefense` is `(AC + secondary) / 10`; the sheet's own
     figure is already divided, so the realm's column is divided here, once. */
  it('divides the realm’s armour and resistance by ten, and reads dodge off slot 34', () => {
    expect(targetOf(thug)).toEqual({ armourClass: 40, damageResist: 3, dodge: 12, hp: 60 });
  });

  it('claims nothing about a monster the realm cannot place', () => {
    expect(targetOf(undefined)).toEqual({});
    expect(targetOf({})).toEqual({});
  });
});

describe('the character’s side of the sheet', () => {
  it('reads the sheet and the class row, and the pack as a percentage', () => {
    const state = {
      progress: { ...EMPTY_CHARACTER.progress, level: 10, agility: 60, strength: 55 },
      inventory: { ...EMPTY_CHARACTER.inventory, encumbrance: 30, encumbranceMax: 120 }
    };
    const sheet = prowessSheetOf(state, { combat: 4, magery: null });
    expect(sheet.level).toBe(10);
    expect(sheet.agility).toBe(60);
    expect(sheet.combatLevel).toBe(4);
    expect(sheet.mageryLevel).toBeNull();
    expect(sheet.encumbrancePercent).toBe(25);
  });

  /* Unread is not light: the 33% threshold grants two bonuses below it, and an
     unread pack must not be granted them. */
  it('leaves the pack unknown when either figure is unread', () => {
    const state = {
      progress: EMPTY_CHARACTER.progress,
      inventory: { ...EMPTY_CHARACTER.inventory, encumbrance: 30, encumbranceMax: null }
    };
    expect(prowessSheetOf(state, { combat: null, magery: null }).encumbrancePercent).toBeNull();
  });
});

describe('the room, appraised', () => {
  const weights: MenaceWeights = {
    held: 1,
    confused: 0.5,
    blinded: 0.5,
    slowed: 0.25,
    afraid: 1,
    summon: 2,
    teleported: 1,
    roomWide: 2,
    lastingTicks: 20,
    unitFloor: 10,
    deathOverRounds: 5
  };
  const player: MenacePlayer = { armourClass: 30, damageResist: 2, magicRes: 0 };
  const bite: MobAttack = { kind: 'melee', chance: 1, accuracy: 45, min: 4, max: 9, energy: 1000 };
  const fighter = (name: string, over: Partial<MobEntity> = {}): MobEntity => ({
    name,
    rawName: name,
    source: 'hybrid',
    charmed: false,
    disposition: 'hostile',
    uncertain: false,
    costly: 'never',
    hp: 60,
    profiles: [{ attacks: [bite], casts: [] }],
    ...over
  });
  const occupant = (name: string, mob?: MobEntity, kind: 'mob' | 'player' | 'unknown' = 'mob') => ({
    name,
    kind,
    ...(mob === undefined ? {} : { mob })
  });

  it('prices every monster and sums what clearing the room costs', () => {
    const appraisal = appraiseRoom(
      [occupant('thug', fighter('thug')), occupant('nasty thug', fighter('nasty thug'))],
      player,
      weights,
      SHEET,
      SWORD,
      'greatermud'
    );
    expect(appraisal.monsters.map((entry) => entry.name)).toEqual(['thug', 'nasty thug']);
    const costs = appraisal.monsters.map((entry) => entry.verdict.cost?.value ?? 0);
    expect(costs.every((cost) => cost > 0)).toBe(true);
    expect(appraisal.cost).toEqual({ value: costs[0]! + costs[1]!, from: 'bound' });
  });

  /* A total that leaves out the one thing it could not weigh is smaller than
     the truth and looks the same, so the total is unknown instead. */
  it('answers an unknown total the moment one monster cannot be costed', () => {
    const appraisal = appraiseRoom(
      [occupant('thug', fighter('thug')), occupant('stranger', undefined, 'unknown')],
      player,
      weights,
      SHEET,
      SWORD,
      'greatermud'
    );
    expect(appraisal.monsters).toHaveLength(2);
    expect(appraisal.monsters[1]?.verdict.cost).toBeNull();
    expect(appraisal.cost).toBeNull();
  });

  it('leaves people out, and an empty room is nothing to appraise', () => {
    const people = appraiseRoom(
      [occupant('Naji', undefined, 'player')],
      player,
      weights,
      SHEET,
      SWORD,
      'greatermud'
    );
    expect(people.monsters).toEqual([]);
    expect(people.cost).toBeNull();
  });

  /* The MajorMUD lineage has no source behind it: rounds and cost are unknown,
     never borrowed from the other family's arithmetic. */
  it('answers unknown on a family whose arithmetic it does not have', () => {
    const appraisal = appraiseRoom(
      [occupant('thug', fighter('thug'))],
      player,
      weights,
      SHEET,
      SWORD,
      'majormud'
    );
    expect(appraisal.monsters[0]?.verdict.menace).not.toBeNull();
    expect(appraisal.monsters[0]?.verdict.rounds).toBeNull();
    expect(appraisal.cost).toBeNull();
  });

  /* The publisher pushes on the key changing: the names and the drawn figures.
     Two appraisals of one room key alike; a monster with a hundred times the
     health takes visibly more rounds and costs visibly more, and does not. */
  it('keys on what a reader would see', () => {
    const one = () =>
      appraiseRoom(
        [occupant('thug', fighter('thug'))],
        player,
        weights,
        SHEET,
        SWORD,
        'greatermud'
      );
    const tougher = appraiseRoom(
      [occupant('thug', fighter('thug', { hp: 6000 }))],
      player,
      weights,
      SHEET,
      SWORD,
      'greatermud'
    );
    expect(roomVerdictKey(one())).toBe(roomVerdictKey(one()));
    expect(roomVerdictKey(one())).not.toBe(roomVerdictKey(tougher));
  });
});

/*
 * What one pass through a lair takes, before anybody has seen what spawned:
 * a round of the worst monster that attacks on sight, as many as the lair
 * holds at once — never the cost of clearing it, which is the card's figure
 * and not the road's. Unknown is unknown — an unpriceable monster gives null,
 * never a reassuring zero — and the router prices null as nothing.
 */
describe('lairPassage', () => {
  const hitting = (perRound: number | null): Verdict => ({
    menace:
      perRound === null
        ? null
        : {
            perRound,
            blows: perRound,
            onDeath: 0,
            hp: 100,
            weight: perRound / 100,
            hazards: [],
            wide: false
          },
    rounds: null,
    // Clearing the room is priced elsewhere and must not leak into a pass.
    cost: perRound === null ? null : { value: perRound * 50, from: 'bound' }
  });
  const everybody = () => true;

  it('prices one round of the worst monster, as many as the lair holds', () => {
    // 30 a round from the worse of the two, twice over.
    expect(lairPassage([hitting(12), hitting(30)], 2, 1, everybody)).toBe(60);
    // One at a time when the lair states no count, or a count below one.
    expect(lairPassage([hitting(30)], null, 1, everybody)).toBe(30);
    expect(lairPassage([hitting(30)], 0, 1, everybody)).toBe(30);
    // A round longer inside is a round more of blows.
    expect(lairPassage([hitting(30)], 1, 2, everybody)).toBe(60);
  });

  it('walks past what does not attack on sight, and counts what nobody has read', () => {
    const only = (attacks: Array<boolean | null>) => (index: number) => attacks[index] ?? null;
    // The passive brute is not the worst monster of a pass; the hostile one is.
    expect(lairPassage([hitting(90), hitting(30)], 1, 1, only([false, true]))).toBe(30);
    // Unknown is not passive.
    expect(lairPassage([hitting(90), hitting(30)], 1, 1, only([null, true]))).toBe(90);
    expect(lairPassage([hitting(90)], 1, 1, only([false]))).toBeNull();
  });

  it('is null when nothing can be priced, and prices what it can', () => {
    expect(lairPassage([hitting(null)], 1, 1, everybody)).toBeNull();
    expect(lairPassage([], 1, 1, everybody)).toBeNull();
    // A lair is not made safe by one monster the arithmetic cannot see.
    expect(lairPassage([hitting(null), hitting(40)], 1, 1, everybody)).toBe(40);
  });

  /*
   * The second fact the router needs from the same pass: counting an unread
   * disposition in is right, and *pricing it as a certainty* is what closed a
   * corridor on a fact nobody had read.
   */
  describe('and whether the wire settles that it happens', () => {
    const only = (attacks: Array<boolean | null>) => (index: number) => attacks[index] ?? null;

    it('is sure when the worst monster is one the wire settles', () => {
      expect(lairPass([hitting(90), hitting(30)], 1, 1, only([true, null]))).toEqual({
        damage: 90,
        sure: true
      });
      // A passive one is not in the pass at all, so it cannot make it unsure.
      expect(lairPass([hitting(30), hitting(90)], 1, 1, only([true, false]))).toEqual({
        damage: 30,
        sure: true
      });
    });

    it('is unsure when the worst monster is one nobody can say will open', () => {
      expect(lairPass([hitting(90), hitting(30)], 1, 1, only([null, true]))).toEqual({
        damage: 90,
        sure: false
      });
      // Nothing certain at all is still a pass, and still unevidenced.
      expect(lairPass([hitting(90)], 1, 1, only([null]))).toEqual({ damage: 90, sure: false });
    });

    it('is null when the pass itself is', () => {
      expect(lairPass([hitting(90)], 1, 1, only([false]))).toBeNull();
      expect(lairPass([], 1, 1, everybody)).toBeNull();
    });
  });
});

/*
 * The cap that keeps *nobody has read this character's standing* from walling
 * a corridor — `edgePenalty`'s answer for a gate it cannot evaluate, one layer
 * down. A settled pass is priced at what it is, however bad.
 */
describe('passShare', () => {
  it('takes a settled pass against the health the character has now', () => {
    expect(passShare({ damage: 30, sure: true }, 60, 0.1)).toBe(0.5);
    // Uncapped upwards: a settled pass that takes the bar is a wall, and should be.
    expect(passShare({ damage: 120, sure: true }, 60, 0.1)).toBe(2);
  });

  it('caps an unevidenced pass, and leaves a mild one alone', () => {
    expect(passShare({ damage: 120, sure: false }, 60, 0.1)).toBe(0.1);
    // Below the cap the real share stands: the slope is kept, only the wall goes.
    expect(passShare({ damage: 3, sure: false }, 60, 0.1)).toBe(0.05);
  });

  it('prices nothing where nothing can be weighed', () => {
    expect(passShare(null, 60, 0.1)).toBeNull();
    // Unread health is not zero health, and a dead bar is not a divisor.
    expect(passShare({ damage: 30, sure: true }, null, 0.1)).toBeNull();
    expect(passShare({ damage: 30, sure: true }, 0, 0.1)).toBeNull();
  });
});

describe('the monster list, which replaces the weighing rather than ranking against it', () => {
  const rows = (...pairs: Array<[string, MobTreatment]>): MobRule[] =>
    pairs.map(([mob, treat]) => ({ mob, treat }));

  it('leaves the weighing alone when no row names anything in the room', () => {
    expect(rankByPriority(['gnoll', 'imp'], rows(['dragon', 'first']))).toBeNull();
  });

  it('leaves the weighing alone when there are no rows at all', () => {
    expect(rankByPriority(['gnoll', 'imp'], [])).toBeNull();
  });

  it('puts a first-band monster ahead of everything unlisted', () => {
    const order = rankByPriority(['rat', 'gnoll', 'dragon'], rows(['dragon', 'first']));
    expect(order?.[0]).toBe(2);
  });

  it('puts a last-band monster behind everything unlisted', () => {
    const order = rankByPriority(['rat', 'gnoll', 'imp'], rows(['rat', 'last']));
    expect(order).toEqual([1, 2, 0]);
  });

  it('orders the five bands exactly as they are written', () => {
    const order = rankByPriority(
      ['e', 'd', 'c', 'b', 'a'],
      rows(['a', 'first'], ['b', 'high'], ['c', 'default'], ['d', 'low'], ['e', 'last'])
    );
    // The names were listed worst-first, so a correct ranking reverses them.
    expect(order).toEqual([4, 3, 2, 1, 0]);
  });

  it('breaks a tie within a band on the order the room listed them', () => {
    const order = rankByPriority(['rat', 'gnoll'], rows(['rat', 'high'], ['gnoll', 'high']));
    expect(order).toEqual([0, 1]);
  });

  /*
   * The wire spells a monster four ways and the config file a fifth. A row
   * written `The Giant Rat` has to rank the `giant rat` the room printed, or
   * the list silently does nothing for the names people actually type.
   */
  it('matches a row against the name the wire spells, article and case aside', () => {
    const order = rankByPriority(['giant rat', 'gnoll'], rows(['The Giant Rat', 'last']));
    expect(order).toEqual([1, 0]);
  });

  /*
   * An unlisted monster is `default` rather than last: the list is somewhere to
   * add one row, so everything else keeps sitting in the middle where `high`
   * and `low` are defined against it.
   */
  it('sits an unlisted monster between the high and low bands', () => {
    const order = rankByPriority(
      ['low one', 'unlisted', 'high one'],
      rows(['low one', 'low'], ['high one', 'high'])
    );
    expect(order).toEqual([2, 1, 0]);
  });

  /*
   * A `never` row is a refusal, not a rank: `choose` declined that monster
   * long before this, so counting it as *listed* would take the whole room off
   * the realm's arithmetic on the strength of one nobody is fighting.
   */
  it('ignores a row that says never attack, rather than ranking on it', () => {
    expect(rankByPriority(['rat', 'gnoll'], rows(['rat', 'never']))).toBeNull();
  });

  it('still ranks on the bands beside a never row', () => {
    const order = rankByPriority(['rat', 'gnoll'], rows(['rat', 'never'], ['gnoll', 'first']));
    expect(order).toEqual([1, 0]);
  });
});
