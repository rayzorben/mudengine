/**
 * What the commands this client sent are waiting on.
 *
 * The fourth cluster out of `CharacterTracker` (2026-08-29), and the one the
 * survey said to take last: everything here is written on the **command
 * path**, from outside `reduce`, and read back by the room, the fight and the
 * prompts as their answers arrive. A queue of moves, peeks and re-reads the
 * next room block answers; the looks a wound sentence answers; the one
 * command that might be a text exit nobody wrote down; the walker's hint that
 * a command is a move; where a `sys go` said it was going; whether the player
 * asked to leave; and what the last command named. Seven slots, one memory,
 * because a room, a fight and a menu each consume a different one and none may
 * see the others'.
 *
 * Two things the tracker keeps, and this class is handed: whether the
 * character is in the realm (an unmodelled command is only worth remembering
 * there), and whether a typed word is a way out of the room it is standing in
 * — which asks the realm data and the current room, both the tracker's.
 *
 * `reset` and `leaveRealm` used to disagree about which of these a new
 * session or a closed socket cleared — the queue and the looks, but not the
 * hint, the teleport, the unmodelled command or the aim — and nothing said
 * why. Settled when this moved: `forget` clears all seven. Every one of them
 * is a claim about the *next* thing the server says, and after a reset or a
 * disconnect the next thing the server says answers nothing this client sent.
 */
import type { Direction } from '../../shared/world';
import { mobKey } from '../../shared/world';
import { commandOf, movementEffect } from '../../shared/commands';
import { tuning } from '../app/tuning';

/**
 * What the next room block is expected to be an answer to.
 *
 * A move changes where the character is; a peek — `l n` — describes somewhere
 * else entirely and must change nothing; a **re-read** — a bare Enter, a bare
 * `look` — describes the room the character is already standing in. All three
 * are queued because all three are commands that can be sent faster than the
 * server answers them, and a room arriving has to be matched to the one that
 * caused it.
 *
 * The third kind was added 2026-09-02, and it exists because the client's own
 * re-reads were the one room-producing commands it did not write down. The
 * walker nudges a stalled step with a bare Enter; the server answered the step
 * and the nudge together — two room blocks in one packet
 * (`2026-09-02_18-07-07_festus.mudcap.jsonl`, t=4862445) — and the second was
 * read as the arrival of the step the *first* one had just released. The walk
 * then ran a room ahead of the character for the rest of the lap: it sent `e`
 * twice inside three milliseconds, auto-combat engaged two monsters out of a
 * room block the character was already leaving, and five `pu`s were answered
 * `Your command had no effect.` from somewhere else entirely.
 *
 * The existing reprint guard could not see it. That one asks the realm data
 * whether the block can be the room the pending move predicts, and in a
 * corridor of namesakes — 293 rooms called Sewer Tunnel, the reprint printing
 * a *subset* of the destination's exits — the answer is honestly *maybe*. The
 * client asked for that room block, which settles it with no realm data at
 * all.
 *
 * Measured before it was written, across every recorded session: of 3,227 bare
 * Enters the client sent, 2,589 were answered with a room block and 188 with a
 * dark-room or blind line (which `arrivedUnseen` already consumes); 449 were
 * sent outside the realm, where this is not queued at all; and **one** in-game
 * Enter went unanswered, in an eight-second stall. Bare `look` is the same
 * shape and the same measurement — 1,234 rooms, 14 dark lines, none unanswered
 * in the realm.
 */
type Expectation = (
  { kind: 'move'; direction: Direction | null } | { kind: 'peek' } | { kind: 'reread' }
) & {
  /**
   * The command that queued this, lower-cased, or null for a move nobody
   * typed — a party follow, a drag.
   *
   * Kept because a refusal names the command and nothing else. `You say "go
   * manhole"` is the whole of what the server says when it will not run one,
   * and without the text there is no way to tell which queued expectation it
   * answers — so the expectation stayed, and the *next* room block was read
   * as the answer to a command that never ran. Measured, 2026-08-29: a walk
   * sent `go manhole` twice, the server ran the first and said the second out
   * loud, and the dark room the following `w` reached was resolved against
   * the phantom instead. The client lost its position and spent three `rm`s
   * finding it again.
   */
  command: string | null;
};

