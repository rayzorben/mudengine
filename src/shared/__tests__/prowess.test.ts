import { describe, expect, it } from 'vitest';

import {
  accuracy,
  BARE_HAND,
  castOdds,
  castsARound,
  manaARound,
  critChance,
  dodge,
  MAGERY,
  regeneration,
  martialRoundDamage,
  roundDamage,
  swing,
  swingsPerRound,
  type ProwessSheet
} from '../prowess';
import { dodgedFraction, hitChance } from '../menace';

/** A level-10 fighter with ordinary stats, every input read. */
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

const SWORD = { min: 5, max: 12, speed: 20, strength: 30, accuracy: 5 };

describe('the family is a parameter, and an unknown one answers nothing', () => {
  it('answers nothing at all on the lineage with no source', () => {
    // The MajorMUD lineage has captures and the fight log and no server source,
    // so every one of these is null rather than GreaterMUD's arithmetic wearing
    // the other family's hat.
    expect(accuracy(SHEET, SWORD, 'majormud')).toBeNull();
    expect(dodge(SHEET, 'majormud')).toBeNull();
    expect(swingsPerRound(SHEET, SWORD, 'majormud')).toBeNull();
    expect(castOdds({ mana: 10, difficulty: 15 }, SHEET, 'majormud')).toBeNull();
    expect(regeneration(SHEET, 50, 'majormud')).toBeNull();
  });

  it('answers nothing when the family itself is unknown', () => {
    expect(accuracy(SHEET, SWORD, null)).toBeNull();
    expect(regeneration(SHEET, 50, null)).toBeNull();
  });
});

describe('accuracy — Player.CalcAccuracy', () => {
  it('is the server’s integer arithmetic, term for term', () => {
    /*
     * base 1
     * + (15 - 20/10) = 13            enc 20% < 33
     * + ((floor(sqrt(10)) * 3) + ((8 + 5) - 2)) * 2 = ((3*3) + 11) * 2 = 40
     * + (60-50)/3 + (50-50)/6 + (55-50)/10 = 3 + 0 + 0 = 3
     * = 57, and the weapon is light enough to cost nothing
     */
    expect(accuracy(SHEET, SWORD, 'greatermud')).toEqual({ value: 57, from: 'bound' });
  });

  it('loses 15 to a weapon the character cannot lift', () => {
    const heavy = { ...SWORD, strength: 90 };
    expect(accuracy(SHEET, heavy, 'greatermud')?.value).toBe(42);
  });

  it('charges nothing for a weapon whose requirement the realm does not state', () => {
    // An absence must never be read as a penalty: `StrReq` missing is the realm
    // not saying, not a weapon that is too heavy.
    const unstated = { min: 5, max: 12, speed: 20 };
    expect(accuracy(SHEET, unstated, 'greatermud')?.value).toBe(57);
  });

  it('withholds the light-load bonus when the pack is unread', () => {
    // Unknown is never the reassuring answer: an unread encumbrance is taken as
    // heavy, so the bonus is not granted.
    expect(accuracy({ ...SHEET, encumbrancePercent: null }, SWORD, 'greatermud')?.value).toBe(44);
    expect(accuracy({ ...SHEET, encumbrancePercent: 80 }, SWORD, 'greatermud')?.value).toBe(44);
  });

  it('refuses outright when one input has never been read', () => {
    expect(accuracy({ ...SHEET, agility: null }, SWORD, 'greatermud')).toBeNull();
    expect(accuracy({ ...SHEET, combatLevel: null }, SWORD, 'greatermud')).toBeNull();
  });

  it('is source with no weapon in hand and a bound with one', () => {
    // With a weapon the accuracy abilities it may grant are invisible to the
    // client, so the figure can only be a floor.
    expect(accuracy(SHEET, null, 'greatermud')?.from).toBe('source');
    expect(accuracy(SHEET, SWORD, 'greatermud')?.from).toBe('bound');
    // An unread pack withholds the light-load bonus, so unarmed or not the
    // figure is a floor. Measured: 30 against the server's 45 with the pack
    // unread, the 15 short being exactly the bonus withheld.
    expect(accuracy({ ...SHEET, encumbrancePercent: null }, null, 'greatermud')?.from).toBe(
      'bound'
    );
  });
});

