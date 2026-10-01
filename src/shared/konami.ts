/**
 * The "what to do next" planner's shared half: the port an outside decision
 * provider implements, what a plan is, and when one is asked for.
 *
 * The provider is a classifier. It is handed a state and named questions and
 * answers each by picking one of the labels it was given (`choice`) or by a
 * probability of yes (`noul`). It invents nothing, so every label is an id
 * this client can act on and every fact it weighs is one this client read.
 * See `todo/50-konami-plan-not-steer.md`.
 */
import { COPPER_PER } from './coins';
import { experienceStanding, type ExperienceTable } from './experience';
import type { BlessingConfig } from './blessings';
import type { Denomination } from './character';
import type { AutomationConfig } from './config';
import type { TrainedAttribute } from './training';

/** A question the provider answers: one label of several, or yes or no. */
export type KonamiQuestion =
  | { type: 'choice'; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } };

/** The provider's answer to one question. */
export type KonamiAnswer =
  | {
      type: 'choice';
      choice: string;
      confidence: number;
      probabilities: Readonly<Record<string, number>>;
    }
  | { type: 'noul'; noul: number };

export interface KonamiAsk {
  /** A plain JSON value: the brief. */
  state: unknown;
  questions: Readonly<Record<string, KonamiQuestion>>;
}

export interface KonamiReply {
  model: string;
  answers: Readonly<Record<string, KonamiAnswer>>;
}

/**
 * What an outside module exports for the planner to ask. Loaded from disk by
 * path (`automation.konamiProviderPath`), so nothing about the provider is
 * compiled into this client.
 */