/**
 * One queued expectation with the moment it was queued.
 *
 * Separate from `Expectation` so that nothing which *classifies* a command has
 * to invent a timestamp: the stamp is put on at `push`, which is the one place
 * a claim enters the queue. See `expire` for what it is for.
 */
type Claim = Expectation & { at: number };

/** One claim the client has given up on, and whether anything waited on it. */
export interface LapsedClaim {
  /** The command that asked for it, or '' for a move nobody typed. */
  command: string;
  /** Whether it was a **move** — the only kind `pendingMoves` counts. */
  moved: boolean;
}

/** Abbreviations of `look`, which the game accepts from one letter up. */
const LOOK_WORDS = new Set(['l', 'lo', 'loo', 'look']);

/** The ten directions, for recognising a movement command. */
export const MOVE_COMMANDS: Record<string, Direction> = {
  n: 'n',
  north: 'n',
  s: 's',
  south: 's',
  e: 'e',
  east: 'e',
  w: 'w',
  west: 'w',
  ne: 'ne',
  northeast: 'ne',
  nw: 'nw',
  northwest: 'nw',
  se: 'se',
  southeast: 'se',
  sw: 'sw',
  southwest: 'sw',
  u: 'u',
  up: 'u',
  d: 'd',
  down: 'd'
};

/**
 * Classifies an outbound command, or returns null when it is none of them.
 *
 * `look north` is not movement and must not be treated as any: the room it
 * prints is the one you looked at, not the one you are in. A bare `look`
 * prints the one you *are* in, which is not movement either — but it is still
 * a room block the client asked for, and one nobody wrote down is one that
 * answers somebody else's move.
 *
 * A bare **Enter** is the same fact and does not come through here: nothing
 * reaches this function for one, by a decision made in `SessionManager` and
 * kept. See `noteReread`.
 */
function expect(command: string): Expectation | null {
  const text = command.trim().toLowerCase();
  if (text.length === 0) return null;

  const direction = MOVE_COMMANDS[text];
  if (direction) return { kind: 'move', direction, command: text };

  if (LOOK_WORDS.has(text)) return { kind: 'reread', command: text };

  const [verb, target] = text.split(/\s+/);
  if (verb !== undefined && target !== undefined && LOOK_WORDS.has(verb) && MOVE_COMMANDS[target]) {
    return { kind: 'peek', command: text };
  }

  return null;
}

/**
 * What a command asked to look *at*, if it named something rather than a way
 * out — `look orc rogue`, not `look n` and not a bare `look`.
 *
 * This is the whole binding between the wound sentence and the monster it
 * describes. `LookCommand` prints the name, the description, then `He appears
 * to be severely wounded.` — a bare pronoun — so nothing in the answer says
 * what was looked at and the question is the only record.
 *
 * Returns the `mobKey` form, which is what the damage ledger is keyed by: the
 * two disagreeing about whether the article counts would put a look and the
 * fight it describes into different buckets.
 */
export function lookTarget(command: string): string | null {
  const text = command.trim().toLowerCase();
  const space = text.indexOf(' ');
  if (space < 0) return null;

  const verb = text.slice(0, space);
  if (!LOOK_WORDS.has(verb)) return null;

  const rest = text.slice(space + 1).trim();
  // A direction is a peek at the next room, which has no wound line in it.
  if (rest.length === 0 || MOVE_COMMANDS[rest]) return null;
  return mobKey(rest);
}

/** What the tracker alone can say about a command, asked as it is observed. */
export interface CommandContext {
  /** Whether the character is in the realm; a menu answer is never a text exit. */
  inGame: boolean;
  /**
   * Whether the wire has said this character is standing at a **menu**.
   *
   * Narrower than `!inGame`, and the difference is load-bearing: `unknown` is
   * a fresh socket or a reconnect, where a typed direction is a real move.
   * This is the phase a menu prompt actually produced, so nothing queued
   * against it can be answered by a room.
   */
  atMenu: boolean;
  /** A typed word that is a way out of the current room, per the realm data. */
  typedExit(command: string): Direction | null;
  /**
   * The occupant a typed argument reaches, in the spelling the room printed.
   *
   * Asked **here**, as the command goes out, rather than when its answer comes
   * back: the room a look was asked about is the room the player was looking
   * at, and by the time the wound sentence arrives the occupant list may have
   * been replaced by a re-read, a kill or an arrival. Resolving late binds the
   * band to whatever now answers to those letters — or, if the list is empty,
   * to nothing at all, which is the original bug wearing a different hat.
   */
  occupantNamed(typed: string): string | null;
}

