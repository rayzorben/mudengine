/**
 * What the planner keeps and writes down: each decision whole (todo 56), the
 * death and stuck logs (57, 58), and what the Konami card is shown (59).
 */
import type { KonamiAsk, KonamiGoal, KonamiPlan, KonamiTrigger } from './konami';
import type { BriefSpot, KonamiBrief } from './konamiBrief';
import type { HuntWait } from './hunting';
import type { HistoryEntry } from './konamiHistory';
import { goalKey, type KonamiLesson } from './konamiLessons';
import type { KonamiRoadView, RoadMark } from './konamiRoad';

/**
 * What became of a decision. `applied` until one of the others lands;
 * `failed` is an ask that made no plan, `vetoed` the player turning one down
 * from the card.
 */
export type KonamiOutcome =
  'applied' | 'done' | 'refused' | 'replaced' | 'failed' | 'died' | 'vetoed';

/** One ask of the provider, whole: what was sent, what came back, what was made of it. */
export interface KonamiDecision {
  id: string;
  at: number;
  trigger: KonamiTrigger;
  provider: string;
  model: string | null;
  /** The brief the questions were built from, trimmed as sent; kept in memory, never written. */
  brief: KonamiBrief;
  /** Exactly what went to the provider (`fitRequest`); null where the plan was decided here. */
  sent: KonamiAsk | null;
  /** The reply as the provider sent it, before it was parsed. */
  raw: unknown;
  plan: KonamiPlan | null;
  /** Why no plan came of it: no reply, a reply that did not answer, a timeout. */
  refusal: string | null;
  outcome: KonamiOutcome;
  outcomeWhy: string | null;
  settledAt: number | null;
  /**
   * When the goal was taken up, and the experience then. A reply giving the same goal back
   * continues it, so the lesson covers the whole stretch rather than the last ask's.
   */
  goalSince: { at: number; exp: number | null };
}

/** One ask as the card's terminal shows it: what went, what came back. */
export interface KonamiExchange {
  /** Null where nothing was asked: the plan was decided here. */
  request: KonamiAsk | null;
  raw: unknown;
  refusal: string | null;
}

export type KonamiIncidentKind = 'death' | 'stuck';

/**
 * Where the planner's records go: the decision log and the incident folders.
 * An interface so the planner does no file handling of its own; the session
 * layer knows where the character's directory is.
 */
export interface KonamiRecords {
  /** Appends one line of JSON to the decision log. */
  journal(line: string): void;
  /** Writes one folder of files; the folder's path, or null where it could not be written. */
  incident(
    kind: KonamiIncidentKind,
    at: number,
    files: Readonly<Record<string, string>>
  ): string | null;
  /** Appends to the running log: every step the planner takes, in order. */
  log(text: string): void;
  /** Where the running log is written. */
  logPath: string;
  /** The newest `lines` lines the session printed, colour codes removed. */
  recentLines(lines: number): string;
  /** Appends one lesson: what a plan came to. */
  lesson(row: KonamiLesson): void;
  /** Every lesson on record for this character, oldest first. */
  lessons(): KonamiLesson[];
  /** Writes the lessons file over with these, for a lesson the player forgot. */
  rewriteLessons(rows: readonly KonamiLesson[]): void;
  /** The goals the player declined or marked bad on the road, oldest first. */
  roadMarks(): RoadMark[];
  /** Writes the road's marks over with these. */
  rewriteRoadMarks(rows: readonly RoadMark[]): void;
  /** Appends one thing the character did to the history. */
  historyLine(entry: HistoryEntry): void;
  /** The whole history on record for this character, oldest first. */
  history(): HistoryEntry[];
}

/** One blow on the character, as the death log lists it. */
export interface KonamiBlow {
  at: number;
  /** Who landed it, where the line names one; null for a trap or a spell nobody cast. */
  from: string | null;
  damage: number;
  text: string;
}

/** What the provider was shown about a spot, as the card draws it beside the odds. */
export interface KonamiSpotFacts {
  expPerHour: number | null;
  expPerLap: number | null;
  /** The simulated fight's share survived, 0..1; null where it was not run. */
  survives: number | null;
  steps: number | null;
  lairs: number | null;
  /** Health the walk's lairs cost, summed; null where any could not be weighed. */
  routeHp: number | null;
  /** The room the walk is expected to die in, where there is one. */
  deadly: string | null;
}

/** One goal offered, the odds the reply gave it, and for a spot what it was told. */
export interface KonamiOptionRow {
  goal: KonamiGoal;
  p: number;
  chosen: boolean;
  spot: KonamiSpotFacts | null;
}

