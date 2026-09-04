import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INTERNAL } from '../../../shared/internal';

import { Expectations, lookTarget, type CommandContext } from '../expectations';

/*
 * The cluster lifted out of `CharacterTracker` on 2026-08-29. The tracker's
 * own tests feed the wire and pin what a room does with the queue; these ask
 * the memory directly — what a command leaves behind, and what consumes it.
 */
/*
 * A room with nothing in it: the look queue then keeps the player's own text,
 * which is what these cases are about. The tests that care about resolution
 * pass their own occupant.
 */
const inGame: CommandContext = {
  inGame: true,
  atMenu: false,
  typedExit: () => null,
  occupantNamed: () => null
};
/** Not in the realm and nothing said which — a fresh socket, or a reconnect. */
const unknownPhase: CommandContext = {
  inGame: false,
  atMenu: false,
  typedExit: () => null,
  occupantNamed: () => null
};
/** Standing at a menu, which the wire said: a menu answers with a menu. */
const atMenu: CommandContext = {
  inGame: false,
  atMenu: true,
  typedExit: () => null,
  occupantNamed: () => null
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the queue of moves', () => {
  it('holds moves and peeks in the order sent, and a room takes one', () => {
    const memory = new Expectations();
    memory.observeCommand('n', inGame);
    memory.observeCommand('look e', inGame);
    memory.observeCommand('sw', inGame);
    expect(memory.count).toBe(3);
    expect(memory.moves).toBe(2);
    expect(memory.head()).toMatchObject({ kind: 'move', direction: 'n', command: 'n' });
    expect(memory.shift()).toMatchObject({ kind: 'move', direction: 'n', command: 'n' });
    expect(memory.shift()).toMatchObject({ kind: 'peek', command: 'look e' });
    expect(memory.shift()).toMatchObject({ kind: 'move', direction: 'sw', command: 'sw' });
    expect(memory.shift()).toBeNull();
  });

  it('stops pretending past twelve unanswered directions', () => {
    const memory = new Expectations();
    for (let i = 0; i < 20; i += 1) memory.observeCommand('n', inGame);
    expect(memory.count).toBe(12);
  });

  it("takes the walker's hint for the exact command, once", () => {
    const memory = new Expectations();
    memory.hintMove('go manhole', 'd');
    memory.observeCommand('st', inGame);
    // An unrelated command does not eat the hint: it may be the step behind a
    // half-typed line.
    expect(memory.count).toBe(0);
    memory.observeCommand('Go Manhole', inGame);
    expect(memory.head()).toMatchObject({ kind: 'move', direction: 'd', command: 'go manhole' });
    memory.shift();
    memory.observeCommand('go manhole', inGame);
    expect(memory.count).toBe(0);
  });

  it('a typed direction supersedes a hint', () => {
    const memory = new Expectations();
    memory.hintMove('go manhole', 'd');
    memory.observeCommand('n', inGame);
    memory.shift();
    memory.observeCommand('go manhole', inGame);
    expect(memory.count).toBe(0);
  });

  it('asks the tracker whether a typed word is a way out, and queues the answer', () => {
    const memory = new Expectations();
    memory.observeCommand('portal', {
      inGame: true,
      atMenu: false,
      typedExit: () => 'u',
      occupantNamed: () => null
    });
    expect(memory.head()).toMatchObject({ kind: 'move', direction: 'u', command: 'portal' });
  });

  it('a refused command takes back the move it queued, and only that one', () => {
    const memory = new Expectations();
    memory.hintMove('go manhole', 'd');
    memory.observeCommand('go manhole', inGame);
    memory.observeCommand('w', inGame);
    expect(memory.moves).toBe(2);

    // A refusal naming something else queued nothing and must take nothing.
    expect(memory.refused('exits')).toBe(false);
    expect(memory.moves).toBe(2);

    expect(memory.refused('go manhole')).toBe(true);
    expect(memory.head()).toMatchObject({ kind: 'move', direction: 'w', command: 'w' });
    expect(memory.moves).toBe(1);
  });

  it('a refusal answers the head, so a command sent twice loses only the second', () => {
    const memory = new Expectations();
    memory.hintMove('go manhole', 'd');
    memory.observeCommand('go manhole', inGame);
    memory.hintMove('go manhole', 'd');
    memory.observeCommand('go manhole', inGame);
    // The first was run and answered by a room; the second was said out loud.
    memory.shift();
    expect(memory.refused('go manhole')).toBe(true);
    expect(memory.count).toBe(0);
  });

  it('a refused command is never learned as a way through the realm', () => {
    const memory = new Expectations();
    memory.observeCommand('jump cliff', inGame);
    expect(memory.refused('jump cliff')).toBe(false);
    expect(memory.takeUnmodelled(true)).toBeNull();
  });
});