export class Expectations {
  /**
   * The direction the player last asked to walk.
   *
   * Movement from a known room is the strongest resolution signal there is —
   * the realm data already says where that exit leads — so it is worth
   * remembering what was typed.
   */
  private pending: Claim[] = [];
  /** Whether the player asked to leave the realm and nothing has cancelled it. */
  private leaving = false;
  /** Where the last `sys go` said it was going, until a room answers it. */
  private teleport: { map: number; number: number } | null = null;
  /** The walker's word that a command is a scripted teleport. See `hintTeleport`. */
  private hintedTeleport: { command: string; map: number; number: number } | null = null;
  /**
   * What the player last asked to look at, if it was not a direction.
   *
   * The wound sentence names nothing — `He appears to be severely wounded.` —
   * so the only thing that says *what* is wounded is the command it answers.
   * A queue for the same reason the room expectations are one: looks can be
   * sent faster than the server answers them, and matching the *last* one asked
   * against the *first* answer to arrive is the bug that made a run of moves
   * resolve every room against the wrong exit. Each wound line consumes one.
   */
  private looking: string[] = [];
  /**
   * The last command this client sent that *might* have been a way through the
   * realm nobody wrote down.
   *
   * `go crimson portal`, `enter manhole`, `jump cliff` — text exits, which are
   * room data rather than commands, which is why there is no `Go` and no
   * `Enter` in the server's own command table. That absence is the test:
   * `movementEffect` says `unknown` for exactly the words the table does not
   * have, and only those reach this slot.
   *
   * It used to be *every* command the tracker did not model as movement, which
   * is a much wider net than it sounds. `l` reprints the room you are standing
   * in, so a look after a walk taught the client that `l` leads from a room to
   * itself; `sys go 5 1` teleports by room number, so it taught a route no
   * player without the command could walk. Both went into a permanent
   * per-character file. See `shared/commands.ts`.
   *
   * They are deliberately **not** queued as expectations: the expectation queue
   * is consumed by arriving rooms, and putting `st` in it would make the next
   * room block the answer to a stat sheet.
   *
   * One slot, cleared by the room block that consumes it, so a discovery is
   * only ever attributed to a command that was the last thing said before it.
   * Two commands and an arriving room is an attribution nobody can make.
   */
  private unmodelled: string | null = null;
  /** A command the walker announced as a move, with the edge's direction. */
  private hinted: { command: string; direction: Direction } | null = null;
  /**
   * What the last command named, whatever the command was, in `mobKey` form.
   *
   * One slot, and read by exactly one thing: `Your command had no effect.`
   * The server says that when the thing a command was aimed at is not there,
   * and the sentence names nothing at all — so the command is the only record
   * of what it was about. See the tracker's `command-no-effect` case, which
   * reads it as `aimed`.
   */
  private aimedAt: string | null = null;

  /**
   * The walker is about to send `command`, and knows it is a move.
   *
   * `Text:` exits are commands (`go manhole`), and the command table cannot
   * model them as movement — `go` is not in `Commands.cs`, which is exactly
   * why they are text exits. Left unmodelled, the room they lead to falls back
   * to name matching, and the rooms text exits lead to are the ones a name
   * cannot settle: the sewers are 293 rooms called Sewer Tunnel, by design.
   * The walker planned the step off a realm edge, so it knows the direction;
   * this writes that knowledge down for the send that is about to happen.
   *
   * One slot, matched on the exact text. Not cleared on a non-matching
   * command — the queue may hold the step behind a half-typed line, and the
   * player's own commands must not eat the hint — but replaced by the next
   * hint, superseded by any modelled move, and dropped on leaving the realm.
   */
  hintMove(command: string, direction: Direction): void {
    this.hinted = { command: command.trim().toLowerCase(), direction };
  }

  /**
   * The walker's word that a command is a scripted teleport to exact
   * coordinates — `dive pool`, `go vortex`, a portal step on a route.
   *
   * One slot, matched on the exact text, exactly as `hintMove` is — and a
   * separate slot rather than a widened one, because what the match *does* is
   * different in both halves: the sent command queues a move with **no
   * direction** (a fabricated one would be resolved against an exit that does
   * not exist) and arms the same teleport slot a `sys go` arms, so the room
   * that arrives resolves by the coordinates the script states.
   */
  hintTeleport(command: string, map: number, number: number): void {
    this.hintedTeleport = { command: command.trim().toLowerCase(), map, number };
  }

