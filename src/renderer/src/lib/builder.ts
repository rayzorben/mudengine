/**
 * The loop builder's decisions, as values rather than as a card's tangle of
 * state.
 *
 * Here rather than in `LoopBuilderCard` for the reason `lib/table.ts` and
 * `lib/loops.ts` give: this is where the edge cases are — what a second click
 * on the start means, when a draft is a loop and when it is a route, which
 * steps of a leg are worth listing — and a decision inside a component can
 * only be tested by rendering it, which this suite has no DOM for.
 */
import { splitStop, type Loop, type LoopStop } from '@shared/loops';
import { DIRECTIONS, type LoopDraft, type RoomId, type RouteStep } from '@shared/world';

/**
 * What a click on a room does to the picks, or `null` for a click that
 * changes nothing.
 *
 * Four cases, and the second is the one the request states outright: the
 * first room clicked is the start; the start clicked again **with nothing
 * else picked** unpicks it; any other room is the next pick; and the room
 * that is already the last pick is not picked twice, because a leg from a
 * room to itself is no steps and a list entry saying nothing. The start
 * clicked with other picks behind it closes the loop — it is an ordinary
 * pick, and `shapeOf` reads the closed shape off the list.
 *
 * `null` rather than the same list, so a caller can tell an edit from a click
 * that made none and keep the undo history honest: a no-op recorded as an
 * edit is an undo that appears to do nothing.
 */
export function pickRoom(picks: readonly RoomId[], room: RoomId): RoomId[] | null {
  if (picks.length === 0) return [room];
  if (picks.length === 1 && picks[0] === room) return [];
  if (picks[picks.length - 1] === room) return null;
  return [...picks, room];
}

/**
 * What the picks add up to.
 *
 * `loop` is a way that ends where it began — three picks at least, because
 * two that are the same room is the unpick case above. `route` is anything
 * with two ends. `start` is one room and nothing to walk yet.
 */
export type DraftShape = 'empty' | 'start' | 'route' | 'loop';

export function shapeOf(picks: readonly RoomId[]): DraftShape {
  if (picks.length === 0) return 'empty';
  if (picks.length === 1) return 'start';
  return picks.length >= 3 && picks[0] === picks[picks.length - 1] ? 'loop' : 'route';
}

/**
 * The loop the draft would be saved as, or null while there is nothing to save.
 *
 * A **loop** drops its closing waypoint: it is the first one again, and the
 * runner plans the closing leg itself (`nextStop` wraps). A **route** keeps
 * both ends and is saved with `bounce`, which is this client's there-and-back
 * — the runner walks it out and back rather than jumping from the end to the
 * start through rooms nobody chose . Either is saved with `prefer` when the
 * player leaves the toggle on, so the router follows it wherever it can for
 * every route this character plans afterwards. Both need two stops at least;
 * a loop that reduced to one place is a place to stand, which `asLoops`
 * refuses.
 *
 * Every stop is written with its coordinates behind the name
 * (`Town Gates 1/2150`), because thirteen rooms are called Town Gates and a
 * stop named by name alone would be refused as ambiguous the night it was
 * walked. A blocked leg saves nothing: a loop with a door in it that the
 * character cannot open is a loop that stops there.
 */
export function loopFor(
  draft: LoopDraft,
  picks: readonly RoomId[],
  name: string,
  prefer: boolean
): Loop | null {
  const shape = shapeOf(picks);
  if (shape === 'empty' || shape === 'start') return null;
  if (draft.legs.some((leg) => leg.route.blocked)) return null;
  if (draft.legs.length !== picks.length - 1) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;

  const stops: LoopStop[] = draft.waypoints.map((stop) => ({ room: `${stop.name} ${stop.id}` }));
  if (shape === 'loop' && stops.length > 1) stops.pop();
  if (stops.length < 2) return null;
  return {
    name: trimmed,
    stops,
    // A route is walked there and back; a loop rings round.
    ...(shape === 'route' ? { bounce: true } : {}),
    // Preferred when the player says so — the card's toggle, on by default:
    // the router then follows its corridors for every route this character
    // plans afterwards, which is what saving a way somebody drew is for, and
    // what makes the way drawn the way walked (`loopDraft.ts`).
    ...(prefer ? { prefer: true } : {})
  };
}

/**
 * A name to offer before the player types one: where it starts and where it
 * ends, or the one place a loop goes round from.
 *
 * Offered rather than imposed — the field is editable and the name is what
 * the palette and the card address the loop by, so a person will usually
 * want their own word for it. Nothing while there is nothing to name.
 */
export function suggestedName(
  draft: LoopDraft,
  picks: readonly RoomId[],
  join: (from: string, to: string) => string,
  round: (place: string) => string
): string {
  const shape = shapeOf(picks);
  const first = draft.waypoints[0];
  const last = draft.waypoints[draft.waypoints.length - 1];
  if (first === undefined || last === undefined) return '';
  if (shape === 'loop') return round(first.name);
  if (shape === 'route') return join(first.name, last.name);
  return '';
}

/**
 * The steps of a leg worth listing under its waypoint.
 *
 * A leg is mostly compass directions through rooms the player will not read
 * one by one; what they read the list for is what the walk *needs* — a key,
 * a level, a lock to pick, a toll, a trap to take — and what it *sends* that
 * is not a direction: a `Text:` exit's phrase, a portal's command. Those are
 * the steps that decide whether this character can walk it, so those are the
 * ones shown, each with its place in the leg so a reader can count.
 */
export function notableSteps(steps: readonly RouteStep[]): Array<{ at: number; step: RouteStep }> {
  const out: Array<{ at: number; step: RouteStep }> = [];
  steps.forEach((step, index) => {
    const plain = step.direction !== 'portal' && isBareDirection(step.command);
    if (step.requirement === null && plain) return;
    out.push({ at: index + 1, step });
  });
  return out;
}

/** Whether a command is one of the ten compass words and nothing more. */
function isBareDirection(command: string): boolean {
  return (DIRECTIONS as readonly string[]).includes(command.trim().toLowerCase());
}

/**
 * The waypoints as `splitStop` would read them back, for the list: the name
 * and the coordinates apart, exactly as the saved file will state them.
 */
export function stopParts(stop: LoopStop): { name: string; at: string | null } {
  const { name, at } = splitStop(stop);
  return { name, at: at === null ? null : `${at.map}/${at.room}` };
}
