/**
 * The one reader of the realm's text blocks (`TBInfo`): every verb the server
 * runs, typed, and how a block runs. Nothing else in the client splits a block.
 *
 * Read from the server's `Textblocks/TextBlockPart.cs` and `Textblock.cs`; no
 * capture backs it. A block is lines; a line is `:`-separated steps, led by
 * the phrase a player types where something typed reaches it. Lines are
 * alternatives: the first whose every step succeeds wins, a failed step ends
 * its line and the next is tried, and what ran before stays done. A verb the
 * server does not know fails its line; arguments it cannot read throw, which
 * abandons the whole block. `mudengine-world` › *There is one navigation engine*.
 */
import type { Denomination } from '../../../shared/character';
import { TB_STATS, type TbStat } from '../../../shared/gates';
import { DIRECTIONS, type Direction } from '../../../shared/world';
import type { RealmSource } from '../RealmSource';
import { number, text } from '../values';

/**
 * Every verb the server's reader matches, with the line of `TextBlockPart.cs`
 * that runs it: the runtime list beside `TbVerb`, and the census test checks
 * it against the server's own source where that is on disk.
 */
export const SERVER_LINE = {
  check: 98,
  levelcheck: 98,
  checkitem: 103,
  giveitem: 132,
  droproomitem: 177,
  message: 204,
  mesage: 204,
  addexp: 239,
  addevil: 245,
  addlife: 252,
  checklives: 268,
  adddelay: 287,
  delay: 287,
  cast: 296,
  checkability: 394,
  checkabilityexact: 416,
  testability: 437,
  failability: 459,
  checkspell: 471,
  failspell: 497,
  class: 523,
  clearitem: 537,
  evilaligned: 590,
  goodaligned: 604,
  failitem: 618,
  giveability: 650,
  setability: 669,
  addability: 683,
  givecoins: 705,
  learnspell: 734,
  maxlevel: 748,
  minlevel: 774,
  needmonster: 800,
  nomonsters: 830,
  monsters: 852,
  price: 863,
  race: 891,
  random: 903,
  remoteaction: 921,
  removeability: 954,
  roomitem: 966,
  failroomitem: 998,
  summon: 1029,
  takeitem: 1047,
  teleport: 1103,
  text: 1125,
  testskill: 1139
} as const;

export type TbVerb = keyof typeof SERVER_LINE;

export const TB_VERBS = Object.keys(SERVER_LINE) as readonly TbVerb[];

/** `givecoins`' letters; anything else is gold (`TextBlockPart.cs:728`). */
const COINS: Record<string, Denomination> = {
  C: 'copper',
  S: 'silver',
  G: 'gold',
  P: 'platinum',
  R: 'runic'
};

