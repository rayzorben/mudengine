/**
 * What the planner hands the provider: the whole character, every hunting
 * spot the survey measured with the arithmetic behind its survival figure,
 * the better gear the realm sells for each slot, and what each setting could
 * be (todo 51). Built by a pure function over what the session already reads,
 * so a test can build one from a fixture and a death log can hold the one
 * that was sent.
 *
 * Nothing is guessed. A figure the client does not have is null, and a spot
 * whose damage is not known is not offered: it is listed as left out, with
 * the reason, because *safe* is the one answer an unknown must never give.
 */
import type { AttackOption } from './attackOptions';
import type { CharacterState } from './character';
import type { MobEntity } from './entities';
import { primaryMob, type HuntingAdvice, type HuntingSpot } from './hunting';
import type { KonamiLayer } from './konami';
import type { MobAttack } from './world';

/** One better item for a slot, and where it is sold. */
export interface GearOffer {
  /** The realm's `Items` row. */
  item: number;
  name: string;
  /** Damage a round (or the mean blow) for a weapon, armour class otherwise. */
  figure: number | null;
  ac: number | null;
  dr: number | null;
  minLevel: number | null;
  shop: string;
  at: { map: number; room: number };
  moves: number;
  /** The counter's price before charm; null where the realm does not say. */
  copper: number | null;
}

/** One slot: what is worn and what the realm sells that is better. */
export interface SlotUpgrade {
  slot: string;
  worn: string | null;
  wornFigure: number | null;
  ranking: 'armour' | 'weapon';
  offers: GearOffer[];
}

/** A spell in the book, and what the realm says it is for. */
export interface BookSpell {
  name: string;
  /** What is typed after `c`. */
  word: string;
  cost: number | null;
  heals: boolean;
  /** Lasts a while, reaches the caster, and neither heals nor harms: kept up. */
  blessing: boolean;
}

/** A monster as the brief states it. */
export interface BriefMob {
  name: string;
  hp: number | null;
  armourClass: number | null;
  damageResist: number | null;
  magicResist: number | null;
  experience: number | null;
  undead: boolean | null;
  /** Rounds this character takes to bring it down, where known. */
  rounds: number | null;
  /** Hit points a round beside it costs this character, where known. */
  perRound: number | null;
  regenSeconds: number | null;
  /** The realm's attack rows, melee and spell, across every row of the name. */
  attacks: MobAttack[];
  spells: string[];
  drops: string[];
}

export interface BriefSpot {
  key: string;
  name: string;
  /** Steps from where the character stands to the loop's first room. */
  steps: number | null;
  rooms: number;
  loopSteps: number;
  boss: boolean;
  respawnSeconds: number | null;
  exp: { perHour: number | null; ceilingPerHour: number | null; perCycle: number | null };
  cycleSeconds: number | null;
  survival: {
    damagePerRoom: number | null;
    worstDamagePerRoom: number | null;
    worstShare: number | null;
    roundsPerKill: number | null;
    restSeconds: number | null;
    unknown: string[];
  };
  mobs: BriefMob[];
}

/** Why a surveyed spot was not offered. */
export type LeftOutReason = 'damage-unknown' | 'rate-unknown';

export interface KonamiBrief {
  at: number;
  character: {
    name: string | null;
    className: string | null;
    race: string | null;
    level: number | null;
    exp: number | null;
    expNeeded: number | null;
    levelReady: boolean | null;
    lives: number | null;
    stats: Record<string, number | null>;
    armourClass: number | null;
    damageResist: number | null;
    hp: number | null;
    hpMax: number | null;
    mana: number | null;
    manaMax: number | null;
    cp: number | null;
    worn: Array<{ slot: string | null; name: string }>;
    carried: Array<{ name: string; count: number }>;
    /** Null where the book has not been read: never guessed from the class. */
    spells: BookSpell[] | null;
    cash: {
      onHand: number | null;
      banks: Array<{ name: string; copper: number }>;
      /** On hand plus every bank on record; null while the purse is unread. */
      total: number | null;
    };
  };
  hunting: {
    from: string | null;
    spots: BriefSpot[];
    leftOut: Array<{ key: string; name: string; why: LeftOutReason }>;
    /** What the survey itself left out before ranking, counted. */
    excluded: HuntingAdvice['excluded'];
    refusal: string | null;
  };
  gear: SlotUpgrade[];
  attacks: Array<{ verb: string; kind: string; perRound: number | null }>;
  openers: string[];
  canSneak: boolean | null;
  /** The settings in force before the plan, the ones a plan may change. */
  settings: Required<Omit<KonamiLayer, 'trainFirst'>> & { trainFirst: string | null };
}

export interface BriefInput {
  state: CharacterState;
  advice: HuntingAdvice;
  /** Each spot's monsters as the realm states them, by the spot's key. */
  entities: ReadonlyMap<string, readonly MobEntity[]>;
  gear: SlotUpgrade[];
  attacks: AttackOption[];
  openers: string[];
  canSneak: boolean | null;
  spells: BookSpell[] | null;
  settings: KonamiBrief['settings'];
  maxSpots: number;
  now: number;
}

