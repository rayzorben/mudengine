/**
 * What a plan came to, as a lesson (`shared/konamiLessons.ts`): read off the
 * decision as it was sent, the character as it stands at the end, and the
 * blows of the last fight when the end was a death. Pure.
 */
import type { CharacterState } from '../../../shared/character';
import type { KonamiGoal } from '../../../shared/konami';
import type { KonamiLesson, LessonOutcome } from '../../../shared/konamiLessons';
import type { KonamiBlow, KonamiDecision } from '../../../shared/konamiRecords';
import { killersOf } from './incident';

export interface LessonInput {
  decision: KonamiDecision;
  outcome: LessonOutcome;
  why: string | null;
  state: CharacterState;
  blows: readonly KonamiBlow[];
  fightGapMs: number;
  /** A plan replaced sooner than this taught nothing (`tuning.konami.lessonMinMs`). */
  lessonMinMs: number;
  now: number;
}

/** Nothing is learned from a plan that never came back, from waiting, or from a moment. */
export function lessonOf(input: LessonInput): KonamiLesson | null {
  const { decision, outcome, state } = input;
  const goal = decision.plan?.goal;
  if (goal === undefined || goal.kind === 'wait') return null;
  // Asked again at once (a trigger folded in, the same plan back): nothing happened yet.
  const since = decision.goalSince;
  if (outcome === 'replaced' && input.now - since.at < input.lessonMinMs) return null;
  const character = decision.brief.character;
  const died = outcome === 'died';
  const killers = died ? killersOf(input.blows, input.fightGapMs) : [];
  const spot =
    goal.kind === 'hunt'
      ? decision.brief.hunting.spots.find((each) => each.key === goal.key)
      : undefined;
  const own = new Set(spot?.mobs.map((mob) => mob.name.toLowerCase()) ?? []);
  const exp =
    since.exp === null || state.progress.exp === null ? null : state.progress.exp - since.exp;
  return {
    at: input.now,
    goal,
    level: character.level,
    hpMax: character.hpMax,
    armourClass: character.armourClass,
    attack: decision.brief.settings.attack,
    outcome,
    why: input.why,
    killers,
    room: died ? state.room.name : null,
    atTheSpot:
      died && spot !== undefined && killers.length > 0
        ? killers.some((name) => own.has(name.toLowerCase()))
        : null,
    // A death takes experience; what it cost is not what the plan earned.
    expGained: died ? null : exp,
    minutes: Math.round((input.now - since.at) / 60_000)
  };
}

/**
 * A goal the player marked bad on the road (todo 68), as a lesson: turned down
 * at the level the road would have reached it, so it is sent with each brief
 * near that level.
 */
export function markedBad(input: {
  goal: KonamiGoal;
  level: number | null;
  state: CharacterState;
  attack: string | null;
  why: string;
  now: number;
}): KonamiLesson {
  const { goal, level, state, attack, why, now } = input;
  return {
    at: now,
    goal,
    level,
    hpMax: state.vitals.hpMax,
    armourClass: state.progress.armourClass,
    attack,
    outcome: 'vetoed',
    why,
    killers: [],
    room: null,
    atTheSpot: null,
    expGained: null,
    minutes: 0
  };
}
