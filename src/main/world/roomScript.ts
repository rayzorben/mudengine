/**
 * `Rooms.CMD` → `TBInfo.Action`: the words a room answers, where each leads,
 * what it wants, and the levers it pulls. The steps come typed from the one
 * reader (`navigation/textblock.ts`); this keeps a room's view of them.
 *
 * `need` is the conditions in the realm's own words (`minlevel 20`, `price
 * 10000`, `nomonsters`), item ids resolved to names, the narration and the
 * trailing message ids left off: a verb nothing here models is still a thing
 * the room wants. `to` is the `teleport` step, written room first, or the
 * landing of a `cast` step's spell.
 */
import type { ParsedAction } from './instructions';
import {
  itemOf,
  keywordTable,
  phrasedSteps,
  phraseOf,
  readLines,
  type TbStep,
  type Textblock
} from './navigation/textblock';
import type { RoomCommand } from '../../shared/world';

/**
 * The levers a room's script pulls — `remoteaction`, which is a lever in the
 * one shape the converter never read.
 *
 * A lever reaches the realm data two ways and only one of them was parsed. The
 * direction columns hold `Action [on the N exit of room 1/1331]: pull lever`
 * (format 23, `parseAction`), and a room's **script** holds the same fact as a
 * step:
 *
 *     lift portcullis:message 1359:testskill strength 20 708:remoteaction 909 1360 0 3
 *
 * `TextBlockPart` reads that as `remoteaction <room> <message> <ordinal>
 * <exit>`: the room is looked up **on the map the player is standing on**
 * (`new RoomID(player.Room.RoomID.Map, roomid)`), the exit by the server's
 * numbering, and a `Door` is opened outright while a `HiddenExit` performs its
 * `ordinal`-th action. So the portcullis in 8/909 is lifted by saying so, and
 * the west exit it lifts is stated in the exit table as `Door [1000
 * picklocks/strength]` — a wall to every character in the realm.
 *
 * 101 steps over 30 exits in Paradigm and 82 over 25 in stock, and exactly one
 * of those exits had a lever from the direction columns: 68 of Paradigm's
 * steps open an exit that reads `Hidden/Needs N Actions` and states no action
 * at all, which is the very shape todo 01 read the direction columns for —
 * *the realm said there is a concealed passage and the client walked into it,
 * was refused, and struck a real corridor out of every route for the session.*
 *
 * Returned as `ParsedAction` so both ends join the levers identically: this is
 * the same fact in a second spelling, not a second kind of thing.
 */
export function leversInScript(action: string): ParsedAction[] {
  // A room script's every line is `<phrase> : <step> : <step>`.
  return foldLevers(
    readLines(action).map((line) => ({
      say: (line.fields[0] ?? '').trim(),
      steps: phrasedSteps(line)
    }))
  );
}

/**
 * One line's `remoteaction` and the item the pack must hold to say it, or
 * undefined where the line pulls nothing.
 */
function leverInSteps(steps: readonly TbStep[]):
  | {
      room: number;
      ordinal: number;
      direction: string;
      item?: number;
    }
  | undefined {
  let opens: { room: number; ordinal: number; direction: string } | undefined;
  let item: number | undefined;
  for (const step of steps) {
    if (step.verb === 'remoteaction') {
      opens = { room: step.room, ordinal: step.ordinal, direction: step.exit };
      continue;
    }
    /*
     * `checkitem 570` — the crowbar that snaps the chains. The server checks
     * the pack before the step runs, so this is `RequirementAction.item` in
     * the realm's other spelling and the router prices it the same way.
     * `roomitem` is deliberately not read: that is an item lying in the room,
     * which is not something the pack can answer for.
     */
    if (step.verb === 'checkitem' && step.item > 0) item = step.item;
  }
  return opens === undefined ? undefined : { ...opens, ...(item === undefined ? {} : { item }) };
}

