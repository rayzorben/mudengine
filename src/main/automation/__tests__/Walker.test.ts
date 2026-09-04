import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { Walker } from '../Walker';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import type { AutomationConfig } from '../../../shared/config';
import type { Route } from '../../../shared/world';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const TUNING = DEFAULT_INTERNAL.tuning;

const config: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 4, minGapMs: 0, ackTimeoutMs: 1000 },
  walk: { stepTimeoutMs: 5000, clearAfterSeconds: 15 }
};

/** Three rooms in a line: 1/1 -e-> 1/2 -e-> 1/3. */
const ROUTE: Route = {
  cost: 2,
  blocked: false,
  steps: [
    {
      from: '1/1',
      to: '1/2',
      direction: 'e',
      command: 'e',
      name: 'Second Room',
      requirement: null,
      dark: false
    },
    {
      from: '1/2',
      to: '1/3',
      direction: 'e',
      command: 'e',
      name: 'Third Room',
      requirement: null,
      dark: false
    }
  ]
};

/** A character standing in `map/number`, in the realm. */
function at(
  map: number | null,
  number: number | null,
  over: Partial<CharacterState> = {}
): CharacterState {
  return {
    ...structuredClone(EMPTY_CHARACTER),
    phase: 'in-game',
    ...over,
    room: { ...structuredClone(EMPTY_CHARACTER.room), map, number, ...(over.room ?? {}) }
  };
}

/**
 * The walk's nudge, as it appears in `sent`: one bare Enter to make the server
 * say something after a command has gone unanswered for `walk.nudgeAfterMs`.
 *
 * Spelled out in the assertions rather than filtered away, because "one per
 * command sent" is a claim, and a test that tolerated any number of them would
 * be blind to a runaway exactly where a door ladder sends the most commands.
 */
const NUDGE = '';

/**
 * What went somewhere, minus the nudge — for the one assertion that is about
 * a route *not* sending its second step, where the nudge's presence or absence
 * says nothing either way.
 */
const moves = (commands: string[]): string[] => commands.filter((command) => command.length > 0);

const block = (type: string, groups: Record<string, string> = {}): Block =>
  ({
    type,
    domain: 'movement',
    raw: '',
    plain: '',
    groups,
    confidence: 1,
    at: 0
  }) as unknown as Block;

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let walker: Walker;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  queue = new CommandQueue(config, { send: (command) => sent.push(command) });
  walker = new Walker(config, queue, { notice: (m) => notices.push(m) });
});

afterEach(() => {
  walker.dispose();
  queue.dispose();
  vi.useRealTimers();
});

describe('refusing to start', () => {
  /* The room on the books is the one the character is leaving, so this route's
     first step is the move already on the wire. See `start`. */
  it('will not plan across a move the server has not answered', () => {
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      pendingMoves: () => 1
    });
    const reason = walk.start(ROUTE, at(1, 1));

    expect(reason).toBe(t('automation.walk.refusalMoveInFlight'));
    expect(sent).toEqual([]);
    walk.dispose();
  });

  /* Captured live 2026-09-01: a loop started in a room with two monsters
     swinging sent its opening step mid-round, and the character walked out of
     the fight it was in. The quarry hold cannot catch this — engagement
     answers "already fighting" while a target is live — so the walk itself
     refuses to begin until the fight is over. Opt-in since 2026-09-03: it is
     what *automation* deciding to leave a room gets, and a loop asks for it by
     name. */
  it('will not start an unasked-for walk out of a fight in progress', () => {
    const reason = walker.start(ROUTE, at(1, 1, { inCombat: true }), { whileFighting: false });
    expect(reason).toBe(t('automation.walk.refusalInCombat'));
    expect(sent).toEqual([]);
  });

  /*
   * Captured 2026-09-04 (`logs/2026-09-04_00-05-40_festus.mudcap.jsonl`,
   * t=452664): a kill in a room holding two monsters. `*Combat Off*` arrived
   * with the survivor still in `attackers` — it bit again on the very next
   * line — and a loop's leg was planned on that line. The server's flag was
   * down and the refusal read only the flag, so the leg started, and the
   * character walked out of the fight 1.5 seconds later. Anything swinging is
   * a fight, which is the definition every other gate in the walker uses.
   */
  it('will not start a loop leg while something is still swinging after *Combat Off*', () => {
    const swinging = at(1, 1, {
      combat: { ...structuredClone(EMPTY_CHARACTER.combat), attackers: ['big carrion beast'] }
    });
    const reason = walker.start(ROUTE, swinging, { whileFighting: false });
    expect(reason).toBe(t('automation.walk.refusalInCombat'));
    expect(sent).toEqual([]);
  });

  /*
   * And the other half of the same capture: the first step was *held* for a
   * quarry, the quarry engaged during the hold, and the re-ask released the
   * step because engagement answers "already fighting" with *no quarry*. A
   * fight that starts under a hold is answered as a fight — here, for a
   * loop's leg, by ending the leg — and never by walking out of it, however
   * many beats the hold's budget has left.
   */
  it('does not release a held first step into a fight that started during the hold', async () => {
    let fighting = false;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      holdAt: () => true,
      stateNow: () =>
        at(1, 1, {
          inCombat: fighting,
          combat: {
            ...structuredClone(EMPTY_CHARACTER.combat),
            ...(fighting ? { target: 'big carrion beast' } : {})
          }
        })
    });
    expect(
      walk.start(ROUTE, at(1, 1), { whileFighting: false, resumeAfterFight: false })
    ).toBeNull();
    expect(sent).toEqual([]);
    // The quarry engages while the first beat is still running.
    fighting = true;
    await vi.advanceTimersByTimeAsync((TUNING.walk.maxHolds + 1) * TUNING.walk.holdMs);
    expect(moves(sent)).toEqual([]);
    expect(walk.walking).toBe(false);
    walk.dispose();
  });

  /* The same situation on a route somebody asked for: it stands still for the fight and keeps the journey. */
  it('holds a route whose first step was waiting on the quarry that then engaged', async () => {
    let fighting = false;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      holdAt: () => true,
      stateNow: () =>
        at(1, 1, {
          inCombat: fighting,
          combat: {
            ...structuredClone(EMPTY_CHARACTER.combat),
            ...(fighting ? { target: 'big carrion beast' } : {})
          }
        })
    });
    expect(walk.start(ROUTE, at(1, 1))).toBeNull();
    fighting = true;
    await vi.advanceTimersByTimeAsync((TUNING.walk.maxHolds + 1) * TUNING.walk.holdMs);
    expect(moves(sent)).toEqual([]);
    expect(walk.walking).toBe(true);
    expect(walk.progress.hold).toBe('fight');
    walk.dispose();
  });

  /*
   * And the same route asked for by a person walks. Reported as *"when I
   * navigate, just navigate — I am the controller, I told you so"*: the route
   * panel already says the character is in combat, the person read it and
   * pressed the button, and on this realm walking out of a room is the only
   * way to break a fight at all — the client's own retreat does exactly this
   * unasked.
   */
  it('walks a route the player asked for straight out of the fight', async () => {
    expect(walker.start(ROUTE, at(1, 1, { inCombat: true }))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
  });

  /*
   * And it does not merely refuse later instead. The refusal would otherwise
   * have become a *hold* on the very next status line — the same standing
   * still, now silent, which is worse than what it replaced.
   */
  it('does not hold for the fight it was asked to leave', async () => {
    walker.start(ROUTE, at(1, 1, { inCombat: true }));
    await vi.advanceTimersByTimeAsync(50);
    walker.onCharacter(at(1, 1, { inCombat: true }));
    expect(walker.progress.hold).toBeNull();
    expect(walker.walking).toBe(true);
  });

  /*
   * A fight that starts *later* is one nobody asked about, and holds as usual
   * — which is the behaviour a separate report asked for: a route abandoned
   * two steps into twenty-one, in a sewer, for the ordinary reason a sewer
   * exists. The exemption is cleared the first moment nothing is fighting,
   * which needs no clock: `inCombat` outlives an escape by a measured median
   * of 3,493ms, and that window is exactly the one the walk must not stop in.
   */
  it('holds for a fight that starts after it left the first one', async () => {
    walker.start(ROUTE, at(1, 1, { inCombat: true }));
    await vi.advanceTimersByTimeAsync(50);
    // Out of the first fight, still in the room it started from.
    walker.onCharacter(at(1, 1));
    walker.onCharacter(at(1, 1, { inCombat: true }));
    expect(walker.progress.hold).toBe('fight');
    expect(walker.walking).toBe(true);
  });

  /*
   * And it ends at the step, not only at the fight clearing — which is the
   * bound the comment claims and the one "cleared when nothing is fighting"
   * does not deliver: a 100%-follower monster, or a corridor of back-to-back
   * engagements, never lets `inCombat` read false at all, so a *different*
   * fight several steps on would inherit the exemption and be marched
   * through. A confirmed step is the fact that says the character left the
   * room the fight was in.
   */
  it('ends the exemption at the first confirmed step, with the fight still running', async () => {
    walker.start(ROUTE, at(1, 1, { inCombat: true }));
    await vi.advanceTimersByTimeAsync(50);
    // The step lands — in the next room, with the follower still swinging.
    walker.onCharacter(at(1, 2, { inCombat: true }));
    expect(walker.progress.hold).toBe('fight');
    expect(walker.walking).toBe(true);
    expect(moves(sent)).toEqual(['e']);
  });

  it('will not walk a blocked route', () => {
    const reason = walker.start({ ...ROUTE, blocked: true, reason: 'no key' }, at(1, 1));
    expect(reason).toBe('no key');
    expect(sent).toEqual([]);
  });

  it('will not walk from a room it cannot identify', () => {
    // Starting from an unknown room makes the first step a guess about which
    // exit is being taken, and every step after it inherits that guess.
    expect(walker.start(ROUTE, at(null, null))).toMatch(/cannot tell/i);
    expect(sent).toEqual([]);
  });

  it('will not walk a route that starts somewhere else', () => {
    expect(walker.start(ROUTE, at(7, 7))).toMatch(/starts somewhere else/i);
    expect(sent).toEqual([]);
  });

  it('says so rather than walking when automation is off', () => {
    const off = new Walker({ ...config, enabled: false }, queue, {});
    expect(off.start(ROUTE, at(1, 1))).toMatch(/disabled/i);
    expect(sent).toEqual([]);
  });

  it('treats an empty route as already there', () => {
    expect(walker.start({ ...ROUTE, steps: [] }, at(1, 1))).toBe('Already there.');
  });
});