const STATS = [
  'strength',
  'intellect',
  'willpower',
  'agility',
  'health',
  'charm',
  'martialArts',
  'magicRes',
  'spellcasting',
  'perception',
  'stealthSkill',
  'thievery',
  'traps',
  'picklocks',
  'tracking'
] as const;

function briefMob(entity: MobEntity | undefined, mob: HuntingSpot['mobs'][number]): BriefMob {
  return {
    name: mob.name,
    hp: entity?.hp ?? null,
    armourClass: entity?.armour ?? null,
    damageResist: entity?.damageResist ?? null,
    magicResist: entity?.magicResist ?? null,
    experience: mob.experience,
    undead: entity?.undead ?? null,
    rounds: mob.rounds,
    perRound: mob.perRound,
    regenSeconds: mob.regenSeconds,
    attacks: entity?.profiles?.flatMap((profile) => profile.attacks) ?? [],
    spells: Object.values(entity?.spells ?? {}).map((spell) => spell.name),
    drops: (entity?.drops ?? []).map((item) => item.name)
  };
}

function briefSpot(spot: HuntingSpot, entities: readonly MobEntity[]): BriefSpot {
  const { estimate } = spot;
  return {
    key: spot.key,
    name: primaryMob(spot),
    steps: spot.rooms[0]?.steps ?? null,
    rooms: spot.rooms.length,
    loopSteps: spot.loopSteps,
    boss: spot.boss,
    respawnSeconds: spot.respawnSeconds,
    exp: {
      perHour: estimate.expPerHour,
      ceilingPerHour: estimate.ceilingPerHour,
      perCycle: estimate.expPerCycle
    },
    cycleSeconds: estimate.cycleSeconds,
    survival: {
      damagePerRoom: estimate.damagePerRoom,
      worstDamagePerRoom: estimate.worstDamagePerRoom,
      worstShare: estimate.worstShare,
      roundsPerKill: estimate.roundsPerKill,
      restSeconds: estimate.restSeconds,
      unknown: [...estimate.unknown]
    },
    mobs: spot.mobs.map((mob) =>
      briefMob(
        entities.find((entity) => entity.name.toLowerCase() === mob.name.toLowerCase()),
        mob
      )
    )
  };
}

/**
 * Why a measured spot is not offered, or null where it is. Damage first: a
 * spot whose worst room nobody could price is exactly the one that kills.
 */
export function leftOutWhy(spot: HuntingSpot): LeftOutReason | null {
  if (spot.estimate.worstShare === null) return 'damage-unknown';
  if (spot.estimate.expPerHour === null && spot.estimate.expPerCycle === null) {
    return 'rate-unknown';
  }
  return null;
}

export function buildBrief(input: BriefInput): KonamiBrief {
  const { state, advice } = input;
  const { progress, vitals, inventory } = state;
  const offered: BriefSpot[] = [];
  const leftOut: KonamiBrief['hunting']['leftOut'] = [];
  for (const spot of advice.spots) {
    const why = leftOutWhy(spot);
    if (why !== null) {
      leftOut.push({ key: spot.key, name: primaryMob(spot), why });
      continue;
    }
    if (offered.length < input.maxSpots) {
      offered.push(briefSpot(spot, input.entities.get(spot.key) ?? []));
    }
  }
  const banks = state.banks.map((bank) => ({ name: bank.name, copper: bank.copper }));
  const onHand = inventory.wealth;
  const stats: Record<string, number | null> = {};
  for (const stat of STATS) stats[stat] = progress[stat];
  return {
    at: input.now,
    character: {
      name: state.name,
      className: state.className,
      race: state.race,
      level: progress.level,
      exp: progress.exp,
      expNeeded: progress.expNeeded,
      levelReady: progress.expNeeded === null ? null : progress.expNeeded <= 0,
      lives: progress.lives,
      stats,
      armourClass: progress.armourClass,
      damageResist: progress.damageResist,
      hp: vitals.hp,
      hpMax: vitals.hpMax,
      mana: vitals.mana,
      manaMax: vitals.manaMax,
      cp: progress.cp,
      worn: inventory.items
        .filter((item) => item.equipped)
        .map((item) => ({ slot: item.slot, name: item.name })),
      carried: inventory.items
        .filter((item) => !item.equipped)
        .map((item) => ({ name: item.name, count: item.count ?? 1 })),
      spells: input.spells,
      cash: {
        onHand,
        banks,
        total: onHand === null ? null : onHand + banks.reduce((sum, bank) => sum + bank.copper, 0)
      }
    },
    hunting: {
      from: advice.from?.name ?? null,
      spots: offered,
      leftOut,
      excluded: advice.excluded,
      refusal: advice.refusal
    },
    gear: input.gear,
    attacks: input.attacks.map((option) => ({
      verb: option.verb,
      kind: option.kind,
      perRound: option.perRound?.value ?? null
    })),
    openers: input.openers,
    canSneak: input.canSneak,
    settings: input.settings
  };
}
