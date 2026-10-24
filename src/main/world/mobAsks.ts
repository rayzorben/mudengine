/**
 * A monster's `ask` table (format 72, todo 01): each word `AskCommand` matches
 * in the block `Monsters.GreetTXT` names, and what saying it can hand over.
 *
 * The server matches the first field of a line whole (`TextBlockPart.cs:1275`),
 * so every word is listed spelled in full. Words whose lines run the same steps
 * are one answer (`chancellor`, `annora`, `chancellor annora` all show 320) and
 * are kept under the longest. What a monster says is not in the realm's export
 * (`TBInfo.Action` is empty for a shown block), so an answer carries only what
 * its steps give, take, teach and charge, read through `navigation/textblock.ts`.
 */
import {
  blockRun,
  blockUses,
  isRollTable,
  isStepArgument,
  linesRun,
  phraseOf,
  phrasedSteps,
  stepsRun,
  untilUnrun,
  type Textblock,
  type TbStep,
  type TbUse
} from './navigation/textblock';

/** One answer as the world file writes it: the word, then items given and taken, spells taught, copper charged. */
export interface BuiltAsk {
  w: string;
  g?: string[];
  t?: string[];
  s?: string[];
  p?: number;
}

/** The names the answers are written with: a row the file does not name is left out. */
export interface AskNames {
  item(id: number): string | undefined;
  spell(id: number): string | undefined;
}

/** Every answer the block `greet` holds, in the table's own order. */
export function askTable(
  greet: number,
  blocks: ReadonlyMap<number, Textblock>,
  names: AskNames
): BuiltAsk[] {
  return askLines(greet, blocks).map(({ words, steps }) =>
    answerOf(longest(words), stepsReached(steps, blocks), names)
  );
}

/**
 * The words the block `greet` answers, those whose lines run the same steps
 * as one, with the steps: the server runs the first line a word matches, and
 * a later line for it never runs.
 */
export function askLines(
  greet: number,
  blocks: ReadonlyMap<number, Pick<Textblock, 'lines'>>
): Array<{ words: string[]; steps: readonly TbStep[] }> {
  const block = blocks.get(greet);
  if (block === undefined || isRollTable(block)) return [];
  const answers = new Map<string, { words: string[]; steps: readonly TbStep[] }>();
  const claimed = new Set<string>();
  for (const line of block.lines) {
    const word = phraseOf(line);
    if (word === null || isStepArgument(word) || claimed.has(word.toLowerCase())) continue;
    claimed.add(word.toLowerCase());
    const steps = phrasedSteps(line);
    const key = steps.map((step) => step.text.trim()).join(':');
    const held = answers.get(key);
    if (held === undefined) answers.set(key, { words: [word], steps });
    else if (!held.words.includes(word)) held.words.push(word);
  }
  return [...answers.values()];
}

/** What a player types to ask a monster something: `ask <name> <word>`, the name whole (`Misc.GetPossibleTargets` matches it). */
export function askPhrase(who: string, word: string): string {
  return `ask ${who} ${word}`;
}

export function longest(words: readonly string[]): string {
  return words.reduce((best, word) => (word.length > best.length ? word : best));
}

/** The steps a line runs, then every step of every block it hands the run to. */
function stepsReached(first: readonly TbStep[], blocks: ReadonlyMap<number, Textblock>): TbStep[] {
  const reached = [...untilUnrun(first)];
  const roots: Partial<Record<TbUse, number[]>> = {};
  for (const step of reached) {
    const next = blockRun(step);
    if (next !== null) (roots[next[1]] ??= []).push(next[0]);
  }
  for (const [id, uses] of blockUses(blocks, roots)) {
    const block = blocks.get(id)!;
    for (const use of uses) {
      if (use === 'shown') continue;
      for (const line of linesRun(block, use)) reached.push(...untilUnrun(stepsRun(line, use)));
    }
  }
  return reached;
}

function answerOf(word: string, steps: readonly TbStep[], names: AskNames): BuiltAsk {
  const gives = new Set<string>();
  const takes = new Set<string>();
  const teaches = new Set<string>();
  let copper: number | undefined;
  const named = (into: Set<string>, name: string | undefined): void => {
    if (name !== undefined && name.length > 0) into.add(name);
  };
  for (const step of steps) {
    if (step.verb === 'giveitem') named(gives, names.item(step.item));
    else if (step.verb === 'takeitem') named(takes, names.item(step.item));
    else if (step.verb === 'learnspell') named(teaches, names.spell(step.spell));
    // Lines are alternatives, so the dearest is what saying it can cost.
    else if (step.verb === 'price' && step.copper !== null && step.copper > 0) {
      copper = Math.max(copper ?? 0, step.copper);
    }
  }
  const answer: BuiltAsk = { w: word };
  if (gives.size > 0) answer.g = [...gives];
  if (takes.size > 0) answer.t = [...takes];
  if (teaches.size > 0) answer.s = [...teaches];
  if (copper !== undefined) answer.p = copper;
  return answer;
}
