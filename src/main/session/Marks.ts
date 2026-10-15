/**
 * A glyph for a line that names a place: a bank's name gets a bank. Only a
 * room's name line, and only when every room the line can be is the same kind
 * of place — `placeAmong` refuses otherwise, because a glyph is a claim and
 * the name line arrives before the room resolves. Off entirely when the
 * internal file says the console is not to be decorated. A decoration over
 * the cells, never the grid: see `mudengine-session` › `parts/terminal.md`,
 * *Enrichment never touches the grid*.
 */
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import { actionsFor } from './actions';
import type { Block } from '../../shared/blocks';
import { bankKey } from '../../shared/character';
import type { TerminalMark } from '../../shared/types';

/** The purse, the vaults, the rooms the name line can be and whether it is a peek; the realm's places and room commands. */
export interface MarksParts {
  readonly tracker: Pick<CharacterTracker, 'current' | 'nextRoomIsPeek' | 'roomsNameCanBe'>;
  readonly world: Pick<WorldGraph, 'placeAmong' | 'roomCommandsAmong'> | undefined;
}

/** What the session that built this answers for it. */
export interface MarksSession {
  /** Whether the internal file lets the console be decorated at all; off, nothing is marked. */
  enrich(): boolean;
}

export class Marks {
  private readonly tracker: MarksParts['tracker'];
  private readonly world: MarksParts['world'];

  constructor(
    parts: MarksParts,
    private readonly session: MarksSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
  }

  /**
   * What the console draws beside a room's name: the glyph for the kind of
   * place it is, and the buttons for what can be done there.
   *
   * Asked on the *name* line, which is before `Obvious exits:` has completed
   * the room, so both halves are answered from the rooms the tracker says the
   * line can be (`roomsNameCanBe`: the room a step leads to, the room stood in
   * and its namesakes next door, or every room of the name), and both refuse
   * when those disagree (`placeAmong`, `roomCommandsAmong`). Guessing here
   * would put a button on screen that sends a command the room does not take,
   * and an unrecognised command on this server is *said out loud* to
   * everybody standing in it.
   *
   * A room with actions and no shop is still worth marking: `go manhole` is a
   * plain room whose only way onward is a command nobody can see. The glyph
   * falls back to `shop` there, because a mark must name an icon and the
   * buttons beside it are already saying what the place offers.
   *
   * **A peeked room gets the glyph and no buttons.** `l n` prints the
   * neighbour in full and nothing in it says the character is not standing
   * there — the settled decision the expectation queue exists for. A glyph
   * against a peeked room is a label and was always tolerable; a *button* is
   * not, because pressing it sends the neighbour's command into the room the
   * character is actually in, and `go manhole` typed where there is no manhole
   * is said out loud to everybody present.
   */
  markFor(block: Block): TerminalMark | undefined {
    if (!this.session.enrich() || block.type !== 'room-name') return undefined;
    const name = block.text.trim();
    const rooms = this.tracker.roomsNameCanBe(name);
    const place = this.world?.placeAmong(rooms);
    const kind = place && place.kind !== 'tavern' ? place.kind : undefined;
    /*
     * The vault standing in front of the character, by the name the realm data
     * gives its shop and then by the room's own name — both through `bankKey`,
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
    const actions = this.tracker.nextRoomIsPeek
      ? []
      : actionsFor(
          kind,
          this.world?.roomCommandsAmong(rooms) ?? [],
          this.tracker.current.inventory.wealth,
          vault?.copper ?? null
        );
    if (!kind && actions.length === 0) return undefined;
    const mark: TerminalMark = {
      icon: kind ?? 'shop',
      label: place?.shop ?? name
    };
    if (actions.length > 0) mark.actions = actions;
    return mark;
  }
}
