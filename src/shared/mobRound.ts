/**
 * One monster's round against the character, rolled blow by blow and cast by
 * cast, as MMUD Explorer's monster attack sim (`clsMonsterAttackSim.RunSim`)
 * runs it. `menace.ts` prices the same round as an expectation; this is the
 * draw, so a spear of dark energy lands as the 80 it is and not as the 25 a
 * round it averages (todo 03). Arithmetic that both read lives in `menace.ts`.
 * See mudengine-automation › *The verdict is also run as a fight*.
 */
import { between, type Random } from './dice';
import {
  facing,
  heldRoundsOf,
  landsOn,
  landsOnCaster,
  magicResistance,
  MOB_ATTEMPTS,
  mobSwingsPerRound,
  ROUND_ENERGY,
  scaledDuration,
  scaledPower,
  woundOf,
  type MenacePlayer,
  type MenaceSubject
} from './menace';
import { HAZARD_ABILITY } from './abilities';
import { copiesOf, drawSummons, summonsOf, type Summons } from './summons';
import { wardedFrom } from './spellWard';
import type { MobAttack, MobProfile, WorldSpell } from './world';

/** `Mob.DoCombat`: the energy carried into a round is held under 2,000. */
const ENERGY_CEILING = 1999;
/**
 * MME's effect clock: a lasting wound ticks at the end of every round, the
 * round it lands included, and once more at the start of every third, for a
 * three-second tick inside a five-second round.
 */
const EXTRA_TICK_EVERY = 3;

/** What one landed spell does, compiled once for this character. */
export interface SpellEffect {
  /** Health taken per application, low and high, magic resistance applied. */
  low: number;
  high: number;
  /** The chance the character's resistance refuses it outright. */
  resist: number;
  /** Effect ticks a lasting wound runs for; 0 wounds once, on the cast. */
  ticks: number;
  /** Rounds the character is held and cannot act; 0 holds nothing. */
  held: number;
  /** What it mends the monster by, where it lands on the caster. */
  mends: [number, number] | null;
  /** The monsters it brings into the room as it lands (`summons.ts`); none for most. */
  summons: Summons;
}

export type MobSlot =
  | {
      kind: 'melee';
      chance: number;
      energy: number;
      /** The hit roll and the dodge after it, against this character. */
      lands: number;
      min: number;
      max: number;
      onHit: SpellEffect | null;
    }
  | {
      kind: 'spell';
      chance: number;
      energy: number;
      castChance: number;
      effect: SpellEffect | null;
    };

/** A monster's way of fighting, against one character. */
export interface MobModel {
  slots: MobSlot[];
  /** Between-round casts, each with its marginal chance of the round's one roll. */
  casts: Array<{ chance: number; effect: SpellEffect | null }>;
  /** The character's damage resistance, taken off every blow. */
  resist: number;
}

/** What a monster carries from round to round. */
export interface MobState {
  energy: number;
  /** Its lasting wounds on the character: the roll, ticks left, and ticks since the last extra. */
  lasting: Array<{ from: SpellEffect; value: number; left: number; ticks: number }>;
}

export interface MobRoundOutcome {
  /** Health the character lost this round. */
  harm: number;
  /** Rounds from now the character is held for; 0 for none. */
  held: number;
  /** Health the monster mended on itself. */
  mended: number;
  /** The realm rows its casts brought into the room this round (a call for aid). */
  summoned: number[];
}

export function freshMobState(): MobState {
  return { energy: 0, lasting: [] };
}

/**
 * What a spell does to this character at a monster's cast level; null where
 * it does nothing the fight counts.
 */
export function spellEffect(
  spell: WorldSpell | undefined,
  level: number,
  player: MenacePlayer
): SpellEffect | null {
  if (spell === undefined) return null;
  const summons = summonsOf(spell);
  if (landsOnCaster(spell)) {
    const heals = (spell.abilities ?? []).find(
      ([id, value]) => id === HAZARD_ABILITY.heal && value >= 0
    );
    if (heals === undefined && summons.length === 0) return null;
    const mends: [number, number] | null =
      heals === undefined
        ? null
        : heals[1] !== 0
          ? [heals[1], heals[1]]
          : scaledPower(spell, level, 'mob');
    return { low: 0, high: 0, resist: 0, ticks: 0, held: 0, mends, summons };
  }
  // A worn item or ImmuPoison takes it off the character whole; its summons still come.
  if (wardedFrom(spell, player.ward)) {
    return summons.length === 0
      ? null
      : { low: 0, high: 0, resist: 0, ticks: 0, held: 0, mends: null, summons };
  }
  const wound = woundOf(spell, level, player);
  const held = heldRoundsOf(spell, level);
  if (wound === null && held === 0 && summons.length === 0) return null;
  return {
    low: Math.round(wound?.low ?? 0),
    high: Math.round(wound?.high ?? 0),
    resist: magicResistance(spell, player.magicRes).resist,
    ticks: wound === null ? 0 : scaledDuration(spell, level, 'mob'),
    held,
    mends: null,
    summons
  };
}

