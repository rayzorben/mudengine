/**
 * What past plans came to: at this level, with this much health and armour,
 * this goal was chosen and this happened: died to these monsters there,
 * gave up because of that, or earned this much in that long. Kept per
 * character in `lessons.jsonl` and handed back with every brief, so the
 * provider does not walk the same character into the same death twice.
 *
 * A lesson holds only near the strength it was learned at: dying to a kobold
 * at level 1 says nothing about level 25. `lessonsFor` keeps the ones within
 * `band` levels of the character now.
 */
import type { KonamiGoal } from './konami';

/** `vetoed`: the player turned the plan down from the card. */
export type LessonOutcome = 'died' | 'done' | 'refused' | 'replaced' | 'vetoed';

export interface KonamiLesson {
  at: number;
  /** What was chosen. */
  goal: KonamiGoal;
  /** The character when it was chosen. */
  level: number | null;
  hpMax: number | null;
  armourClass: number | null;
  attack: string | null;
  outcome: LessonOutcome;
  /** Why, in words: the refusal, or where and to what the character died. */
  why: string | null;
  /** For a death: the monsters that landed blows in the last fight. */
  killers: string[];
  /** For a death: the room it happened in. */
  room: string | null;
  /** For a death on a hunt: whether any killer was one of the spot's own monsters. */
  atTheSpot: boolean | null;
  expGained: number | null;
  minutes: number;
}

/** An item's goal key: what buying it is known by, wherever it is sold. */
export const itemKey = (item: number): string => `buy:${item}`;

/** The goal a lesson is about, as one key: a spot, an item, training, waiting. */
export function goalKey(goal: KonamiGoal): string {
  switch (goal.kind) {
    case 'hunt':
      return `hunt:${goal.key}`;
    case 'buy':
      return itemKey(goal.item);
    case 'train':
    case 'wait':
      return goal.kind;
    default: {
      const never: never = goal;
      return never;
    }
  }
}

/**
 * The lessons that speak to a character at `level`: learned within `band`
 * levels of it, newest first, at most `most`. An unknown level on either side
 * keeps the lesson, since nothing says it no longer applies.
 */
export function lessonsFor(
  lessons: readonly KonamiLesson[],
  level: number | null,
  band: number,
  most: number,
  /** A death is sent this many levels either side instead (todo 76): it killed at 1 and again at 5. */
  deathBand = band
): KonamiLesson[] {
  return lessons
    .filter(
      (lesson) =>
        level === null ||
        lesson.level === null ||
        Math.abs(lesson.level - level) <= (lesson.outcome === 'died' ? deathBand : band)
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, most);
}

/** Lessons of a goal of this kind refused within `ms` of `now`, at `level` where one is given. */
export function refusedLately(
  lessons: readonly KonamiLesson[],
  kind: KonamiGoal['kind'],
  now: number,
  ms: number,
  level?: number | null
): KonamiLesson[] {
  return lessons.filter(
    (lesson) =>
      lesson.goal.kind === kind &&
      lesson.outcome === 'refused' &&
      now - lesson.at < ms &&
      (level === undefined || lesson.level === level)
  );
}

/**
 * The grounds that killed this character within `band` levels below it (todo
 * 76), by goal key: never offered again until it is `band` levels past the
 * death. Soul died at level 1 on the way to the azure slime, was offered it at
 * 5 with the lesson out of range, chose it, and died on the way again.
 */
export function killedAt(
  lessons: readonly KonamiLesson[],
  level: number | null,
  band: number
): Set<string> {
  const keys = new Set<string>();
  for (const lesson of lessons) {
    if (lesson.outcome !== 'died' || lesson.goal.kind !== 'hunt') continue;
    if (level !== null && lesson.level !== null && level >= lesson.level + band) continue;
    keys.add(goalKey(lesson.goal));
  }
  return keys;
}

/** One lesson in a line, for a question's criteria: `at level 1, died on the way to fierce bandit`. */
export function lessonText(lesson: KonamiLesson): string {
  const level = lesson.level === null ? 'an unknown level' : `level ${lesson.level}`;
  switch (lesson.outcome) {
    case 'died': {
      const where =
        lesson.atTheSpot === false ? 'on the way' : lesson.atTheSpot === true ? 'there' : '';
      const to = lesson.killers.length === 0 ? '' : ` to ${lesson.killers.join(', ')}`;
      const room = lesson.room === null ? '' : ` in ${lesson.room}`;
      return `at ${level}, died ${where}${to}${room}`.replace(/\s+/g, ' ').trim();
    }
    case 'refused':
      return `at ${level}, could not be done: ${lesson.why ?? 'no reason given'}`;
    case 'vetoed':
      return `at ${level}, the player said no to it`;
    case 'done':
    case 'replaced': {
      const exp = lesson.expGained === null ? '' : `, ${lesson.expGained} exp`;
      return `at ${level}, ${lesson.outcome === 'done' ? 'finished' : 'ran'} for ${lesson.minutes} minutes${exp}`;
    }
    default: {
      const never: never = lesson.outcome;
      return never;
    }
  }
}