describe('starting from a rest', () => {
  /**
   * A resting character, as the status line reports one.
   */
  const resting = (over: Partial<CharacterState['vitals']> = {}): CharacterState => {
    const state = at(1, 1);
    return { ...state, vitals: { ...state.vitals, resting: true, ...over } };
  };

  /*
   * This used to send `l` first, to stand the character up. A look does not
   * break a rest (2026-08-27, docs/game-behaviour.md) and moving does — so the
   * first step was always going to end the rest by itself, and the look was a
   * command spent on nothing.
   */
  it('walks a resting character without spending a command on standing it up', async () => {
    expect(walker.start(ROUTE, resting())).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent[0]).toBe('e');
  });

  it('walks a meditating one the same way', async () => {
    expect(walker.start(ROUTE, resting({ resting: false, meditating: true }))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent[0]).toBe('e');
  });

  /* Nothing is done about the rest, so nothing is announced about it. */
  it('says nothing about standing up', () => {
    walker.start(ROUTE, resting());
    expect(notices.some((notice) => /standing up/i.test(notice))).toBe(false);
  });

  it('does not send a look when the character is already on its feet', async () => {
    // `l` is not free: it is a command out of the same budget the walk is
    // spent from, and one sent to stand up somebody already standing buys
    // nothing at all.
    expect(walker.start(ROUTE, at(1, 1))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
  });

  /*
   * Standing up rather than refusing, and the reason is that refusing protects
   * nothing: the first step ends the rest whatever this does. What it would
   * buy is somebody having to type `stand` themselves after asking to walk.
   */
  it('walks rather than refusing', () => {
    expect(walker.start(ROUTE, resting())).toBeNull();
  });
});

describe('one step at a time', () => {
  it('sends only the first step, not the whole route', () => {
    // The queue would happily pace all of them, but a sent command cannot be
    // recalled: forty movement commands on the wire are forty decisions that
    // can no longer be revised, and each one is sent whether or not the last
    // one worked.
    expect(walker.start(ROUTE, at(1, 1))).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(moves(sent)).toEqual(['e']);
  });

  it('sends the next step only once the room confirms the last one', () => {
    walker.start(ROUTE, at(1, 1));
    expect(sent).toEqual(['e']);

    walker.onCharacter(at(1, 2));
    expect(sent).toEqual(['e', 'e']);
    expect(walker.progress.done).toBe(1);
  });

  /**
   * The rooms still to travel, which is what the map draws the route with.
   *
   * Confirmed steps come off the front, so what is published is always the
   * way ahead — the request was for the route with the rooms already walked
   * removed, and the walker is the only thing that knows which those are.
   */
  it('publishes the rooms still to travel, opening with the one it is standing in', () => {
    walker.start(ROUTE, at(1, 1));
    expect(walker.progress.path).toEqual(['1/1', '1/2', '1/3']);

    // A step confirmed takes the room behind it off, and moves the anchor on.
    walker.onCharacter(at(1, 2));
    expect(walker.progress.path).toEqual(['1/2', '1/3']);
  });

  /* Same rule as `step` and `hold`: a route that is no longer being walked
     drawn over the map would be a plan the client is not following. */
  it('publishes no path once the walk is over, however it ended', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onCharacter(at(1, 2));
    walker.onCharacter(at(1, 3));
    expect(walker.progress.status).toBe('arrived');
    expect(walker.progress.path).toEqual([]);

    // And a walk stopped part-way, which still holds a route and an index.
    walker.start(ROUTE, at(1, 1));
    expect(walker.progress.path).not.toEqual([]);
    walker.stop('told to');
    expect(walker.progress.path).toEqual([]);
  });

  it('reports arrival once every step is confirmed', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onCharacter(at(1, 2));
    walker.onCharacter(at(1, 3));

    expect(walker.progress.status).toBe('arrived');
    expect(walker.progress.done).toBe(2);
    expect(notices.at(-1)).toMatch(/Arrived at Third Room/);
  });

  /*
   * A loop narrates its own legs, so the walker does not narrate them again.
   *
   * The positive control is the assertion above it and the one below: the
   * *same* route walked loudly says both lines, so "nothing was printed" here
   * cannot pass because the walk failed to happen. `ended` is asserted too,
   * because quiet is about the console and never about the fact — the loop
   * reads that callback and would stall for ever if silence reached it.
   */
  it('says nothing about a walk something else is narrating', () => {
    const ended: boolean[] = [];
    const quiet = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      ended: (arrived) => ended.push(arrived)
    });

    expect(quiet.start(ROUTE, at(1, 1), { quiet: true })).toBeNull();
    quiet.onCharacter(at(1, 2));
    quiet.onCharacter(at(1, 3));

    expect(quiet.progress.status).toBe('arrived');
    expect(quiet.progress.done).toBe(2);
    expect(ended).toEqual([true]);
    expect(notices).toEqual([]);
  });

  it('stops a quiet walk without saying so, and still reports it ended', () => {
    const ended: (string | null)[] = [];
    const quiet = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      ended: (_arrived, reason) => ended.push(reason)
    });

    quiet.start(ROUTE, at(1, 1), { quiet: true });
    quiet.stop('a shut door');

    expect(ended).toEqual(['a shut door']);
    expect(notices).toEqual([]);
    // And the next walk is loud again: silence belongs to the walk that asked
    // for it, not to the walker.
    quiet.start(ROUTE, at(1, 1));
    expect(notices.at(-1)).toMatch(/Walking 2 steps to Third Room/);
  });

  it('ignores state changes that are not a room change', () => {
    walker.start(ROUTE, at(1, 1));
    // The status line ticks constantly; none of those are a step.
    walker.onCharacter(at(1, 1));
    walker.onCharacter(at(1, 1));
    expect(sent).toEqual(['e']);
    expect(walker.progress.status).toBe('walking');
  });
});

