/**
 * `Rooms.CMD` → `TBInfo.Action`: the words a room answers, and what they do.
 *
 * The largest thing this client did not know about the realm it routes through.
 * `Rooms.CMD` is an id into `TBInfo`, and every one of the 389 distinct values
 * on the shipped realm carries a script — a colon-delimited line per command
 * phrase, over 1,080 rooms and 3,992 phrases:
 *
 * ```
 * go vortex:adddelay 5:minlevel 20 1220:message 1205:teleport 681 3:message 1221
 * go portal:roomitem 3389 1373:minlevel 40 2594:message 1375:teleport 1041 8
 * dive pool:message 1943:teleport 121 12:cast 512
 * give minotaur horn to orfeo:check class:class 9 2682:takeitem 1359:giveitem 1422
 * ```
 *
 * **1,068 of those steps are `teleport <room> <map>`, and only 8 of their
 * destinations are an exit the room already records.** That is on the order of
 * a thousand ways through the realm the exit table does not have — which is why
 * this is read at all.
 *
 * What is built here is the **fact, not the route**. A phrase, where it leads,
 * and what it wants; the router is deliberately not given these edges yet, for
 * the reason written down in `mme.md` §6: a thousand new edges is a change to
 * every route the client plans, and the failure mode is a character walked
 * somewhere it cannot get back from. The Room card states them so a player can
 * act on them, and the routing work has this to start from.
 *
 * **The guards are kept in the realm's own words.** `minlevel 20`, `price
 * 10000`, `nomonsters` — the same treatment `Requirement.raw` gets and for the
 * same reason: a verb this does not model is still a thing the room wants, and
 * dropping it would show a portal as free when it is not. Only the item ids are
 * resolved, because `roomitem 3389` tells nobody anything and `roomitem
 * shimmering key` does.
 */
import type { ParsedAction } from './instructions';
import { readKeywordTable } from './questScript';
import { number } from './values';
import type { RoomCommand } from '../../shared/world';

/**
 * The shape is `RoomCommand` in `src/shared/world.ts`, because the renderer
 * reads it and `src/shared` is the boundary both sides import. What is worth
 * saying here is how each field is *filled*:
 *
 * - **`say` collapses spellings.** A script writes one line per phrasing — `go
 *   portal`, `go black portal`, `enter portal`, `enter black portal` — with
 *   byte-identical steps, and those are one command with four names. Compared
 *   on the steps rather than on a normalised phrase: two spellings of one
 *   portal have identical tails, and two genuinely different things in one room
 *   do not.
 * - **`to` is the `teleport` step**, and the realm writes it `teleport <room>
 *   <map>` — room first, which is the opposite of the `map/room` every id in
 *   this client is written as. Or, where the phrase has no such step, the
 *   landing of a `cast` step whose spell carries one (`spellLanding`).
 * - **`need` is the conditions, verbatim**, minus the steps that are only the
 *   server talking to itself (`message`, `text`, `random`, `delay`, `adddelay`,
 *   `cast`) and minus the trailing message id every guard carries. Verbatim on
 *   purpose: a verb this does not model is still a thing the room wants, and
 *   dropping it would show a portal as free when it is not — the same rule
 *   `Requirement.raw` follows.
 */

/**
 * How many of a step's arguments are the **condition**, where that is not one.
 *
 * Every guard trails an optional message id — `minlevel 20 1220` prints 1220
 * on failing it — so the arguments that say what is wanted have to be told
 * from the one that says what is printed, and the count is per verb. Taken
 * from the server's own reader (`TextBlockPart.cs`) and checked against how
 * the two databases on this machine actually write each verb:
 *
 * | verb | server | written as |
 * |---|---|---|
 * | `nomonsters` | `args[1]` is the message | 174 bare, 582 with one |
 * | `monsters` | the same | 292 bare |
 * | `testskill` | `args[1]` skill, `args[2]` value, `args[3]` message | 8 without a message, 520 with |
 * | `checkability` | id, then the rank; one argument is *has it at all* | 1 and 929 |
 * | `testability` | id, then the rank | 1 and 790 |
 *
 * **One is the default and the table is the exceptions**, because one is what
 * `minlevel`, `class`, `price`, `roomitem`, `checkitem`, `race`, `needmonster`
 * and the rest are. A verb read wrongly here is not a cosmetic slip: a chip
 * saying `testskill perception` asks *can you perceive at all* about a gate
 * the realm rates at a number, and `nomonsters 1093` puts a message id in
 * front of a reader as though it were part of the condition.
 *
 * `checkabilityexact` is in the table on `questScript.ts`' grammar rather than
 * on a row — neither database holds one — because it is the third spelling of
 * the same comparison and leaving it out would be a rule that agrees with the
 * other two by accident.
 */