describe('dodge — Player.Dodge', () => {
  it('is the sum of three sheet figures and the light-load bonus', () => {
    // (55-50)/5 + 10/5 + (60-50)/3 = 1 + 2 + 3 = 6, + (10 - 2) = 14
    expect(dodge(SHEET, 'greatermud')).toEqual({ value: 14, from: 'bound' });
  });

  it('never goes below nothing', () => {
    const feeble = { ...SHEET, charm: 10, agility: 10, level: 1, encumbrancePercent: 90 };
    expect(dodge(feeble, 'greatermud')?.value).toBe(0);
  });
});

describe('what a defender’s dodge turns away', () => {
  it('is dodge² over the hit roll’s own denominator', () => {
    // acc 57 -> (57²/14)/10 = 23; dodge 14 -> 196/23 = 8 per cent.
    expect(dodgedFraction(14, 57)).toBeCloseTo(0.08, 5);
  });

  it('tapers above MME’s soft point, under its ceiling', () => {
    const raw = dodgedFraction(60, 57);
    // 3600/23 = 156, far above 55, so the excess is taken through the
    // triangular taper rather than counted whole: 55 + 26.
    expect(raw).toBeCloseTo(0.81, 5);
    expect(dodgedFraction(400, 57)).toBeLessThanOrEqual(0.98);
  });

  it('has an unknown dodge turning nothing away', () => {
    // The answer that makes the most swings land, which is the safe direction
    // for a character deciding what to attack.
    expect(dodgedFraction(null, 57)).toBe(0);
    expect(dodgedFraction(0, 57)).toBe(0);
  });
});

describe('swings per round — CalcEnergyUsed against 1,000', () => {
  /* By hand, in the server's integer order: divisor trunc((10·4 + 45)(60 +
     150)·1500 / 9000) = 2975; energy trunc(2,000,000 / 2975) = 672; the pack
     at 20% makes it trunc(672 · 85 / 100) = 571; 1000 / 571 to three places. */
  it('answers the server’s own fraction, to three decimals', () => {
    expect(swingsPerRound(SHEET, { ...SWORD, speed: 2000 }, 'greatermud')).toEqual({
      value: 1.751,
      from: 'source'
    });
  });

  /* The combat term is level × CombatLVL: the routine adds two and its caller
     subtracts two first. With the +2 left in, the divisor would be 3675 and
     the figure 2.165. */
  it('uses the class’s combat level whole, not plus two', () => {
    const value = swingsPerRound(SHEET, { ...SWORD, speed: 2000 }, 'greatermud')!.value;
    expect(value).toBe(1.751);
    expect(value).not.toBe(2.165);
  });

  /* An unread pack is taken as full — the fewest swings — so the answer is a
     floor: trunc(672 · 125 / 100) = 840, and 1000 / 840. */
  it('takes an unread pack as full and says the answer is a floor', () => {
    expect(
      swingsPerRound(
        { ...SHEET, encumbrancePercent: null },
        { ...SWORD, speed: 2000 },
        'greatermud'
      )
    ).toEqual({ value: 1.19, from: 'bound' });
  });

  it('can be less than one, as a bash on the sheet is', () => {
    // A very slow weapon: energy well over the round's 1,000.
    const slow = swingsPerRound(SHEET, { ...SWORD, speed: 20000 }, 'greatermud')!;
    expect(slow.value).toBeLessThan(1);
    expect(slow.value).toBeGreaterThan(0);
  });

  it('gives a slower weapon no more swings than a faster one', () => {
    const fast = swingsPerRound(SHEET, { ...SWORD, speed: 10 }, 'greatermud')!.value;
    const slow = swingsPerRound(SHEET, { ...SWORD, speed: 40 }, 'greatermud')!.value;
    expect(fast).toBeGreaterThanOrEqual(slow);
  });

  it('refuses when no weapon speed is known', () => {
    expect(swingsPerRound(SHEET, null, 'greatermud')).toBeNull();
    expect(swingsPerRound(SHEET, { min: 1, max: 2 }, 'greatermud')).toBeNull();
  });
});