  /**
   * Records an outbound command, so a room arriving next can be located.
   *
   * A *queue*, not a slot. Directions can be sent faster than the server
   * answers them — a walk enqueues them, and a player can simply type `n n n` —
   * and some of them fail: a direction into a wall leaves the character exactly
   * where it was. With one slot the last direction typed was matched against
   * the first room to arrive, so a run of moves quietly resolved every room
   * against the wrong exit. This is the model `user.coffee` uses: commands are
   * held until something arrives that could be their answer, and a failure
   * consumes its own command without moving anybody.
   *
   * **Returns whether this command was queued as a move**, which is a fact
   * only this function is in a position to state: it knows the command table,
   * the walker's hint and the room's own text exits, and the three of them are
   * what separate `n` and `go manhole` from `st`. `SessionManager` reads it to
   * tell whether the player has taken the wheel — see its `playerMove`.
   */
  observeCommand(command: string, context: CommandContext): boolean {
    const trimmed = command.trim();
    const space = trimmed.indexOf(' ');
    this.aimedAt = space < 0 ? null : mobKey(trimmed.slice(space + 1));

    // `break` cancels a pending exit as surely as it ends a fight.
    if (commandOf(trimmed) === 'Break') this.leaving = false;

    const looked = lookTarget(command);
    if (looked !== null) {
      // Bound to the room as it is *now*. See `occupantNamed`.
      this.looking.push(mobKey(context.occupantNamed(looked) ?? looked));
      if (this.looking.length > tuning().parse.maxPendingMoves) this.looking.shift();
    }

    const expectation = expect(command);
    /*
     * **Nothing is queued outside the realm**, which is `noteReread`'s rule
     * applied to the other two kinds and for the identical reason: a menu
     * answers what it is sent with a menu, never with a room.
     *
     * The realm this client ships pointed at makes that concrete. Paradigm's
     * way in is `[E] . Enter the Realm`, and the login script for every
     * character on it sends `E` — a direction word. Measured in
     * `2026-09-02_23-03-32_festus`: the `E` at the `[PARADIGM]:` prompt queued
     * a move that nothing answered until the realm-entry room block ate it
     * **49 seconds later**, and for the whole of that time `pendingMoves` was
     * 1 — which stands auto-combat down, refuses `Walker.start` and holds a
     * loop's next leg. Every login on this realm paid it.
     *
     * The entry room block then arrives with an empty queue, which is the
     * honest state: walking into the realm is not a step out of anywhere.
     *
     * **At a menu, not merely "not in the realm."** `inGame` is false until the
     * first status line, and that includes `unknown` — a fresh socket, a
     * reconnect, a session the client joined mid-stream — where a typed
     * direction is far more likely to be a real move than a menu answer.
     * `atMenu` is the phase the wire actually stated: a menu prompt was read,
     * so what is on the other end is a menu.
     */
    if (expectation && context.atMenu) return false;
    if (!expectation) {
      const jump = this.hintedTeleport;
      if (jump && jump.command === command.trim().toLowerCase()) {
        /*
         * The walker said this exact command teleports, and to where. Queued
         * as a move with no direction — it moves the character, so the walk
         * and loop desynchronisation guards must count it — and the teleport
         * slot is armed so the arriving room resolves by the coordinates the
         * script states rather than by an exit that does not exist.
         */
        this.hintedTeleport = null;
        this.teleport = { map: jump.map, number: jump.number };
        this.looking = [];
        this.unmodelled = null;
        this.push({ kind: 'move', direction: null, command: jump.command });
        return true;
      }
      const hint = this.hinted;
      if (hint && hint.command === command.trim().toLowerCase()) {
        // The walker said this exact command is a move. Same push as a typed
        // direction, so the resolver gets its strongest signal — which in a
        // corridor of namesakes is the only signal there is.
        this.hinted = null;
        this.pushMove(hint.direction, hint.command);
        return true;
      }
      const derived = context.typedExit(command);
      if (derived !== null) {
        this.hinted = null;
        this.pushMove(derived, command);
        return true;
      }

      const effect = movementEffect(command);
      if (effect === 'teleports') {
        this.unmodelled = null;
        this.pending = [];
        this.looking = [];
        const target = /^sys\s+go(?:to)?\s+(\d{1,3})\s+(\d{1,6})\b/i.exec(command.trim());
        this.teleport = target ? { map: Number(target[1]), number: Number(target[2]) } : null;
        /*
         * A teleport moves the character further than any step, but it is not
         * a *step*: nothing in the realm data connects here to there, so a
         * walk or a loop has nothing to be desynchronised by and the caller
         * has nothing to hand back. Reported as not-a-move for that reason,
         * and the room that arrives replans anything still running.
         */
        return false;
      }
      const worth = context.inGame && effect === 'unknown';
      const text = worth ? command.trim() : '';
      this.unmodelled = text.length > 0 ? text : null;
      return false;
    }
    // Walking away invalidates every unanswered look: the wound line that
    // arrives next describes something in a room this character has left.
    if (expectation.kind === 'move') {
      this.looking = [];
      // A typed direction supersedes a hint — either kind: whatever the
      // walker was about to send, the next room answers this.
      this.hinted = null;
      this.hintedTeleport = null;
    }
    // A modelled command supersedes it: whatever was typed before, this is what
    // the next room is the answer to.
    this.unmodelled = null;
    /*
     * A re-read outside the realm is answered by a menu, not by a room, so
     * nothing is waiting on one. 449 of the 3,227 bare Enters in the recorded
     * sessions are these — character creation, the login prompt, a socket that
     * had already died — and a claim on a room block that is never coming is
     * the one way this queue can be made worse than not keeping it.
     */
    if (expectation.kind === 'reread' && !context.inGame) return false;
    this.push(expectation);
    return expectation.kind === 'move';
  }

