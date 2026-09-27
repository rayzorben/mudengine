/**
 * Whether this character is moving unseen: the move's `Sneaking...` receipt,
 * and the sentences and sends that settle the published `stealth`.
 *
 * Out of `CharacterTracker` (todo 724; `mudengine-wire` › `parts/tracker.md`).
 * Its memory, the receipt (and a follower's relayed one), is written by the
 * sneak, the follow, the breaks and the send path and spent by the room
 * (`RoomSources.stealthAfterMove`); `Expectations` never reads it. Why the
 * wire is read this way round:
 * `mudengine-wire` › *Stealth is read off the command that breaks it*; its
 * readers: `mudengine-automation` › `parts/combat.md` (the opener) and
 * `parts/walking.md` › *The sneak is asked immediately before the step*.
 */
import { tuning } from '../app/tuning';
import type { CharacterState, Stealth } from '../../shared/character';
import { breaksStealth, type CommandName } from '../../shared/commands';

/**
 * Seen, leaving the move's receipt as it was: what the failure cases that
 * answer a request write (`user-sneak-failed`, `user-cant-sneak`,
 * `user-hide-failed`, `user-cant-hide`). A sentence about the move itself
 * (`You make a sound as you enter the room!`) spends it through `broke`.
 */
export function seen(s: CharacterState): CharacterState | null {
  return s.stealth === 'seen' ? null : { ...s, stealth: 'seen' };
}

/**
 * `hide` or `sn` going out. The character was seen and may not be now; the
 * receipts settle the failures (`user-hide-failed`, `user-sneak-failed`)
 * and a move's `Sneaking...` settles the success, so until one arrives the
 * honest word is `unknown` — which never holds the opener, the direction
 * the reviewer of 2026-09-12 chose: assume the shadows until told otherwise,
 * at the price of one downgraded swing when wrong.
 */
function attempted(s: CharacterState): CharacterState {
  return s.stealth !== 'seen' ? s : { ...s, stealth: 'unknown' };
}

export class StealthReceipt {
  /**
   * Whether `Sneaking...` has been printed since the last move was committed.
   *
   * `MoveCommand.PreExecute` prints it when a move is accepted and the
   * character is sneaking (`goodToGo && Sneaking`, `MoveCommand.cs:81-84`),
   * **before** the stealth roll in `Exits.cs:141-160`. So it proves stealth
   * was on when the move started, not that it held: a failed roll that nobody
   * perceived prints it and then the room, like a sneak that worked. The one
   * word for a failed roll is `You make a sound as you enter the room!`, sent
   * only when someone's perception succeeds (`Player.cs:708`), which `broke`
   * reads. Taking the receipt at its word otherwise is the user's decision
   * (todo 758, 2026-09-26): `mudengine-wire` › `parts/tracker.md`.
   *
   * A move without the line is the server saying this character was visible,
   * which is what `afterMove` reads, and why `Walker.sneakFirst` sends `sn`
   * again. `Player.BreakStealth()` has about thirty callers and prints
   * nothing; `You are no longer sneaking.` is the `break` command's alone.
   *
   * The `sn` reply cannot serve instead: `SneakCommand` prints `Attempting to
   * sneak...` on success and on the failure whose perception roll also fails.
   */
  private sneakedThisMove = false;

  /**
   * A `Sneaking...` sent while no move of this character's was in flight: the
   * leader's move, relayed to a sneaking follower (`MoveCommand.cs:86-95`).
   * The server relays it without asking `goodToGo`, so a leader who walks into
   * a wall or is too heavy to move leaves one behind for a move that never
   * happened. It becomes the receipt only when `-- Following your Party
   * leader <dir> --` says the follower was walked (`followed`), within
   * `tuning.parse.staleMoveMs`: a leader's later move relays nothing to a
   * follower who stopped sneaking in between, so an old relay must not stand
   * in for it. When it was printed, or null.
   */
  private relayedAt: number | null = null;

