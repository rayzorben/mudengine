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
  CoinPickup,
  KonamiGoal,
  KonamiLayer,
  KonamiOption,
  KonamiPick,
  KonamiPlan,
  KonamiQuestion,
  KonamiQuestionName,
  KonamiReply
} from './konami';
import { number, offerLabel, purseText, slotGives } from './konamiPurse';
import { readSaving, savingQuestions, type SavingLabels } from './konamiSaving';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from './training';

/** What the character is playing for; said in every question. */
const AIM = 'Unattended play: the most exp over the next 24 hours, and no deaths.';

/** How much of the brief the questions name (`tuning.konami`). */
export interface QuestionSizes {
  /** Past outcomes named in a ground's criterion; the state lists them all. */
  beforeNamed: number;
  /** The most items offered to save for. */
  savingGear: number;
}

/** The `restBelow` choices offered, as fractions of the bar. */
const REST_BELOW = [0.35, 0.5, 0.6, 0.7] as const;

const LARGE_COIN = ['runic', 'platinum', 'gold'] as const;

/** The coin pickups offered, from every coin to gold and up with copper and silver dropped. */
const COIN_PICKUPS: Readonly<Record<string, { pickup: CoinPickup; says: string }>> = {
  all: {
    pickup: { pick: [...LARGE_COIN, 'silver', 'copper'], shed: [] },
    says: 'Pick up every coin, copper and silver included.'
  },
  silver_up: {
    pickup: { pick: [...LARGE_COIN, 'silver'], shed: [] },
    says: 'Leave copper on the floor; keep any already carried.'
  },
  gold_up: {
    pickup: { pick: [...LARGE_COIN], shed: [] },
    says: 'Leave copper and silver on the floor; keep any already carried.'
  },
  gold_up_shed: {
    pickup: { pick: [...LARGE_COIN], shed: ['silver', 'copper'] },
    says: 'Leave copper and silver on the floor, and drop any carried.'
  }
};

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
  coins: Readonly<Record<string, CoinPickup>>;
  saving: SavingLabels;
}

export interface KonamiQuestions {
  questions: Record<string, KonamiQuestion>;
  labels: KonamiLabels;
}

const percent = (share: number | null): string =>
  share === null ? 'unknown' : `${Math.round(share * 100)}%`;

/** A spot's experience: by the hour where the respawn clock is known, else by the lap. */
function rateText(exp: BriefSpot['exp']): string {
  if (exp.perHour !== null) return `${number(exp.perHour)} exp/hr`;
  if (exp.perCycle !== null) return `${number(exp.perCycle)} exp a lap (no respawn time)`;
  return 'exp unknown';
}

/** The coin its monsters carry, where they carry any. */
function cashRateText(cash: BriefSpot['cash']): string {
  return cash.perHour !== null && cash.perHour > 0 ? `, ${number(cash.perHour)} copper/hr` : '';
}

/**
 * What an item changes. A weapon in damage a round against what is wielded;
 * armour in the sheet's armour class (the realm's item figure is ten times
 * it), and what that does to the damage taken at the best spot offered.
 */
function gainText(slot: SlotUpgrade, offer: GearOffer): string {
  if (slot.ranking === 'weapon') {
    const against = slot.worn === null ? 'bare hands' : `${number(slot.wornFigure, 1)} now`;
    return `${number(slotGives(slot.ranking, offer.figure), 1)} damage a round against ${against}`;
  }
  const effect = offer.effect;
  if (effect === null) {
    return `${number(slotGives(slot.ranking, offer.ac), 1)} armour class`;
  }
  const { armourClass, perRound } = effect;
  return (
    `armour class ${number(armourClass.now, 1)} -> ${number(armourClass.with, 1)}; ` +
    `damage taken a round at the best ground ${number(perRound.now, 1)} -> ${number(perRound.with, 1)}`
  );
}

/** The fight there as the simulator ran it. */
function fightText(fight: BriefSpot['fight']): string {
  if (fight === null) return 'fight not simulated';
  return `survives ${percent(fight.survives)} (${fight.level})`;
}

/** The walk there: steps, what its lairs cost, the worst of them and how its fight goes. */
function routeText(spot: BriefSpot): string {
  const route = spot.route;
  if (route === null) return `${number(spot.steps)} steps, no route planned`;
  if (route.lairs === 0) return `${route.steps} steps, no lairs on the way`;
  const cost =
    route.damage === null
      ? `${route.unweighed} of ${route.lairs} lairs on the way not weighed`
      : `the walk costs ${number(route.damage)} HP`;
  const worst = route.worst[0];
  const worstText =
    worst === undefined
      ? ''
      : `; worst lair ${worst.room} ${percent(worst.share)} HP a pass` +
        (worst.fight === null ? '' : ` (${worst.fight})`);
  const deadly = route.deadly === null ? '' : `; expected to die passing ${route.deadly}`;
  return `${route.steps} steps, ${cost}${worstText}${deadly}`;
}

/** Training the level that is ready, as a goal offered. */
function offerTraining(labels: Record<string, KonamiGoal>, criteria: Record<string, string>): void {
  labels['train'] = { kind: 'train' };
  criteria['train'] = 'Walk to a trainer and train the level that is ready.';
}

