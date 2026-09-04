/**
 * Grouping and searching the shelf of loops, as decisions rather than as JSX.
 *
 * Here rather than in `LoopsModal` for the reason `lib/table.ts` gives: this is
 * where the edge cases are — what a two-word query means, where a group with
 * one match goes, what an area with no name is called — and a decision inside a
 * component is one that can only be tested by rendering it, which this suite
 * has no DOM for.
 */
import { loopCategory, splitStop, UNCATEGORISED, type Loop, type LoopScope } from '@shared/loops';

/**
 * Where a chosen loop is kept, once it has been started.
 *
 * Two of the three scopes and an explicit refusal. `global` is deliberately
 * **not** offered: it writes into every character on the client at once, which
 * is a decision the settings screen should be opened for rather than one made
 * in passing from a modal that is one keystroke away.
 */
export type LoopDestination = Extract<LoopScope, 'profile' | 'server'> | 'none';

/**
 * The destinations, in the order they are drawn.
 *
 * The runtime half of the union, beside the type as this project requires of
 * every closed one: a destination in the type and not in this list draws no
 * chip, which is a control that cannot be chosen and no error anywhere saying
 * so. The character is first because it is the default, and the default is
 * where a picked loop almost always belongs.
 */
export const LOOP_DESTINATIONS: readonly LoopDestination[] = ['profile', 'server', 'none'];

/**
 * What choosing a row asks for: a loop to file, or a name already on disk.
 *
 * Two shapes because there are genuinely two, and collapsing them is what went
 * wrong first. A shelf row carries the whole loop, because filing it means
 * writing its stops into a file. A row that is only *held* — somebody's own
 * hand-written loop, which `loop:list` reports as a name and a **count** —
 * carries no stops at all, and the first version of this invented
 * `{ room: '' }` placeholders to fill the gap. `asLoops` drops an empty room,
 * so the loop parsed to nothing and main refused the player's own valid loop
 * as one "the client cannot file". Absence stood in as a value and then
 * propagated as a false claim about their data.
 *
 * So a held-only row is `by-name`: it is already on disk, `loop:start` resolves
 * it the way the palette and the card do, and there is nothing to file.
 */
export type LoopChoice =
  { kind: 'loop'; loop: Loop } | { kind: 'by-name'; name: string; stops: number };

/** One loop as the modal draws it. */
export interface LoopRow {
  /**
   * Its place in the list the modal was handed.
   *
   * The key is *where it is*, never what it is named — the rule the card tables
   * already carry, and it is load-bearing here: the shelf and a character's own
   * loops are merged by name, and a name that appears in both would otherwise
   * be one React key for two rows.
   */
  key: string;
  /** What choosing this row asks for. See {@link LoopChoice}. */
  choice: LoopChoice;
  /** The name as the client addresses it, whichever shape the row is. */
  name: string;
  /** How many stops the row states. */
  stops: number;
  /** The area this row is grouped under. */
  category: string;
  /**
   * The name without its area, since the area is the heading above it.
   *
   * `Ancient Fortress: Hedge Maze-17 2868` under a heading that already says
   * `Ancient Fortress` spends the first third of every row restating it, and
   * the part that distinguishes the rows is what gets pushed off the end.
   */
  shortName: string;
  /** Whether the character already walks it, so the row can say so. */
  held: boolean;
  /**
   * The places this loop visits, for matching against where the character is.
   *
   * Empty for a `by-name` row, and that emptiness is a fact rather than a gap:
   * `loop:list` answers with a name and a stop *count*, so a held-only loop's
   * places are genuinely not known here. It is therefore never hoisted as a
   * loop starting or passing through this room — the alternative is claiming
   * a route the client has not read, which is the one thing
   * {@link LoopChoice} exists to have stopped once already.
   */
  stopsAt: LoopStopPlace[];
}

/** One stop as it is matched against a room: its name, and its coordinates. */
export interface LoopStopPlace {
  name: string;
  at: { map: number; room: number } | null;
}

/**
 * Where the character is, for ranking the shelf against it.
 *
 * All three fields are independently absent, and none of them is guessed: a
 * room the client has not resolved has no `map`/`room` and matches nothing by
 * coordinates, a room with no name matches nothing by name, and a session that
 * has run no loop yet has no recent one. Absence here removes a section; it
 * never invents one.
 */
