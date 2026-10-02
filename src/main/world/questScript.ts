/**
 * What one text block line states for a quest: the gates it puts on the
 * player, what it takes, what it gives and the counter it advances. The steps
 * come typed from the one reader (`navigation/textblock.ts`), which holds the
 * server's semantics; this keeps only the quest's view of them.
 *
 * `testability N V` and `checkability N V` on one line ask for rank exactly V,
 * which is how every chained quest is written, so the pair is folded into one
 * gate. `testskill` is a roll, kept as a `skill` gate; `adddelay` is the line's
 * `delay` (todo 106).
 */
import type { QuestGate, QuestReward } from '../../shared/quests';
import type { TbStep } from './navigation/textblock';

/** What one line of a script says, before anything is joined to anything. */
export interface QuestScript {
  needs: QuestGate[];
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
  const needs: QuestGate[] = [];
  const takes: number[] = [];
  const gives: QuestReward[] = [];
  const granted: Array<{ id: number; value: number }> = [];

  /*
   * An ability gate is accumulated rather than pushed, because the pair that
   * means "exactly" arrives as two opcodes and has to come out as one fact.
   * Keyed by ability id, in the order first seen.
   */
  const abilities = new Map<number, { atLeast?: number; atMost?: number }>();
  const order: number[] = [];
  const gate = (id: number): { atLeast?: number; atMost?: number } => {
    let held = abilities.get(id);
    if (held === undefined) {
      held = {};
      abilities.set(id, held);
      order.push(id);
    }
    return held;
  };

  let level: { min?: number; max?: number } | null = null;
  let alignment: { atMost?: number; atLeast?: number } | null = null;
  let delay: number | null = null;

  for (const step of steps) {
    switch (step.verb) {
      case 'checkability':
        gate(step.ability).atLeast = step.value;
        break;
      case 'testability':
        gate(step.ability).atMost = step.value;
        break;
      case 'checkabilityexact': {
        const held = gate(step.ability);
        held.atLeast = step.value;
        held.atMost = step.value;
        break;
      }
      case 'failability':
        needs.push({ kind: 'ability-absent', id: step.ability });
        break;
      case 'checkitem':
        needs.push({ kind: 'item', id: step.item });
        break;
      case 'failitem':
        needs.push({ kind: 'item-absent', id: step.item });
        break;
      case 'checkspell':
        needs.push({ kind: 'spell', id: step.spell });
        break;
      case 'class':
        needs.push({ kind: 'class', id: step.classId });
        break;
      case 'race':
        needs.push({ kind: 'race', id: step.raceId });
        break;
      case 'minlevel':
        level = { ...(level ?? {}), min: step.level };
        break;
      case 'maxlevel':
        level = { ...(level ?? {}), max: step.level };
        break;
      case 'goodaligned':
        alignment = { ...(alignment ?? {}), atMost: step.value };
        break;
      case 'evilaligned':
        alignment = { ...(alignment ?? {}), atLeast: step.value };
        break;
      case 'checklives':
        // Fails at nine lives or more (`TextBlockPart.cs:268`); its argument is a message.
        needs.push({ kind: 'lives', below: CHECKLIVES_BELOW });
        break;
      case 'price':
        if (step.copper !== null) needs.push({ kind: 'price', amount: step.copper });
        break;
      case 'testskill':
        // `current_hp` is compared as it stands, with no roll, so it is left out.
        if (step.stat !== 'current_hp') {
          needs.push({ kind: 'skill', stat: step.stat, value: step.value });
        }
        break;
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
      // Narration, flow, world effects and conditions on the room: nothing a
      // quest step demands of the player or pays them.
      case 'nothing':
      case 'message':
      case 'show':
      case 'cast':
      case 'clearitem':
      case 'droproomitem':
      case 'roomitem':
      case 'failroomitem':
      case 'removeability':
      case 'failspell':
      case 'needmonster':
      case 'nomonsters':
      case 'monsters':
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

  for (const id of order) {
    needs.push({ kind: 'ability', id, ...abilities.get(id)! });
  }
  if (level !== null) needs.push({ kind: 'level', ...level });
  if (alignment !== null) needs.push({ kind: 'alignment', ...alignment });

  return { needs, takes, gives, granted, ...(delay === null ? {} : { delay }) };
}

/** `checklives` fails at this many lives. */
const CHECKLIVES_BELOW = 9;