function goalQuestion(
  brief: KonamiBrief,
  sizes: QuestionSizes
): {
  question: KonamiQuestion;
  labels: KonamiLabels['goal'];
} {
  const criteria: Record<string, string> = {};
  const labels: Record<string, KonamiGoal> = {};
  /*
   * A level ready to train is trained first: training raises max HP before
   * the next fight. Offered alone unless training at this level has been
   * refused, so a trainer out of reach is no loop.
   */
  const level = brief.character.level;
  const trainRefused = brief.history.some(
    (lesson) =>
      lesson.goal.kind === 'train' && lesson.outcome === 'refused' && lesson.level === level
  );
  // Only while the cash carried covers the trainer (the trip draws on no bank): level 1 is
  // free, level 2 is not.
  const { trainCost } = brief.character;
  const carried = brief.character.cash.onHand;
  const cash = brief.character.cash.total;
  const affordable =
    trainCost !== null && (trainCost === 0 || (carried !== null && trainCost <= carried));
  const ready = brief.character.levelReady === true && affordable;
  if (ready && !trainRefused) {
    offerTraining(labels, criteria);
    return {
      question: {
        type: 'choice',
        instructions: `${AIM} A level is ready to train, and training comes before anything else.`,
        criteria
      },
      labels
    };
  }
  brief.hunting.spots.forEach((spot, index) => {
    const label = `hunt_${index}`;
    labels[label] = { kind: 'hunt', key: spot.key, name: spot.name };
    const before =
      spot.history.length === 0
        ? ''
        : ` Before: ${spot.history.slice(0, sizes.beforeNamed).join('; ')}.`;
    criteria[label] =
      `Hunt ${spot.name} (${spot.key}, ground ${index + 1}): ` +
      `${rateText(spot.exp)}${cashRateText(spot.cash)}; ${fightText(spot.fight)}; worst room ${percent(spot.survival.worstShare)} HP. ` +
      `${routeText(spot)}.${before}`;
  });
  for (const slot of brief.gear) {
    slot.offers.forEach((offer, index) => {
      if (offer.copper === null || cash === null || offer.copper > cash) return;
      if (offer.minLevel !== null && level !== null && offer.minLevel > level) return;
      const label = offerLabel(slot, index);
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
        `Buy and wear ${offer.name} (${slot.slot}, ${offer.copper === 0 ? 'free' : `${offer.copper} copper`}, ` +
        `${offer.moves} moves): ${gainText(slot, offer)}.`;
    });
  }
  if (ready) offerTraining(labels, criteria);
  labels['wait'] = { kind: 'wait' };
  criteria['wait'] = 'Nothing offered is worth doing; stay where you are.';
  return {
    question: {
      type: 'choice',
      instructions:
        `${AIM} What should the character do next? The state lists each hunting ground with the exp and copper it yields an hour, ` +
        `its simulated fight and the walk there, and the best gear sold per slot. ` +
        `Every ground offered passed the survival check; a death loses everything carried, so prefer the safest fight and walk, and among the safe ones the most exp an hour. ` +
        `Lessons are what past plans near this level came to: do not choose again what killed the character, what it ran from, or what the player said no to.`,
      criteria
    },
    labels
  };
}

/**
 * The questions for one brief. A question with nothing to choose between is
 * not asked: one attack, a class that cannot hide, an empty book.
 */
export function planQuestions(brief: KonamiBrief, sizes: QuestionSizes): KonamiQuestions {
  const questions: Record<string, KonamiQuestion> = {};
  const goal = goalQuestion(brief, sizes);
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
    instructions:
      `${AIM} Which stat should character points go to first, for this class and race? ` +
      `The spots chosen are ones where the character takes little damage, so hitting, doing damage and not being hit ` +
      `matter more than hit points; health should not fall far behind, but it is not the first choice.`,
    criteria: trainCriteria
  };

  const coins: Record<string, CoinPickup> = {};
  const coinCriteria: Record<string, string> = {};
  for (const [label, { pickup, says }] of Object.entries(COIN_PICKUPS)) {
    coins[label] = pickup;
    coinCriteria[label] = says;
  }
  questions['coins'] = {
    type: 'choice',
    instructions: `${AIM} Which coins should the character pick up from the floor? ${cashText(brief)}`,
    criteria: coinCriteria
  };

  const saving = savingQuestions(brief, AIM, sizes.savingGear);
  Object.assign(questions, saving.questions);

  return {
    questions,
    labels: {
      goal: goal.labels,
      attack,
      opener,
      heal,
      blessings,
      restBelow,
      trainFirst,
      coins,
      saving: saving.labels
    }
  };
}

/**
 * The purse against what is wanted next, for the coin question: copper and
 * silver matter while cash is short of the next level or upgrade, and are
 * weight and a command a coin once there is plenty.
 */
function cashText(brief: KonamiBrief): string {
  return (
    `${purseText(brief)} ` +
    `Every coin picked up is a command and carries weight: copper and silver are worth it while cash is short of what is needed next, ` +
    `and not once there is plenty.`
  );
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
  const coins = choice('coins');
  if (coins !== null && labels.coins[coins] !== undefined) layer.coins = labels.coins[coins];
  const saved = readSaving(labels.saving, {
    saveFor: choice('saveFor'),
    saveWithin: choice('saveWithin')
  });
  if (saved !== null) layer.cashPerHour = saved.cashPerHour;
  return { goal, layer, picks, options, saving: saved?.saving ?? null };
}

/** Two plans do the same thing: the stuck log's test of whether asking again helped. */
export function samePlan(a: KonamiPlan, b: KonamiPlan): boolean {
  return JSON.stringify([a.goal, a.layer]) === JSON.stringify([b.goal, b.layer]);
}