/** One realm row compiled against the character it fights. */
export function mobModel(
  subject: MenaceSubject,
  profile: MobProfile,
  player: MenacePlayer
): MobModel {
  const spells = subject.spells ?? {};
  const against = facing(player, subject);
  const slots = profile.attacks.map((attack: MobAttack): MobSlot => {
    if (attack.kind === 'melee') {
      return {
        kind: 'melee',
        chance: attack.chance,
        energy: attack.energy,
        lands: landsOn(attack.accuracy, against),
        min: attack.min,
        max: attack.max,
        // The hit spell rides at level zero — `ApplyMobCastSpell(this, targets, 0, true)`.
        onHit: attack.onHit === undefined ? null : spellEffect(spells[attack.onHit], 0, against)
      };
    }
    return {
      kind: 'spell',
      chance: attack.chance,
      energy: attack.energy,
      castChance: attack.castChance,
      effect: spellEffect(spells[attack.spell], attack.level, against)
    };
  });
  const casts = profile.casts.map((cast) => ({
    chance: cast.chance,
    effect: spellEffect(spells[cast.spell], cast.level, against)
  }));
  return { slots, casts, resist: Math.max(0, Math.trunc(player.damageResist ?? 0)) };
}

/**
 * One round, as `RunSim` walks it: a lasting wound due its extra tick takes
 * it, the round's energy is granted, up to `MOB_ATTEMPTS` slots are rolled
 * and paid for, one roll decides the between-round cast, and every lasting
 * wound ticks. A melee slot the energy cannot pay for ends the round and a
 * spell slot does not. A cast that fails costs half its energy, or nothing
 * for a lasting spell; one resisted costs half; one whose wound is already
 * running at the same roll is not an attempt and costs nothing.
 */
export function rollMobRound(random: Random, model: MobModel, state: MobState): MobRoundOutcome {
  const out: MobRoundOutcome = { harm: 0, held: 0, mended: 0, summoned: [] };
  for (const each of state.lasting) {
    if (each.ticks !== EXTRA_TICK_EVERY) continue;
    out.harm += each.value;
    each.left -= 1;
  }
  state.lasting = state.lasting.filter((each) => each.left > 0);
  state.energy = Math.min(ENERGY_CEILING, state.energy + ROUND_ENERGY);

  for (let attempt = 0; attempt < MOB_ATTEMPTS; attempt += 1) {
    const slot = pick(random, model.slots);
    if (slot === null) continue;
    if (state.energy < slot.energy) {
      if (slot.kind === 'melee') break;
      continue;
    }
    if (slot.kind === 'melee') {
      state.energy -= slot.energy;
      if (random() < slot.lands) {
        out.harm += Math.max(0, between(random, slot.min, slot.max) - model.resist);
        if (slot.onHit !== null) apply(random, slot.onHit, state, out);
      }
      if (state.energy < slot.energy) break;
      continue;
    }
    const half = Math.round(slot.energy / 2);
    if (random() >= slot.castChance) {
      state.energy -= (slot.effect?.ticks ?? 0) > 0 ? 0 : half;
      continue;
    }
    const landed = slot.effect === null ? 'landed' : apply(random, slot.effect, state, out);
    state.energy -= landed === 'landed' ? slot.energy : landed === 'resisted' ? half : 0;
  }

  const roll = random();
  let covered = 0;
  for (const cast of model.casts) {
    covered += cast.chance;
    if (roll >= covered) continue;
    if (cast.effect !== null) apply(random, cast.effect, state, out);
    break;
  }

  for (const each of state.lasting) {
    out.harm += each.value;
    each.left -= 1;
    each.ticks = each.ticks >= EXTRA_TICK_EVERY ? 1 : each.ticks + 1;
  }
  state.lasting = state.lasting.filter((each) => each.left > 0);
  return out;
}

/**
 * Every way a round can land something, with how often a round it does, as
 * this draw rolls it: a melee blow (its damage less resistance, and its hit
 * spell) at `mobSwingsPerRound`'s swings × chance × the hit roll, a spell slot
 * at swings × chance × the cast roll, a between-round cast at its marginal
 * chance. `swings` is a melee slot's swings before the hit roll, 0 for the
 * rest. The one weighting `expectedHarm`, `mobTerms` and `expectedSummons` read.
 */
function roundEffects(
  model: MobModel
): Array<{ swings: number; weight: number; blow: number; effect: SpellEffect | null }> {
  const swings = mobSwingsPerRound(model.slots);
  return [
    ...model.slots.map((slot) =>
      slot.kind === 'melee'
        ? {
            swings: swings * slot.chance,
            weight: swings * slot.chance * slot.lands,
            blow: Math.max(0, (slot.min + slot.max) / 2 - model.resist),
            effect: slot.onHit
          }
        : {
            swings: 0,
            weight: swings * slot.chance * slot.castChance,
            blow: 0,
            effect: slot.effect
          }
    ),
    ...model.casts.map((cast) => ({ swings: 0, weight: cast.chance, blow: 0, effect: cast.effect }))
  ];
}