  /**
   * A bare Enter went out, which prints the room the character is standing in.
   *
   * **A door of its own, because an empty line must not go through
   * `observeCommand`.** That function reads the *command* — it clears `aimedAt`
   * and `unmodelled`, and its callers in `SessionManager` clear the
   * classifier's `lastCommand` alongside — and an empty line is not a command:
   * the server keeps nothing of it, so filing one would throw away the slots
   * that interpret the command *before* it. `aimedAt` is the one
   * `Your command had no effect.` reads, so wiping it on the walker's nudge
   * would break the other half of this same fix.
   *
   * So `SessionManager`'s `command.length > 0` gate stays exactly as it was and
   * this is called beside it. It touches one field. Everything that re-reads a
   * room on the client's own behalf sends `REREAD_ROOM` — the walker's nudge,
   * auto-combat's refresh and its unplaceable-arrival read, the idle
   * keep-alive — and every one of them produces a room block the client would
   * otherwise attribute to somebody else's move. That was the whole failure,
   * and routing the nudge through `observeCommand` would have fixed it by
   * breaking two other things.
   *
   * They are one class **here** and not everywhere: the block answering a
   * re-read still spends an armed teleport promise (`takeTeleport`, which any
   * named room block takes before anything decides whose it is), and only
   * `Walker.nudge` refuses to send behind a portal for that reason. Unchanged
   * by this — an unattributed reprint spent it before too — and narrow, since
   * the other three senders need a fight, an unplaceable arrival or 45s of
   * silence to fire at all.
   *
   * Not queued outside the realm: a menu answers an Enter with a menu.
   */
  noteReread(inGame: boolean): void {
    if (!inGame) return;
    this.push({ kind: 'reread', command: '' });
  }

  /**
   * A move this character did not type — the walker's hinted step, a typed
   * text exit the realm data knows, ` -- Following your Party leader north --`.
   * The same push as a typed direction, so the resolver gets the same signal.
   */
  pushMove(direction: Direction, command: string | null = null): void {
    this.looking = [];
    this.unmodelled = null;
    this.push({ kind: 'move', direction, command: command?.trim().toLowerCase() ?? null });
  }

  /** Stamped here, so no caller can queue a claim with no clock on it. */
  private push(expectation: Expectation): void {
    this.pending.push({ ...expectation, at: Date.now() });
    // A queue this deep means the client has already lost track; keeping more
    // would only make it wrong for longer.
    if (this.pending.length > tuning().parse.maxPendingMoves) this.pending.shift();
  }

  /** How many commands are still waiting on a room. */
  get count(): number {
    return this.pending.length;
  }

