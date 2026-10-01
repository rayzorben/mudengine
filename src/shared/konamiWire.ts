/**
 * What the provider is sent (todo 65): the brief, condensed. The provider is
 * paid per call and refuses a request over its size (`max_tokens_exceeded`
 * at about 62,000 characters, 2026-10-01), so the state carries each hunting
 * ground as one row of what it yields and what it costs, the best offers per
 * slot, and each past plan as a line. Monster rows, attack tables and the
 * lairs on a walk stay in the brief, which the death logs and the card read;
 * the provider weighs what they come to, never the rows themselves.
 *
 * `fitRequest` trims the brief until the request fits the budget
 * (`tuning.konami.requestChars`), and the questions are built from the same
 * trimmed brief, so every label offered is a row the state shows.
 */
import { bankedCopper } from './coins';
import type { KonamiAsk, KonamiGoal } from './konami';
import type { BriefSpot, KonamiBrief, SlotUpgrade } from './konamiBrief';
import { goalKey, lessonText, type KonamiLesson } from './konamiLessons';
import { slotGives } from './konamiPurse';
import { planQuestions, type KonamiQuestions, type QuestionSizes } from './konamiQuestions';

/** A hunting ground as the provider reads it: what it yields an hour, and what it costs. */
export interface WireGround {
  key: string;
  name: string;
  expPerHour: number | null;
  /** Experience a lap, where the realm states no respawn time to make an hour of it. */
  expPerLap: number | null;
  copperPerHour: number | null;
  /** The simulated fight at full health: the share survived, as a whole percent. */
  survives: number | null;
  /** The worst room's damage a pass, as a whole percent of max HP. */
  worstRoomHp: number | null;
  steps: number | null;
  /** HP the walk there costs, passing every lair on it once. */
  walkHp: number | null;
  /** The room the walk there is expected to die in, where there is one. */
  deadlyOnWalk: string | null;
  /** What choosing it came to before, newest first. */
  before: string[];
}

/** One offer for a slot: what it gives, what it costs, the level it is worn from. */
export interface WireOffer {
  name: string;
  /** Armour class on the sheet for armour; damage a round for a weapon. */
  gives: number | null;
  copper: number | null;
  fromLevel: number | null;
}

export interface WireSlot {
  slot: string;
  /** `armour` gives armour class, `weapon` damage a round. */
  ranking: SlotUpgrade['ranking'];
  worn: string | null;
  wornGives: number | null;
  offers: WireOffer[];
}

export interface KonamiWireState {
  character: {
    className: string | null;
    race: string | null;
    level: number | null;
    exp: number | null;
    expNeeded: number | null;
    levelReady: boolean | null;
    trainCost: number | null;
    lives: number | null;
    /** The stats the sheet states; one it does not is left out. */
    stats: Record<string, number>;
    hpMax: number | null;
    manaMax: number | null;
    armourClass: number | null;
    damageResist: number | null;
    cp: number | null;
    /** `slot: item`, one per thing worn. */
    worn: string[];
    spells: string[] | null;
    cash: { onHand: number | null; banked: number; total: number | null };
  };
  /** Best first, as the Hunting grounds rank them. */
  grounds: WireGround[];
  /** The grounds the survival check left out, counted by why. */
  leftOut: Record<string, number>;
  /** Slots something better is sold for. */
  gear: WireSlot[];
  /** Past plans near this level, newest first. */
  lessons: string[];
  attacks: KonamiBrief['attacks'];
  openers: string[];
  canSneak: boolean | null;
  settings: KonamiBrief['settings'];
}

/** How much of the brief goes out. */
export interface WireLimits {
  grounds: number;
  offersPerSlot: number;
  lessons: number;
}

const round = (value: number | null, digits = 0): number | null =>
  value === null ? null : Number(value.toFixed(digits));

const percent = (share: number | null): number | null =>
  share === null ? null : Math.round(share * 100);

function ground(spot: BriefSpot): WireGround {
  return {
    key: spot.key,
    name: spot.name,
    expPerHour: round(spot.exp.perHour),
    expPerLap: spot.exp.perHour === null ? round(spot.exp.perCycle) : null,
    copperPerHour: round(spot.cash.perHour),
    survives: percent(spot.fight?.survives ?? null),
    worstRoomHp: percent(spot.survival.worstShare),
    steps: spot.route?.steps ?? spot.steps,
    walkHp: round(spot.route?.damage ?? null),
    deadlyOnWalk: spot.route?.deadly ?? null,
    before: spot.history
  };
}

/** What an item gives, rounded as the provider reads it. */
const gives = (ranking: SlotUpgrade['ranking'], figure: number | null): number | null =>
  round(slotGives(ranking, figure), 1);

function slotRow(slot: SlotUpgrade): WireSlot {
  return {
    slot: slot.slot,
    ranking: slot.ranking,
    worn: slot.worn,
    wornGives: gives(slot.ranking, slot.wornFigure),
    offers: slot.offers.map((offer) => ({
      name: offer.name,
      gives: gives(slot.ranking, slot.ranking === 'weapon' ? offer.figure : offer.ac),
      copper: offer.copper,
      fromLevel: offer.minLevel
    }))
  };
}

const lessonLine = (lesson: KonamiLesson): string => {
  const goal = lesson.goal;
  const what =
    goal.kind === 'hunt'
      ? `hunt ${goal.name}`
      : goal.kind === 'buy'
        ? `buy ${goal.name}`
        : goal.kind;
  return `${what}: ${lessonText(lesson)}`;
};