/** A spell's damage per attempt, the resistance taken off, a lasting wound counted once per tick. */
function effectMean(effect: SpellEffect | null): number {
  return effect === null
    ? 0
    : ((effect.low + effect.high) / 2) * (1 - effect.resist) * Math.max(1, effect.ticks);
}

/**
 * A round's harm in expectation: what choosing a name's worst row is decided
 * on, as this draw deals it, a lasting wound counted once per tick it runs.
 */
export function expectedHarm(model: MobModel): number {
  return roundEffects(model).reduce(
    (sum, { weight, blow, effect }) => sum + weight * (blow + effectMean(effect)),
    0
  );
}

/**
 * A round's harm split into the terms the model is made of, for setting
 * beside what a fight's lines show (todo 26): the melee swings a round, the
 * share that land, a landed blow's damage, the casts that land a round and a
 * landed cast's damage (a hit spell counted as a cast, since the server
 * prints it as a line of its own). `expectedHarm` is their whole. A term with nothing
 * behind it (no melee slot, no cast) is null, not 0.
 */
export interface MobTerms {
  swings: number;
  lands: number | null;
  perHit: number | null;
  casts: number;
  perCast: number | null;
  harm: number;
}

export function mobTerms(model: MobModel): MobTerms {
  let swings = 0;
  let landed = 0;
  let hitDamage = 0;
  let casts = 0;
  let castDamage = 0;
  for (const { swings: tried, weight, blow, effect } of roundEffects(model)) {
    swings += tried;
    if (tried > 0) {
      landed += weight;
      hitDamage += weight * blow;
    }
    // A hit spell is a cast on the wire: its own line after the blow's.
    if (effect === null || effect.high <= 0) continue;
    casts += weight * (1 - effect.resist);
    castDamage += weight * effectMean(effect);
  }
  return {
    swings,
    lands: swings > 0 ? landed / swings : null,
    perHit: landed > 0 ? hitDamage / landed : null,
    casts,
    perCast: casts > 0 ? castDamage / casts : null,
    harm: expectedHarm(model)
  };
}

/**
 * The row that harms the most, in expectation as the draw deals it
 * (`expectedHarm`): a name holding several rows is met as its worst.
 */
export function worstModel(subject: MenaceSubject, player: MenacePlayer): MobModel {
  let worst: MobModel = { slots: [], casts: [], resist: 0 };
  let most = -1;
  for (const profile of subject.profiles ?? []) {
    const model = mobModel(subject, profile, player);
    const harm = expectedHarm(model);
    if (harm > most) {
      most = harm;
      worst = model;
    }
  }
  return worst;
}

/**
 * The copies of each row a round's casts bring in, in expectation as the draw
 * rolls them (`expectedHarm`'s weights, the resistance taken off): what the
 * survey prices a call for aid at.
 */
export function expectedSummons(model: MobModel): Map<number, number> {
  const out = new Map<number, number>();
  for (const { weight, effect } of roundEffects(model)) {
    if (effect === null) continue;
    for (const [row, copies] of copiesOf(effect.summons)) {
      out.set(row, (out.get(row) ?? 0) + weight * (1 - effect.resist) * copies);
    }
  }
  return out;
}

/**
 * An effect landing: `resisted` when the character's resistance refused it,
 * `running` when the same wound is already running at the same roll, which
 * `RunSim` does not count as an attempt.
 */
function apply(
  random: Random,
  effect: SpellEffect,
  state: MobState,
  out: MobRoundOutcome
): 'landed' | 'resisted' | 'running' {
  if (effect.mends !== null) {
    out.mended += between(random, effect.mends[0], effect.mends[1]);
    out.summoned.push(...drawSummons(random, effect.summons));
    return 'landed';
  }
  const value = effect.high > 0 ? between(random, effect.low, effect.high) : 0;
  const lasting = effect.ticks > 0 && value > 0;
  if (lasting && state.lasting.some((each) => each.from === effect && each.value === value)) {
    return 'running';
  }
  if (effect.resist > 0 && random() < effect.resist) return 'resisted';
  if (lasting) {
    state.lasting = state.lasting.filter((each) => each.from !== effect);
    state.lasting.push({ from: effect, value, left: effect.ticks, ticks: 0 });
  } else {
    out.harm += value;
  }
  out.held = Math.max(out.held, effect.held);
  /*
   * Only a cast that landed summons: `ApplySpellAbilities` rolls the target's
   * resistance and skips every ability on a resist (Spell.cs:1052-1108)
   * before the Summon case (1506), a blow's spell and a between-round cast alike.
   */
  out.summoned.push(...drawSummons(random, effect.summons));
  return 'landed';
}

/** A slot by its chance; null when the chances leave the attempt empty. */
function pick(random: Random, slots: readonly MobSlot[]): MobSlot | null {
  let roll = random();
  for (const slot of slots) {
    roll -= Math.max(0, slot.chance);
    if (roll < 0) return slot;
  }
  return null;
}