const CONDITION_WORDS = new Map([
  ['nomonsters', 0],
  ['monsters', 0],
  ['testskill', 2],
  ['checkability', 2],
  ['checkabilityexact', 2],
  ['testability', 2],
  /*
   * And four the server reads two arguments of with no message after them
   * (lines 652, 671, 687, 707): `givecoins 400 G` is four hundred **gold**,
   * and shown as `givecoins 400` it is an unqualified number that could be
   * copper — a ten-thousandfold ambiguity in the one figure a reader acts on.
   */
  ['givecoins', 2],
  ['giveability', 2],
  ['addability', 2],
  ['setability', 2]
]);

/**
 * Steps that are the server narrating rather than a condition on the player.
 *
 * `check` and `levelcheck` are here on the server's own word rather than on a
 * reading of them: `TextBlockPart.cs:98` matches both and returns straight
 * away, with the comment *filler per DC, "blocks" after this do the actual
 * check so no need to do anything*. 62 and 60 of Paradigm's `need` entries
 * were presenting a no-op to a reader as something the room wants.
 */
const NARRATION = new Set([
  'message',
  'text',
  'random',
  'delay',
  'adddelay',
  'cast',
  'check',
  'levelcheck'
]);

/**
 * Steps whose argument is an item number.
 *
 * `check`/`fail` variants included: a room that refuses without an item wants
 * the item just as much as one that checks for it, and a player reading the
 * card is asking the same question either way.
 */
const ITEM_STEPS = new Set([
  'checkitem',
  'roomitem',
  'takeitem',
  'giveitem',
  'failitem',
  'failroomitem',
  'clearitem'
]);

/**
 * The ten directions in the order the server numbers them, so a `remoteaction`
 * can name one.
 *
 * `Exits.GetExitNameID` (a reading of the server's own source, not a guess):
 * north 0, south 1, east 2, west 3, northeast 4, northwest 5, southeast 6,
 * southwest 7, up 8, down 9 — which is the same order `buildRealm.DIRECTIONS`
 * reads the room table's ten columns in, and the same order for the same
 * reason: both are the realm's own numbering of an exit slot.
 */
const EXIT_IDS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd'] as const;

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
 * (`new RoomID(player.Room.RoomID.Map, roomid)`), the exit by the numbering
 * above, and a `Door` is opened outright while a `HiddenExit` performs its
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
  /*
   * A room script's every line is `<phrase> : <step> : <step>`, so the first
   * field is what somebody types and the rest is what it does.
   */
  return foldLevers(
    action.split('\n').map((line) => {
      const parts = line.split(':');
      const say = (parts[0] ?? '').trim();
      return { say, steps: parts.slice(1) };
    })
  );
}

/**
 * One line's `remoteaction` and the item the pack must hold to say it, or
 * undefined where the line pulls nothing.
 */
function leverInSteps(steps: readonly string[]):
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
    const words = step.trim().split(/\s+/);
    if (words[0] === 'remoteaction') {
      const room = number(words[1]);
      const ordinal = number(words[3]);
      const exit = number(words[4]);
      // A step whose exit id is not one of the ten names no exit. Refused
      // rather than folded onto north, which is what `Number(undefined)`
      // would have done.
      const direction = exit === null ? undefined : EXIT_IDS[exit];
      if (room !== null && direction !== undefined) {
        opens = { room, ordinal: ordinal ?? 0, direction };
      }
      continue;
    }
    /*
     * `checkitem 570` — the crowbar that snaps the chains. The server checks
     * the pack before the step runs, so this is `RequirementAction.item` in
     * the realm's other spelling and the router prices it the same way.
     * `roomitem` is deliberately not read: that is an item lying in the room,
     * which is not something the pack can answer for.
     */
    if (words[0] === 'checkitem') {
      const id = number(words[1]);
      if (id !== null && id > 0) item = id;
    }
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
  lines: ReadonlyArray<{ say: string; steps: readonly string[] }>
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
  block: (id: number) => { action: string; linkTo: number } | undefined
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
        here.action.split('\n').map((line) => ({ say: phrases[0]!, steps: line.split(':') }))
      )) {
        found.push({ ...lever, say: phrases });
      }
    }
    if (here.linkTo > 0) queue.push({ id: here.linkTo, words: next.words });
    for (const [target, words] of readKeywordTable(here.action)) {
      queue.push({ id: target, words });
    }
  }
  return found;
}

