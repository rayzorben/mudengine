import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState, type Stealth } from '../../../shared/character';
import { blockOf } from '../../../shared/__tests__/blocks';
import { CharacterTracker } from '../CharacterTracker';
import { tuning } from '../../app/tuning';
import { seen, StealthReceipt } from '../stealth';

/*
 * The order the stealth receipt is spent in, and what does not spend it (todo
 * 700: *order is a decision*). The tracker's tests feed whole lines and read
 * the published `stealth`, which moves the same way whichever side of the
 * spending an early return sits on; and the 107 replayed sessions hold one
 * `Sneaking...`, with no reset or leave pending behind it. So these drive the
 * receipt directly, and hand the lifecycle to a real tracker.
 */

const T = 1_700_000_000_000;

/** In the realm, as stealthy as `stealth` says. */
function standing(stealth: Stealth): CharacterState {
  return { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game', stealth };
}

/** A receipt the move it precedes has not yet spent. */
function printed(): StealthReceipt {
  const receipt = new StealthReceipt();
  receipt.sneaked(standing('unknown'), true, T);
  return receipt;
}

describe('the order the receipt is spent in', () => {
  it('is read before it is spent, once per move', () => {
    const receipt = printed();
    expect(receipt.afterMove()).toBe('sneaking');
    expect(receipt.afterMove()).toBe('seen');
  });

  it('is spent by a break even when the character was already seen', () => {
    const receipt = printed();
    expect(receipt.broke(standing('seen'))).toBeNull();
    expect(receipt.afterMove()).toBe('seen');
  });

  it('is spent by a send that breaks stealth, and says seen at once', () => {
    const receipt = printed();
    const s = receipt.sent(standing('sneaking'), 'rest', 'Rest');
    expect(s.stealth).toBe('seen');
    expect(receipt.afterMove()).toBe('seen');
  });

  it('is kept through a send that breaks nothing, and through a failed receipt', () => {
    const receipt = printed();
    const s = standing('sneaking');
    expect(receipt.sent(s, 'l', 'Look')).toBe(s);
    expect(seen(s)?.stealth).toBe('seen');
    expect(receipt.afterMove()).toBe('sneaking');
  });

  it('is kept through a send before the realm, which changes nothing', () => {
    const receipt = printed();
    const s = { ...standing('sneaking'), phase: 'authenticating' as const };
    expect(receipt.sent(s, 'rest', 'Rest')).toBe(s);
    expect(receipt.afterMove()).toBe('sneaking');
  });

  it('is a receipt when relayed only once the follow is announced, and soon', () => {
    const relayed = new StealthReceipt();
    expect(relayed.sneaked(standing('unknown'), false, T)?.stealth).toBe('sneaking');
    expect(relayed.afterMove()).toBe('seen');

    const followed = new StealthReceipt();
    followed.sneaked(standing('unknown'), false, T);
    followed.followed(T + 1);
    expect(followed.afterMove()).toBe('sneaking');
    expect(followed.afterMove()).toBe('seen');

    // A relay left by a leader at a wall, and a follow long after it.
    const stale = new StealthReceipt();
    stale.sneaked(standing('unknown'), false, T);
    stale.followed(T + tuning().parse.staleMoveMs);
    expect(stale.afterMove()).toBe('seen');

    const none = new StealthReceipt();
    none.followed(T);
    expect(none.afterMove()).toBe('seen');
  });

  it('drops a relay with the receipt: a break, a leave, a move', () => {
    for (const spend of [
      (receipt: StealthReceipt): void => void receipt.broke(standing('sneaking')),
      (receipt: StealthReceipt): void => receipt.forget(),
      (receipt: StealthReceipt): void => void receipt.afterMove()
    ]) {
      const receipt = new StealthReceipt();
      receipt.sneaked(standing('unknown'), false, T);
      spend(receipt);
      receipt.followed(T + 1);
      expect(receipt.afterMove()).toBe('seen');
    }
  });

  it('asks for the shadows back only from seen, after any break the send made', () => {
    const receipt = new StealthReceipt();
    expect(receipt.sent(standing('seen'), 'sn', 'Sneak').stealth).toBe('unknown');
    expect(receipt.sent(standing('seen'), 'hide', 'Hide').stealth).toBe('unknown');
    const sneaking = standing('sneaking');
    expect(receipt.sent(sneaking, 'sn', 'Sneak')).toBe(sneaking);
  });
});

describe('what a tracker does with the receipt', () => {
  /** On the shore, with a way east. */
  const ashore = (): CharacterTracker => {
    const tracker = new CharacterTracker();
    tracker.reset();
    tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T));
    tracker.apply(blockOf('room-name', 'Shore', { name: 'Shore' }, T + 1));
    tracker.apply(blockOf('room-exits', 'Obvious exits: east', { exits: 'east' }, T + 2));
    return tracker;
  };
  /** East Beach arriving: what the move left the character as. */
  const arrive = (tracker: CharacterTracker, at: number): Stealth => {
    tracker.apply(blockOf('room-name', 'East Beach', { name: 'East Beach' }, at));
    tracker.apply(blockOf('room-exits', 'Obvious exits: west', { exits: 'west' }, at + 1));
    return tracker.current.stealth;
  };
  /** A step east, answered by its room, with no `Sneaking...` before it. */
  const step = (tracker: CharacterTracker, at: number): Stealth => {
    tracker.observeCommand('e');
    return arrive(tracker, at);
  };
  /** Sneaking east: `e` sent and `Sneaking...` printed, its room still to come. */
  const sneaking = (): CharacterTracker => {
    const tracker = ashore();
    tracker.observeCommand('e');
    tracker.apply(blockOf('user-sneaking', 'Sneaking...', {}, T + 3));
    return tracker;
  };

  it('spends it on the move it was printed for', () => {
    const tracker = sneaking();
    expect(tracker.current.stealth).toBe('sneaking');
    expect(arrive(tracker, T + 10)).toBe('sneaking');
    expect(step(tracker, T + 20)).toBe('seen');
  });

  /*
   * A leader's move relays `Sneaking...` to each sneaking follower before the
   * server knows the move will go (`MoveCommand.cs:86-95`). Walked, the
   * follower reads `-- Following your Party leader <dir> --` and the room; the
   * leader at a wall or too heavy, nothing follows it (todo 758).
   */
  it('spends a relayed one only on the follow it announces', () => {
    const followed = ashore();
    followed.apply(blockOf('user-sneaking', 'Sneaking...', {}, T + 3));
    expect(followed.current.stealth).toBe('sneaking');
    const follows = '-- Following your Party leader east --';
    followed.apply(blockOf('party-follows', follows, { direction: 'east' }, T + 4));
    expect(arrive(followed, T + 10)).toBe('sneaking');

    // A text exit no realm data names is still this character's own move.
    const ownWay = ashore();
    ownWay.observeCommand('go manhole');
    ownWay.apply(blockOf('user-sneaking', 'Sneaking...', {}, T + 3));
    expect(arrive(ownWay, T + 10)).toBe('sneaking');

    const leftBehind = ashore();
    leftBehind.apply(blockOf('user-sneaking', 'Sneaking...', {}, T + 3));
    expect(leftBehind.current.stealth).toBe('sneaking');
    expect(step(leftBehind, T + 10)).toBe('seen');
  });

  /*
   * A receipt printed before a reset, a closed socket or the menu is forgotten
   * with the realm (todo 750). Reachable: `MoveCommand` prints `Sneaking...`
   * before the move's pre-delay and the room after it (246ms apart on
   * orohost, 2026-08-26), so a link lost in between left it for the next
   * session's first move to read as `sneaking`.
   */
  it('is forgotten by a reset, a closed socket and the menu', () => {
    for (const leave of [
      (tracker: CharacterTracker): void => tracker.reset(),
      (tracker: CharacterTracker): void => void tracker.leaveRealm(T + 5),
      (tracker: CharacterTracker): void =>
        void tracker.apply(blockOf('prompt-character', 'Please select a character:', {}, T + 5))
    ]) {
      const tracker = sneaking();
      leave(tracker);
      tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T + 6));
      tracker.apply(blockOf('room-name', 'Shore', { name: 'Shore' }, T + 7));
      tracker.apply(blockOf('room-exits', 'Obvious exits: east', { exits: 'east' }, T + 8));
      expect(tracker.current.stealth).toBe('seen');
      expect(step(tracker, T + 10)).toBe('seen');
    }
  });

  /*
   * `sn`'s own failure answers the request, not a move: it says seen and
   * leaves the receipt (`seen`), so a room committed after it still reads the
   * `Sneaking...` printed before it.
   */
  it('is not spent by a failed receipt, which answers a request rather than a move', () => {
    const tracker = sneaking();
    const failed = "Attempting to sneak...You don't think you're sneaking.";
    tracker.apply(blockOf('user-sneak-failed', failed, {}, T + 5));
    expect(tracker.current.stealth).toBe('seen');
    expect(arrive(tracker, T + 10)).toBe('sneaking');
  });

  /*
   * Heard on the way in: the move's own sentence breaks stealth, and the room
   * after it must not read the receipt printed before it (todo 750). Wire
   * order `Sneaking...`, `You make a sound as you enter the room!`, the room
   * (`Exits.cs:150-160`, `Player.cs:705-712`; `captures/013`:72-75).
   */
  it('is spent by a sound made entering, so the room reads seen', () => {
    const tracker = sneaking();
    tracker.apply(
      blockOf('user-not-sneaking', 'You make a sound as you enter the room!', {}, T + 5)
    );
    expect(tracker.current.stealth).toBe('seen');
    expect(arrive(tracker, T + 10)).toBe('seen');
  });

  it('is spent by a refused step, so the next move is read on its own', () => {
    const tracker = sneaking();
    tracker.apply(blockOf('direction-failed', 'There is no exit in that direction!', {}, T + 5));
    expect(tracker.current.stealth).toBe('seen');
    expect(step(tracker, T + 10)).toBe('seen');
  });
});
