/**
 * What a blessing does to the fight the simulator runs: a spell's abilities
 * read as the figures `menace.ts` and `prowess.ts` take, at a cast level.
 *
 * Each ability is read as the server reads it (GreaterMUD source): `AC` and
 * `DR` are internal points the sheet prints divided by ten
 * (`StatCommand`), `M.R.` adds to `MRes` as it stands, `Dodge` to
 * `DodgeBonus`, `Accuracy` replaces `CalcAccuracy`'s base of 1, `MaxDamage`
 * tops every blow (`Player.MaxDamage`), the martial rows move only their own
 * attack (`PunchAcc`, `PunchDamage` and the rest), `Crits` adds to
 * `Player.Crits`, `MaxHP` to `BonusMaxHP` and `HPRegen` is a percentage of
 * the regeneration tick, and `Speed` multiplies the weapon's speed
 * (`Player.Speed`). Stealth and backstab rows, and a poison immunity, are not
 * weighed. See mudengine-automation › *Recovery*. `gearEffect` reads the
 * gear worn into the same shape.
 *
 * Dependency-free, like everything in `shared/`.
 */
import { EFFECT_ABILITY, MARTIAL_ACCURACY_ABILITY, MARTIAL_DAMAGE_ABILITY } from './abilities';
import type { CharacterState } from './character';
import { abilitySum } from './light';
import { abilityValueAt, REALM_ARMOUR_SCALE, type MenacePlayer } from './menace';
import type { WorldSpell } from './world';

/** The three martial attacks, as the ability table names their rows. */
export type MartialKind = keyof typeof MARTIAL_DAMAGE_ABILITY;

/** Each martial attack's figure from its row in `rows`, read by `read`. */
function martialRows(
  rows: Readonly<Record<MartialKind, number>>,
  read: (id: number) => number
): Record<MartialKind, number> {
  return { punch: read(rows.punch), kick: read(rows.kick), jumpkick: read(rows.jumpkick) };
}

/** What blessings up, or the martial rows of worn gear, add to the character, in the units each reader takes. */
export interface BlessingEffect {
  /** Sheet armour class: the `AC` rows over ten. */
  armourClass: number;
  /** Sheet damage resistance: the `DR` rows over ten. */
  damageResist: number;
  magicRes: number;
  /** Points of `DodgeBonus`. */
  dodge: number;
  /** The `Accuracy` rows' sum, which `CalcAccuracy` takes in place of its base of 1. */
  accuracy: number;
  /** Added to the top of every blow. */
  maxDamage: number;
  martialAccuracy: Readonly<Record<MartialKind, number>>;
  martialDamage: Readonly<Record<MartialKind, number>>;
  /** Points of `Player.Crits`, per cent. */
  crits: number;
  maxHp: number;
  /** Per cent of the regeneration tick (`Player.HPRegen`). */
  hpRegen: number;
  /**
   * `Player.Speed`: the `Speed` rows multiplied, as a percentage of the
   * weapon's speed (energy a blow), `PLAIN_SPEED` for none. Below it is faster.
   */
  speed: number;
}

/** `Player.Speed` with no `Speed` row: the weapon's own speed. */
export const PLAIN_SPEED = 100;

/** A speed to three places, so an effect added and taken off again leaves exactly `PLAIN_SPEED`. */
function thousandthsOf(speed: number): number {
  return Math.round(speed * 1000) / 1000;
}

/** `Player.Speed`: each `Speed` row scales what the rows before it left, truncated as the server does. */
function speedOf(rows: ReadonlyArray<number>): number {
  return rows.reduce((speed, row) => Math.trunc((speed * row) / 100), PLAIN_SPEED);
}

/** Nothing up. */
export const NO_EFFECT: Readonly<BlessingEffect> = {
  armourClass: 0,
  damageResist: 0,
  magicRes: 0,
  dodge: 0,
  accuracy: 0,
  maxDamage: 0,
  martialAccuracy: { punch: 0, kick: 0, jumpkick: 0 },
  martialDamage: { punch: 0, kick: 0, jumpkick: 0 },
  crits: 0,
  maxHp: 0,
  hpRegen: 0,
  speed: PLAIN_SPEED
};

/**
 * What one spell up adds at a cast level, or null where it carries nothing
 * the simulator weighs: such a spell is not a blessing worth choosing.
 */