describe('a swing at a target', () => {
  const target = { armourClass: 30, damageResist: 2, dodge: 10, health: 120 };

  it('lands less often against dodge than against none', () => {
    const dodged = swing(SHEET, SWORD, target, 'greatermud')!;
    const still = swing(SHEET, SWORD, { ...target, dodge: null }, 'greatermud')!;
    expect(dodged.lands.value).toBeLessThan(still.lands.value);
  });

  it('reports rounds to kill as a bound and never as an estimate', () => {
    const result = swing(SHEET, SWORD, target, 'greatermud')!;
    expect(result.rounds?.from).toBe('bound');
    expect(result.rounds!.value).toBeGreaterThan(0);
  });

  it('answers no rounds when the target’s health is not known', () => {
    const unknown = swing(SHEET, SWORD, { ...target, health: null }, 'greatermud')!;
    expect(unknown.rounds).toBeNull();
    // But what a blow does is still known, which is the point of keeping them
    // apart rather than returning one figure that is null for two reasons.
    expect(unknown.damage.value).toBeGreaterThan(0);
  });

  it('answers no rounds when nothing gets through the resistance', () => {
    const armoured = swing(SHEET, SWORD, { ...target, damageResist: 50 }, 'greatermud')!;
    expect(armoured.damage.value).toBe(0);
    expect(armoured.rounds).toBeNull();
  });

  it('refuses the whole swing on a family with no formula', () => {
    expect(swing(SHEET, SWORD, target, 'majormud')).toBeNull();
  });
});

describe('casts a round — Player.DoMagicRound', () => {
  it('spends the energy of each attempt out of a thousand, at most twenty', () => {
    expect(castsARound({ energy: 500 })).toBe(2);
    expect(castsARound({ energy: 333 })).toBe(3);
    expect(castsARound({ energy: 1000 })).toBe(1);
    expect(castsARound({ energy: 50 })).toBe(20);
    expect(castsARound({ energy: 1 })).toBe(20);
  });

  it('reads a row stating no energy, or none at all, as one attempt', () => {
    expect(castsARound({})).toBe(1);
    expect(castsARound({ energy: 0 })).toBe(1);
  });

  it('charges every attempt its listed cost where the odds are unread', () => {
    expect(manaARound({ energy: 500 }, 3, SHEET, 'majormud')).toBe(6);
    expect(manaARound({ energy: 500 }, null, SHEET, 'greatermud')).toBeNull();
  });
});

describe('cast odds — Spell.Cast', () => {
  it('is spellcasting plus the spell’s own difficulty, capped at certain', () => {
    // 40 + 15 = 55.
    expect(castOdds({ mana: 20, difficulty: 15 }, SHEET, 'greatermud')?.chance.value).toBeCloseTo(
      0.55,
      5
    );
    expect(castOdds({ mana: 20, difficulty: 200 }, SHEET, 'greatermud')?.chance.value).toBe(1);
  });

  it('keeps a negative difficulty negative', () => {
    // `ethereal shield` is -5 on the Paradigm database: a spell that is harder
    // than the caster's figure suggests, not one that is neither.
    expect(castOdds({ mana: 20, difficulty: -5 }, SHEET, 'greatermud')?.chance.value).toBeCloseTo(
      0.35,
      5
    );
  });

  it('charges the failure, which is what makes the expected cost real', () => {
    // 0.55 x 20 + 0.45 x max(1, 10) = 11 + 4.5 = 15.5, against a listed 20.
    const odds = castOdds({ mana: 20, difficulty: 15 }, SHEET, 'greatermud')!;
    expect(odds.expectedMana?.value).toBeCloseTo(15.5, 5);
    expect(odds.expectedMana!.value).toBeLessThan(20);
  });

  it('charges at least one for a failure however cheap the spell', () => {
    const odds = castOdds({ mana: 1, difficulty: -100 }, SHEET, 'greatermud')!;
    expect(odds.expectedMana!.value).toBeGreaterThanOrEqual(1);
  });

  it('refuses when the realm does not state a difficulty', () => {
    // The realm's own zero is written out as absent, and a spell whose column
    // this client has never converted is the same shape. Neither may be read
    // as "as likely as your figure alone".
    expect(castOdds({ mana: 20 }, SHEET, 'greatermud')).toBeNull();
    expect(
      castOdds({ mana: 20, difficulty: 15 }, { ...SHEET, spellcasting: null }, 'greatermud')
    ).toBeNull();
  });
});

