/**
 * What a monster is going to cost this character, and which of several to
 * hit first.
 *
 * Auto-combat used to take monsters in the order the room listed them, which
 * is the order the server printed and therefore the only order the client had
 * any reason to believe in — until the realm data could say how each one
 * fights. It can now (format 20): five attack slots with accuracy, damage,
 * energy and an on-hit spell, the spells cast between rounds with their odds
 * and cast level, and the spell cast on death. Against the character's own
 * armour class, damage resistance and magic resistance off the stat sheet,
 * that is enough to say how many hit points a round beside each monster is
 * expected to cost — so the client can kill the expensive one first.
 *
 * ## The arithmetic is the server's, not a heuristic
 *
 * Every formula here is transcribed from the GreaterMUD source and says which
 * routine it came from. `Mob.DoCombat` rolls a slot, spends its energy, rolls
 * to hit against `(AC / 10)²` over `(Acc² / 14) / 10`, takes `DR / 10` off the
 * blow, and applies the slot's hit spell when damage lands; the between-round
 * loop in `TimedEventManager` makes one roll per monster per round;
 * `Spell.RollAndApplySpellAbilities` scales power by cast level to the cap,
 * applies a damage ability on the cast and on every three-second effect tick
 * for the spell's duration, and lets a target's magic resistance turn a
 * resistable cast away. Where the server's reading and the wire disagree the
 * wire wins, and nothing here has been checked against a capture yet: the
 * figures are a *ranking*, and the trace prints them so a person can see what
 * the ranking was made from.
 *
 * ## What a hazard is worth
 *
 * A blow is hit points and needs no conversion. Paralysis, confusion, fear
 * and a summoned ally are not, and the unit they are converted into is **one
 * round of the whole room's blows against this character** — because that is
 * what a round spent unable to leave actually costs: everything else in the
 * room keeps swinging. The multipliers are judgement, and they live in
 * `tuning.menace` (`internal.yaml`) rather than here, so somebody who thinks a
 * round held is worth two rounds of damage can say so without a rebuild. The
 * unit has a floor for a room of pure casters, where a round of blows is
 * nothing and a round of paralysis still is not.
 *
 * ## Why the order is menace per hit point, not menace
 *
 * Two monsters, one doing 30 a round with 100 health and one doing 50 a round
 * with 3,000: the obvious order is the 50 first, and it is wrong. Killing the
 * small one takes a round or two and removes its 30 from every one of the
 * thirty rounds the big one then takes; killing the big one first means
 * taking both for thirty rounds. Minimising the damage absorbed over the whole
 * fight is ordering by *rate over time-to-remove* — Smith's rule — and the
 * time to remove a monster is proportional to its health. Whether the big
 * one kills the character in three rounds is the retreat threshold's question
 * and not this one's: no order helps with that.
 *
 * ## What the character's side contributes, and what it cannot
 *
 * The stat sheet's `Armour Class`, `Damage Resist` and `Magic Res` are the
 * exact figures the server divides its internal values down to
 * (`StatCommand` prints `AC / 10` and `DR / 10`), so a blow's hit chance and
 * size are computed as the server would. Dodge is not on the sheet and is
 * taken as none; a maximum not yet read is taken as the figure that makes
 * every blow land, because **unknown is never the reassuring answer**. The
 * character's own damage output is not known to the client at all, so the
 * time to kill is health alone; a factor equal for every monster in a room
 * changes no order.
 *
 * Dependency-free, like everything here: `AutoCombat` hands it the room and
 * the sheet, and the trace prints what came back.
 */
import { HAZARD_ABILITY } from './abilities';
import type { MobEntity } from './entities';
import type { MobAttack, MobProfile, WorldSpell } from './world';

/**
 * What of a monster's entity the weighing reads. An occupant the tracker
 * could attach no entity to weighs as `{}`: nothing known, which is `null`.
 */
export type MenaceSubject = Pick<MobEntity, 'hp' | 'deathSpell' | 'profiles' | 'spells'>;

/** The three sheet figures a blow or a cast is measured against. Null is *not read yet*. */
export interface MenacePlayer {
  armourClass: number | null;
  damageResist: number | null;
  magicRes: number | null;
}