/** One step, as the server reads it. `message` is the id printed on failing. */
export type TbAct =
  | { verb: 'nothing' }
  | { verb: 'checkitem' | 'failitem' | 'takeitem'; item: number; message?: number }
  | { verb: 'giveitem' | 'droproomitem' | 'roomitem'; item: number }
  | { verb: 'failroomitem'; item: number; message?: number }
  /** Item 0 clears every item in the room. */
  | { verb: 'clearitem'; item: number }
  | { verb: 'message'; message: number }
  /** `text N`, and a bare `N`: show block N, then run what it links to. */
  | { verb: 'show'; block: number }
  | { verb: 'addexp' | 'addevil'; amount: number }
  | { verb: 'addlife'; message?: number }
  /** Fails at nine lives or more. */
  | { verb: 'checklives'; message?: number }
  | { verb: 'delay'; seconds: number }
  | { verb: 'cast' | 'learnspell'; spell: number }
  /** Sum of the ability at least `value`; one argument is *has it at all* (-1). */
  | { verb: 'checkability'; ability: number; value: number }
  | { verb: 'checkabilityexact' | 'testability'; ability: number; value: number }
  | { verb: 'failability' | 'removeability'; ability: number }
  /**
   * Both verbs run the same code (`TextBlockPart.cs:471`, `:497`): fails while
   * the spell is on the character, otherwise runs `otherwise` and takes its
   * answer, failing where there is none.
   */
  | { verb: 'checkspell' | 'failspell'; spell: number; otherwise?: number }
  | { verb: 'class'; classId: number }
  | { verb: 'race'; raceId: number }
  /** Alignment at least `value` (evil) or at most `value` (good); lower is better. */
  | { verb: 'evilaligned' | 'goodaligned'; value: number }
  | { verb: 'giveability' | 'setability' | 'addability'; ability: number; value: number }
  | { verb: 'givecoins'; amount: number; coin: Denomination }
  | { verb: 'minlevel' | 'maxlevel'; level: number; message?: number }
  /** Monster row `monster` stands in the room. */
  | { verb: 'needmonster'; monster: number; message?: number }
  /** No monster of any kind stands in the room. */
  | { verb: 'nomonsters'; message?: number }
  | { verb: 'monsters' }
  /**
   * Wealth in copper at least the amount, which is then taken: a gate that
   * pays. `setting` is a server setting's name standing for the amount.
   */
  | { verb: 'price'; copper: number | null; setting?: string; message?: number }
  /** Roll 1–100 against block `block`'s cumulative table. */
  | { verb: 'random'; block: number }
  /** Open a door, or perform a hidden exit's `ordinal`-th action, in room `room` of this map. */
  | { verb: 'remoteaction'; room: number; ordinal: number; exit: Direction }
  /** Fails only when the room is full. */
  | { verb: 'summon'; monster: number }
  | { verb: 'teleport'; room: number; map: number }
  /**
   * Stat less `value`, clamped 2–98, against 1–100; `current_hp` unclamped.
   * On failing, runs `otherwise`.
   */
  | { verb: 'testskill'; stat: TbStat; value: number; otherwise?: number }
  /**
   * What the server cannot run. An unknown verb fails its line; arguments it
   * cannot read throw, and the exception abandons the whole block
   * (`Textblock.cs:217`).
   */
  | { verb: 'unknown'; why: 'verb' | 'arguments' };

/** A step and the words it was written as. `said` is the condition, no message id. */
export type TbStep = TbAct & { text: string; said: string };

/**
 * What a step is to somebody reading a way:
 * - `gate` passes or fails on the character, the room or chance, and changes nothing;
 * - `pays` is a gate that also takes what it tests (`takeitem`, `price`);
 * - `effect` changes the character or the world, and fails only on the
 *   server's own limits (`giveitem` at an item's game limit, `summon` in a
 *   full room, `clearitem` with nothing to clear);
 * - `flow` runs another block or waits (`checkspell` and `failspell` also
 *   fail while the spell is on);
 * - `say` prints;
 * - `unknown` fails its line, or its block.
 */
export type TbRole = 'gate' | 'pays' | 'effect' | 'flow' | 'say' | 'unknown';

export function roleOf(step: TbAct): TbRole {
  switch (step.verb) {
    case 'checkitem':
    case 'failitem':
    case 'roomitem':
    case 'failroomitem':
    case 'checklives':
    case 'checkability':
    case 'checkabilityexact':
    case 'testability':
    case 'failability':
    case 'class':
    case 'race':
    case 'evilaligned':
    case 'goodaligned':
    case 'minlevel':
    case 'maxlevel':
    case 'needmonster':
    case 'nomonsters':
    case 'monsters':
    case 'testskill':
      return 'gate';
    case 'takeitem':
    case 'price':
      return 'pays';
    case 'giveitem':
    case 'droproomitem':
    case 'clearitem':
    case 'addexp':
    case 'addevil':
    case 'addlife':
    case 'cast':
    case 'learnspell':
    case 'removeability':
    case 'giveability':
    case 'setability':
    case 'addability':
    case 'givecoins':
    case 'remoteaction':
    case 'summon':
    case 'teleport':
      return 'effect';
    case 'nothing':
    case 'show':
    case 'delay':
    case 'checkspell':
    case 'failspell':
    case 'random':
      return 'flow';
    case 'message':
      return 'say';
    case 'unknown':
      return 'unknown';
    default: {
      const never: never = step;
      return never;
    }
  }
}