/** A decision as the card lists it. */
export interface KonamiDecisionRow {
  id: string;
  at: number;
  trigger: KonamiTrigger;
  /** The character's level when it was asked. */
  level: number | null;
  plan: KonamiPlan | null;
  options: KonamiOptionRow[];
  refusal: string | null;
  outcome: KonamiOutcome;
  outcomeWhy: string | null;
  settledAt: number | null;
}

/** A lesson as the card lists it: `applies` while it is still sent with each brief. */
export interface KonamiLessonRow extends KonamiLesson {
  applies: boolean;
}

function spotFacts(spot: BriefSpot): KonamiSpotFacts {
  return {
    expPerHour: spot.exp.perHour,
    expPerLap: spot.exp.perCycle,
    survives: spot.fight?.survives ?? null,
    steps: spot.route?.steps ?? spot.steps,
    lairs: spot.route?.lairs ?? null,
    routeHp: spot.route?.damage ?? null,
    deadly: spot.route?.deadly ?? null
  };
}

/** A decision as the card lists it, with each option's spot read off the brief it was asked with. */
export function decisionRow(decision: KonamiDecision): KonamiDecisionRow {
  const chosen = decision.plan === null ? null : goalKey(decision.plan.goal);
  return {
    id: decision.id,
    at: decision.at,
    trigger: decision.trigger,
    level: decision.brief.character.level,
    plan: decision.plan,
    options: (decision.plan?.options ?? []).map((option) => {
      const goal = option.goal;
      const spot =
        goal.kind === 'hunt'
          ? decision.brief.hunting.spots.find((each) => each.key === goal.key)
          : undefined;
      return {
        goal,
        p: option.p,
        chosen: goalKey(goal) === chosen,
        spot: spot === undefined ? null : spotFacts(spot)
      };
    }),
    refusal: decision.refusal,
    outcome: decision.outcome,
    outcomeWhy: decision.outcomeWhy,
    settledAt: decision.settledAt
  };
}

export interface KonamiIncidentRow {
  kind: KonamiIncidentKind;
  at: number;
  path: string | null;
}

/** What the goal in hand is doing now, as the module doing it says. */
export type KonamiDoing =
  | { kind: 'train'; trainer: string; room: string; copper: number; training: boolean }
  /** `bank`: fetching the cash first; `shop`: at the counter, listing or buying. */
  | { kind: 'buy'; item: string; shop: string; stage: 'walking' | 'bank' | 'shop' }
  | { kind: 'hunt'; walking: boolean; place: string }
  /** The hunt was steered and has not set off, and why. */
  | { kind: 'waiting'; on: HuntWait };

/** The goal at work, and how far the walk it is on has got, where it is walking. */
export interface KonamiActivity {
  doing: KonamiDoing;
  walk: { done: number; total: number } | null;
}

/** What the Konami card is shown. */
export interface KonamiSnapshot {
  /** `automation.superKonamiMode`. */
  on: boolean;
  paused: boolean;
  /** The provider's name once loaded, else null with `refusal` saying why. */
  provider: string | null;
  asking: boolean;
  /** `automation.enabled`: off, nothing a plan hands a goal to acts, and nothing is asked. */
  automation: boolean;
  /** Waiting to be asked, and why, until the character is free. */
  pending: KonamiTrigger | null;
  refusal: string | null;
  plan: KonamiPlan | null;
  /** Newest first. */
  decisions: KonamiDecisionRow[];
  incidents: KonamiIncidentRow[];
  /** Where this run's running log is written, or null with no records. */
  log: string | null;
  /** The plan in force: experience made since it was chosen, null before the sheet says. */
  expSince: number | null;
  /** What the plan's goal is doing right now; null while nothing is at work on it. */
  activity: KonamiActivity | null;
  /** What the character has done, newest first, at most `tuning.konami.historyShown`. */
  history: HistoryEntry[];
  /** The road ahead and what the player said about it; null before there is either. */
  road: KonamiRoadView | null;
  /** Lessons on record, newest first, at most `tuning.konami.lessonsShown`. */
  lessons: KonamiLessonRow[];
  /** Every lesson on record, shown or not. */
  lessonsKept: number;
  /** The character's level now, and how many levels either side of it a lesson is sent for. */
  level: number | null;
  lessonLevels: number;
}

export const EMPTY_KONAMI: KonamiSnapshot = {
  on: false,
  paused: false,
  provider: null,
  asking: false,
  automation: true,
  pending: null,
  refusal: null,
  plan: null,
  decisions: [],
  incidents: [],
  log: null,
  expSince: null,
  activity: null,
  history: [],
  road: null,
  lessons: [],
  lessonsKept: 0,
  level: null,
  lessonLevels: 0
};
