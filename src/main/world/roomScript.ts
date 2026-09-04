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
 *   this client is written as.
 * - **`need` is the conditions, verbatim**, minus the steps that are only the
 *   server talking to itself (`message`, `text`, `random`, `delay`, `adddelay`,
 *   `cast`) and minus the trailing message id every guard carries. Verbatim on
 *   purpose: a verb this does not model is still a thing the room wants, and
 *   dropping it would show a portal as free when it is not — the same rule
 *   `Requirement.raw` follows.
 */

/** Steps that are the server narrating rather than a condition on the player. */
const NARRATION = new Set(['message', 'text', 'random', 'delay', 'adddelay', 'cast']);

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
export function parseRoomScript(action: string, itemName: (id: number) => string | undefined) {
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
       * Everything else verbatim, and only its *arguments that are conditions*.
       * A step reads `minlevel 20 1220`, where 20 is the level and 1220 is the
       * message printed on failing it — so the trailing message id is dropped
       * and the rest is the realm's own words.
       */
      need.push(words.slice(0, 2).join(' ').trim());
    }
    if (need.length > 0) command.need = [...new Set(need)];
    bySteps.set(key, command);
  }

  return [...bySteps.values()];
}