/**
 * How a hazard that is not hit points is priced. `tuning.menace` — see
 * `TUNING_DEFAULTS` for what each is and why it sits where it does.
 */
export interface MenaceWeights {
  held: number;
  confused: number;
  blinded: number;
  slowed: number;
  afraid: number;
  summon: number;
  teleported: number;
  roomWide: number;
  lastingTicks: number;
  unitFloor: number;
  deathOverRounds: number;
}

/** What, beyond plain blows, a monster can do to the character. */
export type HazardKind =
  | 'damage'
  | 'drain'
  | 'poison'
  | 'held'
  | 'confused'
  | 'blinded'
  | 'slowed'
  | 'afraid'
  | 'summon'
  | 'teleported';

export interface Menace {
  /** Hit points a round beside this monster is expected to cost, hazards priced in. */
  perRound: number;
  /** Of `perRound`, the plain blows. */
  blows: number;
  /** Once, when it dies. Already amortised into `perRound`; kept for the readout. */
  onDeath: number;
  /** Its own health to work from — the high end, as `WorldMob.hp` is. */
  hp: number;
  /** `perRound / hp`: the figure the order is decided on. */
  weight: number;
  /** Every hazard the worst row brings, distinct, in a stable order. */
  hazards: HazardKind[];
  /** True when any of it reaches everybody in the room. */
  wide: boolean;
}

/*
 * The server's own constants, read out of it rather than tuned:
 * `Mob.DoCombat` grants 1,000 energy a round and stops at `MAX_NUM_ATTACKS`
 * (50); `TimedEventManager` ticks spell effects every 3 seconds and combat
 * every 5; `Spell.GetMagicResModifierVsTarget` clamps resistance to 150 and
 * pivots at 50; `GetSpellResistType` reads a `TypeOfResists` of 2 as a spell
 * anybody can resist.
 */
const ROUND_ENERGY = 1000;
const MAX_SWINGS = 50;
const EFFECT_TICK_SECONDS = 3;
const ROUND_SECONDS = 5;
const MAGIC_RES_CEILING = 150;
const MAGIC_RES_PIVOT = 50;
const RESISTED_BY_ANYONE = 2;

/*
 * `Spells.Targets` as a *monster's* cast reads it — `Mob.InvokeBetweenRoundSpell`,
 * `TryInvokeSpell` and `ApplyDeathSpell` all switch on the same enum:
 * `Any` (6), `FullArea` (11) and `FullAttackArea` (12) reach every player in
 * the room; `Self` (1), `SelfOrUser` (2) and `FullPartyArea` (13) land on the
 * monster itself; everything else, the realm's own zero included (`User`),
 * lands on the monster's current target.
 */
const REACHES_THE_ROOM = new Set([6, 11, 12]);
const LANDS_ON_THE_CASTER = new Set([1, 2, 13]);

/**
 * The chance a blow of this accuracy lands on a character with this armour
 * class, as a fraction — `Mob.DoCombat`:
 *
 *     fixedDefense = (AC + secondary) / 10
 *     tempacc = 100 - (fixedDefense² / max((Acc² / 14) / 10, 1))
 *
 * in integer arithmetic throughout, floored at zero. The sheet's figure *is*
 * `AC / 10`, so it goes in whole; the party-rank and protection bonuses are
 * taken as none. An unread armour class is taken as none, which is the
 * answer that makes every blow land.
 */
export function hitChance(accuracy: number, armourClass: number | null): number {
  const fixed = Math.max(0, Math.trunc(armourClass ?? 0));
  const reach = Math.max(Math.trunc(Math.trunc((accuracy * accuracy) / 14) / 10), 1);
  return Math.max(0, 100 - Math.trunc((fixed * fixed) / reach)) / 100;
}

/**
 * What a blow of `min`–`max` is expected to do through this damage
 * resistance, and how often it does anything at all.
 *
 * `damage = rand(min, max) - DR / 10`, and a blow that comes to nothing
 * neither prints nor applies its hit spell — so the mean is taken over the
 * blows that get through rather than over all of them minus the resistance,
 * which would understate a monster whose blows straddle the figure. The
 * sheet's figure is already `DR / 10`.
 */
