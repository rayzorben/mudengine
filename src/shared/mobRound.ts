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
  if (landsOnCaster(spell)) {
    const heals = (spell.abilities ?? []).find(
      ([id, value]) => id === HAZARD_ABILITY.heal && value >= 0
    );
    if (heals === undefined) return null;
    const mends: [number, number] =
      heals[1] !== 0 ? [heals[1], heals[1]] : scaledPower(spell, level, 'mob');
    return { low: 0, high: 0, resist: 0, ticks: 0, held: 0, mends };
  }
  const wound = woundOf(spell, level, player);
  const held = heldRoundsOf(spell, level);
  if (wound === null && held === 0) return null;
  return {
    low: Math.round(wound?.low ?? 0),
    high: Math.round(wound?.high ?? 0),
    resist: magicResistance(spell, player.magicRes).resist,
    ticks: wound === null ? 0 : scaledDuration(spell, level, 'mob'),
    held,
    mends: null
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
  const out: MobRoundOutcome = { harm: 0, held: 0, mended: 0 };
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
 * A round's harm in expectation: what choosing a name's worst row is decided
 * on, as this draw deals it: `mobSwingsPerRound`'s swings, a lasting wound
 * counted once per tick it runs.
 */
export function expectedHarm(model: MobModel): number {
  const mean = (effect: SpellEffect | null): number =>
    effect === null
      ? 0
      : ((effect.low + effect.high) / 2) * (1 - effect.resist) * Math.max(1, effect.ticks);
  let perSwing = 0;
  for (const slot of model.slots) {
    if (slot.kind === 'melee') {
      const blow = Math.max(0, (slot.min + slot.max) / 2 - model.resist);
      perSwing += slot.chance * slot.lands * (blow + mean(slot.onHit));
    } else {
      perSwing += slot.chance * slot.castChance * mean(slot.effect);
    }
  }
  const casts = model.casts.reduce((sum, cast) => sum + cast.chance * mean(cast.effect), 0);
  return mobSwingsPerRound(model.slots) * perSwing + casts;
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