/**
 * Lines that pull a lever, folded onto one `ParsedAction` per lever.
 *
 * Keyed by the lever's identity — the exit it opens and its place in the order
 * — because the realm writes one line per spelling (`lift portcullis`, `move
 * gate`) and those are one lever with four names, exactly as `parseRoomScript`
 * collapses them.
 */
function foldLevers(
  lines: ReadonlyArray<{ say: string; steps: readonly TbStep[] }>
): ParsedAction[] {
  const byLever = new Map<string, ParsedAction & { room: number }>();

  for (const { say, steps } of lines) {
    if (say.length === 0 || steps.length === 0) continue;
    const opens = leverInSteps(steps);
    if (opens === undefined) continue;

    const key = `${opens.room}|${opens.direction}|${opens.ordinal}`;
    const held = byLever.get(key);
    if (held === undefined) {
      byLever.set(key, {
        direction: opens.direction,
        say: [say],
        room: opens.room,
        // Ordinal zero is the realm saying nothing about the order, which is
        // what a bare `Action` says in the other spelling.
        ...(opens.ordinal > 0 ? { index: opens.ordinal } : {}),
        ...(opens.item === undefined ? {} : { item: opens.item })
      });
      continue;
    }
    if (!held.say.includes(say)) held.say.push(say);
    // Two spellings of one lever that disagree about what must be carried are
    // not one answer, and a guess here would price a wall as a free step.
    if (held.item !== opens.item) delete held.item;
  }

  return [...byLever.values()];
}

/**
 * The levers a **monster** pulls when it is asked — the same `remoteaction`,
 * one chain further out.
 *
 * `Monsters.GreetTXT` is a keyword table (`morukai:1435`, `orfeo:1435`) and
 * the block it reaches is a script like any other, so a lever can sit behind a
 * conversation instead of behind a word the room answers. Five monsters do it,
 * identically in both databases on this machine:
 *
 *     shadow guard  9/1423   ask shadow guard morukai  → opens 1423 w
 *     stone sphinx  12/1920  ask stone sphinx fire     → opens 1920 u
 *     stone sphinx  12/2001  ask stone sphinx sun      → opens 2001 u
 *     stone sphinx  12/2051  ask stone sphinx stars    → opens 2051 u
 *     stone sphinx  12/2085  ask stone sphinx e        → opens 2085 u
 *
 * **Every one of them opens an exit of the room it is standing in**, which is
 * what makes the join safe: `remoteaction` names a room number and the server
 * resolves it on the map the player is on, so the map comes from where the
 * realm places the monster and the caller keeps only the placements whose room
 * number the step names. Five samples in two realms, not one — and the shadow
 * guard's is the door to Morukai (9/1425), which reads `Door [1000
 * picklocks/strength]` and is opened by asking, exactly as the realm's own
 * recorded path says (`mega-paramud/Default/ATREMORU.mp`: `w[ask shadow guard
 * orfeo]`).
 *
 * The phrase is the whole typed line, because that is what a lever's `say` is
 * and what the walker sends: `ask <monster> <word>`.
 *
 * `room` on each returned action is the number the step named; the caller
 * fills the map.
 */
export function leversAsked(
  greet: number,
  who: string,
  block: (id: number) => Pick<Textblock, 'lines' | 'linkTo'> | undefined
): ParsedAction[] {
  const found: ParsedAction[] = [];
  const seen = new Set<number>();
  const queue: Array<{ id: number; words: string[] }> = [{ id: greet, words: [] }];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    const here = block(next.id);
    if (here === undefined) continue;

    /*
     * **A reached block's lines are steps, not phrases.** A room's script
     * leads every line with the word somebody types; a block a keyword table
     * reached has already been chosen, so the whole line runs — three of the
     * four stone sphinxes read `remoteaction 2001 0 0 8` and nothing else, and
     * reading the first field as a phrase skipped all three. The fourth
     * survived only because `cast 687` stood where a phrase would be, which is
     * the same bug wearing the right answer.
     *
     * The words that reach a lever are the ones said *at* it, as they are for
     * a quest step: a keyword replaces the path that led to the menu above it,
     * and a lever reached with nothing said is one nobody can pull on purpose.
     */
    if (next.words.length > 0) {
      const phrases = next.words.map((word) => `ask ${who} ${word}`);
      for (const lever of foldLevers(
        here.lines.map((line) => ({ say: phrases[0]!, steps: line.steps }))
      )) {
        found.push({ ...lever, say: phrases });
      }
    }
    if (here.linkTo !== null && here.linkTo > 0) queue.push({ id: here.linkTo, words: next.words });
    for (const [target, words] of keywordTable(here)) {
      queue.push({ id: target, words });
    }
  }
  return found;
}

