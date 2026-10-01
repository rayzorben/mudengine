/**
 * The road ahead and what the player said about it (todo 68): the facts the
 * last brief gathered, projected again from the character as it stands each
 * time the card is drawn, and the goals declined or marked bad, kept on disk
 * so they are never offered to the provider again.
 */
import type { CharacterState } from '../../../shared/character';
import { bankedCopper } from '../../../shared/coins';
import type { KonamiGoal } from '../../../shared/konami';
import { goalKey } from '../../../shared/konamiLessons';
import type { KonamiRecords } from '../../../shared/konamiRecords';
import {
  projectRoad,
  type KonamiRoadView,
  type RoadFacts,
  type RoadMark
} from '../../../shared/konamiRoad';

export class RoadBook {
  private facts: RoadFacts | null = null;
  private readonly marks: RoadMark[];

  constructor(
    private readonly records: Pick<KonamiRecords, 'roadMarks' | 'rewriteRoadMarks'> | null
  ) {
    this.marks = records?.roadMarks() ?? [];
  }

  /** Every goal key declined or marked bad. */
  get declined(): ReadonlySet<string> {
    return new Set(this.marks.map((mark) => mark.key));
  }

  /** What the last brief gathered; null keeps what there was. */
  learn(facts: RoadFacts | null): void {
    if (facts !== null) this.facts = facts;
  }

  /** The player's no to a goal on the road; false where it was already said. */
  mark(goal: KonamiGoal, bad: boolean, level: number | null, now: number): boolean {
    const key = goalKey(goal);
    if (this.marks.some((mark) => mark.key === key)) return false;
    this.marks.push({ key, goal, bad, at: now, level });
    this.records?.rewriteRoadMarks(this.marks);
    return true;
  }

  /** Takes a no back; the goal is the road's and the provider's to offer again. */
  restore(key: string): RoadMark | null {
    const index = this.marks.findIndex((mark) => mark.key === key);
    if (index < 0) return null;
    const [gone] = this.marks.splice(index, 1);
    this.records?.rewriteRoadMarks(this.marks);
    return gone ?? null;
  }

  /**
   * The road from the character as it stands. Nothing is projected from what
   * is not read (the level, the experience, the purse) or before a brief has
   * gathered the facts; null where there are no marks to show either.
   */
  view(state: CharacterState, steps: number): KonamiRoadView | null {
    const marks = [...this.marks].reverse();
    const { level, exp } = state.progress;
    const wealth = state.inventory.wealth;
    if (this.facts === null || level === null || exp === null || wealth === null) {
      return marks.length === 0 ? null : { steps: [], end: 'unread', marks };
    }
    const copper = wealth + bankedCopper(state.banks);
    const road = projectRoad({
      ...this.facts,
      level,
      exp,
      copper,
      declined: this.declined,
      steps
    });
    return { ...road, marks };
  }

  /** A hunt or purchase on the road by its goal key, with the level the road reaches it at. */
  find(
    key: string,
    state: CharacterState,
    steps: number
  ): { goal: Extract<KonamiGoal, { kind: 'hunt' | 'buy' }>; level: number } | null {
    for (const step of this.view(state, steps)?.steps ?? []) {
      if (step.kind !== 'train' && goalKey(step.goal) === key) {
        return { goal: step.goal, level: step.level };
      }
    }
    return null;
  }
}