export interface LoopHere {
  /** The loop this character last ran, whether or not it is still running. */
  recent: string | null;
  /** The room name as the server printed it, or null before one was read. */
  roomName: string | null;
  /** The room the client resolved, or null while it has not. */
  at: { map: number; room: number } | null;
}

/** A group that is nothing here has nothing to say and is not drawn. */
export const NOWHERE: LoopHere = { recent: null, roomName: null, at: null };

/**
 * Why a group is above the areas, or `area` for one that is not.
 *
 * A closed union with its runtime half beside it, as this project requires:
 * `LOOP_SECTIONS` is the order the priority sections are drawn in, and a kind
 * in the type that is missing from it is a section that silently never
 * appears.
 */
export type LoopSection = 'recent' | 'start' | 'waypoint';

export const LOOP_SECTIONS: readonly LoopSection[] = ['recent', 'start', 'waypoint'];

export interface LoopGroup {
  /**
   * A stable identity for the group, which is what the modal remembers as
   * expanded — never the label. Two areas cannot share a name, but a priority
   * section's label is a sentence about the room and would change under
   * somebody's feet as they walked, taking the open/closed state with it.
   */
  id: string;
  /** `area` for an ordinary heading; otherwise why it is above them. */
  section: LoopSection | 'area';
  /** The area this group states, for an `area` group. */
  category: string;
  loops: LoopRow[];
}

/**
 * One loop the character already walks, as the renderer holds it.
 *
 * `loop:list` answers with names and stop *counts* rather than whole loops,
 * which is all a card's picker ever needed. That is enough here too: a loop
 * the character already has is one that never needs filing, so the modal needs
 * to recognise it, not to be able to rewrite it.
 */
export interface HeldLoop {
  name: string;
  stops: number;
}

/**
 * The whole shelf as rows, with the character's own marked.
 *
 * Merged by lower-cased name, which is the rule every other list of loops in
 * this client follows (`mergeLoops`): a name is how a loop is addressed
 * everywhere, so two entries called the same thing are one thing and showing
 * both would be one loop offered twice with no way to tell which is which.
 *
 * A loop the character walks that is **not** on the shelf still gets a row —
 * somebody's own hand-written `Sewer circuit` is exactly the loop they will
 * look for here first, and a modal claiming to hold every loop while omitting
 * the ones they wrote would be the more confusing of the two mistakes. That
 * row is `by-name`: `loop:list` gave a name and a count, so a name and a count
 * is what it carries, and it is chosen through the channel that resolves a
 * name. Inventing stops to fill the gap is what broke it the first time — see
 * {@link LoopChoice}.
 */
export function loopRows(catalogue: readonly Loop[], own: readonly HeldLoop[]): LoopRow[] {
  const held = new Map(own.map((loop) => [loop.name.toLowerCase(), loop]));
  const onShelf = new Map<string, Loop>();
  const order: string[] = [];

  for (const loop of catalogue) {
    const key = loop.name.toLowerCase();
    if (!onShelf.has(key)) order.push(key);
    onShelf.set(key, loop);
  }
  for (const key of held.keys()) {
    if (!onShelf.has(key)) order.push(key);
  }

  return order.map((key, index) => {
    const loop = onShelf.get(key);
    if (loop !== undefined) {
      const category = loop.category ?? loopCategory(loop.name);
      return {
        key: String(index),
        choice: { kind: 'loop', loop },
        name: loop.name,
        stops: loop.stops.length,
        category,
        shortName: shortName(loop.name, category),
        held: held.has(key),
        stopsAt: loop.stops.map(splitStop)
      };
    }
    // Held and not on the shelf: already on disk, so there is nothing to file
    // and no stops to invent.
    const entry = held.get(key)!;
    const category = loopCategory(entry.name);
    return {
      key: String(index),
      choice: { kind: 'by-name', name: entry.name, stops: entry.stops },
      name: entry.name,
      stops: entry.stops,
      category,
      shortName: shortName(entry.name, category),
      held: true,
      // Held-only: `loop:list` gave a count, not places. See `stopsAt`.
      stopsAt: []
    };
  });
}

/**
 * Whether a stop names the room the character is standing in.
 *
 * Coordinates first and alone when the stop states them: `Town Gates 1/2150`
 * names *one* of the thirteen rooms called Town Gates, and matching the other
 * twelve on the name it shares would hoist a loop that starts somewhere else
 * entirely — a confidently wrong answer about where a route begins. A stop
 * with no coordinates is matched on the name, which is all it stated.
 *
 * Every comparison needs both halves present. An unresolved room matches
 * nothing rather than everything, because "the client does not know where it
 * is" must not read as "every loop starts here".
 */