/** The item a step names, for the verbs whose argument is an item row. */
export function itemOf(step: TbAct): number | null {
  switch (step.verb) {
    case 'checkitem':
    case 'failitem':
    case 'takeitem':
    case 'giveitem':
    case 'droproomitem':
    case 'roomitem':
    case 'failroomitem':
    case 'clearitem':
      return step.item;
    case 'nothing':
    case 'message':
    case 'show':
    case 'addexp':
    case 'addevil':
    case 'addlife':
    case 'checklives':
    case 'delay':
    case 'cast':
    case 'learnspell':
    case 'checkability':
    case 'checkabilityexact':
    case 'testability':
    case 'failability':
    case 'removeability':
    case 'checkspell':
    case 'failspell':
    case 'class':
    case 'race':
    case 'evilaligned':
    case 'goodaligned':
    case 'giveability':
    case 'setability':
    case 'addability':
    case 'givecoins':
    case 'minlevel':
    case 'maxlevel':
    case 'needmonster':
    case 'nomonsters':
    case 'monsters':
    case 'price':
    case 'random':
    case 'remoteaction':
    case 'summon':
    case 'teleport':
    case 'testskill':
    case 'unknown':
      return null;
    default: {
      const never: never = step;
      return never;
    }
  }
}

const isDigits = (word: string): boolean => /^-?\d+$/.test(word);

/** An argument that must be a whole number; `undefined` where it is not. */
function whole(word: string | undefined): number | undefined {
  if (word === undefined || !isDigits(word)) return undefined;
  return Number(word);
}

function optional<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}

