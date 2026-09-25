/**
 * A loop: the route a character walks round and round to gain experience.
 *
 * This is the thing MegaMUD players spend their evenings in, and the one
 * feature of it this client had no answer to. MegaMUD records a loop as a
 * **file of hand-recorded steps** — a room code and a direction per line,
 * captured by walking it once — because it has no reliable pathfinder to
 * re-derive them (docs/mega-paramud.md). We do: `WorldGraph.route` plans
 * between any two rooms and `Walker` walks one step at a time, verified.
 *
 * So a loop here is a **list of places**, not a list of steps: the client
 * routes to each in turn and starts again, and a corridor that changes, a
 * door that opens or a route the realm data improves is picked up for free.
 * Two consequences worth stating, because they are why this shape was chosen:
 *
 * - **A recorded loop goes stale silently.** MegaMUD's own release notes are
 *   a list of paths being repaired one room at a time. A waypoint loop cannot
 *   drift: the only thing written down is where to be, which is what the
 *   player actually meant.
 * - **Anybody can write one by hand.** A loop is four lines of YAML naming
 *   rooms, in the options file with everything else — no recorder, no binary,
 *   no per-step flags to learn.
 *
 * What is deliberately *not* here: MegaMUD's per-step flags (dark room, pick
 * lock, disarm trap, stash point). Every one of them is a property of a room
 * or an edge, and the realm data already carries them — the route planner
 * grades a door against the character (CLAUDE.md), the walker opens what it
 * can. A flag on a step would be a second copy of the realm, kept by hand.
 */

import { fileSlug } from './files';
import type { RoomId } from './world';
import type { AfflictionHold } from './walk';

/** One place a loop visits, named the way a person would say it. */
export interface LoopStop {
  /**
   * A room name as the realm data spells it, optionally with `map/room` to
   * settle an ambiguous one (`Newhaven, Arena` names one room; `Town Gates`
   * names thirteen).
   */
  room: string;
  /** Seconds to stay before moving on, for a lair that needs time to repopulate. */
  linger?: number;
  /**
   * Seconds this room takes to make monsters again — its own clock.
   *
   * **Opt-in, and absent on every loop written by hand.** A loop the player
   * drew is a list of places to walk in the order they wrote them, and nothing
   * here changes that; a stop stating this is one the client built from a
   * survey that knows the room's `Rooms.Delay` or its resident's `RegenTime`
   * (`huntLoop`, `src/shared/hunting.ts`).
   *
   * What it buys is the difference between the rate the Hunting card promises
   * and the rate the lap earns. The survey prices a filler lair on a slower
   * clock as though it is entered only on the laps it is standing —
   * `1,2,3,1,2,1,2,3` rather than room 3 every lap — and without a clock on
   * the stop the runner walked the detour every lap regardless (todo 15).
   *
   * Measured in **elapsed time, from the moment the stop was last left
   * cleared** (`dueStop`), never from a precomputed pattern: the pattern is
   * the survey's estimate and the runner's job is to hold to it against what
   * really happened — a fight that ran long, a retreat, a rest.
   */
  every?: number;
}

export interface Loop {
  /** How the player names it: shown in the palette and on the card. */
  name: string;
  stops: LoopStop[];
  /**
   * Walk the stops in order and then back down the list, rather than jumping
   * from the last to the first. A corridor loop is a there-and-back; a ring
   * of rooms is not.
   */
  bounce?: boolean;
  /**
   * The way between these stops is the way this character prefers, and the
   * router follows it wherever it can.
   *
   * What *Save Route* on the loop builder writes (2026-09-05): a route
   * somebody drew by hand is a statement about how to get somewhere, not only
   * a list of places to visit, so every leg between its stops is planned once
   * and the corridors it runs along are priced at a fraction of an ordinary
   * step (`tuning.world.preferredStepCost`) for every route this character
   * plans afterwards — the palette's, the way home from a fight. Not a lap's
   * own leg, which is always the shortest way (`SessionManager.lapTraveller`).
   * A loop without it is only somewhere to walk round.
   */
  prefer?: boolean;
  /**
   * Which area of the realm this loop is in, for a list too long to read.
   *
   * Four hundred and twenty shipped loops in one column is a wall nobody
   * browses, and MegaMUD's own names already carry the answer: every one of
   * them is `Area: Room-map room`, and the 420 fall into 57 areas. So the
   * grouping is a **field**, derived once by `loopCategory` when the loop is
   * parsed, rather than a `split(':')` performed again in every list that
   * draws one — which is the same fact restated in as many places as there
   * are consumers, each free to disagree about what a name with two colons
   * means.
   *
   * Always present after `asLoops`; a loop whose name states no area gets
   * `UNCATEGORISED` rather than an absent field, because a group heading is
   * something every row needs and "no area" is an answer rather than a gap.
   * A file may state it outright to override the name's own prefix.
   */
  category?: string;
}