/** Every item id a script mentions, so the item index can name them. */
export function itemsInScripts(actions: Iterable<string>): Set<number> {
  const found = new Set<number>();
  for (const action of actions) {
    for (const phrase of action.split('\n')) {
      for (const step of phrase.split(':').slice(1)) {
        const [verb, first] = step.trim().split(/\s+/);
        if (verb === undefined || !ITEM_STEPS.has(verb)) continue;
        const id = number(first);
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

  for (const phrase of action.split('\n')) {
    const parts = phrase.split(':');
    const say = (parts[0] ?? '').trim();
    if (say.length === 0 || parts.length < 2) continue;
    const steps = parts.slice(1).map((step) => step.trim());
    const key = steps.join(':');

    const held = bySteps.get(key);
    if (held !== undefined) {
      if (!held.say.includes(say)) held.say.push(say);
      continue;
    }

    const command: RoomCommand = { say: [say] };
    const need: string[] = [];
    for (const step of steps) {
      const words = step.split(/\s+/);
      const verb = words[0];
      if (verb === undefined || verb.length === 0) continue;
      if (verb === 'teleport') {
        // `teleport <room> <map>` — room first, which is the opposite of the
        // `map/room` every id in this client is written as.
        const room = number(words[1]);
        const map = number(words[2]);
        if (room !== null && map !== null) command.to = `${map}/${room}`;
        continue;
      }
      if (verb === 'cast') {
        /*
         * `cast <spell>` moves the character as surely as `teleport` does when
         * the spell carries `TeleportRoom`/`TeleportMap` — the three holes down
         * from Dragon's Teeth Hills into the Stone Tunnel are `cast 336`
         * ("fall") and nothing else, so the way down was a room command with
         * no landing while the way back up was a `teleport` (format 29). A
         * `teleport` step in the same phrase is the realm's own word and wins.
         */
        const id = number(words[1]);
        const landing = id === null ? undefined : spellLanding(id);
        if (landing !== undefined && command.to === undefined) command.to = landing;
        // And what it puts on the character, whether or not it moves them
        // (format 43): the dive's `cast 512` is *holding breath*, the only
        // statement anywhere that the passage below is a timed one.
        if (id !== null && id > 0 && command.casts === undefined) command.casts = id;
        continue;
      }
      /*
       * `remoteaction 909 1360 0 3` is what the phrase *does* — it raises the
       * portcullis — and `RoomCommand.opens` is where that goes
       * (`leversInScript`). Kept out of `need` for `teleport`'s reason: a step
       * that moves the world is not a condition on the player, and printing
       * `remoteaction 909` on a card names nothing anybody can act on.
       */
      if (verb === 'remoteaction') continue;
      /*
       * A step that is nothing but a number is a **text block to print**:
       * `TextBlockPart.cs:1255` looks it up, displays it and succeeds. So
       * `woohoo:666` in 1/193 is a room answering a word with a sentence, and
       * it was on the card as *saying woohoo requires 666*.
       */
      if (/^\d+$/.test(verb)) continue;
      if (NARRATION.has(verb)) continue;
      if (ITEM_STEPS.has(verb)) {
        const id = number(words[1]);
        const named = id === null ? undefined : itemName(id);
        // The id when nothing can name it — the item index carries only what
        // some exit, shop, monster or script asked for, and a derivative may
        // reference one it has retired. The number is worse than a name and
        // better than dropping a condition the room genuinely has. Either way
        // the trailing message id goes, like every other guard's.
        need.push(`${verb} ${named ?? words[1] ?? ''}`.trim());
        continue;
      }
      /*
       * Everything else verbatim, and only its *arguments that are conditions*
       * — `CONDITION_WORDS` above says how many, and the trailing message id
       * every guard carries is what is left off.
       */
      need.push(
        words
          .slice(0, 1 + (CONDITION_WORDS.get(verb) ?? 1))
          .join(' ')
          .trim()
      );
    }
    if (need.length > 0) command.need = [...new Set(need)];
    bySteps.set(key, command);
  }

  return [...bySteps.values()];
}
