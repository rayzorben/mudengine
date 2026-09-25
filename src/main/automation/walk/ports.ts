/**
 * The walk's two ports, beneath `Walker` and the three units it asks (todo
 * 740), so no unit imports the walker: what the walk asks of the session
 * (`WalkerEvents`, implemented in `SessionManager`'s constructor), and what
 * the units ask of the walk in flight (`WalkInFlight`, answered by `Walker`).
 * Each unit is handed the `Pick` of either that it calls. The why is
 * `mudengine-automation` › `parts/walking.md`.
 */
import type { WalkProgress } from '../../../shared/walk';
import type { CharacterState } from '../../../shared/character';
import type {
  Direction,
  Landing,
  RemoteLever,
  RoomId,
  Route,
  RouteStep
} from '../../../shared/world';

export interface WalkerEvents {
  notice?(message: string): void;
  /** Progress changed, so the renderer can redraw. */
  progress?(progress: WalkProgress): void;
  /**
   * The walk finished, one way or the other.
   *
   * For whoever is walking *because of* something else — a loop deciding where
   * to go next. The walker itself knows nothing about loops, which is what
   * keeps a plain walk a plain walk.
   */
  ended?(arrived: boolean, reason: string | null): void;
  /**
   * A step is about to be sent. The tracker cannot model a `Text:` exit as
   * movement from the command alone, and the walker planned it off a realm
   * edge — so the direction is handed over before the command goes out.
   */
  /**
   * A step's command is about to go out. `direction` is `'portal'` for a
   * scripted teleport, whose arriving room is resolved by the coordinates in
   * `to` rather than by an exit — which is why the destination rides along.
   */
  stepping?(command: string, direction: Direction | 'portal', to: RoomId, landing?: Landing): void;
  /**
   * Nobody knows where the character is, and the step that lost it was a draw.
   *
   * `LoopEvents.locate`'s twin and for the same reason — the realm answers
   * `rm` with exact coordinates — but it is armed by a much narrower fact.
   * **A scatter maze can be built so that nothing but asking will do**: no
   * signature among the Warped Asylum's twenty-four landing rooms is unique
   * (they fall into seven groups of two to four), so name and printed exits
   * together settle nothing, and the ladder is right to refuse. One command
   * turns a walk that would have stopped *ambiguous* into one that carries on.
   */
  locate?(): void;
  /**
   * What the character has to see by, when the next step goes somewhere dark.
   *
   * Asked rather than worked out here, for the reason `holdAt` is: answering it
   * needs the realm's item table to know which of the things in the pack is a
   * light at all, and the walker holds a route and a queue and deliberately not
   * the world. Absent, nothing is claimed and nothing is said.
   *
   * `spent` is the one worth interrupting for: the server treats a
   * zero-charge light as **absent** — `use glowing pearl` answers `You don't
   * have glowing pearl.` (measured live, 2026-08-27) — so a pearl reading
   * `(Readied/0)` is a stick. Note there is no `lit`: nothing on the wire says
   * whether a carried light is currently burning, and inventing that
   * distinction would be the reassuring guess.
   */
  lightSource?(state: CharacterState): { state: 'spent' | 'carried' | 'none'; name: string | null };
  /**
   * A step is about to be sent into `ahead`, and anything that must precede
   * it — a light, since 2026-09-03 — goes on the queue now, in the same band,
   * so it reaches the wire first.
   *
   * Asked here rather than worked out in the walker for `lightSource`'s
   * reason: the answer needs the pack's lights and the race's night vision,
   * and the walker holds a route and a queue. `light` is the destination's
   * recorded level, undefined for a room the realm records none for.
   */
  beforeStep?(ahead: { name: string; light: number | undefined }, state: CharacterState): void;
  /**
   * A step is about to be sent into `to`, and the ward the room wants goes
   * on the queue now, in the same band, so it reaches the wire first (todo
   * 105) — the waterskin before the desert. Asked of the session for
   * `beforeStep`'s reason: the answer needs the realm's spell and item
   * tables and the pack.
   */
  wardFor?(to: RoomId, state: CharacterState): void;
  /**
   * Whether auto-combat will actually fight here (`AutoCombat.wouldFight`),
   * where the switches say only what could. A declined journey reads on and
   * fights nothing. See `Holds.canEndAFight`.
   */
  willFight?(): boolean;
  /** Whether the session's escape is in flight or cooling down; the walk holds for it. */
  escaping?(): boolean;
  /**
   * Whether a light would be readied for the room the character is standing in
   * — asked before the walk gives up on a room it cannot read.
   *
   * A blinding room prints no block at all, so the client cannot place it and
   * the walk used to stop there. `AutoLight` answers exactly that case one
   * statement later (`SessionManager.onCharacter` runs the walker first), and
   * measured live on 2026-09-15 the torch was lit 1ms after the walk had
   * already ended and the room was readable 145ms after that. So the question
   * is asked of the module that will do it, and the walk waits instead.
   *
   * Absent, or false — auto-light off, nothing usable in the pack, an escape
   * in flight — and the walk stops exactly as it did, which is what keeps a
   * refusal loud.
   */
  lightComing?(state: CharacterState): boolean;
  /**
   * The name to type for the key an exit demands, when this character is
   * carrying it — and null when it is not, or when the realm cannot name the
   * row.
   *
   * The walker holds a route and no realm and no pack, so both halves are
   * asked of the session, which owns the world data and the character. It
   * answers with a **name** rather than a row id because the command is
   * `use <item> <direction>` and the last word is the exit
   * (`UseCommand.cs` takes `splitcommand[length - 1]` as the exit name), so
   * what goes on the wire is the realm's own spelling of the item.
   */
  keyToUse?(keyId: number): string | null;
  /**
   * Whether to hold the next step a moment: the room just confirmed holds
   * something worth stopping for (a loop's auto-combat answers this). The
   * walker re-asks on a short timer and proceeds when the answer turns false
   * or the patience runs out, so a monster nothing will engage cannot pin a
   * walk forever.
   */
  holdAt?(state: CharacterState): boolean;
  /**
   * Whether the spells a `spell-onset` names hold the character in place, off
   * the realm's own rows — `true`, `false`, or `null` where the realm cannot
   * say: no candidate named, a name it lacks, a row with no ability data. Only
   * `null` leaves the walk to read the sequence (see `Holds.onsetAnsweredStep`); a
   * `true` has already reached it as the tracker's flag.
   */
  spellsHold?(spells: readonly string[]): boolean | null;
  /**
   * Whether the room the character stands in is under a timed spell the way
   * in put on it — the underwater passage (todo 104). Inside one the walk
   * moves and does nothing else: no hold for health, a trap, a rest or a
   * quarry, and a fight that finds the character there is walked out of
   * rather than waited out. The health hold and the trap hold apply at the
   * mouth, which is the step *into* it, and never inside. Absent, nothing
   * is claimed and every hold applies.
   */
  moveOnly?(state: CharacterState): boolean;
  /**
   * The character as it is *now*, for a question asked on a timer.
   *
   * `holdAt` is asked again when the beat expires, and the state captured when
   * the hold began is by then a second and a half old — the monster may be
   * dead, or the fight may have started. Absent, the stale state is used, which
   * is what every existing caller had.
   */
  stateNow?(): CharacterState;
  /**
   * The server refused a step the realm data promised — the `no exit` shape,
   * not a closed door. The edge is named so the session can stop planning
   * through it.
   */
  refused?(from: RoomId, direction: Direction | 'portal', why: 'missing' | 'shut'): void;
  /**
   * A walk has been started, and this is where it is going.
   *
   * Raised here rather than at the IPC handler because this is the one funnel
   * every walk goes through — a route the player chose in the palette, and a
   * loop's own leg to its next stop, which never reaches an IPC handler at all.
   * Recording at the handler would have kept the palette's destinations and
   * silently missed every loop start point, which is half of what the recent
   * list is for.
   *
   * *Started*, not arrived: the destination is what the player asked for, and a
   * route that failed half way is the one they are most likely to ask for
   * again. The walker knows the room and its name off the last step and
   * deliberately not what is done with them.
   */
  destination?(room: RoomId, name: string): void;
  /**
   * How many moves this client has sent that the server has not answered yet.
   *
   * The tracker owns that queue (`CharacterTracker.pendingMoves`) because it
   * counts every move, not only the walker's — a typed direction, a party
   * follow, a leg the last walk had already sent when combat stopped it. The
   * walker needs the count for two decisions it cannot make from its own
   * route: whether the room on the books is one the character has left, and
   * whether a refusal off the wire is the answer to *this* step.
   *
   * Absent, nothing is claimed: the count reads as "only this step", which is
   * the behaviour before it existed.
   */
  pendingMoves?(): number;
  /**
   * Whether a `rest` is on the wire with its answer still to come.
   *
   * *One step outstanding* is already a property of the wire this walker
   * refuses to send across (`pendingMoves`); a rest outstanding is the same
   * kind of fact and gets the same treatment (todo 14). `Recovery.restInFlight`
   * is the window — opened when `rest` goes out, closed the instant
   * `(Resting)` arrives or `tuning.rest.askedMs` expires.
   *
   * Absent, nothing is claimed and no step waits, which is the behaviour
   * before it existed.
   */
  restInFlight?(): boolean;
  /**
   * Whether the room read after a kill is still to be answered (todo 814,
   * `AutoLoot.floorInFlight`): items drop unannounced, so the loot takes them
   * off that reprint, and a step sent ahead of it puts the `get` in the next
   * room. The same kind of fact again, bounded by the read's own expiry.
   * Absent, no step waits.
   */
  floorInFlight?(): boolean;
  /**
   * Whether the character is on the ground (`Grounded.down`, todo 764). The
   * step's clock runs on a timer, and a character down is handed no state and
   * refused every step (`MoveCommand`). **Only `false` is standing**: absent,
   * the walk nudges nothing, since a construction that never said the
   * character is up has not said it may be asked to answer.
   */
  onTheGround?(): boolean;
  /**
   * A fresh route from where the character is *now* to where it was going.
   *
   * Asked when a fight the route stood still for is over and the character is
   * no longer standing where the held step starts — it killed the thing in
   * the next room, or ran, or was followed somewhere. **It replans; it never
   * resumes**, which is the rule `LoopRunner` already follows after every one
   * of its own interruptions and the one `Walker` follows after any failure:
   * the steps ahead were planned from a room the character may have left, and
   * walking them from here sends directions from somewhere it is not.
   *
   * Asked rather than worked out here for `holdAt`'s reason — the answer needs
   * the realm graph, the character's purse and the edges the server has
   * refused this session, and the walker holds a route and a queue and
   * deliberately not the world. Absent, a character that moved during a fight
   * stops the walk as it always did, which is the behaviour before this
   * existed.
   *
   * Returns the route, or the reason there is none — reported as the reason
   * the walk stopped, because a journey that cannot be re-planned is over.
   *
   * `shortest` is the walk's own `start` option, handed back so a lap's leg
   * is re-planned by distance as it was first planned.
   */
  replan?(to: RoomId, shortest: boolean): Route | string;
  /**
   * Every lever the realm says opens this exit, and where each is pulled.
   *
   * Asked rather than worked out here for `replan`'s reason: the answer is an
   * index over every room in the realm and the walker holds a route and a
   * queue and deliberately not the world. Absent, or empty, means the realm
   * names nothing that opens this — which is every exit but 225 of them.
   */
  leversFor?(from: RoomId, direction: Direction): readonly RemoteLever[];
  /**
   * A route between two rooms neither of which is where the character is
   * standing.
   *
   * `replan` answers *from here*, which is every question a walk asks except
   * one: whether a **set** of levers in several rooms can be walked at all.
   * That is all or nothing — pulling some of them spends commands on a passage
   * that stays shut, which is `buildRealm`'s own reason for refusing to write
   * a half-matched `actions` list — so the whole run is checked before the
   * first lever, and legs two onwards start somewhere the character is not yet.
   *
   * Absent means the run cannot be checked, and an unchecked all-or-nothing
   * journey is not one to start. `shortest` as for `replan`.
   */
  routeBetween?(from: RoomId, to: RoomId, shortest: boolean): Route | string;
}

/** The walk in flight, as the units `Walker` asks see it. */
export interface WalkInFlight {
  /** Whether a route is being walked; a timer that wakes to anything else decides nothing. */
  walking(): boolean;
  /** This walk's silence: a loop's leg is narrated by the loop. */
  quiet(): boolean;
  /** The step in flight, or undefined. */
  step(): RouteStep | undefined;
  publish(): void;
  stop(reason: string): void;
  /** The step again, behind what was just answered or queued ahead of it. */
  stepAgain(): void;
}