/**
 * The group a loop with no area in its name belongs to.
 *
 * A word rather than an empty string: this is drawn as a heading beside
 * `Newhaven` and `Volcano`, and a blank heading over a run of rows reads as a
 * rendering fault rather than as the answer it is. The player's own
 * hand-written loops are mostly these — `Sewer circuit` names no area — so it
 * is the one heading somebody is certain to see.
 */
export const UNCATEGORISED = 'Uncategorised';

/**
 * The area a loop's name states, or `UNCATEGORISED`.
 *
 * `Ancient Fortress: Alabaster Palace, North End-17 9670` is `Ancient
 * Fortress`. Split on the **first** colon only: a name with two of them has an
 * area and then a room whose own name contains one, and taking the last would
 * make the room the group.
 *
 * Pure, and the only place the convention is stated — the shipped catalogue,
 * a loop typed by hand and a loop chosen in the modal must all group the same
 * way or the modal's headings and the file's contents disagree.
 */
export function loopCategory(name: string): string {
  const colon = name.indexOf(':');
  if (colon < 0) return UNCATEGORISED;
  const area = name.slice(0, colon).trim();
  return area.length > 0 ? area : UNCATEGORISED;
}

/**
 * How much of a list to keep, for a caller that did not write it.
 *
 * Absent means *all of it*, which is what a file the player owns gets: a
 * loop somebody spent an evening recording must not lose its tail because
 * a number here was chosen for a different caller. A payload that crossed the
 * IPC boundary passes limits, because that one is parsed rather than trusted
 * and an unbounded list there is a window bug turning into a file on disk.
 */
export interface LoopLimits {
  loops: number;
  stops: number;
}

/**
 * Which of the three places a loop was found in.
 *
 * A loop is available to a character, to every character on one server, or to
 * everybody — and the scope is the *directory it sits in*, never a key inside
 * the file. That is what makes moving one between scopes a move, and what
 * stops a file having to agree with where it is.
 */
export type LoopScope = 'global' | 'server' | 'profile';

/**
 * The scopes, as a list, and the guard that reads against it.
 *
 * The runtime half of the closed union: a scope that reaches main over IPC is
 * checked against this rather than cast, because the value picks a *directory
 * to write into* and a wire-built path is a write somewhere nobody chose. Kept
 * beside the type so the two move together — the rule `GUARD_FIELDS` and
 * `AppConfig` already carry, and the failure it prevents is the same one: a
 * member in the type and not in the list typechecks, then refuses at runtime.
 */
export const LOOP_SCOPES: readonly LoopScope[] = ['global', 'server', 'profile'];

export function isLoopScope(value: unknown): value is LoopScope {
  return typeof value === 'string' && (LOOP_SCOPES as readonly string[]).includes(value);
}

/** A loop and where it came from, for a screen that has to say so. */
export interface ScopedLoop {
  loop: Loop;
  scope: LoopScope;
  /** The server or character it belongs to; absent for a global one. */
  owner?: string;
}

/**
 * One list from several, with the later ones winning by lower-cased name.
 *
 * The merge rule loops and servers share: a name is how this client addresses
 * both, so two entries called the same thing are one thing with two
 * definitions, and the later list decides. Order is kept — the first
 * appearance of a name keeps its position, so a list does not reshuffle
 * because a narrower scope overrode one of them. Here rather than beside
 * `mergeServers` because `config.ts` already imports this module, and the
 * other way round would be a cycle.
 */