export function effectOf(spell: WorldSpell, level: number): BlessingEffect | null {
  const at = (ability: number): number => abilityValueAt(spell, ability, level) ?? 0;
  const effect: BlessingEffect = {
    armourClass: at(EFFECT_ABILITY.armourClass) / REALM_ARMOUR_SCALE,
    damageResist: at(EFFECT_ABILITY.damageResist) / REALM_ARMOUR_SCALE,
    magicRes: at(EFFECT_ABILITY.magicRes),
    dodge: at(EFFECT_ABILITY.dodge),
    accuracy: at(EFFECT_ABILITY.accuracy),
    maxDamage: at(EFFECT_ABILITY.maxDamage),
    martialAccuracy: martialRows(MARTIAL_ACCURACY_ABILITY, at),
    martialDamage: martialRows(MARTIAL_DAMAGE_ABILITY, at),
    crits: at(EFFECT_ABILITY.crits),
    maxHp: at(EFFECT_ABILITY.maxHp),
    hpRegen: at(EFFECT_ABILITY.hpRegen),
    // A spell with no `Speed` row reads 0 here, which is no row at all.
    speed: at(EFFECT_ABILITY.speed) || PLAIN_SPEED
  };
  return isNothing(effect) ? null : effect;
}

/** An effect taken off: every figure negated, and the speed inverted, so `sumEffects` and `blessedPlayer` remove it. */
export function negated(effect: BlessingEffect): BlessingEffect {
  const martial = (rows: Readonly<Record<MartialKind, number>>): Record<MartialKind, number> =>
    martialRows(rows, (value) => -value);
  return {
    armourClass: -effect.armourClass,
    damageResist: -effect.damageResist,
    magicRes: -effect.magicRes,
    dodge: -effect.dodge,
    accuracy: -effect.accuracy,
    maxDamage: -effect.maxDamage,
    martialAccuracy: martial(effect.martialAccuracy),
    martialDamage: martial(effect.martialDamage),
    crits: -effect.crits,
    maxHp: -effect.maxHp,
    hpRegen: -effect.hpRegen,
    speed: (PLAIN_SPEED * PLAIN_SPEED) / effect.speed
  };
}

/** Whether an effect moves no figure. */
export function isNothing(effect: BlessingEffect): boolean {
  return sumEffects([effect]) === null;
}

/** Several effects up at once, summed as `Ability.Sum` sums the rows; null where nothing moves. */
export function sumEffects(effects: ReadonlyArray<BlessingEffect>): BlessingEffect | null {
  const total = effects.reduce(add, NO_EFFECT);
  const moves = [
    total.armourClass,
    total.damageResist,
    total.magicRes,
    total.dodge,
    total.accuracy,
    total.maxDamage,
    total.crits,
    total.maxHp,
    total.hpRegen,
    ...Object.values(total.martialAccuracy),
    ...Object.values(total.martialDamage)
  ].some((value) => value !== 0);
  return moves || total.speed !== PLAIN_SPEED ? total : null;
}

/**
 * What the gear worn adds to the round: the `Accuracy`, `MaxDamage`, `Crits`
 * and `Speed` rows and the martial ones (`PunchDmg`, `PunchAcc` and the rest)
 * on every equipped item, as `Player.GetAbility` reads `WornItemAbilities`
 * beside the class and race rows. Clawed gloves are +3 and +3 (2026-10-03, a
 * Mystic whose punches were priced bare-handed). The armour rows are not
 * read: the sheet's printed armour class carries them. A figure `stat all`
 * stated carries all of this already, so it counts on the formula paths
 * only. Null where nothing worn has one.
 */
export function gearEffect(
  items: ReadonlyArray<{ equipped: boolean; abilities?: ReadonlyArray<readonly [number, number]> }>
): BlessingEffect | null {
  const worn = items.filter((item) => item.equipped).flatMap((item) => item.abilities ?? []);
  const sum = (id: number): number => abilitySum(worn, id);
  return sumEffects([
    {
      ...NO_EFFECT,
      accuracy: sum(EFFECT_ABILITY.accuracy),
      maxDamage: sum(EFFECT_ABILITY.maxDamage),
      crits: sum(EFFECT_ABILITY.crits),
      speed: speedOf(worn.filter(([id]) => id === EFFECT_ABILITY.speed).map(([, value]) => value)),
      martialAccuracy: martialRows(MARTIAL_ACCURACY_ABILITY, sum),
      martialDamage: martialRows(MARTIAL_DAMAGE_ABILITY, sum)
    }
  ]);
}