function stopIsHere(stop: LoopStopPlace, here: LoopHere): boolean {
  if (stop.at !== null) {
    return here.at !== null && stop.at.map === here.at.map && stop.at.room === here.at.room;
  }
  if (here.roomName === null) return false;
  return stop.name.toLowerCase() === here.roomName.trim().toLowerCase();
}

/**
 * Why this row belongs above the areas, or `null` for one that does not.
 *
 * Ranked, and each row takes only its first answer — the recent loop that also
 * starts here is drawn once, in `recent`. A hoisted row is **moved**, never
 * copied, which is the palette's own pin rule: a list holding the same loop
 * twice gives a reader two rows to compare and no way to tell them apart.
 *
 * *Starting here* is the first stop specifically, not any stop, because that is
 * the difference the sections are for: a loop whose first stop is this room can
 * be started with no walk at all, and one that merely passes through cannot.
 */
function sectionOf(row: LoopRow, here: LoopHere): LoopSection | null {
  if (here.recent !== null && row.name.toLowerCase() === here.recent.toLowerCase()) return 'recent';
  const first = row.stopsAt[0];
  if (first !== undefined && stopIsHere(first, here)) return 'start';
  if (row.stopsAt.some((stop) => stopIsHere(stop, here))) return 'waypoint';
  return null;
}

/**
 * The rows grouped for drawing, narrowed by a query.
 *
 * Three priority sections first — the loop this character last ran, then the
 * loops that *start* in this room, then the ones that pass through it — and the
 * areas after them. That order is the order somebody reaches for one: the loop
 * they were already walking is the commonest answer by a distance, and a shelf
 * of four hundred and twenty sorted only by area makes the two-keystroke case
 * cost a search.
 *
 * A section with nothing in it is **not drawn**, which is deliberately unlike
 * the areas: fifty-seven headings that are always present are a map of what the
 * realm holds, and a heading is worth a row for that. `Starts here` over no
 * rows is not a map of anything — it is the client saying *no* to a question
 * nobody asked, on every row of every room with no loop in it, which is most of
 * them.
 *
 * Every term has to appear somewhere in the name or the area, in any order:
 * the names are `Area: Room-map room`, so `sewer dark` and `dark sewer` are the
 * same question. The area is searched as well as the name, so typing an area
 * that a row's own name has had trimmed out of it still finds the row.
 *
 * A group with nothing left in it is dropped rather than drawn empty — while
 * searching, an open heading over no rows says the area has been searched and
 * found wanting, which is a claim about fifty-six other areas the reader then
 * has to scroll past to disprove.
 */
export function groupLoops(
  rows: readonly LoopRow[],
  query: string,
  here: LoopHere = NOWHERE
): LoopGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sections = new Map<LoopSection, LoopRow[]>();
  const areas = new Map<string, LoopRow[]>();
  const order: string[] = [];

  for (const row of rows) {
    if (terms.length > 0) {
      const haystack = `${row.name} ${row.category}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
    }
    const section = sectionOf(row, here);
    if (section !== null) {
      const held = sections.get(section);
      if (held === undefined) sections.set(section, [row]);
      else held.push(row);
      continue;
    }
    if (!areas.has(row.category)) {
      areas.set(row.category, []);
      order.push(row.category);
    }
    areas.get(row.category)!.push(row);
  }

  return [
    ...LOOP_SECTIONS.flatMap((section) => {
      const held = sections.get(section);
      return held === undefined ? [] : [{ id: `!${section}`, section, category: '', loops: held }];
    }),
    ...order.map((category) => ({
      id: category,
      section: 'area' as const,
      category,
      loops: areas.get(category)!
    }))
  ];
}

/**
 * A loop's name with its area taken off the front.
 *
 * Only when the area is genuinely a prefix of the name: a loop whose category
 * a file stated outright has a name that does not start with it, and trimming
 * a prefix that is not there would silently take real characters off the front
 * of a name somebody chose. `UNCATEGORISED` is never a prefix, so those keep
 * their names whole, which is right — they have no area to have restated.
 */
function shortName(name: string, category: string): string {
  if (category === UNCATEGORISED) return name;
  const prefix = `${category}:`;
  if (!name.startsWith(prefix)) return name;
  const rest = name.slice(prefix.length).trim();
  // A loop called exactly `Sewers:` would otherwise become a blank row.
  return rest.length > 0 ? rest : name;
}