describe('stopping', () => {
  it('stops when the room is not the one the route predicted', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onCharacter(
      at(9, 9, { room: { ...EMPTY_CHARACTER.room, map: 9, number: 9, name: 'Elsewhere' } })
    );

    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toMatch(/navigation desync/i);
    expect(sent).toEqual(['e']);
  });

  it('stops when the game refuses the direction', () => {
    // `direction-failed` is the game saying so outright. A retry will not help:
    // a shut door is shut until something opens it.
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(block('direction-failed'));

    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toMatch(/refused/i);
  });

  /*
   * A walk that ends on a fight is one somebody else decides what to do about
   * — a loop's leg, or a retreat. Both say so at the call site, and both go on
   * reading `ended`.
   */
  it('stops a walk that does not resume, out loud, in words that stay true', () => {
    /*
     * The reason outlives the fight by minutes: `you are in combat` is false
     * the moment `*Combat Off*` arrives, which is what *"the route says you
     * are in combat but the combat card says not in combat"* was reading.
     */
    walker.start(ROUTE, at(1, 1), { resumeAfterFight: false });
    walker.onCharacter(at(1, 1, { inCombat: true }));

    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe('a fight started');
    expect(notices.join(' ')).toContain('a fight started');
  });

  /* A loop narrates its own legs, so this one stays silent — the fact still
     reaches `ended`, which is what the loop reads. */
  it("says nothing when it is a loop's own leg", () => {
    const ended: Array<string | null> = [];
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      ended: (_arrived, reason) => ended.push(reason)
    });
    walker.start(ROUTE, at(1, 1), { quiet: true, resumeAfterFight: false });
    walker.onCharacter(at(1, 1, { inCombat: true }));

    expect(notices).toEqual([]);
    expect(ended).toEqual(['a fight started']);
  });

  /*
   * A death is a teleport with no destination in it, so the route is over —
   * and it is over for a *reason*. Without the sentence the walk still stopped,
   * two lines later, on the temple not being the room the route predicted:
   * "you ended up somewhere the route did not expect (Temple, Halls of the
   * Dead)", which describes the symptom rather than the death. And in between
   * those two lines everything the walk would do — re-asking a held step,
   * sending the next move — goes out from a character standing somewhere it
   * did not choose to be.
   */
  it('stops on the death sentence, not two lines later on the temple', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(block('user-dies'));

    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(t('automation.walk.reasonDied'));
  });

  it('stops when the player moves the character themselves', () => {
    walker.start(ROUTE, at(1, 1));
    walker.notePlayerMoved();

    expect(walker.progress.status).toBe('stopped');
    /* Asserted against the dictionary rather than the words, because the words
       are the user's to change: this test failed the day the copy was reworded,
       which is a rewording breaking a test that was never about the wording. */
    expect(walker.progress.reason).toBe(t('automation.walk.reasonPlayerTookOver'));
  });

  it('stops when the location becomes ambiguous', () => {
    // "Never guess a location": a walk that continues from a guess is a
    // pathfinder sending commands into the dark.
    walker.start(ROUTE, at(1, 1));
    walker.onCharacter(at(null, null, { room: { ...EMPTY_CHARACTER.room, ambiguous: 4 } }));

    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toMatch(/no longer tell/i);
  });

  it('asks for a prompt before giving up on a step that produces nothing', () => {
    /*
     * Without a deadline the walk sits in `walking` for ever, reporting
     * progress it is not making. With only a deadline it gives up on a silence
     * it never asked the server to break: an empty line is answered with a
     * status line and a reprint of the room, which is the very fact the walk is
     * waiting for, and it costs one command.
     */
    walker.start(ROUTE, at(1, 1));
    expect(moves(sent)).toEqual(['e']);

    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['e', '']);
    // The nudge is not the walk ending: the whole patience runs behind it.
    expect(walker.progress.status).toBe('walking');

    vi.advanceTimersByTime(5000);
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toMatch(/nothing came back/i);
    // And exactly one nudge. A second would be the client answering its own
    // silence with more of it.
    expect(sent.filter((command) => command.length === 0)).toEqual(['']);
  });

  it('drops the nudge when the answer arrives before it goes out', () => {
    /*
     * An arriving room consumes the expectation queue, so a reprint landing
     * behind the *next* step would be read as that step's arrival. Recallable
     * only while it is still queued, which is why it is dropped the moment the
     * step confirms rather than reasoned about afterwards.
     */
    const narrow = new CommandQueue(
      { ...config, pacing: { ...config.pacing, window: 1 } },
      { send: (command) => sent.push(command) }
    );
    const w = new Walker(config, narrow, {});
    w.start(ROUTE, at(1, 1));
    expect(sent).toEqual(['e']);

    // The window is shut, so the nudge is decided and queued but not sent.
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['e']);

    w.onCharacter(at(1, 2));
    narrow.notePrompt();
    // Short of the second step's own nudge, which is a different decision.
    vi.advanceTimersByTime(500);

    // The second step, and no reprint behind it to be mistaken for its answer.
    expect(sent).toEqual(['e', 'e']);
    w.dispose();
    narrow.dispose();
  });

  it('blames the client, not the server, for a step it never sent', () => {
    /*
     * `nothing came back after se` for a step the capture holds no trace of
     * (`logs/2026-09-02_13-29-52_festus.mudcap.jsonl`) sends whoever reads it
     * to the wrong end of the wire. The time an intent spends in the queue is
     * the client's own, and a walk that gives up there has to say so.
     */
    const shut = new CommandQueue(
      { ...config, pacing: { ...config.pacing, window: 0 } },
      { send: (command) => sent.push(command) }
    );
    const w = new Walker(config, shut, {});
    w.start(ROUTE, at(1, 1));
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(5000);
    expect(w.progress.status).toBe('stopped');
    expect(w.progress.reason).toMatch(/never left the client/i);
    w.dispose();
    shut.dispose();
  });

  it('waits, rather than giving up, while the player holds the floor', () => {
    /*
     * This is the shape the reported capture actually had: the step sat in the
     * queue while the player typed. The queue already credits held time back
     * to every expiry it is holding, and a walk's patience is an expiry clock
     * in everything but name — being charged for the player's own typing is
     * the same mistake in a smaller place. Bounded by the queue's own
     * abandoned-line ceiling, past which the hold lapses and the step goes.
     */
    const held = new CommandQueue(config, { send: (command) => sent.push(command) });
    const w = new Walker(config, held, {});
    held.noteTyping(true);
    w.start(ROUTE, at(1, 1));
    expect(sent).toEqual([]);

    // Well past the step deadline, and the walk is still walking.
    vi.advanceTimersByTime(15_000);
    expect(w.progress.status).toBe('walking');
    expect(sent).toEqual([]);

    // Enter: the floor comes back, and so does the step.
    held.noteTyping(false);
    expect(sent).toEqual(['e']);
    expect(w.progress.status).toBe('walking');
    w.dispose();
    held.dispose();
  });

  it('walks on when an abandoned line lapses, rather than racing the queue', () => {
    /*
     * The queue writes a line off after `queue.abandonedLineMs` and sends. The
     * send wait used to sample `suppressed` when its own timer expired, so at
     * that moment the two were a coin toss — the walk could be stopped as
     * never sent by the very tick that released it. A tally of the beats the
     * queue was free has no such moment.
     */
    const held = new CommandQueue(config, { send: (command) => sent.push(command) });
    const w = new Walker(config, held, {});
    held.noteTyping(true);
    w.start(ROUTE, at(1, 1));

    // Past the abandoned-line ceiling, which nothing here touches again: the
    // step goes out, and the wait becomes the ordinary wait on the server —
    // nudge and all.
    vi.advanceTimersByTime(21_000);
    expect(sent).toEqual(['e', NUDGE]);
    expect(w.progress.status).toBe('walking');
    w.dispose();
    held.dispose();
  });

  /*
   * How long "unanswered" is, which is a fact about the realm and used to be a
   * constant.
   *
   * `walk.nudgeAfterMs` was the whole deadline at a flat second, on the
   * reasoning that a move that landed is answered in well under one.
   * Paradigm's movement round is a measured 1,239ms
   * (`logs/2026-09-02_21-04-28_festus.mudcap.jsonl`, 22 uninterrupted town
   * steps; p25 1,228, p90 1,250), so every ordinary step was late, the
   * fallback fired on all of them, and the bare Enter it sends is answered
   * with a full reprint of the room — the console showed each room twice for
   * the whole lap and each step cost a second command.
   */
  describe('on a realm slower than the margin', () => {
    /** Longer than `nudgeAfterMs`, as Paradigm is. */
    const ANSWER_MS = 1_240;

    /** Confirms the outstanding step `ANSWER_MS` after it went out. */
    const answer = (map: number, number: number): void => {
      vi.advanceTimersByTime(ANSWER_MS);
      walker.onCharacter(at(map, number));
    };

    it('nudges once, and then not again once it knows what a move costs here', () => {
      walker.start(ROUTE, at(1, 1));

      // The first step has nothing to be measured against, so it keeps the
      // old behaviour: the margin is the whole deadline and the Enter goes.
      answer(1, 2);
      expect(sent).toEqual(['e', NUDGE, 'e']);

      // The second is given the slowest answer this realm has given plus the
      // margin, which 1,240ms is comfortably inside.
      answer(1, 3);
      expect(sent).toEqual(['e', NUDGE, 'e']);
      expect(walker.progress.status).toBe('arrived');
    });

    /* The measurement is the realm's, not the route's: a second walk starts
       knowing what the first one learned, or every route would pay the
       spurious Enter again at its top. */
    it('carries what it measured into the next walk', () => {
      walker.start(ROUTE, at(1, 1));
      answer(1, 2);
      answer(1, 3);
      sent.length = 0;

      walker.start(ROUTE, at(1, 1));
      answer(1, 2);
      expect(sent).toEqual(['e', 'e']);
    });

    /* A new connection may be a different server, so the measurement goes
       with it rather than being asserted about the next one. */
    it('forgets it on a new connection', () => {
      walker.start(ROUTE, at(1, 1));
      answer(1, 2);
      answer(1, 3);
      walker.reset();
      sent.length = 0;

      walker.start(ROUTE, at(1, 1));
      answer(1, 2);
      expect(sent).toEqual(['e', NUDGE, 'e']);
    });

    /* Measured patience is still patience for an answer, not for silence: a
       step the server never answers is nudged, however fast the realm is. */
    it('still nudges a step that goes unanswered', () => {
      walker.start(ROUTE, at(1, 1));
      answer(1, 2);
      sent.length = 0;

      // Past the slowest answer plus the margin, with nothing coming back.
      vi.advanceTimersByTime(ANSWER_MS + TUNING.walk.nudgeAfterMs + 1);
      expect(sent).toEqual([NUDGE]);
    });
  });

  it('never nudges behind a portal, which has no reprint discriminator', () => {
    /*
     * `takeTeleport()` spends the promise unconditionally and only then
     * decides whether to apply it, so a reprint of the room being left would
     * throw away the coordinates the script stated — and the real arrival
     * would then resolve by name alone, which across 293 rooms called Sewer
     * Tunnel is the ambiguity this client refuses to guess at.
     */
    const PORTAL: Route = {
      ...ROUTE,
      steps: [{ ...ROUTE.steps[0]!, direction: 'portal', command: 'go crimson portal' }]
    };
    walker.start(PORTAL, at(1, 1));
    expect(sent).toEqual(['go crimson portal']);

    vi.advanceTimersByTime(3000);
    // No Enter behind it; the step waits out its own deadline instead.
    expect(sent).toEqual(['go crimson portal']);
    expect(walker.progress.status).toBe('walking');
  });

  it('says so when the arbiter refuses the step outright', () => {
    // `automation.enabled` going off under a running walk: the queue drops
    // every non-user intent, and arming a deadline against that is how a walk
    // waited eight seconds for a command the client itself had refused.
    const off = new CommandQueue({ ...config, enabled: false }, { send: (c) => sent.push(c) });
    const w = new Walker(config, off, {});
    w.start(ROUTE, at(1, 1));

    expect(sent).toEqual([]);
    expect(w.progress.status).toBe('stopped');
    expect(w.progress.reason).toMatch(/refused to send/i);
    w.dispose();
    off.dispose();
  });

  it('cancels a queued step that has not reached the wire', () => {
    // Anything not yet sent is still revisable; that is the point of the queue.
    const narrow = new CommandQueue(
      { ...config, pacing: { ...config.pacing, window: 1 } },
      { send: (command) => sent.push(command) }
    );
    const w = new Walker(config, narrow, {});
    w.start(ROUTE, at(1, 1));
    // Confirm step one so step two is enqueued, but hold the window shut so it
    // cannot be sent.
    w.onCharacter(at(1, 2));
    expect(sent).toEqual(['e']);

    w.stop('testing');
    narrow.notePrompt();
    vi.advanceTimersByTime(2000);

    expect(sent).toEqual(['e']);
    w.dispose();
    narrow.dispose();
  });

  it('does nothing when stopped twice', () => {
    walker.start(ROUTE, at(1, 1));
    walker.stop('first');
    walker.stop('second');
    expect(walker.progress.reason).toBe('first');
  });

  it('is inert after a stop', () => {
    walker.start(ROUTE, at(1, 1));
    walker.stop('testing');
    walker.onCharacter(at(1, 2));
    expect(sent).toEqual(['e']);
  });
});

