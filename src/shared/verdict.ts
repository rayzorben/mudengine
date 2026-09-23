import {
  rankByMenace,
  type Menace,
  type MenacePlayer,
  type MenaceSubject,
  type MenaceWeights,
  weighRoom
} from './menace';
import { swing, type ProwessSheet, type ProwessWeapon, type Reckoning } from './prowess';
import type { RealmFamily } from './realm';
// Type only: `survival.ts` imports this module's values, and a value the other
// way would be the cycle `module-cycle.test.ts` exists to refuse.
import type { Survival } from './survival';
import { DODGE_ABILITY } from './abilities';
import { statedNow } from './stated';
import type { CharacterState, RoomOccupant } from './character';
import type { MobEntity } from './entities';
import { DEFAULT_MOB_PRIORITY, MOB_PRIORITIES, type MobPriorityBand, type MobRule } from './config';
import { mobKey } from './world';

/**
 * *Can I fight this?* — one answer, read by the card and by the engine.
 *
 * The client has had both halves of this for a while and never put them
 * together. `menace.ts` says what a monster costs to **leave standing**;
 * `prowess.ts` (2026-09-04) says what it costs to **kill**. The question a
 * player asks a hundred times an evening is the comparison, and until now they
 * had to do it in their head — with `100 − (AC/10)² / max((Acc²/14)/10, 1)` in
 * one of them and a wild dog biting them.
 *
 * ## Why this is one function and not two implementations
 *
 * `AutoCombat` picks a target and the Reference card explains one. **If the
 * card says a monster is a bad fight and the engine picks it anyway, one of
 * them is lying**, and the only way that stays true is if both read the same
 * function. So the verdict is computed here, in `src/shared/`, dependency-free
 * — the engine ranks with `rankByVerdict` and the surface renders the same
 * `Verdict` it ranked on.
 *
 * ## What changed about the ranking, and why health was only ever a proxy
 *
 * `rankByMenace` orders by `perRound / hp` — Smith's rule, with a monster's
 * *health* standing in for the time it takes to remove. That was right when the
 * client could not compute the other factor: health is proportional to
 * time-to-kill when every monster takes the same damage per round, and a factor
 * equal for everything in a room changes no order.
 *
 * It stops being right the moment armour class and dodge differ, which is
 * always. Two monsters with 100 health, one of which this character hits half
 * as often, take twice as long to remove and are worth killing in the other
 * order. `rankByVerdict` uses **rounds** where rounds are knowable and falls
 * back to `menace.weight` where they are not — per monster, not per room, so
 * one unknown does not throw away what is known about the rest.
 */

/** What a monster costs, in both directions, with every figure's provenance. */
export interface Verdict {
  /** What it costs to leave standing. Null when the realm can say nothing about it. */
  menace: Menace | null;
  /**
   * Rounds to bring it down, from `prowess.swing`. Always a `bound` — the
   * accuracy behind it is a floor and neither crits nor hit spells are counted
   * — so the true figure is at most this. Null when it is not knowable at all,
   * never `0` and never `∞`.
   */
  rounds: Reckoning<number> | null;
  /**
   * Health this fight is expected to cost: `menace.perRound × rounds`.
   *
   * **This is the answer.** Not the monster's damage, not its health — what
   * taking it on takes off this character, which is the one number a person
   * standing in the room can compare against the health they have. Null when
   * either half is unknown, because half of a product is not an estimate of it.
   */
  cost: Reckoning<number> | null;
}

/**
 * The two halves for one monster.
 *
 * The menace is passed in rather than computed, because `weighRoom` prices a
 * whole room at once — the hazard unit is *one round of the whole room's blows*
 * and cannot be derived monster by monster.
 */