export interface KonamiProvider {
  readonly name: string;
  ask(request: KonamiAsk): Promise<KonamiReply>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probability(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/**
 * The provider's reply as the typed value, or null. Parsed at the boundary:
 * an answer to a question that was not asked, a label that was not offered or
 * a probability out of range makes the whole reply unusable, since a plan
 * half-read from it would act on a guess.
 */
export function asKonamiReply(
  value: unknown,
  questions: Readonly<Record<string, KonamiQuestion>>
): KonamiReply | null {
  if (!isRecord(value) || !isRecord(value['answers'])) return null;
  const raw = value['answers'];
  const answers: Record<string, KonamiAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = raw[name];
    if (!isRecord(answer)) return null;
    if (question.type === 'noul') {
      const noul = probability(answer['noul']);
      if (answer['type'] !== 'noul' || noul === null) return null;
      answers[name] = { type: 'noul', noul };
      continue;
    }
    const choice = answer['choice'];
    const confidence = probability(answer['confidence']);
    if (
      answer['type'] !== 'choice' ||
      typeof choice !== 'string' ||
      !(choice in question.criteria) ||
      confidence === null ||
      !isRecord(answer['probabilities'])
    ) {
      return null;
    }
    const probabilities: Record<string, number> = {};
    for (const [label, p] of Object.entries(answer['probabilities'])) {
      const known = probability(p);
      if (known !== null && label in question.criteria) probabilities[label] = known;
    }
    answers[name] = { type: 'choice', choice, confidence, probabilities };
  }
  const model = typeof value['model'] === 'string' ? value['model'] : '';
  return { model, answers };
}

/**
 * Whether a level is ready to train: experience needed counted down to
 * nothing, where `exp` has said; else the experience held against the table
 * (`experienceStanding`, the realm's rows or the ones derived from its data),
 * since `st` states the experience and not what is needed. Null where neither
 * can say.
 */
export function levelReady(progress: {
  level: number | null;
  exp: number | null;
  expNeeded: number | null;
  expTable: ExperienceTable | null;
}): boolean | null {
  if (progress.expNeeded !== null) return progress.expNeeded <= 0;
  const standing = experienceStanding(progress.level, progress.exp, progress.expTable);
  return standing === null ? null : standing.earned > standing.level;
}

/** Why a plan was asked for. */
export const KONAMI_TRIGGERS = [
  'entered',
  'level',
  'trained',
  'death',
  'goal-done',
  'goal-refused',
  'cash-step',
  'upgrade-affordable',
  'gear',
  'stuck',
  'asked',
  'vetoed',
  'chosen',
  'ready',
  'review',
  'saved',
  'train-affordable',
  'underpaid'
] as const;

export type KonamiTrigger = (typeof KONAMI_TRIGGERS)[number];

const PLATINUM = COPPER_PER.platinum;
const RUNIC = COPPER_PER.runic;

/**
 * Which cash step a total is on, the user's ladder: nothing, 1p, 10p, 20p …
 * 90p, then 1 runic, 2 runic and on. A total crossing into a higher step is
 * worth a new plan, since gear that was out of reach may not be now. Null
 * cash is no step.
 */
export function cashStep(copper: number | null): number | null {
  if (copper === null) return null;
  if (copper < PLATINUM) return 0;
  const platinum = Math.floor(copper / PLATINUM);
  if (platinum < 10) return 1;
  if (copper < RUNIC) return 1 + Math.floor(platinum / 10);
  return 10 + Math.floor(copper / RUNIC);
}

/** What the plan sends the character to do. */
export type KonamiGoal =
  | { kind: 'hunt'; key: string; name: string }
  | {
      kind: 'buy';
      item: number;
      name: string;
      slot: string;
      shop: string;
      at: { map: number; room: number };
      copper: number;
    }
  | { kind: 'train' }
  /** Nothing offered was worth doing; the character stays where it is. */
  | { kind: 'wait' };

/**
 * The settings a plan chose, laid over the character's own for as long as the
 * planner runs. Absent is *leave the player's setting alone*.
 */
export interface KonamiLayer {
  attack?: string;
  /** `''` is no opener. */
  opener?: string;
  sneak?: boolean;
  /** A spell word, or `'auto'` for the book's best (`spells.autoChooseHeal`). */
  heal?: string;
  /** The book's blessings to keep up, each on the caster. */
  blessings?: string[];
  restBelow?: number;
  trainFirst?: TrainedAttribute;
  /** The coins picked up from the floor, and those carried that are dropped. */
  coins?: CoinPickup;
  /** Copper an hour the hunt should earn while the plan saves (`hunting.cashPerHour`). */
  cashPerHour?: number;
}

/**
 * What the plan saves for: the copper wanted, and whether it must be carried
 * (the trainer's trip draws on no bank) or may be banked too (a shop trip
 * withdraws). Reaching it asks for a new plan.
 */
export interface KonamiSaving {
  what: string;
  copper: number;
  carried: boolean;
  /** The item saved for, where it is one; bought first once the copper is there (todo 77). */
  item: number | null;
}

/** Which coins are worth bending down for, and which are worth shedding. */
export interface CoinPickup {
  pick: Denomination[];
  shed: Denomination[];
}

/** The questions asked, by name; one per blessing in the book, named for its spell word. */
export type KonamiQuestionName =
  | 'goal'
  | 'attack'
  | 'opener'
  | 'sneak'
  | 'heal'
  | 'restBelow'
  | 'trainFirst'
  | 'coins'
  | 'saveFor'
  | 'saveWithin'
  | `bless_${string}`;

/** The label picked for a question and how sure the provider was. */
export interface KonamiPick {
  question: KonamiQuestionName;
  label: string;
  /** The choice's confidence, or a yes/no's probability of yes. */
  p: number;
}

/** One goal the provider was offered, and the odds it gave it. */
export interface KonamiOption {
  goal: KonamiGoal;
  p: number;
}

/** What an answer makes: somewhere to go and the settings to go with. */
export interface KonamiPlan {
  goal: KonamiGoal;
  layer: KonamiLayer;
  picks: KonamiPick[];
  /** Every goal the reply gave odds to, likeliest first; the chosen one among them. */
  options: KonamiOption[];
  /** What the plan saves for, or null. */
  saving: KonamiSaving | null;
}

/** A self blessing as the player's own form writes one (`normalizeBlessings`). */
function selfBlessing(spell: string): BlessingConfig {
  return { spell, target: 'self', minMana: 0, prioritizeOverHeal: false, inCombat: true };
}

/** One setting a layer writes: its path under `automation` and the value. */
export type LayerWrite = readonly [path: readonly string[], value: unknown];

/**
 * What a layer changes, as paths under `automation`: laid over the settings
 * in memory while the planner runs (`layered`), and written into the
 * character's file when the player keeps them. One list, so the two cannot
 * disagree about what a plan's settings are.
 */
export function layerWrites(config: AutomationConfig, layer: KonamiLayer): LayerWrite[] {
  const writes: LayerWrite[] = [];
  if (layer.attack !== undefined) writes.push([['combat', 'attack'], layer.attack]);
  if (layer.opener !== undefined) {
    writes.push([['combat', 'opener'], layer.opener]);
    writes.push([['combat', 'hideForOpener'], layer.opener.length > 0]);
  }
  if (layer.sneak !== undefined) writes.push([['movement', 'sneak'], layer.sneak]);
  if (layer.heal !== undefined) {
    writes.push([['spells', 'autoChooseHeal'], layer.heal === 'auto']);
    if (layer.heal !== 'auto') writes.push([['spells', 'heal'], layer.heal]);
  }
  if (layer.blessings !== undefined) {
    writes.push([['spells', 'blessings'], layer.blessings.map(selfBlessing)]);
  }
  if (layer.restBelow !== undefined) {
    writes.push([['health', 'restBelow'], layer.restBelow]);
    writes.push([['health', 'restTo'], Math.max(config.health.restTo, layer.restBelow)]);
  }
  if (layer.trainFirst !== undefined) {
    writes.push([['train', 'stats'], true]);
    // Above any race's ceiling: `planTraining` aims at the ceiling and says so.
    writes.push([['train', 'wanted', layer.trainFirst], 999]);
  }
  if (layer.coins !== undefined) {
    writes.push([['loot', 'coins'], true]);
    writes.push([['loot', 'coinKinds'], layer.coins.pick]);
    writes.push([['loot', 'discardKinds'], layer.coins.shed]);
  }
  if (layer.cashPerHour !== undefined) {
    writes.push([['hunting', 'cashPerHour'], layer.cashPerHour]);
  }
  return writes;
}

/**
 * The switches a goal needs, on for as long as it is the goal and never kept
 * into the file: Auto-Hunt to walk the spot the plan named, the trainer trip
 * to collect a level, the shop trip to buy the item. Turning the planner on
 * is the consent to these, as turning Auto-Hunt on is to its walk; the card
 * lists them.
 */
export function goalWrites(goal: KonamiGoal['kind']): LayerWrite[] {
  switch (goal) {
    case 'hunt':
      return [[['hunting', 'enabled'], true]];
    case 'train':
      return [[['train', 'levels'], true]];
    case 'buy':
      return [[['supplies', 'enabled'], true]];
    case 'wait':
      return [];
    default: {
      const never: never = goal;
      return never;
    }
  }
}

/** The character's settings with a plan laid over them. */
export function layered(
  config: AutomationConfig,
  layer: KonamiLayer,
  goal: KonamiGoal['kind']
): AutomationConfig {
  const out = structuredClone(config);
  for (const [path, value] of [...layerWrites(config, layer), ...goalWrites(goal)]) {
    let at = out as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
    at[path[path.length - 1]!] = structuredClone(value);
  }
  return out;
}