describe('the command that might be a text exit', () => {
  it('is remembered only in the realm, and answered only by a room nothing else was waiting for', () => {
    const memory = new Expectations();
    memory.observeCommand('enter manhole', atMenu);
    expect(memory.takeUnmodelled(true)).toBeNull();
    memory.observeCommand('enter manhole', inGame);
    expect(memory.takeUnmodelled(true)).toBe('enter manhole');
    // One slot, one room: taken means gone.
    expect(memory.takeUnmodelled(true)).toBeNull();
  });

  it('is not the answer when a direction is still queued ahead of it', () => {
    const memory = new Expectations();
    memory.observeCommand('enter manhole', inGame);
    memory.observeCommand('n', inGame);
    // The direction superseded it outright.
    expect(memory.takeUnmodelled(true)).toBeNull();
    const again = new Expectations();
    again.observeCommand('n', inGame);
    again.observeCommand('enter manhole', inGame);
    expect(again.count).toBe(1);
    // The room answers the direction, not the text.
    expect(again.takeUnmodelled(true)).toBeNull();
  });

  it('is never a command the table models', () => {
    const memory = new Expectations();
    memory.observeCommand('l', inGame);
    expect(memory.takeUnmodelled(true)).toBeNull();
    memory.observeCommand('sys go 5 1', inGame);
    expect(memory.takeUnmodelled(true)).toBeNull();
  });
});

describe('a teleport', () => {
  it('empties the queue and remembers where it said it was going, once', () => {
    const memory = new Expectations();
    memory.observeCommand('n', inGame);
    memory.observeCommand('sys go 5 1', inGame);
    expect(memory.count).toBe(0);
    expect(memory.takeTeleport()).toEqual({ map: 5, number: 1 });
    expect(memory.takeTeleport()).toBeNull();
  });
});

describe('looks', () => {
  it('binds a wound sentence to the look that asked, in order, and a move clears them', () => {
    const memory = new Expectations();
    memory.observeCommand('look orc rogue', inGame);
    memory.observeCommand('l kobold', inGame);
    expect(memory.shiftLook()).toBe('orc rogue');
    memory.observeCommand('n', inGame);
    expect(memory.shiftLook()).toBeUndefined();
  });

  it('a peek leaves the looks standing; only a move clears them', () => {
    const memory = new Expectations();
    memory.observeCommand('look orc rogue', inGame);
    memory.observeCommand('look n', inGame);
    expect(memory.shiftLook()).toBe('orc rogue');
  });

  it('a look at a direction is a peek, not a look at something', () => {
    expect(lookTarget('look n')).toBeNull();
    expect(lookTarget('look')).toBeNull();
    expect(lookTarget('look The orc rogue')).toBe('orc rogue');
  });
});

describe('what the last command named', () => {
  it('is the argument, keyed like a monster, and nothing for a bare verb', () => {
    const memory = new Expectations();
    memory.observeCommand('a giant rat', inGame);
    expect(memory.aimed).toBe('giant rat');
    memory.observeCommand('l', inGame);
    expect(memory.aimed).toBeNull();
  });
});

describe('leaving the realm', () => {
  it('a menu prompt is the exit only when asked for, and takes the queue with it', () => {
    const memory = new Expectations();
    memory.observeCommand('n', inGame);
    expect(memory.leftForMenu()).toBe(false);
    memory.observeCommand('look orc', inGame);
    memory.askedToLeave();
    expect(memory.leftForMenu()).toBe(true);
    expect(memory.count).toBe(0);
    expect(memory.shiftLook()).toBeUndefined();
    expect(memory.leftForMenu()).toBe(false);
  });

  it('break cancels the exit', () => {
    const memory = new Expectations();
    memory.askedToLeave();
    memory.observeCommand('break', inGame);
    expect(memory.leftForMenu()).toBe(false);
  });

  it('forgetting clears every slot', () => {
    const memory = new Expectations();
    memory.hintMove('go manhole', 'd');
    memory.observeCommand('look orc', inGame);
    memory.observeCommand('enter manhole', inGame);
    memory.observeCommand('n', inGame);
    memory.askedToLeave();
    memory.forget();
    expect(memory.count).toBe(0);
    expect(memory.shiftLook()).toBeUndefined();
    expect(memory.takeUnmodelled(true)).toBeNull();
    expect(memory.aimed).toBeNull();
    expect(memory.leftForMenu()).toBe(false);
    memory.observeCommand('go manhole', inGame);
    expect(memory.count).toBe(0);
  });
});