describe('regeneration — Player.cs:4813 and :4863', () => {
  it('is at least one health a tick, and resting is triple', () => {
    // max(1, (10+20) x 60 / 750) = max(1, 2) = 2
    const back = regeneration(SHEET, null, 'greatermud')!;
    expect(back.health).toEqual({ value: 2, from: 'bound' });
    expect(back.restingHealth.value).toBe(6);
  });

  it('never returns nothing to a frail character', () => {
    const frail = regeneration({ ...SHEET, level: 1, health: 10 }, null, 'greatermud')!;
    expect(frail.health.value).toBe(1);
  });

  it('answers no mana figure for a class that casts nothing', () => {
    expect(regeneration(SHEET, MAGERY.mage, 'greatermud')?.mana).toBeNull();
  });

  it('computes mana off the stat the class magery type names (GetBaseMARegen)', () => {
    const caster = { ...SHEET, mageryLevel: 3, intellect: 60, willpower: 40, charm: 80 };
    // (10+20) x 60 x (3+2) / 1650 = 9000/1650 = 5
    expect(regeneration(caster, MAGERY.mage, 'greatermud')?.mana).toEqual({
      value: 5,
      from: 'bound'
    });
    // WIL 40: 6000/1650 = 3; the mean 50: 7500/1650 = 4; CHM 80: 12000/1650 = 7
    expect(regeneration(caster, MAGERY.priest, 'greatermud')?.mana?.value).toBe(3);
    expect(regeneration(caster, MAGERY.druid, 'greatermud')?.mana?.value).toBe(4);
    expect(regeneration(caster, MAGERY.bard, 'greatermud')?.mana?.value).toBe(7);
    // A Mystic's tick is a flat 1.
    expect(regeneration(caster, MAGERY.mystic, 'greatermud')?.mana).toEqual({
      value: 1,
      from: 'bound'
    });
    // The type unknown: a figure off the wrong stat is worse than an absence.
    expect(regeneration(caster, null, 'greatermud')?.mana).toBeNull();
  });

  it('refuses when the sheet has not been read', () => {
    expect(regeneration({ ...SHEET, health: null }, null, 'greatermud')).toBeNull();
  });
});

/*
 * `stat all`'s own figures (`ProwessSheet.stated`) outrank every formula here,
 * gear and spells included, and need no family: nothing was computed.
 */
describe('what the server stated', () => {
  const STATED: ProwessSheet = {
    ...SHEET,
    stated: {
      accuracy: 105,
      swings: 3.584,
      health: 6,
      resting: 18,
      mana: 11,
      meditating: 8,
      damage: { min: 8, max: 25 }
    }
  };

  it('wins over the transcription, and says so', () => {
    expect(accuracy(STATED, SWORD, 'greatermud')).toEqual({ value: 105, from: 'stated' });
    expect(swingsPerRound(STATED, SWORD, 'greatermud')).toEqual({ value: 3.584, from: 'stated' });
  });

  /*
   * 2026-10-05, Festus's `st a`: a bash rolls `CalcAccuracy` on strength and
   * agility (`BashCombatRound.Acc`) at half the plain round's blows, and a
   * smash at half as much again as a bash's accuracy.
   */
  it('gives a bash and a smash their own accuracy and blows from the plain round', () => {
    // Plain stats term: (60−50)/3 + 0 + (55−50)/10 = 3. Bash's: (55−50)/3 + (60−50)/6 = 2.
    const target = { armourClass: 40, damageResist: 0, dodge: null, health: 100 };
    const bash = swing(STATED, SWORD, target, 'greatermud', { kind: 'bash', bonus: 0 })!;
    expect(bash.lands.value).toBe(hitChance(105 - 3 + 2 - 15, 40));
    expect(bash.swings).toEqual({ value: 1.792, from: 'stated' });
    const smash = swing(STATED, SWORD, target, 'greatermud', { kind: 'smash', bonus: 0 })!;
    expect(smash.lands.value).toBe(hitChance(Math.trunc(((105 - 3 + 2) * 3) / 2) - 25, 40));
    expect(smash.swings?.value).toBe(1);
  });

  it('is the server’s figure on any family, and for a bare hand', () => {
    expect(accuracy(STATED, null, 'majormud')).toEqual({ value: 105, from: 'stated' });
    expect(swingsPerRound(STATED, null, null)).toEqual({ value: 3.584, from: 'stated' });
  });

  it('states the regeneration, and keeps none for a class that casts nothing', () => {
    const regen = regeneration(STATED, null, 'greatermud')!;
    expect(regen.health).toEqual({ value: 6, from: 'stated' });
    expect(regen.restingHealth).toEqual({ value: 18, from: 'stated' });
    expect(regen.mana).toBeNull();
    expect(regen.meditatingMana).toBeNull();
  });

  /*
   * `TimedEventManager`: the passive tick adds `MARegen`, bonus and all, and
   * the meditating tick `GetBaseMARegen()` flat — the sheet's `8/11`.
   */
  it('meditates at the base rate and stands at the bonus rate', () => {
    const caster = regeneration({ ...STATED, mageryLevel: 2 }, null, 'greatermud')!;
    expect(caster.mana).toEqual({ value: 11, from: 'stated' });
    expect(caster.meditatingMana).toEqual({ value: 8, from: 'stated' });
  });

  it('takes the blow’s range off the sheet, and still rolls only on GreaterMUD', () => {
    const target = { armourClass: 0, damageResist: 0, dodge: null, health: 100 };
    const hit = swing(STATED, null, target, 'greatermud')!;
    // The stated range's mean, and a critical's share at three times its top.
    const crit = critChance(STATED, 'attack', 'greatermud')!.value;
    const top = STATED.stated!.damage!.max;
    expect(hit.damage.value).toBeCloseTo((1 - crit) * 16.5 + crit * 3 * top, 6);
    expect(hit.damage.from).toBe('stated');
    expect(hit.swings).toEqual({ value: 3.584, from: 'stated' });
    // The hit roll is GreaterMUD's arithmetic, whoever stated the accuracy.
    expect(swing(STATED, null, target, 'majormud')).toBeNull();
  });

  it('falls back to the arithmetic for what it does not state', () => {
    const partial: ProwessSheet = { ...SHEET, stated: { health: 6, resting: 18 } };
    expect(accuracy(partial, SWORD, 'greatermud')).toEqual({ value: 57, from: 'bound' });
    expect(regeneration(partial, null, 'greatermud')?.health.from).toBe('stated');
  });
});