export function expectedBlow(
  min: number,
  max: number,
  damageResist: number | null
): { damage: number; lands: number } {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const resist = Math.max(0, Math.trunc(damageResist ?? 0));
  const width = high - low + 1;
  const first = Math.max(low, resist + 1);
  if (first > high) return { damage: 0, lands: 0 };
  const count = high - first + 1;
  const total = (count * (first - resist + (high - resist))) / 2;
  return { damage: total / width, lands: count / width };
}

/**
 * A spell's power at a cast level — `Spell.RollAndApplySpellAbilities`:
 * the level is capped at `Cap`, and each end grows by `Inc` per `IncLVLs`
 * levels, truncated as the server truncates.
 */
export function scaledPower(spell: WorldSpell, level: number): [number, number] {
  const capped = spell.cap !== undefined && spell.cap > 0 ? Math.min(level, spell.cap) : level;
  const [minBase, maxBase] = spell.power ?? [0, 0];
  const grow = (pair: [number, number] | undefined): number =>
    pair === undefined || pair[0] === 0 ? 0 : Math.trunc((capped / pair[0]) * pair[1]);
  return [minBase + grow(spell.minGrowth), maxBase + grow(spell.maxGrowth)];
}

/**
 * How much of a cast this character's magic resistance turns away —
 * `Spell.GetMagicResModifierVsTarget` and the resist roll beneath it.
 *
 * `factor` scales a resistable magnitude: `1 - (MR - 50) / 100`, with the
 * resistance clamped to 0–150, so a character *below* 50 takes more than the
 * spell states. `resist` is the chance the whole cast is refused, which the
 * server rolls only for a spell the realm marks as resistable by anyone. A
 * spell carrying `NonMagicalSpell` — every bite and breath — is exempt from
 * both. An unread resistance is taken as none, the figure that lets the most
 * through.
 */
export function magicResistance(
  spell: WorldSpell,
  magicRes: number | null
): { factor: number; resist: number } {
  const nonMagical = (spell.abilities ?? []).some(([id]) => id === HAZARD_ABILITY.nonMagical);
  if (nonMagical) return { factor: 1, resist: 0 };
  const held = Math.min(MAGIC_RES_CEILING, Math.max(0, magicRes ?? 0));
  const factor = 1 - (held - MAGIC_RES_PIVOT) / 100;
  const resist = spell.resist === RESISTED_BY_ANYONE ? Math.max(0, 1 - factor) : 0;
  return { factor, resist };
}

interface Hazard {
  harm: number;
  kinds: HazardKind[];
  wide: boolean;
}

const NOTHING: Hazard = { harm: 0, kinds: [], wide: false };

/**
 * What one cast of a spell is expected to cost, in hit points, with the
 * hazards that are not hit points priced in units of `unit`.
 *
 * `applications` is the cast plus every effect tick of the duration, because
 * that is how often the server calls `Hit` for a damage, drain or poison
 * ability — bounded by `lastingTicks`, since a poison that runs five minutes
 * is cured or outrun long before it runs out. A held, confused, blinded,
 * slowed or afraid character is priced per *round* of the duration, and the
 * two clocks differ: effect ticks are three seconds and rounds are five.
 * Confusion and fear state a percentage per action or tick and are scaled by
 * it; the rest are in force for as long as the effect holds.
 */
