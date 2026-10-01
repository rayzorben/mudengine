/**
 * The questions asked of the provider about a brief, and the plan its answers
 * make (todo 54). Every label is something this client can do: a spot key, an
 * item at a counter, an attack verb the class holds, a spell in the book.
 * Nothing is offered that the brief did not already show to be possible, so
 * whichever label comes back, carrying it out is a matter of handing it to the
 * module that already does that thing.
 */
import type { BriefSpot, GearOffer, KonamiBrief, SlotUpgrade } from './konamiBrief';
import type {
  KonamiGoal,
  KonamiLayer,
  KonamiOption,
  KonamiPick,
  KonamiPlan,
  KonamiQuestion,
  KonamiQuestionName,
  KonamiReply
} from './konami';
import { REALM_ARMOUR_SCALE } from './menace';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from './training';

/** What the character is playing for; said in every question. */
const AIM =
  'The character plays unattended. Aim for the most experience over the next 24 hours with no deaths: a death costs experience, gear and time.';

/** The `restBelow` choices offered, as fractions of the bar. */
const REST_BELOW = [0.35, 0.5, 0.6, 0.7] as const;

/** What each label of each question stands for. */
export interface KonamiLabels {
  goal: Readonly<Record<string, KonamiGoal>>;
  attack: Readonly<Record<string, string>>;
  opener: Readonly<Record<string, string>>;
  heal: Readonly<Record<string, string>>;
  /** Question name to the blessing's spell word. */
  blessings: Readonly<Record<`bless_${string}`, string>>;
  restBelow: Readonly<Record<string, number>>;
  trainFirst: Readonly<Record<string, TrainedAttribute>>;
}

export interface KonamiQuestions {
  questions: Record<string, KonamiQuestion>;
  labels: KonamiLabels;
}

const number = (value: number | null, digits = 0): string =>
  value === null ? 'unknown' : value.toFixed(digits);

const percent = (share: number | null): string =>
  share === null ? 'unknown' : `${Math.round(share * 100)}%`;

/** A spot's experience: by the hour where the respawn clock is known, else by the lap. */
function rateText(exp: BriefSpot['exp']): string {
  if (exp.perHour !== null) return `${number(exp.perHour)} exp an hour`;
  if (exp.perCycle !== null) {
    return `${number(exp.perCycle)} exp a lap (no hourly rate: the realm states no respawn time)`;
  }
  return 'unknown exp';
}

/**
 * What an item changes. A weapon in damage a round against what is wielded;
 * armour in the sheet's armour class (the realm's item figure is ten times
 * it), and what that does to the damage taken at the best spot offered.
 */
function gainText(slot: SlotUpgrade, offer: GearOffer): string {
  if (slot.ranking === 'weapon') {
    const against =
      slot.worn === null
        ? 'fighting bare-handed'
        : `${number(slot.wornFigure, 1)} for the ${slot.worn} wielded now`;
    return `${number(offer.figure, 1)} damage a round, against ${against}`;
  }
  const effect = offer.effect;
  const replaces = slot.worn === null ? 'nothing worn there now' : `the ${slot.worn} worn now`;
  if (effect === null) {
    return `${number(offer.ac === null ? null : offer.ac / REALM_ARMOUR_SCALE, 1)} armour class, in place of ${replaces}`;
  }
  const { armourClass, perRound } = effect;
  return (
    `armour class ${number(armourClass.now, 1)} -> ${number(armourClass.with, 1)} in place of ${replaces}; ` +
    `damage taken a round at ${effect.spot} (one of each monster there) ${number(perRound.now, 1)} -> ${number(perRound.with, 1)}`
  );
}

/** The fight there as the simulator ran it. */
function fightText(fight: BriefSpot['fight']): string {
  if (fight === null) return 'fight not simulated';
  return `fight simulated at full health: survived ${percent(fight.survives)} (${fight.level}), ${number(fight.rounds, 1)} rounds`;
}

/** The walk there, condensed: steps, lairs passed, what they cost, the worst of them. */
function routeText(spot: BriefSpot, hpMax: number | null): string {
  const route = spot.route;
  if (route === null) return `${number(spot.steps)} steps away (no route planned)`;
  if (route.lairs === 0) return `${route.steps} steps away, passing no lairs`;
  const cost =
    route.damage === null
      ? `, ${route.unweighed} of them not weighed, so what passing costs is unknown`
      : ` costing about ${number(route.damage)} HP in all to pass (${number(hpMax)} max)`;
  const worst = route.worst
    .map(
      (lair) =>
        `${lair.monsters.join('/') || 'unknown'} in ${lair.room} ${percent(lair.share)} of max HP a pass` +
        (lair.fight === null ? '' : `, its fight ${lair.fight}`)
    )
    .join('; ');
  const deadly = route.deadly === null ? '' : ` Expected to die passing ${route.deadly}.`;
  return `${route.steps} steps away, passing ${route.lairs} lairs${cost}; worst: ${worst}.${deadly}`;
}