describe('progress', () => {
  it('reports the step in flight while walking, and nothing once stopped', () => {
    walker.start(ROUTE, at(1, 1));
    expect(walker.progress).toMatchObject({
      status: 'walking',
      done: 0,
      total: 2,
      destination: 'Third Room',
      destinationRoom: { map: 1, room: 3 },
      // The room each name stands for, so the card can open it: a room the
      // character is not in is a control, not text.
      step: { command: 'e', name: 'Second Room', to: { map: 1, room: 2 } }
    });

    walker.stop('testing');
    expect(walker.progress.step).toBeNull();
  });

  it('forgets everything on a new connection', () => {
    walker.start(ROUTE, at(1, 1));
    walker.reset();
    expect(walker.progress.status).toBe('idle');
    expect(walker.progress.total).toBe(0);
  });
});

/*
 * `automation.movement`: what a route is allowed to do on the way.
 *
 * The door case is the interesting one, because it is the exception to the
 * comment that used to sit in `onBlock` — *"a shut door is shut until something
 * opens it"*, which is true and is also the description of a command.
 */
describe('a door in the way', () => {
  const withMovement = (over: Partial<AutomationConfig['movement']>): Walker =>
    new Walker({ ...config, movement: { ...config.movement, ...over } }, queue, {
      notice: (m) => notices.push(m)
    });

  it('opens it and takes the step again', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    expect(open.progress.status).toBe('walking');
    expect(sent).toEqual(['e', 'open e', 'e']);
    open.dispose();
  });

  /*
   * The two `direction-failed` shapes are not one fact. `There is no exit in
   * that direction!` says the realm data was wrong, and no amount of opening
   * helps — which is why the pattern captures the barrier rather than the
   * walker matching on the sentence.
   */
  it('does not try to open a wall', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed'));

    expect(open.progress.status).toBe('stopped');
    expect(sent).toEqual(['e']);
    open.dispose();
  });

  /* A locked door answers the same way every time. */
  it('gives up after the tries it was given', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    open.onBlock(block('direction-failed', { barrier: 'gate' }));

    expect(open.progress.status).toBe('stopped');
    expect(sent).toEqual(['e', 'open e', 'e']);
    open.dispose();
  });

  it('stops at a door when it was not asked to open one', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(block('direction-failed', { barrier: 'door' }));

    expect(walker.progress.status).toBe('stopped');
    expect(sent).toEqual(['e']);
  });

  /*
   * Per step, not per route: a corridor with a door at each end is two ordinary
   * steps, and a budget spent on the first must not refuse the second.
   */
  it('gives each step its own budget', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    open.onCharacter(at(1, 2, { room: { ...EMPTY_CHARACTER.room, map: 1, number: 2 } }));
    vi.advanceTimersByTime(200);
    open.onBlock(block('direction-failed', { barrier: 'door' }));
    // Past the pacing window's own timeout: six commands with no prompt to
    // acknowledge them is more credit than the queue holds, which is the
    // queue's job and not this one's.
    vi.advanceTimersByTime(3000);

    expect(sent).toEqual(['e', 'open e', 'e', 'e', 'open e', 'e', NUDGE]);
    open.dispose();
  });
});

/*
 * Forcing what `open` cannot get past.
 *
 * The whole ladder, in the order the sewers under Newhaven walked it: shut,
 * open, locked, and then either a lock-pick or a shoulder. The transcript that
 * produced this feature ran `w`, `open w` three times and stopped — three
 * commands spent to be told the same word three times.
 */
describe('a locked barrier in the way', () => {
  /** The same route, with a door on the first step the realm records a number for. */
  const gated = (requirement: Route['steps'][number]['requirement']): Route => ({
    ...ROUTE,
    steps: [{ ...ROUTE.steps[0]!, requirement }, ROUTE.steps[1]!]
  });

  const door = (over: Record<string, unknown> = {}) =>
    ({ kind: 'door', raw: 'Door [41 picklocks/strength]', ...over }) as NonNullable<
      Route['steps'][number]['requirement']
    >;

  const forcing = (over: Partial<AutomationConfig['movement']>): Walker =>
    new Walker({ ...config, movement: { ...config.movement, ...over } }, queue, {
      notice: (m) => notices.push(m)
    });

  /** The character standing at 1/1 with a stat sheet the walker has seen. */
  const skilled = (strength: number | null, picklocks: number | null): CharacterState => {
    const state = at(1, 1);
    return {
      ...state,
      progress: { ...state.progress, strength, picklocks }
    };
  };

  it('stops opening the moment the server says the door is locked', () => {
    const walk = forcing({ openDoors: true, openTries: 3 });
    walk.start(gated(door({ pickDifficulty: 41, bashDifficulty: 41 })), skilled(60, 0));
    walk.onCharacter(skilled(60, 0));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    // `The door is locked.` — opening is spent, whatever the budget said.
    walk.onBlock(block('open-failed', { barrier: 'door', reason: 'locked' }));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    // One `open`, not three. The two it did not send are the point.
    expect(sent).toEqual(['e', 'open e', 'e']);
    expect(walk.progress.status).toBe('stopped');
    walk.dispose();
  });

  it('bashes a locked door when strength is within reach of the realm’s number', () => {
    const walk = forcing({ openDoors: true, openTries: 1, bashDoors: true, bashTries: 2 });
    walk.start(gated(door({ pickDifficulty: 41, bashDifficulty: 41 })), skilled(35, 0));
    // 35 against 41 is inside the ten-point margin.
    walk.onCharacter(skilled(35, 0));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'door', reason: 'locked' }));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['e', 'open e', 'e', 'bas e']);

    // `Your attempts to bash through fail!` — one more, and no more than that.
    walk.onBlock(block('bash-failed'));
    // Past the pacing window's own timeout: five commands with no prompt to
    // acknowledge them is more credit than the queue holds, which is the
    // queue's business and not this one's.
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'e', 'bas e', 'bas e', NUDGE]);

    /*
     * `You bashed the door open.` The barrier is open and the character has
     * not moved (`captures/005`), so the direction goes out again — and
     * nothing is opened, because a bashed door is open already.
     */
    walk.onBlock(block('door-changed', { barrier: 'door', state: 'open' }));
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'e', 'bas e', 'bas e', NUDGE, 'e', NUDGE]);
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });

  it('picks before bashing, and opens the door the pick unlocked', () => {
    const walk = forcing({
      openDoors: true,
      openTries: 1,
      bashDoors: true,
      bashTries: 2,
      pickLocks: true,
      pickTries: 2
    });
    walk.start(gated(door({ pickDifficulty: 41, bashDifficulty: 41 })), skilled(200, 30));
    walk.onCharacter(skilled(200, 30));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'door', reason: 'locked' }));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    // Strength is well past the number and picklocks only just inside it, and
    // the pick still goes first: it is the attempt that costs no health.
    expect(sent).toEqual(['e', 'open e', 'e', 'pi e']);

    // `Your skill fails you this time.` — the same sentence a failed disarm
    // gets, read as a pick only because the walker asked the question.
    walk.onBlock(block('skill-failed'));
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'e', 'pi e', 'pi e', NUDGE]);

    // `You successfully unlocked the door.` — unlocked and still shut.
    walk.onBlock(block('door-changed', { state2: 'unlocked' }));
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'e', 'pi e', 'pi e', NUDGE, 'open e', 'e', NUDGE]);
    walk.dispose();
  });

  /*
   * The pick budget runs out and the bash budget has not, so the ladder moves
   * across rather than stopping — the two are rungs, not alternatives.
   */
  it('falls through from picking to bashing when the picks run out', () => {
    const walk = forcing({ bashDoors: true, bashTries: 1, pickLocks: true, pickTries: 1 });
    walk.start(gated(door({ pickDifficulty: 41, bashDifficulty: 41 })), skilled(200, 200));
    walk.onCharacter(skilled(200, 200));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('skill-failed'));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('bash-failed'));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['e', 'pi e', 'bas e']);
    expect(walk.progress.status).toBe('stopped');
    // And it says which door and what it wanted, rather than `the game
    // refused e`.
    expect(notices.at(-1)).toContain('door');
    walk.dispose();
  });

  it('does not bash a lock the realm says only picklocks open', () => {
    const walk = forcing({ bashDoors: true, bashTries: 3 });
    // `Key: 2126 [or 157 picklocks]`: no strength number at all.
    walk.start(
      gated(door({ raw: 'Key: 2126 [or 157 picklocks]', pickDifficulty: 157 })),
      skilled(400, 0)
    );
    walk.onCharacter(skilled(400, 0));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));

    expect(sent).toEqual(['e']);
    expect(walk.progress.status).toBe('stopped');
    walk.dispose();
  });

  it('refuses when the character is not close enough, and says the numbers', () => {
    const walk = forcing({ bashDoors: true, bashTries: 3, pickLocks: true, pickTries: 3 });
    walk.start(gated(door({ pickDifficulty: 1000, bashDifficulty: 1000 })), skilled(30, 10));
    walk.onCharacter(skilled(30, 10));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));

    expect(sent).toEqual(['e']);
    expect(walk.progress.status).toBe('stopped');
    expect(notices.at(-1)).toContain('1000');
    walk.dispose();
  });

  /*
   * An unknown skill never meets a stated number — the same direction every
   * threshold in this client takes, and here the cheap one: the sheet is one
   * `st` away.
   */
  it('does not force on a stat sheet nobody has read', () => {
    const walk = forcing({ bashDoors: true, bashTries: 3, pickLocks: true, pickTries: 3 });
    walk.start(gated(door({ pickDifficulty: 20, bashDifficulty: 20 })), at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));

    expect(sent).toEqual(['e']);
    expect(walk.progress.status).toBe('stopped');
    walk.dispose();
  });

  /*
   * `Door` with no bracket, 1,015 of them in the shipped realm. The router
   * prices these as ordinary and routes through them, so refusing to force one
   * would make the plan a promise the walk breaks.
   */
  it('forces a barrier the realm records no number for', () => {
    const walk = forcing({ bashDoors: true, bashTries: 1 });
    walk.start(gated({ kind: 'door', raw: 'Door' }), at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['e', 'bas e']);
    walk.dispose();
  });

  it('leaves a wall alone however much forcing is turned on', () => {
    const walk = forcing({ bashDoors: true, bashTries: 3, pickLocks: true, pickTries: 3 });
    walk.start(gated(door({ pickDifficulty: 0, bashDifficulty: 0 })), skilled(200, 200));
    // `There is no exit in that direction!` — no barrier captured.
    walk.onBlock(block('direction-failed'));

    expect(sent).toEqual(['e']);
    expect(walk.progress.status).toBe('stopped');
    walk.dispose();
  });

  /*
   * A hand-typed `bas` at a door the player is dealing with themselves must
   * not be read as an answer to a question the walker never asked.
   */
  it('ignores a bash it did not send', () => {
    const walk = forcing({ bashDoors: true, bashTries: 3 });
    walk.start(gated(door({ pickDifficulty: 41, bashDifficulty: 41 })), skilled(200, 0));
    walk.onCharacter(skilled(200, 0));
    walk.onBlock(block('bash-failed'));
    walk.onBlock(block('door-changed', { state: 'open' }));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['e']);
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });
});

