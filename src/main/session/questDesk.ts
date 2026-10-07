/**
 * What the Quests card asks of a session: the order a step's items are best
 * fetched in, the plan to reach a step, and that plan run and stopped
 * (`QuestRunner`). Out of `SessionManager` beside `gearDesk`, so a card's
 * questions reach their units without passing through the session's own face.
 */
import { t } from '../app/i18n';
import type { QuestRunner } from '../automation/QuestRunner';
import type { CharacterState } from '../../shared/character';
import type { QuestErrand, QuestPlan, QuestRunProgress } from '../../shared/quests';
import type { Errands } from './Errands';
import type { WorldGraph } from '../world/WorldGraph';

export interface QuestDeskParts {
  world(): Pick<WorldGraph, 'quests'> | undefined;
  errands: Pick<Errands, 'questErrand' | 'questPlan'>;
  runner: Pick<QuestRunner, 'start' | 'stop' | 'progress'>;
  state(): CharacterState;
}

export interface QuestDesk {
  /** The order one quest step's items are best fetched in. See `Errands.questErrand`. */
  errand(block: number): QuestErrand | null;
  /** The plan to reach one step of a quest from here. See `Errands.questPlan`. */
  plan(block: number, marked: number | null): Promise<QuestPlan | null>;
  /**
   * Run the plan to one step (todo 102): the card's *Run it*. The plan is
   * drawn afresh here rather than taken from the card, for the reason
   * `walkPlan` redraws a route: it is true from the room it was drawn in, and
   * the press may come a minute later. The refusal, or null once under way.
   */
  run(block: number, marked: number | null): Promise<string | null>;
  /** The card's *Stop*: the run and whatever it started, put down out loud. */
  stop(): void;
  /** How the run is going, for a window that has just attached. */
  readonly progress: QuestRunProgress;
}

export function questDesk(parts: QuestDeskParts): QuestDesk {
  return {
    errand: (block) => parts.errands.questErrand(block),
    plan: (block, marked) => parts.errands.questPlan(block, marked),
    run: async (block, marked) => {
      const quest = parts
        .world()
        ?.quests()
        .find((each) => each.steps.some((step) => step.block === block));
      if (quest === undefined) return t('automation.quests.refusalUnknownStep', { block });
      const plan = await parts.errands.questPlan(block, marked);
      if (plan === null) return t('automation.quests.refusalNoPlan');
      return parts.runner.start(plan, quest, parts.state());
    },
    stop: () => parts.runner.stop(t('automation.quests.whyStopped')),
    get progress() {
      return parts.runner.progress;
    }
  };
}