function goalQuestion(brief: KonamiBrief): {
  question: KonamiQuestion;
  labels: KonamiLabels['goal'];
} {
  const criteria: Record<string, string> = {};
  const labels: Record<string, KonamiGoal> = {};
  brief.hunting.spots.forEach((spot, index) => {
    const label = `hunt_${index}`;
    labels[label] = { kind: 'hunt', key: spot.key, name: spot.name };
    const before = spot.history.length === 0 ? '' : ` Before: ${spot.history.join('; ')}.`;
    criteria[label] =
      `Hunt ${spot.name} (spot ${spot.key}, ranked ${index + 1} on the Hunting grounds): ` +
      `${rateText(spot.exp)}; ${fightText(spot.fight)}; worst room takes ${percent(spot.survival.worstShare)} of max HP. ` +
      `Getting there: ${routeText(spot, brief.character.hpMax)}${before}`;
  });
  const cash = brief.character.cash.total;
  const level = brief.character.level;
  for (const slot of brief.gear) {
    slot.offers.forEach((offer, index) => {
      if (offer.copper === null || cash === null || offer.copper > cash) return;
      if (offer.minLevel !== null && level !== null && offer.minLevel > level) return;
      const label = `buy_${slot.slot.toLowerCase().replace(/[^a-z]+/g, '_')}_${index}`;
      labels[label] = {
        kind: 'buy',
        item: offer.item,
        name: offer.name,
        slot: slot.slot,
        shop: offer.shop,
        at: offer.at,
        copper: offer.copper
      };
      criteria[label] =
        `Buy and wear ${offer.name} for the ${slot.slot} slot at ${offer.shop} ` +
        `(${offer.copper === 0 ? 'free' : `${offer.copper} copper`}, ${offer.moves} moves away): ` +
        `${gainText(slot, offer)}.`;
    });
  }
  if (brief.character.levelReady === true) {
    labels['train'] = { kind: 'train' };
    criteria['train'] = 'Walk to a trainer and train the level that is ready.';
  }
  labels['wait'] = { kind: 'wait' };
  criteria['wait'] = 'Nothing offered is worth doing; stay where you are.';
  return {
    question: {
      type: 'choice',
      instructions:
        `${AIM} What should the character do next? The state lists every spot with each monster's stats, ` +
        `the damage arithmetic, the simulated fight and the walk there with the lairs it passes, and the gear per slot. ` +
        `Every spot offered passed the survival check; a death loses everything carried, so prefer the spot whose fight and walk are safest, and among the safe ones the most exp an hour. ` +
        `Its history is what past plans near this level came to, and the monsters there the character ran from: do not choose again what killed the character, what it ran from, or what the player said no to.`,
      criteria
    },
    labels
  };
}

/**
 * The questions for one brief. A question with nothing to choose between is
 * not asked: one attack, a class that cannot hide, an empty book.
 */
export function planQuestions(brief: KonamiBrief): KonamiQuestions {
  const questions: Record<string, KonamiQuestion> = {};
  const goal = goalQuestion(brief);
  questions['goal'] = goal.question;

  const attack: Record<string, string> = {};
  if (brief.attacks.length > 1) {
    const criteria: Record<string, string> = {};
    for (const option of brief.attacks) {
      attack[option.verb] = option.verb;
      criteria[option.verb] =
        `${option.kind} (${option.verb}): ${number(option.perRound, 1)} damage a round before armour and misses.`;
    }
    questions['attack'] = {
      type: 'choice',
      instructions: `${AIM} Which attack should the character fight with?`,
      criteria
    };
  }

  const opener: Record<string, string> = {};
  if (brief.openers.length > 0) {
    const criteria: Record<string, string> = { none: 'No opener: attack from the start.' };
    opener['none'] = '';
    for (const verb of brief.openers) {
      opener[verb] = verb;
      criteria[verb] = `Hide, then open each fight with ${verb}.`;
    }
    questions['opener'] = {
      type: 'choice',
      instructions: `${AIM} How should the character open a fight?`,
      criteria
    };
  }

  if (brief.canSneak === true) {
    questions['sneak'] = {
      type: 'noul',
      instructions: `${AIM} Should the character sneak while it walks?`,
      criteria: { true: 'Sneak between rooms.', false: 'Walk normally.' }
    };
  }

  const heal: Record<string, string> = {};
  const blessings: Record<`bless_${string}`, string> = {};
  const book = brief.character.spells ?? [];
  const heals = book.filter((spell) => spell.heals);
  if (heals.length > 0) {
    const criteria: Record<string, string> = {
      auto: 'Choose the heal per cast: the cheapest that reaches the ceiling, else the biggest.'
    };
    heal['auto'] = 'auto';
    for (const spell of heals) {
      heal[spell.word] = spell.word;
      criteria[spell.word] = `Always heal with ${spell.name} (${number(spell.cost)} mana).`;
    }
    questions['heal'] = {
      type: 'choice',
      instructions: `${AIM} Which heal should the character use?`,
      criteria
    };
  }
  for (const spell of book.filter((known) => known.blessing)) {
    const name = `bless_${spell.word}` as const;
    blessings[name] = spell.word;
    questions[name] = {
      type: 'noul',
      instructions: `${AIM} Should the character keep ${spell.name} (${number(spell.cost)} mana) up on itself?`,
      criteria: { true: `Keep ${spell.name} up.`, false: `Do not cast ${spell.name}.` }
    };
  }

  const restBelow: Record<string, number> = {};
  const restCriteria: Record<string, string> = {};
  for (const share of REST_BELOW) {
    const label = `rest_${Math.round(share * 100)}`;
    restBelow[label] = share;
    restCriteria[label] = `Rest when HP falls below ${Math.round(share * 100)}% of max.`;
  }
  questions['restBelow'] = {
    type: 'choice',
    instructions: `${AIM} Below what share of max HP should the character stop and rest?`,
    criteria: restCriteria
  };

  const trainFirst: Record<string, TrainedAttribute> = {};
  const trainCriteria: Record<string, string> = {};
  for (const stat of TRAINED_ATTRIBUTES) {
    trainFirst[stat] = stat;
    trainCriteria[stat] =
      `Spend character points on ${stat} first (now ${number(brief.character.stats[stat] ?? null)}).`;
  }
  questions['trainFirst'] = {
    type: 'choice',
    instructions: `${AIM} Which stat should character points go to first, for this class and race?`,
    criteria: trainCriteria
  };

  return {
    questions,
    labels: { goal: goal.labels, attack, opener, heal, blessings, restBelow, trainFirst }
  };
}