export function mergeNamed<T extends { name: string }>(...lists: readonly (readonly T[])[]): T[] {
  const order: string[] = [];
  const byName = new Map<string, T>();
  for (const list of lists) {
    for (const entry of list) {
      const key = entry.name.toLowerCase();
      if (!byName.has(key)) order.push(key);
      byName.set(key, entry);
    }
  }
  return order.map((key) => byName.get(key)!);
}

/**
 * One list of loops from several, with the later ones winning by name.
 *
 * The palette starts a loop by name, `loopNamed` finds one by name,
 * `LoopRunner` reports one by name — and the narrower scope decides: a
 * character that writes its own `Sewer loop` means *that* one, exactly as its
 * `automation:` overlay replaces a global block rather than being merged into
 * it.
 */
export function mergeLoops(...lists: readonly (readonly Loop[])[]): Loop[] {
  return mergeNamed(...lists);
}

/**
 * A filename for a loop, from its name.
 *
 * The name inside the file stays exactly what the player wrote; this is only
 * how the file is found. Shared with servers and characters, which are
 * addressed the same way — see `fileSlug`.
 */
export function loopFileName(name: string, taken: ReadonlySet<string> = new Set()): string {
  return fileSlug(name, taken);
}

/** Parses the `automation.loops` block. Anything malformed is dropped, never guessed at. */
export function asLoops(value: unknown, limits?: LoopLimits): Loop[] {
  if (!Array.isArray(value)) return [];
  const loops: Loop[] = [];
  for (const entry of value) {
    if (limits && loops.length >= limits.loops) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    const stops = asStops(record['stops'], limits?.stops);
    /*
     * A loop with one stop is a **camp**: stand in the lair, fight what the
     * clock brings, rest, and dwell again — MegaMUD's advice for every
     * instant-regen lair, and what *Loop it* on a one-room spot means (todo
     * 108, 2026-09-13). The runner dwells, steps to the same stop and dwells
     * again without a command leaving; it used to be dropped here as a place
     * the walker would arrive at and never leave, which is exactly the point.
     */
    if (name.length === 0 || stops.length < 1) continue;
    /*
     * The category is derived here rather than migrated into the files on
     * disk, which is what makes this a fallback and not a rewrite: every loop
     * that has ever been written — the 420 shipped, and the ones the player
     * typed by hand — gets its group the moment it is parsed, with nothing
     * asked of the user and no file touched. A file that states `category:`
     * outright wins, for the loop whose area is not in its name.
     */
    const stated = typeof record['category'] === 'string' ? record['category'].trim() : '';
    loops.push({
      name,
      stops,
      ...(record['bounce'] === true ? { bounce: true } : {}),
      ...(record['prefer'] === true ? { prefer: true } : {}),
      category: stated.length > 0 ? stated : loopCategory(name)
    });
  }
  return loops;
}

/**
 * Whether two lists of loops say the same thing.
 *
 * One consumer, and it is worth naming because the obvious guess is wrong:
 * `ConfigStore.setExtras`, which uses it as a **change detector**. The loop
 * and server stores watch their own trees, so a loop file appearing has to
 * reach every character the way an edit to the options file does — and a store
 * merely *settling* at startup must not republish the configuration twice.
 * This decides which of the two just happened.
 *
 * It is not on the profile-overlay path. A character's own loops are laid over
 * the base by `ProfileStore`, which never calls this.
 */