/** One step, from its text. */
export function readStep(field: string): TbStep {
  const textOf = field.trim();
  const words = textOf.length === 0 ? [] : textOf.split(/\s+/);
  // Matched exactly, as the server matches it: `Message` is not a verb.
  const word = words[0] ?? '';
  const said = (count: number): string => words.slice(0, 1 + count).join(' ');
  const done = (act: TbAct, count: number): TbStep => ({ ...act, text: textOf, said: said(count) });
  const broken = (): TbStep => done({ verb: 'unknown', why: 'arguments' }, 1);
  const a = whole(words[1]);
  const b = whole(words[2]);
  const c = whole(words[3]);

  // An empty step is the server's no-op (`TextBlockPart.cs:90`), and so is one
  // led by a space: the server splits on single spaces without trimming, so
  // its verb is empty.
  if (word.length === 0 || /^\s/.test(field)) return done({ verb: 'nothing' }, 0);
  // A bare number shows that block (`TextBlockPart.cs:1255`).
  if (isDigits(word)) return done({ verb: 'show', block: Number(word) }, 0);
  if (!Object.hasOwn(SERVER_LINE, word)) return done({ verb: 'unknown', why: 'verb' }, 1);
  const verb = word as TbVerb;

  switch (verb) {
    case 'check':
    case 'levelcheck':
      return done({ verb: 'nothing' }, 0);
    case 'checkitem':
    case 'failitem':
    case 'takeitem':
      return a === undefined ? broken() : done({ verb, item: a, ...optional('message', b) }, 1);
    case 'failroomitem':
      return a === undefined
        ? broken()
        : done({ verb: 'failroomitem', item: a, ...optional('message', b) }, 1);
    case 'giveitem':
    case 'droproomitem':
    case 'roomitem':
      return a === undefined ? broken() : done({ verb, item: a }, 1);
    case 'clearitem':
      return a === undefined ? broken() : done({ verb: 'clearitem', item: a }, 1);
    case 'message':
    case 'mesage':
      return a === undefined ? broken() : done({ verb: 'message', message: a }, 1);
    case 'text':
      return a === undefined ? broken() : done({ verb: 'show', block: a }, 1);
    case 'addexp':
    case 'addevil': {
      const amount = number(words[1]);
      return amount === null ? broken() : done({ verb, amount }, 1);
    }
    // `addlife` reads its message id before adding the life, so a missing one
    // throws (`TextBlockPart.cs:254`); `checklives` reads it only on failing.
    case 'addlife':
      return a === undefined ? broken() : done({ verb: 'addlife', message: a }, 1);
    case 'checklives':
      return done({ verb: 'checklives', ...optional('message', a) }, 1);
    case 'adddelay':
    case 'delay':
      return a === undefined ? broken() : done({ verb: 'delay', seconds: a }, 1);
    case 'cast':
    case 'learnspell':
      return a === undefined ? broken() : done({ verb, spell: a }, 1);
    case 'checkability':
      return a === undefined || (words[2] !== undefined && b === undefined)
        ? broken()
        : done({ verb: 'checkability', ability: a, value: b ?? -1 }, 2);
    case 'checkabilityexact':
    case 'testability':
      return a === undefined || b === undefined
        ? broken()
        : done({ verb, ability: a, value: b }, 2);
    case 'failability':
    case 'removeability':
      return a === undefined ? broken() : done({ verb, ability: a }, 1);
    case 'checkspell':
    case 'failspell':
      return a === undefined ? broken() : done({ verb, spell: a, ...optional('otherwise', b) }, 1);
    case 'class':
      return a === undefined ? broken() : done({ verb: 'class', classId: a }, 1);
    case 'race':
      return a === undefined ? broken() : done({ verb: 'race', raceId: a }, 1);
    case 'evilaligned':
    case 'goodaligned': {
      const value = number(words[1]);
      return value === null ? broken() : done({ verb, value }, 1);
    }
    case 'giveability':
    case 'setability':
      return a === undefined || b === undefined
        ? broken()
        : done({ verb, ability: a, value: b }, 2);
    case 'addability':
      // One argument prints an error and succeeds (`TextBlockPart.cs:699`).
      if (words.length < 3) return done({ verb: 'nothing' }, 0);
      return a === undefined || b === undefined
        ? broken()
        : done({ verb, ability: a, value: b }, 2);
    case 'givecoins':
      return a === undefined || words[2] === undefined
        ? broken()
        : done(
            { verb: 'givecoins', amount: a, coin: COINS[(words[2] ?? '').toUpperCase()] ?? 'gold' },
            2
          );
    case 'minlevel':
    case 'maxlevel':
      return a === undefined ? broken() : done({ verb, level: a, ...optional('message', b) }, 1);
    case 'needmonster':
      return a === undefined
        ? broken()
        : done({ verb: 'needmonster', monster: a, ...optional('message', b) }, 1);
    case 'nomonsters':
      return done({ verb: 'nomonsters', ...optional('message', a) }, 0);
    case 'monsters':
      return done({ verb: 'monsters' }, 0);
    case 'price': {
      const amount = words[1];
      if (amount === undefined) return broken();
      const copper = whole(amount);
      return done(
        {
          verb: 'price',
          copper: copper ?? null,
          ...(copper === undefined ? { setting: amount } : {}),
          ...optional('message', b)
        },
        1
      );
    }
    case 'random':
      return a === undefined ? broken() : done({ verb: 'random', block: a }, 1);
    case 'remoteaction': {
      // `remoteaction <room> <message> <ordinal> <exit>`; the exit by the
      // server's numbering (`Exits.GetExitNameID`), which is `DIRECTIONS`' order.
      const exit = DIRECTIONS[whole(words[4]) ?? -1];
      return a === undefined || c === undefined || exit === undefined
        ? broken()
        : done({ verb: 'remoteaction', room: a, ordinal: c, exit }, 1);
    }
    case 'summon':
      return a === undefined ? broken() : done({ verb: 'summon', monster: a }, 1);
    case 'teleport':
      return a === undefined || b === undefined
        ? broken()
        : done({ verb: 'teleport', room: a, map: b }, 2);
    case 'testskill': {
      const stat = (words[1] ?? '').toLowerCase();
      if (!(TB_STATS as readonly string[]).includes(stat) || b === undefined) return broken();
      return done(
        { verb: 'testskill', stat: stat as TbStat, value: b, ...optional('otherwise', c) },
        2
      );
    }
    default: {
      const never: never = verb;
      return never;
    }
  }
}