/**
 * The plan the answers make. The reply was parsed against the same questions
 * (`asKonamiReply`), so every label is one of ours; a yes/no is yes above one
 * half.
 */
export function readPlan(reply: KonamiReply, { labels }: KonamiQuestions): KonamiPlan {
  const picks: KonamiPick[] = [];
  const choice = (question: KonamiQuestionName): string | null => {
    const answer = reply.answers[question];
    if (answer?.type !== 'choice') return null;
    picks.push({ question, label: answer.choice, p: answer.confidence });
    return answer.choice;
  };
  const yes = (question: KonamiQuestionName): boolean | null => {
    const answer = reply.answers[question];
    if (answer?.type !== 'noul') return null;
    picks.push({ question, label: answer.noul > 0.5 ? 'yes' : 'no', p: answer.noul });
    return answer.noul > 0.5;
  };

  const goalLabel = choice('goal');
  const goal: KonamiGoal = (goalLabel === null ? undefined : labels.goal[goalLabel]) ?? {
    kind: 'wait'
  };
  const goalAnswer = reply.answers['goal'];
  const options: KonamiOption[] =
    goalAnswer?.type === 'choice'
      ? Object.entries(goalAnswer.probabilities)
          .flatMap(([label, p]) => {
            const offered = labels.goal[label];
            return offered === undefined ? [] : [{ goal: offered, p }];
          })
          .sort((a, b) => b.p - a.p)
      : [];
  const layer: KonamiLayer = {};
  const attack = choice('attack');
  if (attack !== null && labels.attack[attack] !== undefined) layer.attack = labels.attack[attack];
  const opener = choice('opener');
  if (opener !== null && labels.opener[opener] !== undefined) layer.opener = labels.opener[opener];
  const sneak = yes('sneak');
  if (sneak !== null) layer.sneak = sneak;
  const heal = choice('heal');
  if (heal !== null && labels.heal[heal] !== undefined) layer.heal = labels.heal[heal];
  const kept: string[] = [];
  for (const [question, word] of Object.entries(labels.blessings) as Array<
    [`bless_${string}`, string]
  >) {
    if (yes(question) === true) kept.push(word);
  }
  if (Object.keys(labels.blessings).length > 0) layer.blessings = kept;
  const rest = choice('restBelow');
  if (rest !== null && labels.restBelow[rest] !== undefined) {
    layer.restBelow = labels.restBelow[rest];
  }
  const stat = choice('trainFirst');
  if (stat !== null && labels.trainFirst[stat] !== undefined) {
    layer.trainFirst = labels.trainFirst[stat];
  }
  return { goal, layer, picks, options };
}

/** Two plans do the same thing: the stuck log's test of whether asking again helped. */
export function samePlan(a: KonamiPlan, b: KonamiPlan): boolean {
  return JSON.stringify([a.goal, a.layer]) === JSON.stringify([b.goal, b.layer]);
}

/** The cheapest item offered that is not yet affordable, in copper; null when none is priced. */
export function nextUpgradePrice(brief: KonamiBrief): number | null {
  const cash = brief.character.cash.total ?? 0;
  let cheapest: number | null = null;
  for (const slot of brief.gear) {
    for (const offer of slot.offers) {
      if (offer.copper === null || offer.copper <= cash) continue;
      if (cheapest === null || offer.copper < cheapest) cheapest = offer.copper;
    }
  }
  return cheapest;
}
