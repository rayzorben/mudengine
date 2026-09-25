/**
 * What a session tells whoever holds it: the one contract between a
 * `SessionManager` and its host, beside both so a unit carved out of the
 * session can take a `Pick` of it without reaching up into the manager. Its
 * optional members are diagnostics by design. See `mudengine-session`.
 */
import type { StandDown } from '../automation/LoginAutomator';
import type { AutomationSnapshot } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState, RealmFamily as RealmWord } from '../../shared/character';
import type { AutomationSwitch } from '../../shared/config';
import type { Find } from '../../shared/finds';
import type { LoopProgress } from '../../shared/loops';
import type { Discovery } from '../../shared/memory';
import type { PlayerRegistry } from '../../shared/players';
import type { QuestRunProgress, QuestWatched, RoomAsk } from '../../shared/quests';
import type { CharacterIdentity, ResetSignal } from '../../shared/reset';
import type { ConnectionState, StreamChunk, StreamLine, TelnetEvent } from '../../shared/types';
import type { RoomVerdict } from '../../shared/verdict';
import type { WalkProgress } from '../../shared/walk';
import type { RoomId } from '../../shared/world';

export interface SessionSink {
  data(chunk: StreamChunk): void;
  /**
   * Raw payload bytes, Telnet framing removed and *not yet decoded*.
   *
   * The one record that can settle a disagreement about what the server
   * actually sent and in what order. `data` is already decoded and
   * quirk-adjusted, so an encoding fault or a reordering argued from it is
   * argued from the client's own interpretation rather than from the wire.
   */
  bytes?(payload: Buffer): void;
  /** One framed line of server output. See `LineTokenizer` for why this is not CRLF. */
  line(line: StreamLine): void;
  /** One classified line. Facts only — see docs/legacy-assessment.md §6. */
  block(block: Block): void;
  /** Character and room state, republished only when it actually changed. */
  character(state: CharacterState): void;
  /**
   * What is known about the other players, whole, republished only when it
   * changed — and never with the character, whose status line it used to ride
   * on at a clone per record (`mudengine-session` › *The registry is its own push*).
   */
  players(registry: PlayerRegistry): void;
  state(state: ConnectionState): void;
  /**
   * The socket went and this client never asked it to.
   *
   * Separate from `state` because a `closed` phase cannot tell the two apart:
   * the player pressing Disconnect, the low-health hang-up, switching realms
   * and a dead link all arrive at that phase, and only this side knows which.
   * The alternative on offer was matching the notice's wording, and copy is
   * not a protocol.
   *
   * `why` is the reason dialling back would undo something somebody meant —
   * see `LoginAutomator.standDown` — or null when the connection was simply
   * lost.
   *
   * **Required**, unlike the other diagnostics on this sink. It is the only
   * channel auto-reconnect has, and a second implementation that forgot it
   * would be a client that silently never dials a dropped character back —
   * with no compile error to say so. The reason it was optional ("nothing in a
   * test needs it") was answered by the test file, which implements it.
   */
  dropped(why: StandDown | null): void;
  telnet(event: TelnetEvent): void;
  /** An engine message to surface inline in the terminal. */
  notice(message: string): void;
  /**
   * The decoded stream, whole — every byte the server sent, escape sequences
   * intact, before the feed decided what the terminal is shown. For the
   * capture and the session log, which are records of what happened rather
   * than of what was painted; `data` is what was painted.
   */
  decoded?(text: string): void;
  /**
   * Everything this character has learned about the realm, after learning
   * something new.
   *
   * The whole list rather than the one addition, for the same reason a `who`
   * listing replaces the roster: a window that missed a push would otherwise
   * hold a record with a hole in it and no way to notice.
   */
  learned?(discoveries: Discovery[]): void;
  /**
   * Everything a `search` has turned up in this realm, after one turned up
   * something. The whole list, for the reason `learned` sends the whole list.
   */
  finds?(finds: Find[]): void;
  /**
   * The character in the realm may not be the character these records are
   * about. Reported, never acted on: see `SessionManager.watchForReset`.
   */
  reset?(notice: {
    signals: ResetSignal[];
    before: CharacterIdentity;
    after: CharacterIdentity;
  }): void;
  /**
   * The rank each quest has been seen to reach from what the player typed.
   * The whole map, for the reason `learned` sends the whole record.
   */
  questSaid?(progress: QuestWatched): void;
  /** How a run of a quest's plan is going, on every change. See `QuestRunner`. */
  questRun?(progress: QuestRunProgress): void;
  /**
   * A command the client committed to the wire, reassembled from keystrokes.
   * One place does this, so a capture and the tracker cannot disagree.
   */
  command?(command: string, source: 'user' | 'automation'): void;
  /** How a route walk is going, when one is running. */
  walk?(progress: WalkProgress): void;
  /**
   * A walk was started toward this room — the palette's recent destinations.
   *
   * A hook rather than a store, for the reason `memory` is an interface: this
   * is the session layer, and where the file goes belongs to whoever decided
   * where the files go. Absent in every test and in the anonymous case, where
   * walking somewhere and forgetting it is better than refusing to walk.
   */
  destination?(room: RoomId, name: string): void;
  /** Loop progress — where the loop is, for the HUD. */
  loop?(progress: LoopProgress): void;
  /**
   * The decision trace: what automation queued, sent and decided.
   *
   * Coalesced by the caller rather than published per change — during a combat
   * burst the queue changes many times a second, and chrome must never be able
   * to pace the stream.
   */
  automation?(snapshot: AutomationSnapshot): void;
  /**
   * The room appraised — every monster's verdict and what clearing the room
   * is expected to cost — on change. The same `Verdict` auto-combat ranks on.
   */
  verdict?(appraisal: RoomVerdict): void;
  /**
   * What the things standing in this room can be asked, for this character as
   * it stands — on change, and keyed like the verdict. See `asksHere`.
   */
  asks?(offers: readonly RoomAsk[]): void;
  /**
   * The realm named its own data — `[MAJORMUD]:`, `[PARADIGM]:` at its menu —
   * once per connection. A hook rather than a store, like `destination`: which
   * bundled world that word chooses for this address next time is written
   * down by whoever decided where the files go (`WorldBook`).
   */
  realmTold?(realm: RealmWord): void;
  /**
   * Flip one automation switch in this character's own file, for the two
   * things the session decides on the player's behalf (`CombatLease`): combat
   * lent for a hold, and given back on arrival. Whether it was written.
   */
  switchAutomation?(name: AutomationSwitch, on: boolean): boolean;
}
