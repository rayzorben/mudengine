/**
 * The glyph and buttons beside a room's name: a bank's name gets a bank and
 * a deposit. Decided on the name line from the rooms it can be, decided again
 * once the room is placed, and the buttons taken off once the character is
 * elsewhere (todo 143). Off entirely when the internal file says the console
 * is not to be decorated. A decoration over the cells, never the grid:
 * `mudengine-session` › `parts/terminal.md`, *Enrichment never touches the
 * grid* and *A marked line's id rides in the painted text*.
 */
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import { actionsFor } from './actions';
import type { LineMarks } from './MarkBook';
import { pressless } from './markFile';
import type { Block } from '../../shared/blocks';
import { bankKey, type CharacterState } from '../../shared/character';
import type { LineId, TerminalMark } from '../../shared/types';
import type { RoomReference, WorldRoom } from '../../shared/world';

/** The purse, the vaults, the rooms the name line can be and whether it is a peek; the realm's places and room commands. */
export interface MarksParts {
  readonly tracker: Pick<CharacterTracker, 'current' | 'nextRoomIsPeek' | 'roomsNameCanBe'>;
  readonly world: Pick<WorldGraph, 'placeAmong' | 'roomCommandsAmong' | 'get'> | undefined;
  /** Where each line's mark is recorded, and changed once it is on screen. */
  readonly book: LineMarks;
}

/** What the session that built this answers for it. */
export interface MarksSession {
  /** Whether the internal file lets the console be decorated at all; off, nothing is marked. */
  enrich(): boolean;
}

/** The name line of the room the character stands in: the one line with live buttons. */
interface Live {
  id: LineId;
  name: string;
  mark: TerminalMark | null;
  /** The room it was decided for once placed, `map/number`; null while only the name is known. */
  placed: string | null;
  /** The room stood in when the name was printed: until the exits are read, the room is still that one. */
  before: string | null;
  /** Whether this line's own `Obvious exits:` has been read; before it, a placement is the room before. */
  exitsRead: boolean;
}

const roomKey = (map: number | null, number: number | null): string | null =>
  map === null || number === null ? null : `${map}/${number}`;

export class Marks {
  private readonly tracker: MarksParts['tracker'];
  private readonly world: MarksParts['world'];
  private readonly book: LineMarks;
  private live: Live | null = null;
  /** A peeked room's name was the last printed: the exits that follow are its, not the live line's. */
  private peeked = false;

  constructor(
    parts: MarksParts,
    private readonly session: MarksSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.book = parts.book;
  }

  /**
   * The id of a room's name line, recorded with what the console draws beside
   * it and, once placed, the room it was printed for. Every name line gets
   * one, marked or not, so a room placed only once `Obvious exits:` arrives
   * can have its buttons then.
   *
   * Asked on the *name* line, before the room is complete, so the mark is
   * answered from the rooms the tracker says the line can be
   * (`roomsNameCanBe`) and refuses when those disagree (`placeAmong`,
   * `roomCommandsAmong`). Guessing here would put a button on screen that
   * sends a command the room does not take, and an unrecognised command on
   * this server is *said out loud* to everybody standing in it.
   *
   * A peeked room gets the glyph and no buttons, and never becomes the live
   * line: `l n` prints the neighbour in full and nothing in it says the
   * character is not standing there; pressing a neighbour's button would send
   * its command into the room the character is actually in.
   */
  markFor(block: Block): LineId | undefined {
    if (!this.session.enrich()) return undefined;
    if (block.type === 'room-exits') {
      if (this.live !== null && !this.peeked) this.live.exitsRead = true;
      return undefined;
    }
    if (block.type !== 'room-name') return undefined;
    const name = block.text.trim();
    const peek = this.tracker.nextRoomIsPeek;
    const mark = this.decide(name, this.tracker.roomsNameCanBe(name), peek);
    const id = this.book.issue(mark ?? undefined);
    this.peeked = peek;
    if (peek) return id;
    // A room printed again, here or elsewhere: the last line printed is the one stood in.
    this.retire();
    const { map, number } = this.tracker.current.room;
    this.live = { id, name, mark, placed: null, before: roomKey(map, number), exitsRead: false };
    return id;
  }

  /**
   * The live line, against the character as it now stands: once the room of
   * that name is placed its line is decided again from that room alone, and
   * once the character is placed somewhere else its buttons come off.
   */
  onCharacter(state: CharacterState): void {
    const live = this.live;
    if (live === null) return;
    const { name, map, number } = state.room;
    if (name !== live.name || map === null || number === null) {
      // Still the room before (its exits not yet read), or one left without a name line.
      if (live.placed !== null) this.retire();
      return;
    }
    const placed = roomKey(map, number);
    if (live.placed === placed && (live.mark?.room !== undefined || !live.exitsRead)) return;
    /*
     * The room stood in when the name was printed: a look here, or a namesake
     * next door whose exits are still to come. Placed, so leaving it without a
     * name line takes the buttons off, but neither decided again from it nor
     * given its room until this line's exits say which it is.
     */
    if (!live.exitsRead && live.placed === null && placed === live.before) {
      live.placed = placed;
      return;
    }
    live.placed = placed;
    const room = this.world?.get(map, number);
    const where: RoomReference = { map, room: number };
    // The line keeps its room after the buttons come off: a click on the name in the backscroll routes there.
    live.mark = withRoom(this.decide(name, room ? [room] : [], false), name, where);
    this.book.change([{ id: live.id, mark: live.mark }]);
  }

  /** The live line's buttons off; its glyph is a label, sends nothing, and stays, as does its room. */
  private retire(): void {
    const live = this.live;
    this.live = null;
    if (live === null || live.mark?.actions === undefined) return;
    this.book.change([{ id: live.id, mark: pressless(live.mark) }]);
  }

  /**
   * The glyph for the kind of place the rooms are, and the buttons for what
   * can be done there; null when there is neither. A room with commands and
   * no shop is still worth marking: `go manhole` is a plain room whose only
   * way onward is a command nobody can see.
   */
  private decide(name: string, rooms: readonly WorldRoom[], peek: boolean): TerminalMark | null {
    const place = this.world?.placeAmong(rooms);
    const kind = place && place.kind !== 'tavern' ? place.kind : undefined;
    /*
     * The vault standing in front of the character, by the name the realm data
     * gives its shop and then by the room's own name, both through `bankKey`,
     * because the bank's header and the realm file need not agree on an
     * article (`The Bank of Godfrey` against `Bank of Godfrey`). A vault that
     * matches neither has not been asked, and offers no withdrawal.
     */
    const banks = this.tracker.current.banks;
    const vault =
      (place?.shop === undefined
        ? undefined
        : banks.find((held) => bankKey(held.name) === bankKey(place.shop))) ??
      banks.find((held) => bankKey(held.name) === bankKey(name));
    const actions = peek
      ? []
      : actionsFor(
          kind,
          this.world?.roomCommandsAmong(rooms) ?? [],
          this.tracker.current.inventory.wealth,
          vault?.copper ?? null
        );
    if (!kind && actions.length === 0) return null;
    return {
      ...(kind ? { icon: kind } : {}),
      label: place?.shop ?? name,
      ...(actions.length > 0 ? { actions } : {})
    };
  }
}

/** A line's mark with the room it was printed for; a plain room is a mark with nothing to draw. */
const withRoom = (mark: TerminalMark | null, label: string, room: RoomReference): TerminalMark => ({
  ...(mark ?? { label }),
  room
});