export function sameLoops(a: readonly Loop[], b: readonly Loop[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((loop, index) => {
    const other = b[index];
    if (!other) return false;
    if (loop.name !== other.name) return false;
    if ((loop.bounce ?? false) !== (other.bounce ?? false)) return false;
    // Preferring is a routing fact about the whole realm, so a file that
    // gains or loses it has to republish for the reason `category` does.
    if ((loop.prefer ?? false) !== (other.prefer ?? false)) return false;
    /*
     * `category` **is** compared, even though `loopNode` deliberately never
     * writes it.
     *
     * Not comparing it looks safe — it is derived from the name, so two loops
     * with the same name usually agree about it and the check reads as a
     * tautology. It stops being one the moment a file states `category:`
     * outright, which the field's own documentation permits for the loop whose
     * area is not in its name. Editing that key would then be a change this
     * function reported as no change at all: the store would not recompose, the
     * configuration would not republish, and the Loops modal would go on
     * grouping the loop under its old area until something unrelated forced a
     * reload. A hot-reloaded file that does not hot-reload is the failure here,
     * arriving through the one field that was assumed not to matter.
     *
     * Both operands always come through `asLoops` — every `LoopStore` path
     * does — so this is never `string` against `undefined`, and the ordinary
     * derived case still compares equal rather than republishing on every poll.
     *
     * Writing it back is the separate question and the answer is still no: a
     * value the client derived, appearing in a file the user owns, is one they
     * would then have to keep in step with a name they are free to edit.
     */
    if (loop.category !== other.category) return false;
    if (loop.stops.length !== other.stops.length) return false;
    return loop.stops.every((stop, at) => {
      const twin = other.stops[at];
      return (
        !!twin &&
        stop.room === twin.room &&
        (stop.linger ?? 0) === (twin.linger ?? 0) &&
        (stop.every ?? 0) === (twin.every ?? 0)
      );
    });
  });
}

function asStops(value: unknown, limit?: number): LoopStop[] {
  if (!Array.isArray(value)) return [];
  const stops: LoopStop[] = [];
  for (const entry of value) {
    if (limit !== undefined && stops.length >= limit) break;
    // `- Newhaven, Arena` is the ordinary case and needs no key.
    if (typeof entry === 'string') {
      const room = entry.trim();
      if (room.length > 0) stops.push({ room });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const room = typeof record['room'] === 'string' ? record['room'].trim() : '';
    if (room.length === 0) continue;
    const linger = record['linger'];
    const every = record['every'];
    stops.push({
      room,
      ...(typeof linger === 'number' && Number.isFinite(linger) && linger > 0
        ? { linger: Math.min(600, Math.round(linger)) }
        : {}),
      /*
       * No ceiling, unlike `linger`: a linger is time the character stands
       * still and 600 seconds of that is already absurd, where a clock is a
       * fact about the room and the realm states some in hours (a boss's
       * `RegenTime`). A stop nobody reaches within its clock is simply one the
       * lap walks whenever nothing else is due.
       */
      ...(typeof every === 'number' && Number.isFinite(every) && every > 0
        ? { every: Math.round(every) }
        : {})
    });
  }
  return stops;
}

/**
 * `Newhaven, Arena` or `Town Gates 1/2150` — the room, and the coordinates
 * that settle which one when the name is shared.
 */
export function splitStop(stop: LoopStop): {
  name: string;
  at: { map: number; room: number } | null;
} {
  const match = /^(.*?)\s+(\d{1,3})\/(\d{1,6})$/.exec(stop.room);
  if (!match) return { name: stop.room, at: null };
  return {
    name: (match[1] ?? '').trim(),
    at: { map: Number(match[2]), room: Number(match[3]) }
  };
}

/** Where the loop goes after `index`, honouring `bounce`. */
export function nextStop(
  loop: Loop,
  index: number,
  forward: boolean
): { index: number; forward: boolean } {
  const last = loop.stops.length - 1;
  if (!loop.bounce) return { index: (index + 1) % loop.stops.length, forward: true };
  if (forward) {
    return index >= last
      ? { index: last - 1, forward: false }
      : { index: index + 1, forward: true };
  }
  return index <= 0 ? { index: 1, forward: true } : { index: index - 1, forward: false };
}

/**
 * The next stop to walk to, given what each one's clock says.
 *
 * `nextStop` answers *where does the list go next*; this answers *which stop
 * is worth walking to*, and it is the whole of todo 15. A lair with a slower
 * clock than the ring around it is standing on only some of the laps, and the
 * Hunting card already prices it that way — `1,2,3,1,2,1,2,3` rather than
 * room 3 every lap. Walking the detour every lap regardless earns the detour's
 * cost and nothing else, so the rate the card promised is not the rate the lap
 * earns.
 *
 * **On elapsed time, never on a pattern.** The survey's `1,2,3,1,2` is an
 * estimate made before anything happened; a fight that ran long, a retreat or
 * a rest moves every clock it predicted. `cleared` is when each stop was last
 * *left cleared* — the runner's own record — and this compares it against now.
 *
 * Three rules, in order:
 *
 * 1. **The first stop in walking order whose clock has come round**, starting
 *    after the one the character is standing at. Walking order is `nextStop`'s
 *    own, so a bounce loop still bounces and the shape of the lap is kept.
 *    A stop with no clock is always due, which is why a loop written by hand
 *    walks exactly as it always did: every stop is due, so the first candidate
 *    is the ordinary next one.
 * 2. **A stop the client has never cleared is due**, rather than guessed at.
 *    Unknown is never the reassuring answer, and the guess here would be
 *    *don't go*.
 * 3. **Otherwise the one that comes round soonest.** Nothing being due is the
 *    ordinary case on a short ring, and the answer is not to stand still (the
 *    dwell at the stop already absorbs arriving early) nor to walk the next
 *    stop in the list, which is exactly the detour being avoided.
 *
 * `lapped` is true when the walking order wrapped on the way to the chosen
 * stop — the lap counter's own question, answered here because a skipped stop
 * must not count as a visit and the scan is the only thing that knows which
 * stops were passed over.
 */
export function dueStop(
  loop: Loop,
  index: number,
  forward: boolean,
  cleared: ReadonlyMap<string, number>,
  now: number
): { index: number; forward: boolean; lapped: boolean } {
  let at = { index, forward };
  let lapped = false;
  let soonest: { index: number; forward: boolean; lapped: boolean; due: number } | null = null;
  for (let step = 0; step < loop.stops.length; step += 1) {
    const was = at.index;
    const next = nextStop(loop, at.index, at.forward);
    // The lap counter's own test, made once per step of the scan rather than
    // once on the stop that happens to be chosen.
    if ((loop.bounce && was === loop.stops.length - 1) || (!loop.bounce && next.index === 0)) {
      lapped = true;
    }
    at = next;
    const stop = loop.stops[at.index];
    if (stop === undefined) continue;
    if (stop.every === undefined) return { ...at, lapped };
    const last = cleared.get(stop.room);
    if (last === undefined) return { ...at, lapped };
    const due = last + stop.every * 1000;
    if (due <= now) return { ...at, lapped };
    if (soonest === null || due < soonest.due) soonest = { ...at, lapped, due };
  }
  if (soonest !== null)
    return { index: soonest.index, forward: soonest.forward, lapped: soonest.lapped };
  // A loop with no stops at all: there is nowhere to go and the caller's own
  // `reasonStopMissing` is what says so. Every other shape has answered above.
  return { index, forward, lapped: false };
}

/*
 * What a running loop reports. Here rather than beside the runner because the
 * renderer draws it and `src/shared/` is the one place all three processes may
 * import from.
 *
 * **There is no `paused`** (2026-09-11). There was, and beside `stopped` it
 * was a distinction the player had to hold and the client could not keep: a
 * lap the person paused and a lap that gave up on three stops in a row were
 * drawn with different words, offered different controls, and both left the
 * character standing in a corridor. Both are now `stopped`, which keeps the
 * loop and its place — `resume` plans afresh from wherever the character
 * actually is, which is what the old `resume` did for a pause anyway. A stop
 * is a pause that may or may not be permanent. See `src/shared/movement.ts`.
 */
export type LoopStatus = 'idle' | 'running' | 'stopped';

/**
 * Why a running loop is standing still, when it is. `fight` is the point of
 * the loop, `health` is the hold `automation.health.restBelow` asked for,
 * and `retreated` is the beat after running away — the character is one room
 * from what it ran from, so the lap waits for the fight to be over and the
 * health back before planning a leg that may lead straight back in. `errand`
 * is the supplies trip: the pack fell below a minimum and the character is
 * walking to a shop and back, after which the lap plans on from wherever the
 * shop is. `offline` is a connection that was lost under the lap: the
 * character is still standing wherever the socket went, and the lap waits to
 * be back in the realm and placed before planning on from there. Null is a
 * loop that is walking or dwelling as planned.
 */
export type LoopHold =
  | 'fight'
  | 'health'
  | 'retreated'
  | 'errand'
  | 'offline'
  /**
   * A `rest` this client asked for, whose answer has not come back.
   *
   * The lap waits a beat rather than stepping into it. A rest and the next leg
   * decided in the same tick were both right at the moment each was made, and
   * the step undid the rest a millisecond later — seven times out of seven on
   * the run that found it (todo 14). Bounded by the window itself, so it cannot
   * deadlock: see `Recovery.restInFlight`.
   */
  | 'resting'
  /** Waiting out a stated affliction before the next leg — see `afflictionHolding` in `walk.ts`. */
  | AfflictionHold
  | null;

export interface LoopProgress {
  status: LoopStatus;
  /** Which loop, as the player named it. */
  name: string | null;
  /** Which stop it is heading for, one-based, and how many there are. */
  stop: number;
  stops: number;
  /** The stop's room as the loop names it, without the `1/2152` suffix. */
  stopName: string | null;
  /**
   * The stops this lap has yet to reach, in the order it will reach them,
   * resolved to rooms — the one being walked to first.
   *
   * A loop is a list of *places*, so this is what the map marks for it: the
   * places still owed this lap, with the ones already walked through gone.
   * Deliberately **not** the rooms of the legs between them, which is what a
   * line across the whole lap would need: a leg is planned when it is walked
   * (that is the whole reason a loop here is places rather than recorded
   * steps), so a lap drawn ahead of time would be a route the runner is under
   * no obligation to take — and after a fight, routinely is not. The leg
   * actually being walked is a walk like any other and draws itself through
   * `WalkProgress.path`.
   *
   * Only the stops the client could place, so this is **not** a count of what
   * the lap owes — `stop` and `stops` are, and they are unaffected. A stop
   * named ambiguously or not at all has no room to mark and simply drops out
   * of the drawing; `routeTo` resolves it again and reports the real refusal
   * when the lap gets there.
   */
  remainingStops: RoomId[];
  /**
   * Every stop of the lap, **named**, in order, as the loop writes them.
   *
   * `remainingStops` beside it is what a map marks with, and it drops the stops
   * the client could not place; this is what a reader reads, and it drops
   * nothing — the lap the player wrote is the lap they want to see. With `stop`
   * it says all three things at once: what is behind, what is being walked to,
   * and what is still owed. The last of those is the one a player acts on and
   * the only one the card never showed.
   */
  stopNames: string[];
  /** Laps completed since it started. */
  laps: number;
  reason: string | null;
  hold: LoopHold;
  /** When this run started, epoch ms; null while nothing has. */
  startedAt: number | null;
  /**
   * When this run first stood on the loop, epoch ms; null until it has.
   *
   * `startedAt` is the button; this is the lap. They differ by the walk out —
   * twenty-eight steps from town, on the run this was asked for — and that
   * stretch is not part of what the loop is earning. Set once per run, at the
   * first stop the run reaches *or* immediately when the character was already
   * standing on one when Start was pressed; a `resume` leaves it alone,
   * because a pause is in the middle of a lap that has long since begun.
   *
   * Read by the Combat Stats card, which re-bases its figures on it (todo 01,
   * *"starting a loop should reset combat statistics; restarting a loop should
   * not"*). Published rather than inferred from `stop` moving, because a stop
   * moves for a skip too, and a skipped opening stop is not a character that
   * got to the start of its loop.
   */
  lapBegunAt: number | null;
  /**
   * The character's experience when the run started, or null when it was not
   * known then — in which case nothing about experience made is claimed.
   */
  expAtStart: number | null;
  /** Which way round a bounce loop is being walked. Always true otherwise. */
  forward: boolean;
  bounce: boolean;
}

export const NO_LOOP: LoopProgress = {
  status: 'idle',
  name: null,
  stop: 0,
  stops: 0,
  stopName: null,
  remainingStops: [],
  stopNames: [],
  laps: 0,
  reason: null,
  hold: null,
  startedAt: null,
  lapBegunAt: null,
  expAtStart: null,
  forward: true,
  bounce: false
};