/**
 * Giving up on a claim nothing answered.
 *
 * The bound lives here, on the claim, rather than in one of the six things
 * that read `pendingMoves` — the escape, `Walker.start`, `LoopRunner.advance`,
 * the walk home and auto-combat. Until 2026-09-03 only auto-combat had a clock,
 * so a sentence this parser cannot read answering a move let *it* recover after
 * eight seconds and left the character unable to run away, walk a route or run
 * a loop for the rest of the session, silently.
 */
describe('a claim nothing ever answers', () => {
  const life = DEFAULT_INTERNAL.tuning.parse.staleMoveMs;

  it('is given up on once it is past its life, and names the command', () => {
    const memory = new Expectations();
    const at = Date.now();
    memory.observeCommand('n', inGame);
    expect(memory.moves).toBe(1);

    expect(memory.expire(at + life - 1)).toEqual([]);
    expect(memory.moves).toBe(1);
    expect(memory.expire(at + life)).toEqual([{ command: 'n', moved: true }]);
    expect(memory.moves).toBe(0);
  });

  /*
   * **Pruned from the front while stale, never dropped wholesale.** The queue
   * is in the order the commands were sent, so a stale head says nothing about
   * a move queued behind it a moment ago — whose room may be in the next
   * packet. Dropping that one too would turn one lost step into two.
   */
  it('keeps a claim behind it that is still young', async () => {
    const memory = new Expectations();
    const at = Date.now();
    memory.observeCommand('n', inGame);
    await vi.advanceTimersByTimeAsync(life - 1);
    memory.observeCommand('e', inGame);

    expect(memory.expire(at + life)).toEqual([{ command: 'n', moved: true }]);
    expect(memory.moves).toBe(1);
    expect(memory.head()).toMatchObject({ kind: 'move', direction: 'e' });
  });

  /* A move nobody typed — a party follow, a drag — has no command to name. */
  it('reports an empty command for a move nobody typed', () => {
    const memory = new Expectations();
    const at = Date.now();
    memory.pushMove('n');
    expect(memory.expire(at + life)).toEqual([{ command: '', moved: true }]);
  });

  /*
   * A peek and a re-read expire the same way and are marked as **not** moves:
   * `pendingMoves` counts moves alone, so neither held the escape, the walker
   * or a loop, and the notice must not claim it did.
   */
  it('gives up on a peek and a re-read the same way, and says they held nothing', () => {
    const memory = new Expectations();
    const at = Date.now();
    memory.observeCommand('look e', inGame);
    memory.noteReread(true);
    expect(memory.expire(at + life)).toEqual([
      { command: 'look e', moved: false },
      { command: '', moved: false }
    ]);
    expect(memory.count).toBe(0);
  });

  it('does nothing at all with an empty queue', () => {
    expect(new Expectations().expire(Date.now())).toEqual([]);
  });
});

/**
 * Nothing is queued at a **menu**, which is `noteReread`'s rule applied to the
 * other two kinds: a menu answers what it is sent with a menu, never a room.
 *
 * Concrete, and it costs every character on the realm this client ships
 * pointed at: Paradigm's way in is `[E] . Enter the Realm`, so every login
 * script sends `E` — a direction word. Measured in
 * `2026-09-02_23-03-32_festus`: that `E` queued a move nothing answered for 49
 * seconds, and `pendingMoves` stands auto-combat down, refuses `Walker.start`
 * and holds a loop's next leg for every millisecond of it.
 */
describe('a direction word sent at a menu', () => {
  it('queues nothing, because a menu answers with a menu', () => {
    const memory = new Expectations();
    memory.observeCommand('E', atMenu);
    expect(memory.count).toBe(0);
    expect(memory.moves).toBe(0);
  });

  it('queues nothing for a look at a menu either', () => {
    const memory = new Expectations();
    memory.observeCommand('l', atMenu);
    memory.observeCommand('look n', atMenu);
    expect(memory.count).toBe(0);
  });

  /*
   * **And the guard is the menu, not merely "not in the realm."** `inGame` is
   * false until the first status line, which includes a fresh socket and a
   * reconnect — where a typed direction is a real move and dropping its claim
   * would resolve the room that answers it against nothing.
   */
  it('still queues one before the wire has said where the character is', () => {
    const memory = new Expectations();
    memory.observeCommand('n', unknownPhase);
    expect(memory.moves).toBe(1);
  });

  it('queues one in the realm, which is the whole point of the queue', () => {
    const memory = new Expectations();
    memory.observeCommand('n', inGame);
    expect(memory.moves).toBe(1);
  });
});
