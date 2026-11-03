/**
 * The room name lines printed while the character was lost, or placed only by
 * a guessed room (the steps after a dark room walked through), kept until a
 * resync places the character. Then each takes the room it was printed for,
 * read back along the exits stepped through (`retrace`), so a click on it in
 * the backscroll routes there; a guessed line the resync proves wrong takes
 * the right room, or loses its room when the right one cannot be told.
 * `mudengine-session` › `parts/terminal.md`, *A name line carries the room it
 * was printed for*.
 */
import { tuning } from '../app/tuning';
import type { Expectation } from '../parse/expectations';
import { retrace, type Onward } from '../world/navigation/retrace';
import type { WorldGraph } from '../world/WorldGraph';
import type { LineMarks } from './MarkBook';
import { pressless } from './markFile';
import { withRoom, withoutRoom } from './markRoom';
import { placedOn, type CharacterState } from '../../shared/character';
import type { LineId, MarkChange, TerminalMark } from '../../shared/types';
import { roomId, type Direction, type RoomReference } from '../../shared/world';

/** The claim a room block answered, as read on its name line. */
export interface Entered {
  /** Whether a command was waiting for it: a block nothing asked for may be a move nobody announced. */
  asked: boolean;
  /** The way stepped, for a step with one; a teleport, a draw's landing and a look have none. */
  direction: Direction | null;
}

/** What the name line knows of the claim at the head of the queue. */
export function enteredBy(claim: Readonly<Expectation> | null): Entered {
  const step = claim?.kind === 'move' && claim.landing === undefined ? claim.direction : null;
  return { asked: claim !== null, direction: step };
}

/** The live name line once its exits are read and it names the room stood in. */
export interface PrintedLine {
  id: LineId;
  name: string;
  /** What it carries now. */
  mark: TerminalMark | null;
  entered: Entered;
}

interface Kept extends PrintedLine {
  /** The arrivals counted when its block was read (`Room.arrival`). */
  arrival: number;
  /** Placed by evidence of its own: a resync reads back no further than this. */
  fixed: boolean;
  /** The room it carries from a guess, or null. */
  guess: RoomReference | null;
}

export interface LostLinesParts {
  readonly world: Pick<WorldGraph, 'findByName' | 'get'> | undefined;
  readonly book: Pick<LineMarks, 'change'>;
}

export class LostLines {
  /** Oldest first; the newest is the live line. */
  private lines: Kept[] = [];
  /** A dark room was walked into on a guess, and no resync has placed the character since. */
  private guessing = false;

  constructor(private readonly parts: LostLinesParts) {}

  /** The character as it now stands, and the live line when its block names the room stood in. */
  onCharacter(state: CharacterState, line: PrintedLine | null): void {
    const on = placedOn(state.room.resolvedBy);
    // A dark room prints no name line, so a guess is never a line's, even one that shares its name.
    if (on === 'guess') this.guessing = true;
    if (on === 'guess' || line === null || this.parts.world === undefined) return;
    const newest = this.lines.at(-1);
    if (newest?.id === line.id) {
      newest.mark = line.mark;
    } else {
      const { id, name, mark, entered } = line;
      this.lines.push({
        id,
        name,
        mark,
        entered,
        arrival: state.room.arrival,
        fixed: false,
        guess: null
      });
      if (this.lines.length > tuning().session.lostLinesKept) this.drop();
    }
    const placed = this.lines.at(-1)!;
    const { map, number } = state.room;
    if (placed.fixed || map === null || number === null || on === 'none') return;
    const here = { map, room: number };
    if (on === 'before' && this.guessing) placed.guess = here;
    else this.resync(placed, here);
  }

  /** The oldest line let go: a guess no resync can check any more is taken off it. */
  private drop(): void {
    const oldest = this.lines.shift();
    if (oldest === undefined || oldest.guess === null) return;
    this.parts.book.change([{ id: oldest.id, mark: withoutRoom(oldest.mark) }]);
  }

  /** The newest line placed on its own evidence: every line behind it read back from there. */
  private resync(newest: Kept, here: RoomReference): void {
    const run: Kept[] = [];
    for (let i = this.lines.length - 2; i >= 0; i -= 1) {
      const line = this.lines[i]!;
      if (line.fixed) break;
      run.push(line);
    }
    const from = this.parts.world?.get(here.map, here.room);
    const behind = run.map((line, k) => ({
      name: line.name,
      onward: onward(line, run[k - 1] ?? newest)
    }));
    const rooms = from && this.parts.world ? retrace(this.parts.world, from, behind) : [];
    const changes: MarkChange[] = [];
    // A guess stands only where the trace reached the same room; past where it stops, nothing can tell.
    run.forEach((line, k) => {
      const room = rooms[k];
      if (room === undefined) {
        if (line.guess !== null) changes.push({ id: line.id, mark: withoutRoom(line.mark) });
        return;
      }
      const ref = { map: room.map, room: room.room };
      if (
        line.guess === null ||
        roomId(line.guess.map, line.guess.room) !== roomId(room.map, room.room)
      ) {
        changes.push({ id: line.id, mark: pressless(withRoom(line.mark, line.name, ref)) });
      }
    });
    if (changes.length > 0) this.parts.book.change(changes);
    newest.fixed = true;
    newest.guess = null;
    this.lines = [newest];
    this.guessing = false;
  }
}

/** How the character went from `line`'s room to `next`'s, by the arrivals counted between them. */
function onward(line: Kept, next: Kept): Onward {
  const moved = next.arrival - line.arrival;
  if (moved === 0) return next.entered.asked ? 'stayed' : null;
  return moved === 1 ? next.entered.direction : null;
}