/**
 * The character with nothing up, from a state read while `buffs` were: the
 * sheet's armour, resistance and magic resistance and the bar's maximum carry
 * what is up, so it is taken off them, and the buffs and the `stat all` sheet
 * (whose figures carry them too) go. Dodge is the formula's (`prowess.dodge`)
 * and carries none. An unread figure stays unread. One state for every reader
 * that weighs blessings, so a buff going up or down moves none of them.
 */
export function bareStateOf(
  state: CharacterState,
  spellOf: (name: string) => WorldSpell | null
): CharacterState {
  // An unread level prices nothing that is up: what it carries cannot be told.
  const level = state.progress.level;
  const up = level === null ? null : effectsUp(state.buffs, spellOf, level);
  const less = (value: number | null, by: number): number | null =>
    value === null ? null : value - by;
  const { progress, vitals } = state;
  return {
    ...state,
    buffs: [],
    stated: null,
    progress:
      up === null
        ? progress
        : {
            ...progress,
            armourClass: less(progress.armourClass, up.armourClass),
            damageResist: less(progress.damageResist, up.damageResist),
            magicRes: less(progress.magicRes, up.magicRes)
          },
    vitals: up === null ? vitals : { ...vitals, hpMax: less(vitals.hpMax, up.maxHp) }
  };
}

/**
 * The character as a monster's blows meet it with an effect up: armour,
 * resistance, magic resistance and dodge. An unread figure stays unread,
 * since a blessing added to *unknown* is still unknown.
 */
export function blessedPlayer(player: MenacePlayer, effect: BlessingEffect): MenacePlayer {
  const plus = (value: number | null | undefined, by: number): number | null =>
    value === null || value === undefined ? null : value + by;
  return {
    ...player,
    armourClass: plus(player.armourClass, effect.armourClass),
    damageResist: plus(player.damageResist, effect.damageResist),
    magicRes: plus(player.magicRes, effect.magicRes),
    dodge: plus(player.dodge, effect.dodge)
  };
}

/**
 * Whether two spells cannot be up together: either names the other in a
 * `RemovesSpell` row, so casting it takes the other off (`Spell.cs`).
 */
export function exclusive(a: WorldSpell, b: WorldSpell): boolean {
  const removes = (from: WorldSpell, of: WorldSpell): boolean =>
    (from.abilities ?? []).some(
      ([id, value]) => id === EFFECT_ABILITY.removesSpell && value === of.id
    );
  return removes(a, b) || removes(b, a);
}

/**
 * The effects of what is up now, by each buff's own name at the character's
 * level: what the sheet's printed figures already carry. A buff the realm
 * cannot name moves nothing here.
 */
export function effectsUp(
  buffs: ReadonlyArray<{ spell: string }>,
  spellOf: (name: string) => WorldSpell | null,
  level: number
): BlessingEffect | null {
  return sumEffects(
    buffs.flatMap((buff) => {
      const spell = spellOf(buff.spell);
      const effect = spell === null ? null : effectOf(spell, level);
      return effect === null ? [] : [effect];
    })
  );
}

function add(a: BlessingEffect, b: BlessingEffect): BlessingEffect {
  const martial = (
    x: Readonly<Record<MartialKind, number>>,
    y: Readonly<Record<MartialKind, number>>
  ): Record<MartialKind, number> => ({
    punch: x.punch + y.punch,
    kick: x.kick + y.kick,
    jumpkick: x.jumpkick + y.jumpkick
  });
  return {
    armourClass: a.armourClass + b.armourClass,
    damageResist: a.damageResist + b.damageResist,
    magicRes: a.magicRes + b.magicRes,
    dodge: a.dodge + b.dodge,
    accuracy: a.accuracy + b.accuracy,
    maxDamage: a.maxDamage + b.maxDamage,
    martialAccuracy: martial(a.martialAccuracy, b.martialAccuracy),
    martialDamage: martial(a.martialDamage, b.martialDamage),
    crits: a.crits + b.crits,
    maxHp: a.maxHp + b.maxHp,
    hpRegen: a.hpRegen + b.hpRegen,
    speed: thousandthsOf((a.speed * b.speed) / PLAIN_SPEED)
  };
}