describe('sneaking before a route', () => {
  const sneaking = (): Walker =>
    new Walker({ ...config, movement: { ...config.movement, sneak: true } }, queue, {
      notice: (m) => notices.push(m)
    });

  it('sneaks first when asked to', () => {
    const walk = sneaking();
    walk.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['sn', 'e']);
    walk.dispose();
  });

  /*
   * `unknown` is not `sneaking` — nobody has said — so it still asks. Only a
   * character the server has actually confirmed is hidden is left alone.
   */
  it('does not ask again for a character the server says is already sneaking', () => {
    const walk = sneaking();
    walk.start(ROUTE, at(1, 1, { stealth: 'sneaking' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  it('does not sneak when it was not asked to', () => {
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e']);
  });
});

describe('holding a step where there is quarry', () => {
  it('waits a beat in a room worth stopping in, then walks on when nothing bites', () => {
    // Where the monster is, rather than a blanket yes: the beat is asked about
    // the room the character is standing in, and the start room is one of them.
    let quarryRoom: number | null = 2;
    walker = new Walker(config, queue, {
      holdAt: (state) => state.room.number === quarryRoom
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);
    // The first step confirms into a room with a monster in it: held.
    walker.onCharacter(at(1, 2));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);
    // Nothing engaged it after all; the patience lapses and the walk resumes.
    quarryRoom = null;
    vi.advanceTimersByTime(1_600);
    expect(sent).toEqual(['e', 'e']);
  });

  /*
   * The first step of a *fresh route* is the one that was never held, and it is
   * the step a loop takes every time it plans again after a fight: `Walker`
   * stops when combat starts, the loop waits it out and plans from where the
   * character is standing — a room that may still hold the monster's friend.
   *
   * Captured 2026-09-01. `Also here: big thug, thug.`; the big one was killed,
   * and off the one status line after the loot auto-combat queued `a thug`
   * (combat band) while the loop queued `e` (movement band). Both were on the
   * wire inside the 350ms gap, so the character engaged the second thug and
   * walked out of the fight — `*Combat Engaged*` arrives too late for
   * `cancelQueued` to recall a move already sent.
   */
  it('does not step out of the room a fresh route was planned in while it holds a quarry', () => {
    walker = new Walker(config, queue, { holdAt: (state) => state.room.number === 1 });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);

    // Auto-combat opened on it, which is what the beat was waiting for.
    walker.onCharacter(at(1, 1, { inCombat: true }));
    expect(walker.progress.hold).toBe('fight');
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  /*
   * `holds` is otherwise only cleared by a confirmed step, and combat stops a
   * leg mid-hold — so without a reset at `start` the loop's *next* leg would
   * inherit a spent budget and step out of the room unheld, which is the bug
   * above with one more fight in front of it.
   */
  it('gives each walk its own patience', () => {
    let asked = 0;
    walker = new Walker(config, queue, {
      holdAt: () => {
        asked += 1;
        return true;
      }
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    // Three beats and then the bound: the step goes out with the budget spent.
    vi.advanceTimersByTime(1_600);
    vi.advanceTimersByTime(1_600);
    vi.advanceTimersByTime(1_600);
    expect(asked).toBe(3);
    expect(sent).toEqual(['e']);

    walker.stop('a fight');
    asked = 0;
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    expect(asked).toBe(1);
    expect(sent).toEqual(['e']);
  });

  /*
   * The bound is only a bound if the beat is **re-asked**, and for a while it
   * was not: the timer went straight to `sendCurrent`, so a step held exactly
   * once whatever the answer had become and `MAX_HOLDS` was unreachable. This
   * test passed anyway — it advanced past three beats and found the step sent,
   * which is just as true of one beat. Counting the asks is the positive
   * control it was missing.
   */
  it('cannot be pinned forever by a monster nothing will engage', () => {
    let asked = 0;
    walker = new Walker(config, queue, {
      holdAt: (state) => {
        // The start room is empty, so the count is the beats at the step
        // being tested rather than one walk's worth of both rooms.
        if (state.room.number === 1) return false;
        asked += 1;
        return true;
      }
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(asked).toBe(1);

    // Two more beats, each one re-asking, and then the patience is spent.
    vi.advanceTimersByTime(1_600);
    expect(asked).toBe(2);
    vi.advanceTimersByTime(1_600);
    expect(asked).toBe(3);
    expect(sent).toEqual(['e']);

    // The fourth beat is the bound: nothing is asked, and the walk goes on.
    vi.advanceTimersByTime(1_600);
    expect(asked).toBe(3);
    expect(sent).toEqual(['e', 'e']);
  });

  /*
   * And it stops asking the moment the answer changes, rather than serving out
   * the full three: the room emptied, so there is nothing to stop for.
   */
  it('walks on as soon as the quarry is gone, without spending the rest of the patience', () => {
    let quarryRoom: number | null = 2;
    walker = new Walker(config, queue, {
      holdAt: (state) => state.room.number === quarryRoom
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(sent).toEqual(['e']);

    quarryRoom = null;
    vi.advanceTimersByTime(1_600);
    expect(sent).toEqual(['e', 'e']);
  });

  /*
   * The beat is re-asked a second and a half later, by which time the state it
   * began with is stale — the monster may be dead. `stateNow` is what the
   * question is asked about.
   */
  it('asks the second beat about the character as it is now', () => {
    const seen: Array<number | null> = [];
    const now = at(1, 2, { inCombat: false });
    walker = new Walker(config, queue, {
      holdAt: (state) => {
        seen.push(state.room.number);
        // Room 1 is the start room and is empty, so the first step goes out.
        return state.room.number !== 1;
      },
      stateNow: () => at(1, 9)
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(now);
    vi.advanceTimersByTime(1_600);
    expect(seen).toEqual([1, 2, 9]);
  });

  it('a fight starting during the hold takes the walk over, and the quarry beat dies with it', () => {
    walker = new Walker(config, queue, { holdAt: (state) => state.room.number !== 1 });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    walker.onCharacter(at(1, 2, { inCombat: true }));
    expect(walker.progress.hold).toBe('fight');
    vi.advanceTimersByTime(10_000);
    /*
     * The held step was never sent into the fight, and the fight hold's own
     * re-ask does not send it either: `holdAt` still says this room is worth
     * stopping in, so the step waits on the beat it was already waiting on.
     */
    expect(sent).toEqual(['e']);
  });
});

describe('an exit the realm data promised and the server refused', () => {
  it('names the edge, and only for the no-exit shape', () => {
    const refused: string[] = [];
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`)
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed'));
    expect(refused).toEqual(['1/1|e']);
    expect(walker.progress.status).toBe('stopped');
  });

  it('says nothing for a closed door, which open can still answer', () => {
    const refused: string[] = [];
    walker = new Walker({ ...config, movement: { ...config.movement, openDoors: false } }, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`)
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed', { barrier: 'door' }));
    expect(refused).toEqual([]);
  });

  /*
   * The failure this was written for, off the wire on 2026-08-30: a fight
   * ended while a loop's `ne` was unanswered, the loop replanned from the room
   * it had left and sent `ne` again, and the refusal that earned was booked
   * against the `se` that had gone out behind it. `1/1|e` is a corridor the
   * character had just walked, struck out of every route for the session.
   */
  it('blames nothing when a second move is unanswered', () => {
    const refused: string[] = [];
    // Nothing outstanding when the leg is planned, and two moves out by the
    // time the refusal lands: the step's own, and one this route never sent.
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    pending = 2;
    walker.onBlock(block('direction-failed'));

    expect(refused).toEqual([]);
    // The walk still stops, and as *lost* rather than as a refused route —
    // which is what makes a loop ask `rm` and keep the stop.
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(t('automation.walk.reasonAmbiguous'));
  });

  it('blames the edge when the refusal is the only move outstanding', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    pending = 1;
    walker.onBlock(block('direction-failed'));

    expect(refused).toEqual(['1/1|e']);
  });
});

/*
 * `Hidden/Searchable` — 249 of them in the shipped realm, and `edgePenalty`
 * prices a route through one *including* the search. Before this the walk sent
 * a bare direction, was told `There is no exit in that direction!` as the realm
 * data said it would be, and then struck the exit out of every route.
 */
describe('a hidden exit in the way', () => {
  const hidden: Route = {
    ...ROUTE,
    steps: [
      {
        ...ROUTE.steps[0]!,
        requirement: { kind: 'hidden', raw: 'Hidden/Searchable', searchable: true }
      }
    ]
  };

  it('searches for it and sends the step again', () => {
    walker.start(hidden, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed'));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['e', 'search e', 'e']);
    expect(walker.progress.status).toBe('walking');
  });

  it('does not blame the edge while the searches are unspent', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(hidden, at(1, 1));
    vi.advanceTimersByTime(50);
    pending = 1;
    walker.onBlock(block('direction-failed'));

    expect(refused).toEqual([]);
  });

  /* Once the client has done what the data told it to and the exit still is
     not there, the refusal is finally news about the edge. */
  it('blames the edge once the searches are spent', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(hidden, at(1, 1));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.advanceTimersByTime(50);
      pending = 1;
      walker.onBlock(block('direction-failed'));
    }

    // Two searches, and no third: `SEARCH_TRIES` bounds what one exit is worth.
    expect(sent.filter((command) => command === 'search e')).toHaveLength(2);
    expect(refused).toEqual(['1/1|e']);
    expect(walker.progress.status).toBe('stopped');
  });

  /* A hidden exit the data says no search reveals has nothing to try. */
  it('does not search one the realm says is not searchable', () => {
    const sealed: Route = {
      ...ROUTE,
      steps: [
        {
          ...ROUTE.steps[0]!,
          requirement: { kind: 'hidden', raw: 'Hidden/Needs 2 Actions', searchable: false }
        }
      ]
    };
    walker.start(sealed, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed'));

    expect(sent).toEqual(['e']);
    expect(walker.progress.status).toBe('stopped');
  });
});

/*
 * A dark room is not silence. `Walker` used to sit out the step deadline and
 * report `nothing came back after d`, which blames the server for something
 * that never happened — plenty came back, and it said the room was dark.
 */
describe('a room the server would not describe', () => {
  it('stops with the darkness rather than waiting out the deadline', () => {
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(
      at(null, null, { room: { ...structuredClone(EMPTY_CHARACTER.room), light: 'pitch black' } })
    );
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toContain('pitch black');
    expect(notices.join(' ')).not.toContain('nothing came back');
  });

  it('keeps walking when dead reckoning did place the character', () => {
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(
      at(1, 2, {
        room: {
          ...structuredClone(EMPTY_CHARACTER.room),
          map: 1,
          number: 2,
          light: 'pitch black',
          resolvedBy: 'dead-reckoning',
          confidence: 0.75
        }
      })
    );
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e', 'e']);
  });
});

/*
 * The warning is only worth anything *before* the step: afterwards it is an
 * explanation for why nothing can be seen. Both halves are already known — the
 * realm names the room being walked into, and the listing counts the charges.
 *
 * And only the half the realm does not state itself. `The room is pitch black -
 * you can't see anything` arrives with every dark room, so a client line saying
 * the same thing per step was six duplicates down a six-room corridor.
 */
describe('one step from a dark room', () => {
  const DARK_AHEAD: Route = {
    ...ROUTE,
    steps: [ROUTE.steps[0]!, { ...ROUTE.steps[1]!, dark: true }]
  };

  /** Two dark steps in a row, which is what a dark corridor actually is. */
  const DARK_TWICE: Route = {
    ...ROUTE,
    steps: [
      { ...ROUTE.steps[0]!, dark: true },
      { ...ROUTE.steps[1]!, dark: true }
    ]
  };

  it('says so when the light is spent', () => {
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightSource: () => ({ state: 'spent', name: 'glowing pearl' })
    });
    walker.start(DARK_AHEAD, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(notices.join(' ')).toContain('glowing pearl is spent');
  });

  /* A fact about the pack, not about the step — so it is said once, however
     many dark rooms the route runs through. */
  it('says it once for one light, not once per dark step', () => {
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightSource: () => ({ state: 'spent', name: 'glowing pearl' })
    });
    walker.start(DARK_TWICE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 3));
    expect(notices.filter((m) => m.includes('is spent'))).toHaveLength(1);
  });

  /* The realm says this one itself, on arrival, in every capture that walks
     into a dark room. A second copy in the client's own words is spam. */
  it('says nothing when there is no light at all', () => {
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightSource: () => ({ state: 'none', name: null })
    });
    walker.start(DARK_AHEAD, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(notices.join(' ')).not.toContain('dark');
  });

  /* And says nothing when there is one, or when nobody can answer. */
  it('is quiet when something usable is carried', () => {
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightSource: () => ({ state: 'carried', name: 'torch' })
    });
    walker.start(DARK_AHEAD, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(notices.join(' ')).not.toContain('dark');
  });

  it('is quiet when the next step is not into the dark', () => {
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightSource: () => ({ state: 'spent', name: 'glowing pearl' })
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(notices.join(' ')).not.toContain('spent');
  });
});

/*
 * The way back moved out of here entirely.
 *
 * `Walker.retreatFrom` used to answer it off `recent`, and could not: the step
 * that matters is the one taken as a fight begins, and a fight beginning is
 * what calls `stop()` before the room arrives, so the newest entry pointed at
 * the room the character had left. It is `CharacterTracker.wayBackFrom` now,
 * fed by every confirmed move whoever caused it — see `CharacterTracker.test.ts`.
 */

/*
 * A portal step — a room-script teleport on a route. The command is the
 * script's phrase, and the `stepping` hint carries `'portal'` and the
 * destination so the tracker resolves the arrival by coordinates rather than
 * by an exit that does not exist.
 */
describe('a portal step', () => {
  const PORTAL: Route = {
    cost: 4,
    blocked: false,
    steps: [
      {
        from: '1/1',
        to: '2/1',
        direction: 'portal',
        command: 'dive pool',
        name: 'Far Cavern',
        requirement: { kind: 'text', raw: 'dive pool', commands: ['dive pool'] },
        dark: false
      }
    ]
  };

  it('sends the phrase and hints the teleport, then confirms the arrival', () => {
    const hinted: Array<{ command: string; direction: string; to: string }> = [];
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stepping: (command, direction, to) => hinted.push({ command, direction, to })
    });
    expect(walker.start(PORTAL, at(1, 1))).toBeNull();
    expect(sent).toEqual(['dive pool']);
    expect(hinted).toEqual([{ command: 'dive pool', direction: 'portal', to: '2/1' }]);
    walker.onCharacter(at(2, 1));
    expect(walker.progress.status).toBe('arrived');
  });
});

/**
 * A route stands still while the character is too hurt to be travelling.
 *
 * Reported with a transcript in which the character was **already sitting** —
 * `[HP=33/KAI=0]: (Resting)` — when `Walking 29 steps to Bank of Godfrey`
 * stood it up and marched it at 33 HP through five dark rooms it had no light
 * for. A loop already refused to do that; a route the player asked for did
 * not, and `restBelow`/`restTo` are one pair meaning *the character does not
 * travel below this*.
 */
describe('walking while hurt', () => {
  /** A character at a stated fraction of full health, standing in 1/1. */
  const hurt = (fraction: number): CharacterState => {
    const state = at(1, 1);
    state.vitals = { ...state.vitals, hp: Math.round(fraction * 100), hpMax: 100 };
    return state;
  };

  /**
   * A walker whose thresholds are stated rather than inherited, and whose
   * `stateNow` the caller can move.
   *
   * The provider is not decoration: the hold re-asks on a timer and reads the
   * character through `stateNow`, exactly as `SessionManager` supplies it,
   * because the state captured when a hold began is stale by the time the beat
   * expires. A fixture without it would test the walker holding for ever.
   */
  const walkerAt = (
    restBelow: number,
    restTo = 0
  ): { walk: Walker; heal: (fraction: number) => void } => {
    let current = hurt(1);
    const walk = new Walker({ ...config, health: { ...config.health, restBelow, restTo } }, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current
    });
    return {
      walk,
      heal: (fraction) => {
        current = hurt(fraction);
      }
    };
  };

  it('holds the first step instead of marching a hurt character off', async () => {
    const { walk } = walkerAt(0.5);
    expect(walk.start(ROUTE, hurt(0.3))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('health');
    walk.dispose();
  });

  /* The whole point: it is a hold, not a refusal, so the walk is still on. */
  it('is still walking while it waits, not stopped', () => {
    const { walk } = walkerAt(0.5);
    walk.start(ROUTE, hurt(0.3));
    expect(walk.progress.status).toBe('walking');
    expect(walk.progress.reason).toBeNull();
    walk.dispose();
  });

  it('says so, because a route that does not move looks like a broken client', () => {
    const { walk } = walkerAt(0.5);
    walk.start(ROUTE, hurt(0.3));
    expect(notices.some((notice) => /too hurt to travel/i.test(notice))).toBe(true);
    walk.dispose();
  });

  /*
   * The positive control for every silence above: the same route, the same
   * walker, a character above the floor. Without this the four assertions
   * that nothing was sent would pass just as well if `start` had refused.
   */
  it('walks normally above the floor', async () => {
    const { walk } = walkerAt(0.5);
    expect(walk.start(ROUTE, hurt(0.9))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  it('does not hold at all when the threshold is off', async () => {
    const { walk } = walkerAt(0);
    walk.start(ROUTE, hurt(0.01));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /*
   * Unknown is not low — the rule every threshold in this client follows. A
   * walk pinned for want of a stat sheet is a character that never arrives.
   */
  it('does not hold on a health figure with no maximum behind it', async () => {
    const { walk } = walkerAt(0.5);
    const state = at(1, 1);
    state.vitals = { ...state.vitals, hp: 3, hpMax: null };
    walk.start(ROUTE, state);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /*
   * Hysteresis, not a threshold. `restTo` is the ceiling; healing one point
   * past the floor must not send the character off again to be knocked back
   * under it on the next blow.
   */
  it('waits for the ceiling rather than the floor once it is holding', async () => {
    const { walk, heal } = walkerAt(0.5, 0.8);
    walk.start(ROUTE, hurt(0.3));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);

    // Past the floor and short of the ceiling: the band the pair exists for.
    heal(0.6);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('health');
    walk.dispose();
  });

  it('walks on once health is back to the ceiling, and says so', async () => {
    const { walk, heal } = walkerAt(0.5, 0.8);
    walk.start(ROUTE, hurt(0.3));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);

    heal(0.85);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    expect(notices.some((notice) => /health is back/i.test(notice))).toBe(true);
    walk.dispose();
  });

  /*
   * The contract `SessionManager.mayRest` reads. It is a getter of its own and
   * not `progress.hold` because the gate is asked on every status line and the
   * progress object is built for the card; asserting it here is what keeps the
   * two from drifting into disagreement about when a character may sit down.
   */
  it('reports the hold to whoever decides about resting, and only while walking', async () => {
    const { walk, heal } = walkerAt(0.5, 0.8);
    walk.start(ROUTE, hurt(0.3));
    await vi.advanceTimersByTimeAsync(50);
    expect(walk.holding).toBe('health');

    heal(0.85);
    await vi.advanceTimersByTimeAsync(2000);
    expect(walk.holding).toBeNull();

    walk.stop('done');
    expect(walk.holding).toBeNull();
    walk.dispose();
  });

  /*
   * The one walk that must never wait to be better: a `safe-haven` retreat
   * exists *because* the character is hurt, and holding it leaves a bleeding
   * character in the open beside the lair it just ran from. Found by this change
   * breaking `SessionManager`'s own safe-haven test, which is the sort of
   * thing a fixture earns its keep for.
   */
  /*
   * A loop's leg is held by `LoopRunner`, off the same two thresholds and with
   * its own `health` hold to report it. Holding it here as well is two halves
   * of one gate in two files — caught by `npm run smoke`, whose fixture runs a
   * lap at 98/400 and whose first step stopped reaching the wire.
   */
  it('never holds a loop leg, which the loop itself decides', async () => {
    const { walk } = walkerAt(0.5);
    expect(walk.start(ROUTE, hurt(0.2), { quiet: true, holdWhenHurt: false })).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  it('never holds a retreat, which is the walk being hurt is the reason for', async () => {
    const { walk } = walkerAt(0.5);
    expect(walk.start(ROUTE, hurt(0.1), { holdWhenHurt: false })).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });
});

/*
 * The reported failure, in full: `Walking 21 steps to Bank of Godfrey`, two
 * steps walked, a nasty giant rat wandered in, the client killed it — and then
 * sent nothing at all for 140 seconds, until the player pressed Enter by hand
 * (`logs/2026-09-02_16-54-23_festus.mudcap.jsonl`). A journey across a realm
 * whose corridors are full of wandering monsters cannot end at the first one.
 */
describe('a fight on the way', () => {
  /**
   * A walker that can plan again, with `stateNow` the caller can move.
   *
   * Both are what `SessionManager` supplies and both are load-bearing here:
   * the hold re-asks on a timer against the state as it is *then*, and a
   * character that moved during the fight is replanned from where it actually
   * stands rather than from where the route was drawn.
   */
  const walkerThatCanPlan = (
    start: CharacterState,
    replan?: (to: string) => Route | string
  ): { walk: Walker; move: (state: CharacterState) => void } => {
    let current = start;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current,
      ...(replan ? { replan } : {})
    });
    return { walk, move: (state) => (current = state) };
  };

  const fighting = (map: number, room: number): CharacterState => at(map, room, { inCombat: true });

  it('holds the route rather than ending it, and says nothing about it', async () => {
    const { walk } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    notices.length = 0;

    walk.onCharacter(fighting(1, 1));

    expect(walk.progress.status).toBe('walking');
    expect(walk.progress.hold).toBe('fight');
    expect(walk.progress.reason).toBeNull();
    expect(walk.progress.destination).toBe('Third Room');
    /*
     * Silent on purpose. The server has already printed `*Combat Engaged*` in
     * the room; a line per wandering monster on a twenty-one step journey is
     * the chrome talking over it, which is what `Walk stopped: a fight
     * started` was reported as.
     */
    expect(notices).toEqual([]);
    walk.dispose();
  });

  /* `mayRest` reads this: a held walk must let `Recovery` sit the character
     down, and a marching one must not. */
  it('reports the hold, so resting is allowed while it waits', () => {
    const { walk } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    walk.onCharacter(fighting(1, 1));
    expect(walk.holding).toBe('fight');
    walk.dispose();
  });

  /* Nothing moved, so the route it was walking is still the route from here —
     no plan needed, and the step that was interrupted goes out again. */
  it('sends the held step again when the fight ends where it started', async () => {
    const { walk, move } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);

    walk.onCharacter(fighting(1, 1));
    sent.length = 0;
    move(at(1, 1));
    walk.onCharacter(at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    expect(moves(sent)).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  /*
   * The character was chased, ran, or killed the thing in the doorway. **It
   * replans; it never resumes** — the steps ahead were drawn from a room it is
   * no longer in, and sending them from here sends directions from somewhere
   * it is not.
   */
  it('plans again from wherever the fight actually left the character', async () => {
    const asked: string[] = [];
    const detour: Route = {
      cost: 1,
      blocked: false,
      steps: [
        {
          from: '1/9',
          to: '1/3',
          direction: 'n',
          command: 'n',
          name: 'Third Room',
          requirement: null,
          dark: false
        }
      ]
    };
    const { walk, move } = walkerThatCanPlan(at(1, 1), (to) => {
      asked.push(to);
      return detour;
    });
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter(fighting(1, 1));
    sent.length = 0;
    // It ran, and the fight ended a room away from anything the route knew.
    move(at(1, 9));
    walk.onCharacter(at(1, 9));
    await vi.advanceTimersByTimeAsync(50);

    // Asked for a route to where the player said to go, not to the next step.
    expect(asked).toEqual(['1/3']);
    expect(moves(sent)).toEqual(['n']);
    expect(walk.progress.total).toBe(1);
    expect(walk.progress.destination).toBe('Third Room');
    walk.dispose();
  });

  /* Chased into the destination, or the last step's answer arrived among the
     combat lines. The journey is over, and it ended the way it was asked for. */
  it('arrives when the fight ends in the room the route was heading for', async () => {
    const { walk, move } = walkerThatCanPlan(at(1, 1), () => ({
      cost: 0,
      blocked: false,
      steps: []
    }));
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    notices.length = 0;

    walk.onCharacter(fighting(1, 1));
    move(at(1, 3));
    walk.onCharacter(at(1, 3));

    expect(walk.progress.status).toBe('arrived');
    expect(notices.join(' ')).toContain('Arrived at Third Room');
    walk.dispose();
  });

  /*
   * The duplicate-move bug in `start` wearing a different hat: the room on the
   * books is the one being left, so a plan made from it would begin with the
   * move already on the wire, sent a second time. Measured 2026-08-30 — it
   * cost a loop two real corridors and then its life.
   */
  it('will not plan across a move the server has not answered', async () => {
    let inFlight = 0;
    const asked: string[] = [];
    let current = at(1, 1);
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current,
      pendingMoves: () => inFlight,
      replan: (to) => {
        asked.push(to);
        return ROUTE;
      }
    });
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter(fighting(1, 1));
    sent.length = 0;
    // The step the fight interrupted is still on the wire, so the room on the
    // books is the one being left.
    inFlight = 1;
    current = at(1, 2);
    walk.onCharacter(at(1, 2));
    await vi.advanceTimersByTimeAsync(1_600);

    expect(asked).toEqual([]);
    expect(moves(sent)).toEqual([]);
    expect(walk.progress.hold).toBe('fight');
    walk.dispose();
  });

  /*
   * And it is bounded. A route reporting `1/2` that will never move again is
   * the lie stopping exists to avoid, so the wait for a position gets the same
   * patience a step does and then gives up saying so.
   */
  it('gives up after the step timeout when it never learns where it is', async () => {
    let inFlight = 0;
    let current = at(1, 1);
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current,
      pendingMoves: () => inFlight
    });
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter(fighting(1, 1));
    // And the server never answers it — the one move stays on the books.
    inFlight = 1;
    current = at(1, 1);
    walk.onCharacter(at(1, 1));
    await vi.advanceTimersByTimeAsync(config.walk.stepTimeoutMs + 2_000);

    expect(walk.progress.status).toBe('stopped');
    /*
     * Named as what it is. `the client could not place the character` would
     * send whoever reads this an hour later to look at room resolution, when
     * the client knows exactly where it is and is waiting on a command the
     * server never answered.
     */
    expect(walk.progress.reason).toBe(t('automation.walk.reasonMoveUnanswered', { command: 'e' }));
    walk.dispose();
  });

  /*
   * A fight the client is still in has no clock on it — it ends when the
   * monster dies, when the character runs, or when the character does — so the
   * patience above must not start ticking until it is over. Otherwise a long
   * fight would abandon the route it was fought in the middle of.
   */
  it('does not spend that patience while the fight is still running', async () => {
    const { walk, move } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter(fighting(1, 1));
    move(fighting(1, 1));
    await vi.advanceTimersByTimeAsync(config.walk.stepTimeoutMs * 3);
    expect(walk.progress.status).toBe('walking');

    sent.length = 0;
    move(at(1, 1));
    walk.onCharacter(at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });

  /*
   * Something recorded as swinging is a fight whether or not the flag is up —
   * `CharacterTracker` files an attacker a round before `*Combat Engaged*` on
   * a monster that opened, and a step sent in that round walks the character
   * out of a fight `cancelQueued` cannot recall it from.
   */
  it('holds for a blow that has landed before the flag says so', () => {
    const { walk } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    const swung = at(1, 1);
    swung.combat = { ...swung.combat, attackers: ['nasty giant rat'] };
    walk.onCharacter(swung);
    expect(walk.progress.hold).toBe('fight');
    walk.dispose();
  });

  /*
   * Found by review and reproduced: `onBlock`'s only guard was `status !==
   * 'walking'`, and a held walk *is* walking — so the door and hidden-exit
   * ladders answered a refusal that arrived mid-fight by putting `search e`
   * and `e` on the wire inside the round, which is the one thing the hold
   * exists to prevent and `cancelQueued` cannot recall.
   */
  it('runs no rung of the door ladder while it is holding for a fight', async () => {
    let current = at(1, 1);
    const walk = new Walker(
      { ...config, movement: { ...config.movement, openDoors: true, openTries: 1 } },
      queue,
      { notice: (m) => notices.push(m), stateNow: () => current }
    );
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);

    // A wanderer opens on the character before the step's answer lands.
    current = fighting(1, 1);
    walk.onCharacter(current);
    sent.length = 0;

    // And the door's refusal arrives in the middle of the round.
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    await vi.advanceTimersByTimeAsync(10_000);

    // `open e` and `e` again would both be movement commands inside the round.
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('fight');
    walk.dispose();
  });

  /* A death is the exception, and it is ahead of that guard: everything the
     walk would do next goes out from a temple it did not choose. */
  it('still ends on the death sentence while held', () => {
    const { walk } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    walk.onCharacter(fighting(1, 1));
    walk.onBlock(block('user-dies'));
    expect(walk.progress.status).toBe('stopped');
    expect(walk.progress.reason).toBe(t('automation.walk.reasonDied'));
    walk.dispose();
  });

  /*
   * The bound, and why there is one at all: `automation.combat` and
   * `automation.safety.retreat` are both off by default, so on a stock
   * configuration nothing here kills the monster and nothing runs. Without it
   * an unattended character is beaten where it stands and the console — which
   * used to print `Walk stopped: a fight started` — says nothing at all.
   */
  it('gives up on a fight nothing in this client is ending', async () => {
    const { walk, move } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter(fighting(1, 1));
    move(fighting(1, 1));
    await vi.advanceTimersByTimeAsync(TUNING.walk.fightHoldMs + 2_000);

    expect(walk.progress.status).toBe('stopped');
    expect(walk.progress.reason).toBe(t('automation.walk.reasonFightUnending'));
    expect(notices.join(' ')).toContain('not waiting any longer');
    walk.dispose();
  });

  /*
   * `LoopRunner.noteEscaped`'s measurement, applied to the other walk that can
   * now outlive a fight: an escape leaves the character one room from what it
   * ran from, and the shortest path onward begins with the reverse of the move
   * that got away. The health hold catches a health-triggered escape; this is
   * the floor under `whenOutnumbered` and the PvP reaction, which fire at any
   * health.
   */
  it('does not walk straight back into the room it just ran from', async () => {
    const { walk, move } = walkerThatCanPlan(at(1, 1), () => ROUTE);
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter(fighting(1, 1));
    walk.noteEscaped();
    sent.length = 0;
    move(at(1, 1));
    walk.onCharacter(at(1, 1));

    await vi.advanceTimersByTimeAsync(TUNING.loop.escapeSettleMs - 1_000);
    expect(moves(sent)).toEqual([]);
    expect(walk.progress.hold).toBe('fight');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });

  /* A fight breaks stealth, and `start`'s `sn` is only sent once. */
  it('sneaks again before walking on, for a character configured to', async () => {
    let current = at(1, 1);
    const walk = new Walker({ ...config, movement: { ...config.movement, sneak: true } }, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current
    });
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['sn', 'e']);

    walk.onCharacter(fighting(1, 1));
    sent.length = 0;
    current = at(1, 1);
    walk.onCharacter(at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    expect(sent).toEqual(['sn', 'e']);
    walk.dispose();
  });

  /* The player's journey has been dropped, and only the thing that replaced
     it would otherwise reach the console. */
  it('says so when something else takes the walker off a held route', async () => {
    const { walk } = walkerThatCanPlan(at(1, 1));
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    walk.onCharacter(fighting(1, 1));
    notices.length = 0;

    // A `safe-haven` retreat, which is the caller this can happen from.
    walk.start(ROUTE, at(1, 1), { holdWhenHurt: false, resumeAfterFight: false });

    expect(notices.join(' ')).toContain('Dropped the walk to Third Room');
    walk.dispose();
  });

  /*
   * The fight left the character under the floor it may travel at, so the
   * health hold takes over from the fight hold rather than the route marching
   * off at whatever the fight left it on. Two holds, one after the other,
   * handed over in `carryOn`.
   */
  it('hands over to the health hold when the fight left it too hurt to travel', async () => {
    const hurt = at(1, 1);
    hurt.vitals = { ...hurt.vitals, hp: 20, hpMax: 100 };
    let current: CharacterState = at(1, 1);
    const walk = new Walker(
      { ...config, health: { ...config.health, restBelow: 0.5, restTo: 0 } },
      queue,
      { notice: (m) => notices.push(m), stateNow: () => current }
    );
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    walk.onCharacter({ ...hurt, inCombat: true });
    sent.length = 0;
    current = hurt;
    walk.onCharacter(hurt);
    await vi.advanceTimersByTimeAsync(50);

    expect(walk.progress.hold).toBe('health');
    expect(moves(sent)).toEqual([]);
    walk.dispose();
  });
});

describe('what goes ahead of a step', () => {
  /* Since 2026-09-03 the walker tells whoever is listening about the room a
     step is about to enter, *before* the step is queued, so a torch lit for
     it reaches the wire first. */
  it('is told the destination’s level before the step is queued', () => {
    const seen: Array<{ ahead: { name: string; light: number | undefined }; sentSoFar: number }> =
      [];
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => at(1, 1),
      beforeStep: (ahead) => seen.push({ ahead, sentSoFar: sent.length })
    });
    const dark: Route = {
      ...ROUTE,
      steps: [{ ...ROUTE.steps[0]!, dark: true, light: -175 }, ROUTE.steps[1]!]
    };
    expect(walk.start(dark, at(1, 1))).toBeNull();
    expect(seen).toEqual([{ ahead: { name: 'Second Room', light: -175 }, sentSoFar: 0 }]);
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });

  it('is not asked again for a retry behind a door', () => {
    const seen: string[] = [];
    const walk = new Walker(
      { ...config, movement: { ...config.movement, openDoors: true, openTries: 1 } },
      queue,
      {
        notice: (m) => notices.push(m),
        stateNow: () => at(1, 1),
        beforeStep: (ahead) => seen.push(ahead.name)
      }
    );
    walk.start(ROUTE, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(50);
    expect(seen).toEqual(['Second Room']);
    walk.dispose();
  });
});

describe('what a walk still owes across a lost connection', () => {
  it('a plain route owes its destination while it is being walked', () => {
    expect(walker.journey).toBeNull();
    expect(walker.start(ROUTE, at(1, 1))).toBeNull();
    expect(walker.journey).toEqual({ to: '1/3', name: 'Third Room' });
  });

  /* A stopped route is a plan the client is no longer following; picking it
     back up would walk a journey the player had already watched end. */
  it('owes nothing once the walk has ended', () => {
    walker.start(ROUTE, at(1, 1));
    walker.stop(t('session.walk.stoppedConnectionClosed'));
    expect(walker.journey).toBeNull();
  });

  /* A loop's leg, an errand's walk and a retreat's walk home are each planned
     again by what asked for them. Offered back as well, the pick-up would walk
     one on top of the loop's own leg. */
  it('a walk whose owner plans it again is not offered back', () => {
    expect(walker.start(ROUTE, at(1, 1), { resumeAfterLoss: false })).toBeNull();
    expect(walker.journey).toBeNull();
  });
});
