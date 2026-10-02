/**
 * What one text block line states for a quest: the gates it puts on the
 * player (`gatesOf`), what it takes, what it gives and the counter it
 * advances. The steps come typed from the one reader (`navigation/textblock.ts`);
 * `adddelay` is the line's `delay` (todo 106).
 */
import type { Gate } from '../../shared/gates';
import type { QuestReward } from '../../shared/quests';
import { gatesOf } from './navigation/stepGates';
import type { TbStep } from './navigation/textblock';

/** What one line of a script says, before anything is joined to anything. */
export interface QuestScript {
  needs: Gate[];
  takes: number[];
  gives: QuestReward[];
  /**
   * The quest counter this line advances, when it advances one.
   *
   * A line may `giveability` several things — the alignment quests hand out
   * class perks alongside the counter — so which one is *the quest* is decided
   * by `buildRealm` against the set of counters the realm actually chains,
   * never guessed at here.
   */
  granted: Array<{ id: number; value: number }>;
  /** `adddelay N`: how long the server holds the rest of the line, in seconds. */
  delay?: number;
}

/**
 * Reads one line's steps (`TbLine.steps`) into the facts they state.
 *
 * Returns a script with nothing in it for a line that states none, which is
 * most of them: the great majority of blocks are dialogue, and a keyword table
 * is not a script at all.
 */
export function readQuestScript(steps: readonly TbStep[]): QuestScript {
  const takes: number[] = [];
  const gives: QuestReward[] = [];
  const granted: Array<{ id: number; value: number }> = [];
  let delay: number | null = null;

  for (const step of steps) {
    switch (step.verb) {
      case 'delay':
        // Several on one line add up: the server holds at each in turn.
        if (step.seconds > 0) delay = (delay ?? 0) + step.seconds;
        break;
      case 'takeitem':
        takes.push(step.item);
        break;
      case 'addexp':
        if (step.amount !== 0) gives.push({ kind: 'exp', amount: step.amount });
        break;
      case 'giveitem':
        gives.push({ kind: 'item', id: step.item });
        break;
      case 'givecoins':
        gives.push({ kind: 'coins', amount: step.amount, coin: step.coin });
        break;
      case 'giveability':
      case 'setability':
        gives.push({ kind: 'ability', id: step.ability, value: step.value, mode: 'set' });
        granted.push({ id: step.ability, value: step.value });
        break;
      case 'addability':
        gives.push({ kind: 'ability', id: step.ability, value: step.value, mode: 'add' });
        break;
      case 'learnspell':
        gives.push({ kind: 'spell', id: step.spell });
        break;
      case 'addlife':
        // One life (`TextBlockPart.cs:252`); its argument is a message.
        gives.push({ kind: 'lives', amount: 1 });
        break;
      case 'addevil':
        if (step.amount !== 0) gives.push({ kind: 'alignment', amount: step.amount });
        break;
      // The conditions are `gatesOf`'s; the rest is narration, flow and what
      // the step does to the world rather than pays the player.
      case 'checkability':
      case 'testability':
      case 'checkabilityexact':
      case 'failability':
      case 'checkitem':
      case 'failitem':
      case 'checkspell':
      case 'failspell':
      case 'class':
      case 'race':
      case 'roomitem':
      case 'failroomitem':
      case 'nomonsters':
      case 'needmonster':
      case 'monsters':
      case 'minlevel':
      case 'maxlevel':
      case 'goodaligned':
      case 'evilaligned':
      case 'checklives':
      case 'price':
      case 'testskill':
      case 'nothing':
      case 'message':
      case 'show':
      case 'cast':
      case 'clearitem':
      case 'droproomitem':
      case 'removeability':
      case 'random':
      case 'remoteaction':
      case 'summon':
      case 'teleport':
      case 'unknown':
        break;
      default: {
        const never: never = step;
        return never;
      }
    }
  }

  return { needs: gatesOf(steps), takes, gives, granted, ...(delay === null ? {} : { delay }) };
}