export function verdictFor(
  menace: Menace | null,
  subject: { armourClass?: number; damageResist?: number; dodge?: number; hp?: number },
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Verdict {
  const attack = swing(
    sheet,
    weapon,
    {
      armourClass: subject.armourClass ?? null,
      damageResist: subject.damageResist ?? null,
      dodge: subject.dodge ?? null,
      // The menace's own figure first: it is the realm's high end, and where
      // the realm cannot name the monster it is what the lore has learned.
      health: menace?.hp ?? subject.hp ?? null
    },
    family
  );
  const rounds = attack?.rounds ?? null;
  const cost =
    menace === null || rounds === null
      ? null
      : { value: menace.perRound * rounds.value, from: 'bound' as const };
  return { menace, rounds, cost };
}

/** What `targetOf` reads off a monster: the realm's columns and its ability slots. */
export type TargetEntity = Pick<MobEntity, 'armour' | 'damageResist' | 'abilities' | 'hp'>;

/**
 * The monster's side of the roll, in the sheet's units.
 *
 * `Monsters.ArmourClass` and `DamageResist` are the server's internal figures,
 * and the roll divides both by ten — `PlayerAttackType.GetDefense` is
 * `(target.AC + secondary) / 10`, the blow is `rand(min, max) − DR / 10`
 * (docs/greatermud/combat.md) — which is also the form the character's own
 * sheet already prints. So `prowess.swing` takes the divided figure from both
 * sides and the division happens here, once. Dodge is the row's `Abil-n = 34`
 * slot, in points, and there is no unit to convert.
 *
 * **`AutoCombat` used to pass `{}` here.** `hitChance` takes an unread armour
 * class as none — the answer that makes every blow land — so with the entity
 * never consulted every monster was priced as unarmoured, and the rounds
 * figure, labelled *at most*, was smaller than the truth for anything in
 * armour: a bound in the wrong direction, which is the confidently wrong
 * answer the ranking exists to avoid. Found reading the code for the
 * `explain()` fix (2026-09-05), not by a fight; `AutoCombat.test.ts` holds the
 * case.
 */
export function targetOf(entity: TargetEntity | undefined): {
  armourClass?: number;
  damageResist?: number;
  dodge?: number;
  hp?: number;
} {
  if (entity === undefined) return {};
  const dodge = entity.abilities?.find(([id]) => id === DODGE_ABILITY)?.[1];
  return {
    ...(entity.armour !== undefined ? { armourClass: entity.armour / 10 } : {}),
    ...(entity.damageResist !== undefined ? { damageResist: entity.damageResist / 10 } : {}),
    ...(dodge !== undefined ? { dodge } : {}),
    ...(entity.hp !== undefined ? { hp: entity.hp } : {})
  };
}

/**
 * The character's side of the sheet, read off the state.
 *
 * One reading, shared by the engine's ranking and the room's appraisal,
 * because two copies of *which sheet figure feeds which formula* agree until
 * one is edited. `combat` and `magery` are the class row's — the sheet prints
 * neither — and a null row leaves both null, which `prowess` answers with
 * null rather than a guess. And what the last `stat all` said, where it still
 * holds (`statedNow`), so every reader of the sheet gets the server's figure
 * without asking for it.
 */
export function prowessSheetOf(
  state: Pick<CharacterState, 'progress' | 'inventory'> &
    Partial<Pick<CharacterState, 'stated' | 'buffs' | 'className' | 'party' | 'name'>>,
  cls: { combat: number | null; magery: number | null }
): ProwessSheet {
  const { encumbrance, encumbranceMax } = state.inventory;
  return {
    level: state.progress.level,
    agility: state.progress.agility,
    intellect: state.progress.intellect,
    charm: state.progress.charm,
    willpower: state.progress.willpower,
    health: state.progress.health,
    strength: state.progress.strength,
    spellcasting: state.progress.spellcasting,
    combatLevel: cls.combat,
    mageryLevel: cls.magery,
    encumbrancePercent:
      encumbrance === null || encumbranceMax === null || encumbranceMax <= 0
        ? null
        : (100 * encumbrance) / encumbranceMax,
    stated: statedNow(state)
  };
}

/**
 * Every monster in a room, weighed both ways.
 *
 * One call, because the menace half must be a room at a time. Same order in as
 * out, so a caller can index straight back into its own list. Each subject is
 * the entity as the room lists it — `{}` for one the realm cannot place, which
 * weighs as unknown on both sides.
 */
export function weighVerdicts(
  subjects: ReadonlyArray<MenaceSubject & TargetEntity>,
  player: MenacePlayer,
  weights: MenaceWeights,
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Verdict[] {
  const menaces = weighRoom(subjects, player, weights);
  return subjects.map((subject, index) =>
    verdictFor(menaces[index] ?? null, targetOf(subject), sheet, weapon, family)
  );
}

/**
 * The room the character is standing in, appraised.
 *
 * This is the surface [05](docs/mudplay/05-can-i-fight-this.md) §4 asks for
 * on the Room card — *the verdict a player wants on arrival is about the
 * room* — and the engine's `rankByVerdict` reads the same `Verdict`s, so the
 * card and the decision cannot disagree.
 */
export interface RoomVerdict {
  /**
   * One entry per occupant that is not a person, in the room's own order, with
   * the occupant line's word for it. A stranger the realm cannot place is
   * here with a null verdict rather than left out: an appraisal that quietly
   * dropped the one thing it could not weigh would read as complete.
   */
  monsters: Array<{ name: string; verdict: Verdict }>;
  /**
   * Health clearing the room is expected to cost — the sum of every monster's
   * `cost`, and **null the moment one of them is unknown**, because a total
   * that leaves a monster out is smaller than the truth and looks the same.
   * A `bound`, as every `cost` under it is.
   */
  cost: Reckoning<number> | null;
  /**
   * The room's fight run rather than added up (`simulateFight`): how often
   * this character walks out, against everything here that would fight, with
   * the heal it would cast and the regeneration it gets. Null where the fight
   * cannot be run honestly, and the card says so rather than guessing.
   */
  survival: Survival | null;
}

export const EMPTY_ROOM_VERDICT: RoomVerdict = { monsters: [], cost: null, survival: null };

/** Every occupant the room lists that is not a person — the ones a verdict is about. */
export function appraiseRoom(
  occupants: ReadonlyArray<Pick<RoomOccupant, 'name' | 'kind' | 'mob'>>,
  player: MenacePlayer,
  weights: MenaceWeights,
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): RoomVerdict {
  const monsters = occupants.filter((who) => who.kind !== 'player');
  if (monsters.length === 0) return EMPTY_ROOM_VERDICT;
  const verdicts = weighVerdicts(
    monsters.map((who) => who.mob ?? {}),
    player,
    weights,
    sheet,
    weapon,
    family
  );
  let total = 0;
  let complete = true;
  for (const verdict of verdicts) {
    if (verdict.cost === null) complete = false;
    else total += verdict.cost.value;
  }
  return {
    monsters: monsters.map((who, index) => ({ name: who.name, verdict: verdicts[index]! })),
    cost: complete ? { value: total, from: 'bound' } : null,
    // Run by the session, which alone holds the heal and the buffs; the
    // appraisal itself is the expectation and says nothing about the tail.
    survival: null
  };
}

/**
 * What one pass through a room's lair takes, and whether the wire says so.
 *
 * `sure` is false when the worst monster counted is one whose disposition is
 * conditional on a standing nothing has read — it may open on this character
 * or it may not, and `attacksOnSight` answers neither. The damage is still the
 * honest worst case; the flag is what lets the router price it as a
 * discouragement instead of a wall. See {@link lairPass}.
 */
export interface LairPass {
  /** Hit points, for the worst that waits there. */
  damage: number;
  /** Whether the wire settles that it happens at all. */
  sure: boolean;
}

/**
 * What one pass through a lair is expected to take, in hit points.
 *
 * The router's question, and not the card's. A verdict's `cost` is what
 * *clearing* a monster takes — its blows for the rounds needed to kill it —
 * and a route is not a fight: walking in and out costs one round (`rounds`,
 * `tuning.world.passRounds`) of the blows of whatever is awake and attacks on
 * sight. So this is the worst such monster's `menace.perRound`, as many
 * times as the lair holds at once (`WorldLair.max`): a lair of four rats
 * costs a round of four rats, a lair of one boss a round of the boss, and a
 * lair that mixes them is priced as if it were full of the worst — the
 * direction that is safe to be wrong in, since a route is chosen before
 * anybody has seen what actually spawned.
 *
 * `attacks` says, per monster, whether it attacks on sight; `false` is walked
 * past for nothing, and `null` — a disposition nobody has read — counts,
 * because an unknown is never the reassuring answer. Null when no monster's
 * menace is knowable; a lair with nothing to weigh is not free, it is
 * unknown, and the router prices unknown as nothing rather than as a wall
 * (`dangerPenalty`). Priced by clearing, every lair on a level-11
 * character's way to the Black Mountains was a wall and the route went round
 * three maps to save five of them.
 */
export function lairPassage(
  verdicts: ReadonlyArray<Verdict>,
  held: number | null,
  rounds: number,
  attacks: (index: number) => boolean | null
): number | null {
  let worst: number | null = null;
  for (const [index, verdict] of verdicts.entries()) {
    if (verdict.menace === null || attacks(index) === false) continue;
    if (worst === null || verdict.menace.perRound > worst) worst = verdict.menace.perRound;
  }
  if (worst === null) return null;
  return worst * Math.max(1, held ?? 1) * Math.max(1, rounds);
}

/**
 * What one pass takes, and whether the wire settles that it happens at all.
 *
 * `lairPassage` folds *certainly attacks* and *nobody can say* together on
 * purpose — unknown is never the reassuring answer, so both count — and the
 * router then has one number where it needs two facts. A monster's
 * disposition can be conditional on a standing (`hates-evil` opens on an
 * Outlaw and leaves a Saint alone), so a character whose roster row has not
 * been read meets `null` from every guard in town; priced at its full share
 * that reaches `deadlyShare` and **walls** the corridor, which is a route
 * closed on a fact nobody has read.
 *
 * So the same predicate is read twice, which is cheaper than a second return
 * shape and says exactly what the difference is: `possible` counts everything
 * `lairPassage` counts, `certain` counts only what the wire settles, and when
 * they part it is because the *worst* monster is one that may not open at all.
 * The damage stays the honest worst case — `sure` is what earns it a cap
 * rather than a wall (`tuning.world.unsureShare`, applied by `passShare`).
 */
export function lairPass(
  verdicts: ReadonlyArray<Verdict>,
  held: number | null,
  rounds: number,
  attacks: (index: number) => boolean | null
): LairPass | null {
  const possible = lairPassage(verdicts, held, rounds, (index) => attacks(index) !== false);
  if (possible === null) return null;
  const certain = lairPassage(verdicts, held, rounds, (index) => attacks(index) === true);
  return { damage: possible, sure: certain !== null && certain >= possible };
}

/**
 * A weighed pass as a share of the bar the router prices against, capped where
 * the wire cannot settle that the fight happens at all.
 *
 * The share is taken against the health the character has **now** rather than
 * against the maximum: a route planned at a third of the bar has to be three
 * times as careful as one planned at the top of it. `cap` is what an
 * unevidenced pass may cost at most, and it exists so that *nobody has read
 * this character's standing* discourages a room instead of closing it — the
 * same answer `edgePenalty` gives a gate it cannot evaluate. Null where
 * nothing can be weighed, which prices at nothing; unread health is not zero
 * health.
 */
export function passShare(
  pass: LairPass | null,
  health: number | null,
  cap: number
): number | null {
  if (pass === null || health === null || !(health > 0)) return null;
  const share = pass.damage / health;
  return pass.sure ? share : Math.min(share, cap);
}

/**
 * What of an appraisal a reader can see, so a publisher pushes on change and
 * not on every status line: the names, and each figure to the unit it is drawn
 * at. Two appraisals with the same key draw the same row.
 */
export function roomVerdictKey(appraisal: RoomVerdict): string {
  // Rounds are drawn rounded *up* when they are a bound — a ceiling rounded
  // down stops being one — and to the nearest otherwise; health to the nearest.
  const rounds = (reckoning: Reckoning<number> | null): string =>
    reckoning === null
      ? '-'
      : `${reckoning.from === 'bound' ? Math.ceil(reckoning.value) : Math.round(reckoning.value)}${reckoning.from[0]}`;
  const health = (reckoning: Reckoning<number> | null): string =>
    reckoning === null ? '-' : `${Math.round(reckoning.value)}${reckoning.from[0]}`;
  return [
    ...appraisal.monsters.map(
      ({ name, verdict }) =>
        `${name}:${verdict.menace === null ? '-' : Math.round(verdict.menace.perRound)}:${rounds(
          verdict.rounds
        )}:${health(verdict.cost)}`
    ),
    health(appraisal.cost),
    appraisal.survival === null
      ? '-'
      : `${Math.round(appraisal.survival.survives * 100)}:${appraisal.survival.level}:${Math.round(
          appraisal.survival.rounds.value
        )}:${appraisal.survival.hpLeft ?? '-'}`
  ].join('|');
}

/**
 * What this character is actually swinging with.
 *
 * `equipped` is the listing's own word for worn, wielded or lit, and the kind
 * is the realm's — so a lit torch and a worn helm are excluded by kind and a
 * weapon sitting in the pack by `equipped`. **The first one wins and the rest
 * are ignored**: a two-weapon listing is a state this client cannot price (the
 * server swings one attack type at a time) and picking the better of the two
 * would be a guess about which the server chose.
 *
 * `null` for a character fighting unarmed, which is honest: martial arts is on
 * the stat sheet and its conversion to a damage range is not in hand, so
 * `swing()` answers no damage rather than inventing one.
 */
export function wieldedWeapon(
  items: ReadonlyArray<{ equipped: boolean; kind?: string; weapon?: ProwessWeapon }>
): ProwessWeapon | null {
  const found = items.find((item) => item.equipped && item.kind === 'weapon' && item.weapon);
  return found?.weapon ?? null;
}

/**
 * What to hit first — Smith's rule, on rounds where rounds are known.
 *
 * Ordered by *damage rate over time to remove*: killing the thing that costs
 * the most per round of the time it takes to remove minimises the damage
 * absorbed over the whole fight. `menace.weight` is that ratio with health
 * standing in for time; this is the same ratio with the time itself.
 *
 * **Mixed rooms rank honestly.** A monster whose rounds are known is compared
 * on `perRound / rounds` and one whose rounds are not falls back to its
 * `weight`, and the two scales are not the same — so the fallbacks are ordered
 * *among themselves* and placed after every monster the client can actually
 * cost. That is deliberate: a monster nothing is known about is not a monster
 * to open on, and putting it last is the same refusal `rankByMenace` makes of
 * a null menace by putting it first (there, nothing known means nothing to
 * fear; here, nothing known means nothing to promise).
 *
 * A null menace keeps `rankByMenace`'s own answer — first, because a monster
 * the realm cannot place is the one this client has the least right to skip
 * past.
 */
export function rankByVerdict(verdicts: ReadonlyArray<Verdict>): number[] {
  const scored = verdicts.map((verdict, index) => {
    const { menace, rounds } = verdict;
    if (menace === null) return { index, tier: 0, score: 0 };
    if (rounds === null || rounds.value <= 0) return { index, tier: 2, score: menace.weight };
    return { index, tier: 1, score: menace.perRound / rounds.value };
  });
  return scored
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index)
    .map((entry) => entry.index);
}

/**
 * The order to attack a room in when the monster list has something to say.
 *
 * Bands first, and **instead of** the weighing rather than above it: a listed
 * monster's band decides, and within one band the room's own listing order
 * decides. That is the order the client used before any weighing existed, and
 * it is the one somebody reading their own list can predict — which is the
 * whole point of writing the list. `rankByVerdict` is not consulted here at
 * all; see `CombatConfig.mobRules`.
 *
 * `names` and `verdicts` are parallel to the candidates the caller is choosing
 * between, and the returned indices point back into them. `verdicts` is taken
 * only so the caller can hand the chosen one's verdict to the trace.
 *
 * Returns null when no row names anything in the room, which is the common
 * case and the one where the realm's arithmetic should decide as it always
 * has. Deciding that here keeps the caller from asking the same question
 * twice.
 *
 * A `never` row is not a rank and is skipped outright: such a monster was
 * declined long before this, so a row for it says nothing about the order of
 * what is left — and counting it as *listed* would take the whole room off
 * the realm's arithmetic on the strength of a monster nobody is fighting.
 */
export function rankByPriority(
  names: readonly string[],
  rows: readonly MobRule[]
): number[] | null {
  if (rows.length === 0) return null;
  /*
   * Both sides through `mobKey`. The normalizer keys a row on the way in, but
   * a row still being typed on the settings screen has not been through it —
   * and a list that quietly did nothing until the file was reloaded would be
   * the control lying about itself while somebody watched it.
   */
  const bands = new Map<string, MobPriorityBand>();
  for (const row of rows) {
    if (row.treat === 'never') continue;
    bands.set(mobKey(row.mob), row.treat);
  }
  const middle = MOB_PRIORITIES.indexOf(DEFAULT_MOB_PRIORITY);
  let listed = false;
  const scored = names.map((name, index) => {
    const band = bands.get(mobKey(name));
    if (band !== undefined) listed = true;
    return { index, rank: band === undefined ? middle : MOB_PRIORITIES.indexOf(band) };
  });
  if (!listed) return null;
  // Ties break on the room's listing order, which `index` already is.
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.index);
}

/** Re-exported so a caller that only has menaces still has one ranking to reach for. */
export { rankByMenace };