/** Every item id a room's script mentions, so the item index can name them. */
export function itemsInScripts(blocks: Iterable<Pick<Textblock, 'lines'>>): Set<number> {
  const found = new Set<number>();
  for (const block of blocks) {
    for (const line of block.lines) {
      for (const step of phrasedSteps(line)) {
        const id = itemOf(step);
        if (id !== null && id > 0) found.add(id);
      }
    }
  }
  return found;
}

/**
 * One `TBInfo.Action` as the commands it offers.
 *
 * Phrases whose steps are identical are one command with several names.
 * Compared on the *steps*, not on a normalised phrase: two spellings of one
 * portal have byte-identical tails, and two genuinely different things in one
 * room do not.
 */
export function parseRoomScript(
  action: string,
  itemName: (id: number) => string | undefined,
  spellLanding: (id: number) => string | undefined = () => undefined
) {
  const bySteps = new Map<string, RoomCommand>();

  for (const line of readLines(action)) {
    const say = phraseOf(line);
    if (say === null) continue;
    const steps = phrasedSteps(line);
    const key = steps.map((step) => step.text).join(':');

    const held = bySteps.get(key);
    if (held !== undefined) {
      if (!held.say.includes(say)) held.say.push(say);
      continue;
    }

    const command: RoomCommand = { say: [say] };
    const need: string[] = [];
    for (const step of steps) {
      switch (step.verb) {
        case 'teleport':
          command.to = `${step.map}/${step.room}`;
          break;
        case 'cast': {
          /*
           * `cast <spell>` moves the character as surely as `teleport` does
           * when the spell carries a landing: the holes down from Dragon's
           * Teeth Hills are `cast 336` and nothing else (format 29). A
           * `teleport` step in the same phrase is the realm's own word and
           * wins. And what it puts on the character either way (format 43):
           * the dive's `cast 512` is *holding breath*.
           */
          const landing = spellLanding(step.spell);
          if (landing !== undefined && command.to === undefined) command.to = landing;
          if (step.spell > 0 && command.casts === undefined) command.casts = step.spell;
          break;
        }
        // What the phrase does to the world (`RoomCommand.opens` holds the
        // lever) or the server talking to itself: not conditions on the player.
        case 'remoteaction':
        case 'nothing':
        case 'show':
        case 'message':
        case 'delay':
        case 'random':
          break;
        // Every other step is something the room wants, in its own words.
        case 'checkitem':
        case 'failitem':
        case 'takeitem':
        case 'giveitem':
        case 'droproomitem':
        case 'roomitem':
        case 'failroomitem':
        case 'clearitem':
        case 'addexp':
        case 'addevil':
        case 'addlife':
        case 'checklives':
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
        case 'summon':
        case 'testskill':
        case 'unknown': {
          const item = itemOf(step);
          // `clearitem 0` clears every item, and item 0 has no name.
          need.push(item === null ? step.said : `${step.verb} ${itemName(item) ?? item}`.trim());
          break;
        }
        default: {
          const never: never = step;
          return never;
        }
      }
    }
    if (need.length > 0) command.need = [...new Set(need)];
    bySteps.set(key, command);
  }

  return [...bySteps.values()];
}