/** The brief as it is sent. */
export function wireState(brief: KonamiBrief): KonamiWireState {
  const { character } = brief;
  const stats: Record<string, number> = {};
  for (const [stat, value] of Object.entries(character.stats)) {
    if (value !== null) stats[stat] = value;
  }
  const leftOut: Record<string, number> = {};
  for (const spot of brief.hunting.leftOut) leftOut[spot.why] = (leftOut[spot.why] ?? 0) + 1;
  return {
    character: {
      className: character.className,
      race: character.race,
      level: character.level,
      exp: character.exp,
      expNeeded: character.expNeeded,
      levelReady: character.levelReady,
      trainCost: character.trainCost,
      lives: character.lives,
      stats,
      hpMax: character.hpMax,
      manaMax: character.manaMax,
      armourClass: character.armourClass,
      damageResist: character.damageResist,
      cp: character.cp,
      worn: character.worn.map((item) => `${item.slot ?? 'worn'}: ${item.name}`),
      spells: character.spells?.map((spell) => spell.name) ?? null,
      cash: {
        onHand: character.cash.onHand,
        banked: bankedCopper(character.cash.banks),
        total: character.cash.total
      }
    },
    grounds: brief.hunting.spots.map(ground),
    leftOut,
    gear: brief.gear.filter((slot) => slot.offers.length > 0).map(slotRow),
    lessons: brief.history.map(lessonLine),
    attacks: brief.attacks,
    openers: brief.openers,
    canSneak: brief.canSneak,
    settings: brief.settings
  };
}

/** The brief cut to the limits: the best grounds, the best offers per slot, the newest lessons. */
export function trimBrief(brief: KonamiBrief, limits: WireLimits): KonamiBrief {
  return {
    ...brief,
    hunting: { ...brief.hunting, spots: brief.hunting.spots.slice(0, limits.grounds) },
    gear: brief.gear.map((slot) => ({
      ...slot,
      offers: slot.offers.slice(0, limits.offersPerSlot)
    })),
    history: brief.history.slice(0, limits.lessons)
  };
}

/** How much one ask may send (`tuning.konami`). */
export interface RequestSizes {
  limits: WireLimits;
  /** The least the limits are trimmed to; still over the budget there, it goes and says so. */
  floor: WireLimits;
  budget: number;
  questions: QuestionSizes;
}

/** The sizes as `tuning.konami` states them. */
export function requestSizes(konami: {
  maxSpots: number;
  upgradesPerSlot: number;
  lessonsSent: number;
  requestChars: number;
  trimGrounds: number;
  trimOffers: number;
  trimLessons: number;
  beforeNamed: number;
  savingGear: number;
}): RequestSizes {
  return {
    limits: {
      grounds: konami.maxSpots,
      offersPerSlot: konami.upgradesPerSlot,
      lessons: konami.lessonsSent
    },
    floor: {
      grounds: konami.trimGrounds,
      offersPerSlot: konami.trimOffers,
      lessons: konami.trimLessons
    },
    budget: konami.requestChars,
    questions: { beforeNamed: konami.beforeNamed, savingGear: konami.savingGear }
  };
}

/** The next smaller limits, or null at the floor: lessons first, then offers, then grounds. */
function smaller(limits: WireLimits, floor: WireLimits): WireLimits | null {
  if (limits.lessons > floor.lessons) {
    return { ...limits, lessons: Math.max(floor.lessons, Math.floor(limits.lessons / 2)) };
  }
  if (limits.offersPerSlot > floor.offersPerSlot) {
    return { ...limits, offersPerSlot: limits.offersPerSlot - 1 };
  }
  if (limits.grounds > floor.grounds) return { ...limits, grounds: limits.grounds - 1 };
  return null;
}

export interface FittedRequest {
  /** The brief the questions were built from. */
  brief: KonamiBrief;
  asked: KonamiQuestions;
  /** Exactly what goes to the provider. */
  sent: KonamiAsk;
  chars: number;
  limits: WireLimits;
  /** Still over the budget at the floor. */
  over: boolean;
}

/** The request at the limits, trimmed toward the floor until it fits the budget. */
export function fitRequest(brief: KonamiBrief, sizes: RequestSizes): FittedRequest {
  let at = sizes.limits;
  for (;;) {
    const trimmed = trimBrief(brief, at);
    const asked = planQuestions(trimmed, sizes.questions);
    const sent: KonamiAsk = { state: wireState(trimmed), questions: asked.questions };
    const chars = JSON.stringify(sent).length;
    const next = chars > sizes.budget ? smaller(at, sizes.floor) : null;
    if (next === null) {
      return { brief: trimmed, asked, sent, chars, limits: at, over: chars > sizes.budget };
    }
    at = next;
  }
}

/**
 * What an ask would decide, without the figures that drift between asks: the
 * level, whether one is ready, and every label of every question with each goal
 * by what it is. The same substance twice is the same ask, and is not paid for
 * again on a clock (todo 66).
 */
export function requestSubstance({ brief, asked }: FittedRequest): string {
  const goals = Object.values(asked.labels.goal).map(goalKey).sort();
  const others = Object.entries(asked.questions)
    .filter(([name]) => name !== 'goal')
    .map(([name, question]) => [name, Object.keys(question.criteria).sort()]);
  return JSON.stringify([brief.character.level, brief.character.levelReady, goals, others]);
}

/** The goal where only one is offered: nothing to ask the provider (a level to train first). */
export function onlyGoal({ asked }: FittedRequest): KonamiGoal | null {
  const goals = Object.values(asked.labels.goal);
  return goals.length === 1 ? goals[0]! : null;
}