describe('damage a round, by how the weapon is swung', () => {
  const blade = { min: 10, max: 20, speed: 1500 };

  it('is blows a round times the mean blow for an attack', () => {
    const swings = swingsPerRound({ ...SHEET, stated: null }, blade, 'greatermud');
    const round = roundDamage(SHEET, blade, 'attack', 'greatermud');
    expect(swings).not.toBeNull();
    expect(round?.value).toBeCloseTo(Math.min(6, swings!.value) * 15, 6);
    expect(round?.from).toBe('bound');
  });

  it('prices a smash as one blow at five times a 1.2× range', () => {
    // floor(12) + floor(24) = 36, halved, times five.
    expect(roundDamage(SHEET, blade, 'smash', 'greatermud')?.value).toBeCloseTo(90, 6);
  });

  it('prices a bash as half the blows at 2.75 times a 1.1× range', () => {
    const attack = roundDamage(SHEET, blade, 'attack', 'greatermud')!.value;
    const bash = roundDamage(SHEET, blade, 'bash', 'greatermud')!.value;
    // Half the swings, 2.75 × (11 + 22) / 2 a blow against 15.
    expect(bash / attack).toBeCloseTo((0.5 * 2.75 * 16.5) / 15, 1);
  });

  it('ignores what stat all said about the weapon in hand', () => {
    const stated = { ...SHEET, stated: { swings: 5, damage: { min: 1, max: 2 } } };
    expect(roundDamage(stated, blade, 'attack', 'greatermud')).toEqual(
      roundDamage(SHEET, blade, 'attack', 'greatermud')
    );
  });

  it('answers nothing outside GreaterMUD', () => {
    expect(roundDamage(SHEET, blade, 'attack', 'majormud')).toBeNull();
  });
});

describe('a martial-arts round', () => {
  const bare = { ...SHEET, stated: null };

  it('takes its range from the level and its blows from the attack’s own speed', () => {
    // Level 10: a punch is 10/8 + 2 = 3 to (10 + 3)/4 + 6 = 9, at speed 1150.
    const swings = swingsPerRound(bare, { min: 3, max: 9, speed: 1150 }, 'greatermud')!.value;
    const punch = martialRoundDamage(bare, 'punch', 0, 'greatermud');
    expect(punch?.value).toBeCloseTo((Math.min(6, swings) * 12) / 2, 6);
    expect(punch?.from).toBe('bound');
  });

  it('adds the attack’s damage ability to both ends and multiplies a kick by 1.33', () => {
    // Level 10: a kick is 3 to 10/5 + 7 = 9, plus 2 at each end.
    const swings = swingsPerRound(bare, { min: 5, max: 11, speed: 1400 }, 'greatermud')!.value;
    const kick = martialRoundDamage(bare, 'kick', 2, 'greatermud')!.value;
    expect(kick).toBeCloseTo((Math.min(6, swings) * 16 * 1.33) / 2, 6);
  });

  it('knows nothing without a level or off the GreaterMUD lineage', () => {
    expect(martialRoundDamage({ ...bare, level: null }, 'jumpkick', 0, 'greatermud')).toBeNull();
    expect(martialRoundDamage(bare, 'jumpkick', 0, 'majormud')).toBeNull();
  });
});