/** One line of a block: its fields, and every field read as a step. */
export interface TbLine {
  fields: readonly string[];
  /** Every field as a step: how the server runs a block nothing typed reached. */
  steps: readonly TbStep[];
}

export interface Textblock {
  id: number;
  /** The action as stored, NUL padding removed. */
  action: string;
  linkTo: number | null;
  lines: readonly TbLine[];
}

export function readLines(action: string): TbLine[] {
  return action
    .split('\n')
    .map((line) => line.split(':'))
    .map((fields) => ({ fields, steps: fields.map(readStep) }));
}

/**
 * The phrase a typed word reaches this line by: its first field, where the
 * line has more than one. What the server matches `ExecuteOnMatch` against.
 */
export function phraseOf(line: TbLine): string | null {
  if (line.fields.length < 2) return null;
  const phrase = (line.fields[0] ?? '').trim();
  return phrase.length > 0 ? phrase : null;
}

/**
 * The steps a run reaches: up to and including the first the server cannot
 * run, after which nothing on the line happens.
 */
export function untilUnrun(steps: readonly TbStep[]): readonly TbStep[] {
  const stop = steps.findIndex((step) => step.verb === 'unknown');
  return stop === -1 ? steps : steps.slice(0, stop + 1);
}

/** The steps a typed phrase runs: every field after the phrase. */
export function phrasedSteps(line: TbLine): readonly TbStep[] {
  return line.steps.slice(1);
}

/**
 * A roll table's threshold: a line a `random` reaches leads with the
 * cumulative percentage it answers to (`ExecuteRandom`).
 */
export function rollOf(line: TbLine): number | null {
  const first = (line.fields[0] ?? '').trim();
  return isDigits(first) ? Number(first) : null;
}

/**
 * Whether a phrase is a step's argument rather than something a person says:
 * one holding a digit. A roll table's lines read as phrases are not 180
 * things to type.
 */
export function isStepArgument(phrase: string): boolean {
  return /\d/.test(phrase);
}

/**
 * A keyword table: `word:block` per line, the shape a monster's greeting takes.
 * Several words routinely reach one block; one that `isStepArgument` is not a word.
 */
export function keywordTable(block: Pick<Textblock, 'lines'>): Map<number, string[]> {
  const table = new Map<number, string[]>();
  for (const line of block.lines) {
    if (line.fields.length < 2) continue;
    const last = line.steps[line.steps.length - 1]!;
    if (last.verb !== 'show' || !isDigits(last.text)) continue;
    const word = line.fields.slice(0, -1).join(':').trim();
    if (word.length === 0 || isStepArgument(word)) continue;
    const held = table.get(last.block);
    if (held === undefined) table.set(last.block, [word]);
    else if (!held.includes(word)) held.push(word);
  }
  return table;
}

/**
 * How the server runs a block, which decides what its lines are:
 * - `phrased`: a typed word picks the lines it leads (`Rooms.CMD`,
 *   `Monsters.GreetTXT`), and the rest of each is steps;
 * - `steps`: every field is a step (a spell's `TextBlock`, a fallback, what a
 *   shown block links to);
 * - `roll`: each line leads with the cumulative threshold a 1–100 roll picks;
 * - `shown`: printed as text, and only what it links to runs.
 */
export type TbUse = 'phrased' | 'steps' | 'roll' | 'shown';

/**
 * The lines a block run this way reaches. A roll table stops at the first
 * line that does not lead with a threshold (`ExecuteRandom` fails there).
 */
export function linesRun(
  block: Pick<Textblock, 'lines'>,
  use: Exclude<TbUse, 'shown'>
): readonly TbLine[] {
  if (use !== 'roll') return block.lines;
  const end = block.lines.findIndex((line) => rollOf(line) === null);
  return end === -1 ? block.lines : block.lines.slice(0, end);
}