  /**
   * `Sneaking...`. The server sends it only to a character that is sneaking,
   * so it is the fact at once; whether it is also the receipt for a move
   * depends on whose move it was (`ownMove`: a command of this character's
   * may be moving it, `Expectations.mayBeMoving`).
   */
  sneaked(s: CharacterState, ownMove: boolean, at: number): CharacterState | null {
    if (ownMove) this.sneakedThisMove = true;
    this.relayedAt = ownMove ? null : at;
    return s.stealth === 'sneaking' ? null : { ...s, stealth: 'sneaking' };
  }

  /** The leader's move walked this follower too, so a fresh relayed line is the receipt. */
  followed(at: number): void {
    const relayedAt = this.relayedAt;
    this.relayedAt = null;
    if (relayedAt !== null && at - relayedAt < tuning().parse.staleMoveMs) {
      this.sneakedThisMove = true;
    }
  }

  /**
   * A move landed. Say whether this character is still unseen, and forget.
   *
   * Called from the two places a move is committed — the described arrival and
   * the dark one (`room.ts`) — for the reason the trail (`trail.ts`) is recorded
   * there: a walker step, a typed direction and a party follow all reach them
   * the same way. Unlike the trail, this refuses **nothing**: an unplaced room,
   * an ambiguous one and a teleport are all moves, and stealth breaks on a move
   * whether or not the client could work out where it landed.
   *
   * `seen` rather than `unknown` when the line did not come, because it is not
   * an absence of evidence: the server prints it on every sneaking move, so a
   * move without it is the server saying this character was visible. That is
   * also the direction this project's rule about unknown points — the
   * reassuring answer is the dangerous one, and here the reassuring answer is
   * `sneaking`.
   */
  afterMove(): Stealth {
    const settled: Stealth = this.sneakedThisMove ? 'sneaking' : 'seen';
    this.forget();
    return settled;
  }

  /**
   * A sentence the server prints beside `BreakStealth()`. The character is
   * visible from now on, and the move's receipt is spent with it.
   *
   * The receipt goes too for `direction-failed`'s reason: a `Sneaking...`
   * printed before the door was picked belongs to the move the door refused,
   * and left standing it would be spent on the move after it.
   */
  broke(s: CharacterState): CharacterState | null {
    this.forget();
    return seen(s);
  }

  /**
   * The realm is left — a reset, a closed socket, the menu — and a receipt
   * printed before it belongs to a move that will never land (todo 750).
   */
  forget(): void {
    this.sneakedThisMove = false;
    this.relayedAt = null;
  }

  /**
   * A command going out, and what it costs in stealth before it goes.
   *
   * The server breaks stealth for a dozen ordinary commands and announces
   * none of them (`breaksStealth`), so the only evidence left is the
   * *absence* of `Sneaking...` on the next move — which arrives after that
   * move has been taken. Reported 2026-09-11: a character sneaked, backstabbed
   * what was in the room, then walked into the next one in plain sight and
   * opened with `a` rather than `bs`, because `stealth` still said `sneaking`
   * from the receipt two moves back.
   *
   * The command, not the answer, for the reason the door is read from its
   * sentence and this is not: there is no sentence. A move the server
   * announces sets it straight again on arrival, so this can only ever be
   * early, never wrong in the reassuring direction.
   *
   * Then the two that ask for it back (`attempted`). Neither receipt is
   * trusted, so the send is the only moment the answer can be marked as *not
   * yet known* — which is where `AutoCombat.opener` spends the backstab, and
   * where a hidden character was read as `seen` until 2026-09-12: 34 `hide`s
   * in twelve minutes, every fight after them opened with `a`.
   *
   * Committed by the caller rather than returned from a block, because the
   * send path answers no block. Nothing is pushed from there: the prompt that
   * answers the command is a block, and it is microseconds behind. What reads
   * this in between is `Walker.sneakFirst`, through `tracker.current`, which
   * is the whole point.
   */
  sent(s: CharacterState, command: string, named: CommandName | null): CharacterState {
    if (s.phase !== 'in-game') return s;
    const broken = breaksStealth(command) ? (this.broke(s) ?? s) : s;
    return named === 'Hide' || named === 'Sneak' ? attempted(broken) : broken;
  }
}