function hazardOf(
  spell: WorldSpell | undefined,
  level: number,
  unit: number,
  player: MenacePlayer,
  weights: MenaceWeights
): Hazard {
  if (spell === undefined) return NOTHING;
  const targets = spell.targets ?? 0;
  const wide = REACHES_THE_ROOM.has(targets);
  const onItself = LANDS_ON_THE_CASTER.has(targets);
  const [low, high] = scaledPower(spell, level);
  const mean = (low + high) / 2;
  const ticks = Math.max(0, spell.duration ?? 0);
  const rounds = Math.max(1, (ticks * EFFECT_TICK_SECONDS) / ROUND_SECONDS);
  const applications = 1 + Math.min(ticks, Math.max(0, weights.lastingTicks));
  const { factor, resist } = magicResistance(spell, player.magicRes);
  // A percentage the ability states, else the spell's own power.
  const chance = (value: number): number =>
    Math.min(1, Math.max(0, (value !== 0 ? value : mean) / 100));

  let harm = 0;
  const kinds = new Set<HazardKind>();
  const add = (kind: HazardKind, amount: number): void => {
    if (amount <= 0) return;
    harm += amount;
    kinds.add(kind);
  };
  for (const [id, value] of spell.abilities ?? []) {
    // `abil.Sum == 0 ? modifiedValue : abil.Sum`: the ability's own figure
    // where it states one, otherwise the spell's rolled power.
    const magnitude = value !== 0 ? Math.abs(value) : mean;
    switch (id) {
      case HAZARD_ABILITY.damage:
        if (!onItself) add('damage', magnitude * applications);
        break;
      case HAZARD_ABILITY.damageWithMr:
        if (!onItself) add('damage', magnitude * factor * applications);
        break;
      case HAZARD_ABILITY.drain:
        if (!onItself) add('drain', magnitude * applications);
        break;
      case HAZARD_ABILITY.poison:
        if (!onItself) add('poison', magnitude * applications);
        break;
      case HAZARD_ABILITY.heal:
        // A negative heal is a wound on every tick — `damnation` states
        // `Heal -2` over ten ticks — and a positive one is the monster
        // mending itself, which costs the character nothing per round.
        if (!onItself && value < 0) add('damage', magnitude * applications);
        break;
      case HAZARD_ABILITY.holdPerson:
        if (!onItself) add('held', weights.held * unit * rounds);
        break;
      case HAZARD_ABILITY.confusion:
        if (!onItself) add('confused', weights.confused * unit * rounds * chance(value));
        break;
      case HAZARD_ABILITY.blind:
        if (!onItself) add('blinded', weights.blinded * unit * rounds);
        break;
      case HAZARD_ABILITY.slowness:
        if (!onItself) add('slowed', weights.slowed * unit * rounds);
        break;
      case HAZARD_ABILITY.fear:
        if (!onItself) add('afraid', weights.afraid * unit * rounds * chance(value));
        break;
      case HAZARD_ABILITY.summon:
        // Whoever the spell names, the ally arrives in this room.
        add('summon', weights.summon * unit);
        break;
      case HAZARD_ABILITY.teleportRoom:
        if (!onItself) add('teleported', weights.teleported * unit);
        break;
      default:
        break;
    }
  }
  if (harm <= 0) return NOTHING;
  harm *= 1 - resist;
  if (wide) harm *= weights.roomWide;
  return { harm, kinds: [...kinds], wide };
}

/**
 * How many blows a round holds — `Mob.DoCombat` grants 1,000 energy a round
 * and swings until it is spent or fifty swings are in, so the count is the
 * grant over the energy an average swing costs. A profile whose swings cost
 * nothing swings the fifty.
 */
function swingsPerRound(attacks: readonly MobAttack[]): number {
  const perSwing = attacks.reduce((sum, attack) => sum + attack.chance * attack.energy, 0);
  if (perSwing <= 0) return attacks.length > 0 ? MAX_SWINGS : 0;
  return Math.min(MAX_SWINGS, ROUND_ENERGY / perSwing);
}

/** Plain blows only: what the room's `unit` is made from. */
function bloodPerRound(profile: MobProfile, player: MenacePlayer): number {
  const swings = swingsPerRound(profile.attacks);
  let perSwing = 0;
  for (const attack of profile.attacks) {
    if (attack.kind !== 'melee') continue;
    const { damage } = expectedBlow(attack.min, attack.max, player.damageResist);
    perSwing += attack.chance * hitChance(attack.accuracy, player.armourClass) * damage;
  }
  return swings * perSwing;
}