/** The steps a line of a block run this way executes. */
export function stepsRun(line: TbLine, use: Exclude<TbUse, 'shown'>): readonly TbStep[] {
  switch (use) {
    case 'phrased':
      return phrasedSteps(line);
    case 'roll':
      return rollOf(line) === null ? [] : line.steps.slice(1);
    case 'steps':
      return line.steps;
    default: {
      const never: never = use;
      return never;
    }
  }
}

/**
 * Every way each block is run, from the roots the realm's tables name. A
 * block reached two ways is both. What nothing reaches is absent: a block
 * the realm has no way to run.
 */
export function blockUses(
  blocks: ReadonlyMap<number, Pick<Textblock, 'lines' | 'linkTo'>>,
  roots: { phrased: Iterable<number>; steps: Iterable<number> }
): Map<number, Set<TbUse>> {
  const uses = new Map<number, Set<TbUse>>();
  const queue: Array<[number, TbUse]> = [
    ...[...roots.phrased].map((id): [number, TbUse] => [id, 'phrased']),
    ...[...roots.steps].map((id): [number, TbUse] => [id, 'steps'])
  ];
  while (queue.length > 0) {
    const [id, use] = queue.shift()!;
    const block = blocks.get(id);
    if (block === undefined) continue;
    const held = uses.get(id) ?? new Set<TbUse>();
    if (held.has(use)) continue;
    held.add(use);
    uses.set(id, held);
    const linked = block.linkTo !== null && block.linkTo > 0 ? block.linkTo : null;
    if (use === 'shown') {
      // `TextBlock.Display` runs what the shown block links to.
      if (linked !== null) queue.push([linked, 'steps']);
      continue;
    }
    // An empty command line shows what the block links to.
    if (use === 'phrased' && linked !== null) queue.push([linked, 'shown']);
    for (const line of linesRun(block, use)) {
      for (const step of stepsRun(line, use)) {
        const next = blockRun(step);
        if (next !== null) queue.push(next);
      }
    }
  }
  return uses;
}

/** The block a step hands the run to, and how, or null for a step that runs none. */
export function blockRun(step: TbAct): [number, TbUse] | null {
  switch (step.verb) {
    case 'show':
      return [step.block, 'shown'];
    case 'random':
      return [step.block, 'roll'];
    case 'checkspell':
    case 'failspell':
    case 'testskill':
      return step.otherwise === undefined ? null : [step.otherwise, 'steps'];
    case 'nothing':
    case 'checkitem':
    case 'failitem':
    case 'takeitem':
    case 'giveitem':
    case 'droproomitem':
    case 'roomitem':
    case 'failroomitem':
    case 'clearitem':
    case 'message':
    case 'addexp':
    case 'addevil':
    case 'addlife':
    case 'checklives':
    case 'delay':
    case 'cast':
    case 'learnspell':
    case 'checkability':
    case 'checkabilityexact':
    case 'testability':
    case 'failability':
    case 'removeability':
    case 'class':
    case 'race':
    case 'evilaligned':
    case 'goodaligned':
    case 'giveability':
    case 'setability':
    case 'addability':
    case 'givecoins':
    case 'minlevel':
    case 'maxlevel':
    case 'needmonster':
    case 'nomonsters':
    case 'monsters':
    case 'price':
    case 'remoteaction':
    case 'summon':
    case 'teleport':
    case 'unknown':
      return null;
    default: {
      const never: never = step;
      return never;
    }
  }
}

/** Every block in the realm, read once. */
export function readTextblocks(source: RealmSource): Map<number, Textblock> {
  const blocks = new Map<number, Textblock>();
  for (const row of source.table('TBInfo')?.rows ?? []) {
    const id = number(row['Number']);
    if (id === null) continue;
    // Access pads the column with NULs. The spaces are load-bearing: they part
    // a verb from its arguments and hold `Commander Markus` together.
    const action = text(row['Action']).replaceAll('\u0000', '').trim();
    const linkTo = number(row['LinkTo']);
    blocks.set(id, { id, action, linkTo, lines: readLines(action) });
  }
  return blocks;
}