  /** How many of them would move the character. */
  get moves(): number {
    return this.pending.filter((expectation) => expectation.kind === 'move').length;
  }

  /**
   * Gives up on claims nothing has answered, and says which.
   *
   * **The bound belongs here, where the claim is made**, because six things
   * read `pendingMoves` — the escape, `Walker.start`, `LoopRunner.advance`,
   * the walk home and auto-combat — and until 2026-09-03 exactly one of them
   * had a clock. A sentence this parser cannot read answering a move therefore
   * let auto-combat recover after eight seconds and left the character unable
   * to run away, walk a route or run a loop **for the rest of the session**,
   * silently. That has already shipped twice from two different sentences (the
   * toll refusal, and `You are blind.` answering a move) and the file's own
   * note says the third has not been written yet — so the answer is a bound on
   * the fact rather than another bound on one reader of it.
   *
   * **Pruned from the front while stale, not dropped wholesale.** The queue is
   * in the order the commands were sent and the server answers in order, so a
   * stale head says nothing about a move queued behind it one second ago —
   * whose room may well be in the next packet. Dropping that one too would
   * turn one lost step into two.
   *
   * Returns what was given up on so the client can say it out loud once. A
   * move nobody typed contributes an empty command; the caller decides how to
   * word that.
   *
   * **`moved` is on it because only a move held anything.** `pendingMoves`
   * counts moves alone, so a lapsed peek or re-read gated neither the escape,
   * nor `Walker.start`, nor a loop's next leg — and the notice said it had. A
   * bare Enter goes unanswered about once in three thousand, so that sentence
   * was false roughly once a session.
   */
  expire(now: number): LapsedClaim[] {
    const life = tuning().parse.staleMoveMs;
    const dropped: LapsedClaim[] = [];
    while (this.pending[0] !== undefined && now - this.pending[0].at >= life) {
      const claim = this.pending[0];
      dropped.push({ command: claim.command ?? '', moved: claim.kind === 'move' });
      this.pending.shift();
    }
    return dropped;
  }

  /** The command the next room block answers, left in place. */
  head(): Expectation | null {
    return this.pending[0] ?? null;
  }

  /** The command a room block, or a refused direction, has just answered. */
  shift(): Expectation | null {
    return this.pending.shift() ?? null;
  }

  /**
   * The command a *refusal* has just answered — `There is no exit in that
   * direction!`, `The door is closed!`.
   *
   * A bare Enter cannot be refused, so a re-read still queued ahead of the
   * command that was is one whose room block never arrived: the server answers
   * in order, so anything queued behind it would still be waiting. That
   * happened once in 2,778 in-game re-reads across the recorded sessions — an
   * eight-second stall — and dropping the stale claim here is what keeps the
   * one occurrence from taking a real move's answer with it.
   */
  shiftRefused(): Expectation | null {
    let ahead = 0;
    while (this.pending[ahead]?.kind === 'reread') ahead += 1;
    /*
     * Nothing behind them, so this refusal answered a command that queued
     * nothing — a barrier `open n`, a `bas n` on a wall. Taking a re-read for
     * one of those would take a room block that is still coming, which is the
     * same reasoning `refused()` makes by matching on the text; this sentence
     * names no command, so counting is all it can do.
     */
    if (this.pending[ahead] === undefined) return null;
    this.pending.splice(0, ahead);
    return this.pending.shift() ?? null;
  }

