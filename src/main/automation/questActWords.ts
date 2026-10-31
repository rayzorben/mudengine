/**
 * A quest step's act in the words the quest book uses for it: `ask Commander
 * Markus letter`, `kill nasty dread mystic`, `do touch gem there`. One
 * wording for the quest run's rows and `@abil`'s answer. The renderer's
 * `askWords` reads the step itself the same way, with the same locale keys.
 */
import { t } from '../app/i18n';
import type { PlanAct } from '../../shared/quests';

/** The act's words, or `#block` where the realm traced the step to nobody. */
export function actWords(act: PlanAct | null, block: number): string {
  if (act === null) return `#${block}`;
  switch (act.verb) {
    case 'kill':
      return t('cards.quests.step.kill', { who: act.mob });
    case 'ask':
      return t('cards.quests.step.ask', { who: act.who, word: act.say });
    case 'say':
      return t('cards.quests.step.doHere', { word: act.phrase });
    default: {
      const never: never = act;
      return never;
    }
  }
}