/*
 * 2026-10-01: Soul, a Mystic who lost the staff in a death, kicked for 28 a
 * round while every hunting spot read unpriced, because a swing without a
 * weapon had no range.
 */
describe('a fight without a weapon', () => {
  const bare = { ...SHEET, stated: null };
  const target = { armourClass: 0, damageResist: 0, dodge: null, health: 60 };

  it('swings the bare hand, 1–3 at speed 1200, when nothing is wielded', () => {
    const fist = swing(bare, null, target, 'greatermud')!;
    const blows = Math.min(6, swingsPerRound(bare, BARE_HAND, 'greatermud')!.value);
    const crit = critChance(bare, 'attack', 'greatermud')!.value;
    expect(fist.range).toEqual({ low: 1, high: 3 });
    expect(fist.damage.value).toBeCloseTo((1 - crit) * 2 + crit * 9, 6);
    expect(fist.rounds?.value).toBeCloseTo(60 / (fist.lands.value * fist.damage.value * blows), 6);
  });

  it('prices a kick by its own range and multiplier, not the weapon in hand', () => {
    const kick = swing(bare, SWORD, target, 'greatermud', { kind: 'kick', bonus: 0 })!;
    const plain = swing(bare, null, target, 'greatermud')!;
    expect(kick.rounds!.value).toBeLessThan(plain.rounds!.value);
    // `KickCombatRound.AttackTypeAccMod`: a kick rolls at ten less accuracy.
    const armoured = { ...target, armourClass: 25 };
    const kicked = swing(bare, null, armoured, 'greatermud', { kind: 'kick', bonus: 0 })!;
    expect(kicked.lands.value).toBeLessThan(swing(bare, null, armoured, 'greatermud')!.lands.value);
    // Level 10: 3–9, times 1.33 and floored: 3–11, a mean of 7 and a critical of 33.
    const crit = critChance(bare, 'kick', 'greatermud')!.value;
    expect(kick.range).toEqual({ low: 3, high: 11 });
    expect(kick.damage.value).toBeCloseTo((1 - crit) * 7 + crit * 33, 6);
  });
});

describe('a critical blow', () => {
  it('is the stats’ share and a poor fighter’s bonus, capped at 65%', () => {
    // Level 10, intellect 50, agility 60, charm 55: 1 from the stats; combat 4 adds 3.
    expect(critChance(SHEET, 'attack', 'greatermud')).toEqual({ value: 0.04, from: 'bound' });
    const sharp = { ...SHEET, intellect: 400, combatLevel: 7 };
    expect(critChance(sharp, 'kick', 'greatermud')?.value).toBe(0.36);
    expect(critChance({ ...sharp, intellect: 900 }, 'kick', 'greatermud')?.value).toBe(0.65);
  });

  // The Mystic row's Crits 10 (2026-10-05): two thirds of Soul's 15 at level 14.
  it('counts the class and race rows’ crits', () => {
    expect(critChance({ ...SHEET, classCrits: 10 }, 'attack', 'greatermud')?.value).toBeCloseTo(
      0.14
    );
  });

  it('never comes of a bash or a smash, and is unknown off GreaterMUD', () => {
    expect(critChance(SHEET, 'bash', 'greatermud')).toEqual({ value: 0, from: 'source' });
    expect(critChance(SHEET, 'attack', 'majormud')).toBeNull();
  });
});

describe('strength in the blow', () => {
  it('raises the top of every range a point each ten over 50, and the bottom over 100', () => {
    const target = { armourClass: 0, damageResist: 0, dodge: null, health: 60 };
    const strong = { ...SHEET, stated: null, strength: 115 };
    expect(swing(strong, SWORD, target, 'greatermud')!.range).toEqual({ low: 6, high: 18 });
    expect(swing({ ...strong, strength: null }, SWORD, target, 'greatermud')!.range).toEqual({
      low: 5,
      high: 12
    });
  });
});