  /**
   * The server refused a command outright — `You say "<it>"`, which is what
   * this server does with a word it does not have. Returns whether that
   * answered something queued.
   *
   * Matched on the text rather than consumed blindly, because most refused
   * commands queued nothing at all: `exits`, `time`, `stats` and `gold` are
   * all said out loud, and shifting the queue for one of those would take the
   * move a room is still coming for. The refusal answers the **head** because
   * the server runs what it is sent in order — the same reason
   * `direction-failed` consumes the head — so a command sent twice has its
   * first answered by whatever it did and its second by this.
   *
   * Also clears the unmodelled slot when it is the same command: a way through
   * the realm the server would not run is not a way through the realm, and
   * writing it into a character's permanent file is the confidently wrong
   * record `shared/commands.ts` exists to prevent.
   */
  refused(command: string): boolean {
    const text = command.trim().toLowerCase();
    if (text.length === 0) return false;
    if (this.unmodelled !== null && this.unmodelled.trim().toLowerCase() === text) {
      this.unmodelled = null;
    }
    if (this.hinted?.command === text) this.hinted = null;
    if (this.hintedTeleport?.command === text) this.hintedTeleport = null;
    /*
     * A re-read cannot be refused, so one queued ahead of the command this
     * names is one whose room block never arrived — the same reading
     * `shiftRefused` makes, and it has to be made here too or the refusal
     * stops matching and the move behind it stays queued for a room that is
     * not coming. That is the one position this client has ever lost
     * (`Expectation.command`, above), re-opened through the new kind.
     *
     * Counted rather than dropped first: most refused commands queued nothing
     * at all — `exits`, `time`, `gold` — and shifting for one of those would
     * take a re-read whose room *is* still coming.
     */
    let ahead = 0;
    while (this.pending[ahead]?.kind === 'reread') ahead += 1;
    if (this.pending[ahead]?.command !== text) return false;
    this.pending.splice(0, ahead);
    const head = this.pending.shift();
    // A refused teleport command must disarm the coordinates it promised, or
    // the *next* named room would be resolved to somewhere nobody went.
    if (head?.kind === 'move' && head.direction === null) this.teleport = null;
    return true;
  }

  /** The monster the next wound sentence describes, if a look asked. */
  shiftLook(): string | undefined {
    return this.looking.shift();
  }

  /** Every unanswered look is about a room, or a fight, that is over. */
  clearLooks(): void {
    this.looking = [];
  }

  /**
   * The command that may have been an unwritten way through the realm, and
   * only when the room that just arrived can be its answer: nothing else was
   * queued ahead of it. Cleared either way — one slot, one room.
   */
  takeUnmodelled(answerable: boolean): string | null {
    const text = answerable && this.pending.length === 0 ? this.unmodelled : null;
    this.unmodelled = null;
    return text;
  }

  /** Where a `sys go` said it was going, consumed by the room that answers it. */
  takeTeleport(): { map: number; number: number } | null {
    const said = this.teleport;
    this.teleport = null;
    return said;
  }

  /** What the last command named, in `mobKey` form. */
  get aimed(): string | null {
    return this.aimedAt;
  }

  /** `You are about to leave the realm`: a menu prompt arriving next is the exit. */
  askedToLeave(): void {
    this.leaving = true;
  }

  /**
   * A menu prompt arrived in the realm. True only when leaving was asked for,
   * in which case the queue and the looks go with the realm — they were about
   * rooms the character will not see answered.
   */
  leftForMenu(): boolean {
    if (!this.leaving) return false;
    this.leaving = false;
    this.pending = [];
    this.looking = [];
    return true;
  }

  /**
   * The character died, so the next room is the temple and no command led there.
   *
   * A death is a **teleport with no destination in it**. The realm moves the
   * character to wherever it keeps the dead, and every unanswered expectation
   * in the queue is now about a room that will never arrive — the move that was
   * being walked, the look that was asked, the text exit the last command might
   * have been. Left standing, the temple's room block consumes the head of that
   * queue and is resolved against it.
   *
   * That is not hypothetical. It wrote `Learned: "nw" leads from Darkwood
   * Forest to Temple, Halls of the Dead` into a permanent per-character file —
   * a way through the realm that does not exist, offered to every future route
   * — and the walk then stopped saying only that it had ended up somewhere the
   * route did not expect.
   *
   * The same clearing as `forget`, minus the two slots a death does not touch:
   * `leaving` is a request the player made and dying does not withdraw it, and
   * `aimedAt` is read only by `Your command had no effect.`, which cannot
   * follow a death.
   */
  died(): void {
    this.pending = [];
    this.teleport = null;
    this.looking = [];
    this.unmodelled = null;
    this.hinted = null;
    this.hintedTeleport = null;
  }

  /** A closed socket: whatever the walker was about to send, it will not. */
  dropHint(): void {
    this.hinted = null;
    this.hintedTeleport = null;
  }

  /** A new session, or the realm left: nothing sent is still waiting on anything. */
  forget(): void {
    this.pending = [];
    this.leaving = false;
    this.teleport = null;
    this.looking = [];
    this.unmodelled = null;
    this.hinted = null;
    this.hintedTeleport = null;
    this.aimedAt = null;
  }
}