/** One row's whole cost per round, hazards priced in. */
function rowPerRound(
  profile: MobProfile,
  spells: Record<number, WorldSpell>,
  unit: number,
  player: MenacePlayer,
  weights: MenaceWeights
): { perRound: number; blows: number; kinds: Set<HazardKind>; wide: boolean } {
  const kinds = new Set<HazardKind>();
  let wide = false;
  const take = (hazard: Hazard, scale: number): number => {
    if (hazard.harm <= 0 || scale <= 0) return 0;
    for (const kind of hazard.kinds) kinds.add(kind);
    wide = wide || hazard.wide;
    return hazard.harm * scale;
  };

  const swings = swingsPerRound(profile.attacks);
  let blows = 0;
  let perSwing = 0;
  for (const attack of profile.attacks) {
    if (attack.kind === 'melee') {
      const hit = hitChance(attack.accuracy, player.armourClass);
      const { damage, lands } = expectedBlow(attack.min, attack.max, player.damageResist);
      blows += attack.chance * hit * damage;
      // The hit spell rides on a blow that did damage, at level zero —
      // `spell.ApplyMobCastSpell(this, tempTargets, 0, true)`.
      if (attack.onHit !== undefined) {
        perSwing += take(
          hazardOf(spells[attack.onHit], 0, unit, player, weights),
          attack.chance * hit * lands
        );
      }
    } else {
      perSwing += take(
        hazardOf(spells[attack.spell], attack.level, unit, player, weights),
        attack.chance * attack.castChance
      );
    }
  }
  let perRound = swings * (blows + perSwing);
  blows *= swings;
  for (const cast of profile.casts) {
    perRound += take(hazardOf(spells[cast.spell], cast.level, unit, player, weights), cast.chance);
  }
  return { perRound, blows, kinds, wide };
}

/**
 * Every monster in a room, weighed against this character.
 *
 * Returned in the order given, one answer per monster. `null` is **the realm
 * does not say** — a monster it cannot place, or a realm file converted
 * before profiles were written — and never *harmless*: `rankByMenace` puts
 * those first, because the reassuring guess is the dangerous one. A monster
 * the realm knows and states no attack for weighs nothing, which is a
 * different fact.
 *
 * The room is weighed together because the unit a hazard is priced in is the
 * room's: a round held next to three ogres is not a round held next to a rat.
 */
export function weighRoom(
  mobs: readonly MenaceSubject[],
  player: MenacePlayer,
  weights: MenaceWeights
): Array<Menace | null> {
  const blood = mobs.map((mob) =>
    mob.profiles === undefined
      ? 0
      : mob.profiles.reduce((worst, row) => Math.max(worst, bloodPerRound(row, player)), 0)
  );
  const unit = Math.max(
    Math.max(0, weights.unitFloor),
    blood.reduce((sum, each) => sum + each, 0)
  );
  const rounds = Math.max(1, weights.deathOverRounds);

  return mobs.map((mob) => {
    if (mob.profiles === undefined) return null;
    const spells = mob.spells ?? {};
    let worst = { perRound: 0, blows: 0, kinds: new Set<HazardKind>(), wide: false };
    for (const row of mob.profiles) {
      const weighed = rowPerRound(row, spells, unit, player, weights);
      if (weighed.perRound > worst.perRound) worst = weighed;
    }
    const death =
      mob.deathSpell === undefined
        ? NOTHING
        : hazardOf(spells[mob.deathSpell], 0, unit, player, weights);
    for (const kind of death.kinds) worst.kinds.add(kind);
    // Once, whenever it dies — and best taken early, at full health, which
    // is why it counts towards the order at all rather than being a fixed
    // cost of the fight. Spread over the rounds a kill is taken to need.
    const perRound = worst.perRound + death.harm / rounds;
    const hp = mob.hp !== undefined && mob.hp > 0 ? mob.hp : 1;
    return {
      perRound,
      blows: worst.blows,
      onDeath: death.harm,
      hp,
      weight: perRound / hp,
      hazards: [...worst.kinds],
      wide: worst.wide || death.wide
    };
  });
}

/**
 * The order to take a room's monsters in: the ones the realm cannot weigh
 * first, then by weight, ties in the order given.
 *
 * Indices rather than entities, so a caller ranking a filtered list can map
 * back to whatever it filtered from.
 */
export function rankByMenace(menaces: ReadonlyArray<Menace | null>): number[] {
  return menaces
    .map((menace, index) => ({ menace, index }))
    .sort((a, b) => {
      if (a.menace === null || b.menace === null) {
        if (a.menace === null && b.menace === null) return a.index - b.index;
        return a.menace === null ? -1 : 1;
      }
      return b.menace.weight - a.menace.weight || a.index - b.index;
    })
    .map((entry) => entry.index);
}
