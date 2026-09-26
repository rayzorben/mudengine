import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { Walker } from '../Walker';
import type { WalkerEvents } from '../walk/ports';
import { CONFIG as config, ROUTE, at, moves, useRigs } from '../walk/__tests__/walking';
import {
  EMPTY_CHARACTER,
  NO_AFFLICTIONS,
  type Afflictions,
  type CharacterState
} from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import type { AutomationConfig, MovementConfig } from '../../../shared/config';
import type { Direction, RemoteLever, Route, RouteStep } from '../../../shared/world';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { wireExit } from '../../../shared/entities';

const TUNING = DEFAULT_INTERNAL.tuning;

/**
 * The walk's nudge, as it appears in `sent`: one bare Enter to make the server
 * say something after a command has gone unanswered for `walk.nudgeAfterMs`.
 *
 * Spelled out in the assertions rather than filtered away, because "one per
 * command sent" is a claim, and a test that tolerated any number of them would
 * be blind to a runaway exactly where a door ladder sends the most commands.
 */
const NUDGE = '';

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

/*
 * The shared rig, read through this file's own variables: a test swaps
 * `sent` for a fresh array and `walker` for one built its own way, so the
 * queue sends into whichever `sent` is current and the `walker` standing at
 * the end is disposed with the rig's.
 */
const walkerOn = useRigs();
beforeEach(() => {
  ({ sent, notices, queue, walker } = walkerOn({}, config, (command) => sent.push(command)));
});
afterEach(() => walker.dispose());

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
      // A quarry is a monster auto-combat will fight, so it fights this one.
      willFight: () => true,
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
   *
   * **On this configuration, which is the stock one** (2026-09-06): `config`
   * is `DEFAULT_CONFIG.automation`, where `combat` and `safety.retreat` are
   * both off, so nothing this client runs would end the fight and the step
   * genuinely *is* the escape. That was always the argument; it was simply
   * never asked as a question. See `leavingAFight` in `start`.
   */
  it('walks a route the player asked for straight out of a fight nothing will end', async () => {
    expect(walker.start(ROUTE, at(1, 1, { inCombat: true }))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
  });

  /*
   * And the character that *will* finish it holds instead — reported
   * 2026-09-06 as *"the automation when walking just decided to not finish
   * attacking even though auto combat is on; auto combat should always clear
   * the room before moving on"*, and measured
   * (`logs/2026-09-06_11-19-43_festus.mudcap.jsonl`): `aa big skeleton` at
   * t=7634, `*Combat Engaged*` at t=7703, and the route's opening `n` on the
   * wire at t=7916 — over a monster auto-combat had just re-engaged, on a
   * profile with `combat.enabled`, `retaliate` and `whileWalking` all on.
   *
   * The pair is the point: same route, same live fight, same button, and the
   * player's own configuration is the only thing that differs.
   */
  it('holds a route the player asked for when auto-combat will clear the room', async () => {
    const fights: AutomationConfig = { ...config, combat: { ...config.combat, enabled: true } };
    const walk = new Walker(fights, queue, { notice: (m) => notices.push(m) });

    expect(walk.start(ROUTE, at(1, 1, { inCombat: true }))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);

    expect(walk.progress.hold).toBe('fight');
    expect(walk.walking).toBe(true);
    expect(sent).toEqual([]);
    walk.dispose();
  });

  /*
   * And it is a hold rather than a stall: the room clears and the journey goes
   * on. Without this the fix would be the 2026-09-03 refusal wearing the
   * hold's face, which is the failure that decision was made against.
   */
  it('steps off once the fight it held for is over', async () => {
    const fights: AutomationConfig = { ...config, combat: { ...config.combat, enabled: true } };
    const walk = new Walker(fights, queue, { notice: (m) => notices.push(m) });

    walk.start(ROUTE, at(1, 1, { inCombat: true }));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);

    // The skeleton dies; the character is still standing where it fought.
    walk.onCharacter(at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    expect(walk.progress.hold).toBeNull();
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });

  /*
   * And the escape is not caught by it. A `safe-haven` retreat passes
   * `resumeAfterFight: false` and leaves `whileFighting` at the player's
   * default, so reading `canEndAFight` alone would have had it answer the
   * fight by *stopping* — the walk planned to run from a fight refusing to
   * take its first step out of it. A walk that will not wait a fight out is
   * always leaving one.
   */
  it('still leaves for a walk that does not wait fights out', async () => {
    const fights: AutomationConfig = { ...config, combat: { ...config.combat, enabled: true } };
    const walk = new Walker(fights, queue, { notice: (m) => notices.push(m) });

    expect(
      walk.start(ROUTE, at(1, 1, { inCombat: true }), {
        holdWhenHurt: false,
        resumeAfterFight: false,
        resumeAfterLoss: false
      })
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(50);

    expect(walk.progress.hold).toBeNull();
    expect(sent).toEqual(['e']);
    walk.dispose();
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
    // Nothing fights the first fight, so the walk leaves it; the later one is
    // fought, so the walk waits it out.
    let fights = false;
    const walk = new Walker(config, queue, { willFight: () => fights });
    walk.start(ROUTE, at(1, 1, { inCombat: true }));
    await vi.advanceTimersByTimeAsync(50);
    // Out of the first fight, still in the room it started from.
    walk.onCharacter(at(1, 1));
    fights = true;
    walk.onCharacter(at(1, 1, { inCombat: true }));
    expect(walk.progress.hold).toBe('fight');
    expect(walk.walking).toBe(true);
    walk.dispose();
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
    let fights = false;
    const walk = new Walker(config, queue, { willFight: () => fights });
    walk.start(ROUTE, at(1, 1, { inCombat: true }));
    await vi.advanceTimersByTimeAsync(50);
    // The step lands — in the next room, with the follower still swinging,
    // and something fighting it now.
    fights = true;
    walk.onCharacter(at(1, 2, { inCombat: true }));
    expect(walk.progress.hold).toBe('fight');
    expect(walk.walking).toBe(true);
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });

  it('will not walk a blocked route', () => {
    const reason = walker.start({ ...ROUTE, blocked: true, reason: 'no key' }, at(1, 1));
    expect(reason).toBe('no key');
    expect(sent).toEqual([]);
  });

  it('will not walk from a room it cannot identify', () => {
    // Starting from an unknown room makes the first step a guess about which
    // exit is being taken, and every step after it inherits that guess.
    expect(walker.start(ROUTE, at(null, null))).toBe(t('automation.walk.refusalUnknownStart'));
    expect(sent).toEqual([]);
  });

  it('will not walk a route that starts somewhere else', () => {
    expect(walker.start(ROUTE, at(7, 7))).toBe(t('automation.walk.refusalStaleRoute'));
    expect(sent).toEqual([]);
  });

  it('says so rather than walking when automation is off', () => {
    const off = new Walker({ ...config, enabled: false }, queue, {});
    expect(off.start(ROUTE, at(1, 1))).toBe(t('automation.walk.refusalDisabled'));
    expect(sent).toEqual([]);
  });

  it('treats an empty route as already there', () => {
    expect(walker.start({ ...ROUTE, steps: [] }, at(1, 1))).toBe(t('automation.walk.alreadyThere'));
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
    expect(notices).toEqual([
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    ]);
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
    expect(notices.at(-1)).toBe(t('automation.walk.arrived', { stepName: 'Third Room' }));
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
    expect(notices.at(-1)).toBe(
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    );
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
    expect(walker.progress.reason).toBe(
      t('automation.walk.reasonWrongRoom', { roomName: 'Elsewhere' })
    );
    expect(sent).toEqual(['e']);
  });

  it('stops when the game refuses the direction', () => {
    // `direction-failed` is the game saying so outright. A retry will not help:
    // a shut door is shut until something opens it.
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(block('direction-failed'));

    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(t('automation.walk.reasonRefused', { command: 'e' }));
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
    expect(walker.progress.reason).toBe(t('automation.walk.reasonCombat'));
    expect(notices).toContain(
      t('automation.walk.stopped', { reason: t('automation.walk.reasonCombat') })
    );
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
    expect(ended).toEqual([t('automation.walk.reasonCombat')]);
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
    expect(walker.progress.reason).toBe(t('automation.walk.reasonAmbiguous'));
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
    expect(walker.progress.reason).toBe(t('automation.walk.reasonTimeout', { command: 'e' }));
    // And exactly one nudge. A second would be the client answering its own
    // silence with more of it.
    expect(sent.filter((command) => command.length === 0)).toEqual(['']);
  });

  /*
   * Todo 764: a character that drops with a step on the wire is refused every
   * step (`MoveCommand`) and handed no state, so the walk's own clock nudged
   * and then stopped as *nothing came back*, which blames the server for a
   * silence the ground explains. The test above is the positive control: the
   * rig answers standing, and that walk nudges.
   */
  it('neither nudges nor blames the server when the character drops mid-step', () => {
    let down = false;
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      onTheGround: () => down
    });
    walker.start(ROUTE, at(1, 1));
    expect(moves(sent)).toEqual(['e']);
    down = true;
    vi.advanceTimersByTime(6000);
    expect(sent).toEqual(['e']);
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(t('automation.walk.reasonGrounded', { command: 'e' }));
  });

  // A construction that does not say the character is standing is not read as standing.
  it('sends no nudge on a character nobody said is standing', () => {
    walker = new Walker(config, queue, { notice: (m) => notices.push(m) });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(6000);
    expect(sent).toEqual(['e']);
    expect(walker.progress.reason).toBe(t('automation.walk.reasonTimeout', { command: 'e' }));
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
    expect(w.progress.reason).toBe(t('automation.walk.reasonNotSent', { command: 'e' }));
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
    const w = new Walker(config, held, { onTheGround: () => false });
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

  it('does not give up on a step the server is holding behind the player’s line', () => {
    /*
     * The step is on the wire, then the player starts a gossip. The server
     * backlogs its answer behind the half-typed line (`TGSSocket.Send`) and
     * flushes it on Enter, so neither the nudge nor the give-up is due until
     * the line closes, and both windows start again from then.
     */
    const held = new CommandQueue(config, { send: (command) => sent.push(command) });
    const w = new Walker(config, held, { onTheGround: () => false });
    w.start(ROUTE, at(1, 1));
    expect(sent).toEqual(['e']);
    held.noteTyping(true);

    // Past the nudge and the whole patience, with the line still open.
    vi.advanceTimersByTime(10_000);
    held.noteTyping(true);
    vi.advanceTimersByTime(5_000);
    expect(sent).toEqual(['e']);
    expect(w.progress.status).toBe('walking');

    // Positive control: Enter, then the same silence nudges and gives up.
    held.noteTyping(false);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual(['e', NUDGE]);
    expect(w.progress.status).toBe('walking');
    vi.advanceTimersByTime(5_000);
    expect(w.progress.status).toBe('stopped');
    expect(w.progress.reason).toBe(t('automation.walk.reasonTimeout', { command: 'e' }));
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

  it('nudges a stalled portal step as it nudges any other', () => {
    /*
     * The reprint the Enter asks for cannot spend the coordinates the script
     * stated any more: a block naming the room being left, while the portal's
     * destination is named otherwise, is the step not having landed yet, and
     * the promise waits for the real arrival (todo 808; the tracker's own
     * tests, `a scripted teleport the walker hinted`).
     */
    const PORTAL: Route = {
      ...ROUTE,
      steps: [{ ...ROUTE.steps[0]!, direction: 'portal', command: 'go crimson portal' }]
    };
    walker.start(PORTAL, at(1, 1));
    expect(sent).toEqual(['go crimson portal']);

    vi.advanceTimersByTime(TUNING.walk.nudgeAfterMs + 1);
    expect(sent).toEqual(['go crimson portal', NUDGE]);
    expect(walker.progress.status).toBe('walking');
  });

  /*
   * Except from a room nothing can be seen in: a dark reprint names nothing,
   * so the Enter's answer would still be taken as the landing (todo 808,
   * review). Said, and the step is left to its own deadline.
   */
  it('does not nudge a portal step left from a pitch-black room, and says so', () => {
    const dark = at(1, 1, {
      room: { ...EMPTY_CHARACTER.room, map: 1, number: 1, light: 'pitch black' }
    });
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => dark
    });
    const PORTAL: Route = {
      ...ROUTE,
      steps: [{ ...ROUTE.steps[0]!, direction: 'portal', command: 'go crimson portal' }]
    };
    walker.start(PORTAL, dark);
    expect(sent).toEqual(['go crimson portal']);

    vi.advanceTimersByTime(TUNING.walk.nudgeAfterMs + 1);
    expect(sent).toEqual(['go crimson portal']);
    expect(notices).toContain(t('automation.walk.noNudgeUnseen', { command: 'go crimson portal' }));
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
    expect(w.progress.reason).toBe(t('automation.walk.reasonNotQueued', { command: 'e' }));
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

  /*
   * A route whose first step is through a door the realm says wants item 177.
   * `edgePenalty` only plans one of these once a listing has landed and the
   * pack holds the key, so this is the ordinary shape of a keyed step rather
   * than a corner.
   */
  const KEYED: Route = {
    ...ROUTE,
    steps: [{ ...ROUTE.steps[0]!, requirement: { kind: 'key', raw: 'Key: 177', keyId: 177 } }]
  };

  /*
   * Reported 2026-09-06: two bone keys in the pack, a hundred and forty-three
   * on the floor, and the walk bashed the locked door six times without ever
   * trying the key. The rung goes above pick and bash and answers to neither
   * switch — see `Barriers.force`.
   */
  it('uses the key it is carrying rather than bashing the door', () => {
    const walk = new Walker(
      { ...config, movement: { ...config.movement, bashDoors: true } },
      queue,
      {
        notice: (m) => notices.push(m),
        keyToUse: (id) => (id === 177 ? 'bone key' : null)
      }
    );
    walk.start(KEYED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'use bone key e']);

    /*
     * Unlocked is not open. The key earns the same sentence a successful pick
     * does — `You successfully unlocked the door.`, `Door.TryUnlock` and the
     * pick path share it — so it lands in the machinery that was already
     * there: an `open` first, unconditionally, and then the step again.
     */
    walk.onBlock(block('door-changed', { barrier: 'door', state2: 'unlocked' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'use bone key e', 'open e', 'e']);
    walk.dispose();
  });

  /* A key the pack does not hold is not typed: the rung yields to the ones
     under it rather than sending `use  e`. */
  it('bashes when the key is not in the pack', () => {
    const walk = new Walker(
      { ...config, movement: { ...config.movement, bashDoors: true } },
      queue,
      {
        notice: (m) => notices.push(m),
        keyToUse: () => null
      }
    );
    walk.start(KEYED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'bas e']);
    walk.dispose();
  });

  /*
   * A key that does not match the door answers `Your command had no effect.`
   * — the commonest line in the game after the status line, which is why it
   * moves the ladder on only while this walk has a `use` of its own in flight.
   */
  it('falls through to the next rung when the key does not fit', () => {
    const walk = new Walker(
      { ...config, movement: { ...config.movement, bashDoors: true } },
      queue,
      {
        notice: (m) => notices.push(m),
        keyToUse: () => 'bone key'
      }
    );
    walk.start(KEYED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'use bone key e']);

    walk.onBlock(block('command-no-effect'));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'use bone key e', 'bas e']);
    walk.dispose();
  });

  /* And it is spent once per run of the ladder: a key that did not work will
     not work on being sent again in the same breath. */
  it('does not send the key twice in one run of the ladder', () => {
    const walk = new Walker(
      { ...config, movement: { ...config.movement, bashDoors: false } },
      queue,
      {
        notice: (m) => notices.push(m),
        keyToUse: () => 'bone key'
      }
    );
    walk.start(KEYED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('command-no-effect'));
    vi.advanceTimersByTime(200);
    expect(sent.filter((c) => c.startsWith('use'))).toEqual(['use bone key e']);
    walk.dispose();
  });

  /*
   * The step is no longer queued behind the `open`: the two answers that
   * decide the next rung come back first (`Barriers.sendOpen`). It goes out on
   * the door opening — or, as here, on the deadline that stands in for a
   * success sentence this client did not read.
   */
  it('opens it and takes the step again', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'open e']);

    open.onBlock(block('door-changed', { barrier: 'door', state: 'open' }));
    vi.advanceTimersByTime(200);

    expect(open.progress.status).toBe('walking');
    expect(sent).toEqual(['e', 'open e', 'e']);
    open.dispose();
  });

  /*
   * `The <…> is now open.` is read out of the server's source and only ever
   * captured with `door` in it, so a realm that phrases it some third way
   * would leave the walk waiting on a sentence nothing matches. The deadline
   * sends the step anyway — the behaviour this had before `open` waited for
   * an answer at all, one round trip later.
   */
  it('takes the step anyway when nothing answers the open', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'open e']);

    vi.advanceTimersByTime(TUNING.walk.nudgeAfterMs + 50);
    expect(moves(sent)).toEqual(['e', 'open e', 'e']);
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

  /*
   * A locked gate answers the same way every time, so the budget runs out —
   * and with nothing else turned on the walk **holds** rather than ending. It
   * is a shut door, not a broken route: see `Barriers.holdAtBarrier`.
   */
  it('holds after the tries it was given, and says so once', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    open.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));

    expect(open.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    expect(sent).toEqual(['e', 'open e']);
    expect(notices.at(-1)).toBe(
      t('automation.walk.barrierHolding', {
        barrier: 'gate',
        detail: t('automation.walk.barrierNotAllowed')
      })
    );

    // And the whole ladder again on its own clock, with no second line about
    // the same shut gate.
    const said = notices.length;
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);
    expect(moves(sent)).toEqual(['e', 'open e', 'e']);
    open.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    expect(notices.length).toBe(said);
    open.dispose();
  });

  /*
   * **And the lock is remembered between rounds.** It was not: `forgetBarrier`
   * cleared it on every retry, so the round that follows sent `open` at a gate
   * the server had already called locked — twelve rounds of `e`, `open e`,
   * twenty-four commands to be told twice over what the first two said. The
   * whole exchange was reported off the wire as todo 01 (`Inner Gate`, a gate
   * wanting 301 picklocks, a character with none).
   *
   * The ladder still runs again — a bash or a pick may roll better, and
   * somebody else may walk through — so what this asserts is the *shape* of a
   * round: the direction, and nothing spent on the rung the server has already
   * answered.
   */
  it('never opens again at a gate the server has called locked', () => {
    const open = withMovement({ openDoors: true, openTries: 3 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    open.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    expect(moves(sent)).toEqual(['e', 'open e']);

    for (let round = 0; round < 3; round += 1) {
      vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);
      open.onBlock(block('direction-failed', { barrier: 'gate' }));
      vi.advanceTimersByTime(200);
    }
    // Three more rounds, three more directions, and not one more `open`.
    expect(moves(sent)).toEqual(['e', 'open e', 'e', 'e', 'e']);
    expect(open.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    open.dispose();
  });

  /*
   * `That is not a door or a gate!` is the other `open-failed` shape and says
   * nothing about a lock — the realm data was wrong about the barrier — so the
   * budget is left alone and the next round asks again.
   */
  it('opens again after a refusal that was not about a lock', () => {
    const open = withMovement({ openDoors: true, openTries: 3 });
    open.start(ROUTE, at(1, 1));
    open.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    open.onBlock(block('open-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);
    open.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'open e', 'e', 'open e']);
    open.dispose();
  });

  /* And the rounds are bounded, or an unattended character stands there all
     evening at a door nothing in this client is working on. */
  it('gives up on the door once the rounds are spent', () => {
    const open = withMovement({ openDoors: true, openTries: 1 });
    open.start(ROUTE, at(1, 1));
    for (let round = 0; round <= TUNING.walk.barrierRetries; round += 1) {
      open.onBlock(block('direction-failed', { barrier: 'gate' }));
      vi.advanceTimersByTime(200);
      open.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
      vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);
    }

    expect(open.progress.status).toBe('stopped');
    expect(open.progress.reason).toBe(
      t('automation.walk.reasonBarrier', {
        barrier: 'gate',
        command: 'e',
        detail: t('automation.walk.barrierNotAllowed')
      })
    );
    open.dispose();
  });

  it('holds at a door when it was not asked to open one', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(block('direction-failed', { barrier: 'door' }));

    expect(walker.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
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
    open.onBlock(block('door-changed', { barrier: 'door', state: 'open' }));
    vi.advanceTimersByTime(200);
    open.onCharacter(at(1, 2, { room: { ...EMPTY_CHARACTER.room, map: 1, number: 2 } }));
    vi.advanceTimersByTime(200);
    // The second step's own door, and its own `open`.
    open.onBlock(block('direction-failed', { barrier: 'door' }));
    // Past the pacing window's own timeout: five commands with no prompt to
    // acknowledge them is more credit than the queue holds, which is the
    // queue's job and not this one's.
    vi.advanceTimersByTime(3000);

    expect(sent).toEqual(['e', 'open e', 'e', 'e', 'open e', 'e']);
    open.dispose();
  });
});

/*
 * The room has already said the door is shut.
 *
 * todo 01, reported off the wire: `Obvious exits: north, closed door south`,
 * and the client sent `s` to be told `The door is closed!`. The step was a
 * command spent on a fact the room block already carried — the same argument
 * `mustSearchFirst` makes about a hidden exit the room has not printed.
 */
describe('a door the room has already said is shut', () => {
  const withMovement = (over: Partial<AutomationConfig['movement']>, state: CharacterState) =>
    new Walker({ ...config, movement: { ...config.movement, ...over } }, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => state
    });

  /** Standing in 1/1 with the room's `Obvious exits:` line as given. */
  const printing = (...exits: Array<[string, string | null]>): CharacterState =>
    at(1, 1, {
      room: {
        ...structuredClone(EMPTY_CHARACTER.room),
        map: 1,
        number: 1,
        exits: exits.map(([direction, note]) => wireExit(direction, note))
      }
    });

  it('opens it instead of spending the step to be refused', () => {
    const shut = printing(['n', null], ['e', 'closed door']);
    const walk = withMovement({ openDoors: true, openTries: 1 }, shut);
    walk.start(ROUTE, shut);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['open e']);
    walk.dispose();
  });

  /* And the step goes out on the door opening, exactly as the reactive rung
     leaves it — one command shorter. */
  it('takes the step once the door answers', () => {
    const shut = printing(['e', 'closed gate']);
    const walk = withMovement({ openDoors: true, openTries: 1 }, shut);
    walk.start(ROUTE, shut);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['open e']);

    walk.onBlock(block('door-changed', { barrier: 'gate', state: 'open' }));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['open e', 'e']);
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });

  /* A door the room says is open is not opened again: `open` at one answers
     `The door is already open.` and buys nothing. */
  it('walks straight through a door the room says is open', () => {
    const ajar = printing(['e', 'open door']);
    const walk = withMovement({ openDoors: true, openTries: 1 }, ajar);
    walk.start(ROUTE, ajar);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /* A room whose exits were never read proves nothing — a blinding room prints
     no list at all, and the refusal is answered the way it always was. */
  it('does not read an empty exit list as a shut door', () => {
    const dark = printing();
    const walk = withMovement({ openDoors: true, openTries: 1 }, dark);
    walk.start(ROUTE, dark);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /* The switch is the switch. With `openDoors` off nothing is sent at the
     door, pre-emptively or otherwise. */
  it('sends the step when it was not asked to open doors', () => {
    const shut = printing(['e', 'closed door']);
    const walk = withMovement({ openDoors: false }, shut);
    walk.start(ROUTE, shut);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /*
   * And a door the server has called locked is not opened again on the barrier
   * round's retry: the room block still says `closed door`, because it does not
   * reprint, and `open` at a lock answers the same word every time. The step
   * falls through so `onRefusedStep` reaches the forcing rungs as before.
   */
  it('does not open a door it has been told is locked', () => {
    const shut = printing(['e', 'closed door']);
    const walk = withMovement({ openDoors: true, openTries: 1 }, shut);
    walk.start(ROUTE, shut);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['open e']);

    walk.onBlock(block('open-failed', { barrier: 'door', reason: 'locked' }));
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);

    expect(moves(sent)).toEqual(['open e', 'e']);
    walk.dispose();
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
      notice: (m) => notices.push(m),
      // Standing: these walks are nudged, which only a character up may be (todo 764).
      onTheGround: () => false
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
    // `The door is locked.` — opening is spent, whatever the budget said, and
    // the move that used to be queued behind the `open` is never sent.
    walk.onBlock(block('open-failed', { barrier: 'door', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    // One `open`, not three, and no second `e`. What it did not send is the
    // point of the whole change.
    expect(sent).toEqual(['e', 'open e']);
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
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
    vi.advanceTimersByTime(200);

    // Straight from the locked answer to the bash: no move spent on a door
    // the client has just been told is locked.
    expect(sent).toEqual(['e', 'open e', 'bas e']);

    // `Your attempts to bash through fail!` — one more, and no more than that.
    walk.onBlock(block('bash-failed'));
    // Past the pacing window's own timeout: four commands with no prompt to
    // acknowledge them is more credit than the queue holds, which is the
    // queue's business and not this one's.
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'bas e', 'bas e', NUDGE]);

    /*
     * `You bashed the door open.` The barrier is open and the character has
     * not moved (`captures/005`), so the direction goes out again — and
     * nothing is opened, because a bashed door is open already.
     */
    walk.onBlock(block('door-changed', { barrier: 'door', state: 'open' }));
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'bas e', 'bas e', NUDGE, 'e', NUDGE]);
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
    vi.advanceTimersByTime(200);

    // Strength is well past the number and picklocks only just inside it, and
    // the pick still goes first: it is the attempt that costs no health.
    expect(sent).toEqual(['e', 'open e', 'pi e']);

    // `Your skill fails you this time.` — the same sentence a failed disarm
    // gets, read as a pick only because the walker asked the question.
    walk.onBlock(block('skill-failed'));
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['e', 'open e', 'pi e', 'pi e', NUDGE]);

    /*
     * `You successfully unlocked the door.` — unlocked and still shut, so an
     * `open` goes first. That `open` is a rung like any other now, so the step
     * follows its answer rather than being queued blind behind it.
     */
    walk.onBlock(block('door-changed', { barrier2: 'door', state2: 'unlocked' }));
    vi.advanceTimersByTime(3000);
    expect(moves(sent)).toEqual(['e', 'open e', 'pi e', 'pi e', 'open e', 'e']);
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
    // Every rung spent, so it waits at the door rather than ending the
    // journey — and it says which door and what it wanted, rather than `the
    // game refused e`.
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    // The failed rung names no barrier of its own, so the dictionary's word stands in.
    expect(notices.at(-1)).toBe(
      t('automation.walk.barrierHolding', {
        barrier: t('automation.walk.fallbackBarrier'),
        detail: t('automation.walk.barrierHeld')
      })
    );
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
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    walk.dispose();
  });

  it('refuses when the character is not close enough, and says the numbers', () => {
    const walk = forcing({ bashDoors: true, bashTries: 3, pickLocks: true, pickTries: 3 });
    walk.start(gated(door({ pickDifficulty: 1000, bashDifficulty: 1000 })), skilled(30, 10));
    walk.onCharacter(skilled(30, 10));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));

    expect(sent).toEqual(['e']);
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    expect(notices.at(-1)).toBe(
      t('automation.walk.barrierHolding', {
        barrier: 'door',
        detail: t('automation.walk.barrierTooHard', { wanted: 1000, picklocks: 10, strength: 30 })
      })
    );
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
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    walk.dispose();
  });

  /*
   * A bash is the one rung paid for in hit points — `You take 1 damage for
   * bashing the gate!` — and the ladder now repeats, so without this a
   * character can knock itself out at a door with nothing else in the room
   * threatening it. `restBelow` is the figure that already says this character
   * does not travel below this.
   */
  it('will not spend a bash while the character is under the travel floor', () => {
    const hurt = (fraction: number): CharacterState => {
      const state = skilled(400, 0);
      return { ...state, vitals: { ...state.vitals, hp: fraction * 100, hpMax: 100 } };
    };
    const walk = new Walker(
      { ...config, movement: { ...config.movement, bashDoors: true, bashTries: 3 } },
      queue,
      {
        notice: (m) => notices.push(m),
        stateNow: () => hurt(0.2)
      }
    );
    // A loop's leg: `holdWhenHurt` off, because `LoopRunner` holds the lap
    // between legs. That is the walk this gate exists for — within a leg
    // nothing else is watching the health.
    walk.start(gated(door({ bashDifficulty: 41 })), hurt(0.2), { holdWhenHurt: false });
    walk.onCharacter(hurt(0.2));
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    // Nothing bashed, and it waits at the door instead of ending the journey:
    // the health is what the wait is for.
    expect(sent).toEqual(['e']);
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    walk.dispose();
  });

  it('bashes once the health is back', () => {
    let fraction = 0.2;
    const state = (): CharacterState => {
      const base = skilled(400, 0);
      return { ...base, vitals: { ...base.vitals, hp: fraction * 100, hpMax: 100 } };
    };
    const walk = new Walker(
      { ...config, movement: { ...config.movement, bashDoors: true, bashTries: 3 } },
      queue,
      {
        notice: (m) => notices.push(m),
        stateNow: () => state()
      }
    );
    walk.start(gated(door({ bashDifficulty: 41 })), state(), { holdWhenHurt: false });
    walk.onCharacter(state());
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e']);

    fraction = 0.9;
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);

    expect(moves(sent)).toEqual(['e', 'e', 'bas e']);
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

  /*
   * `SneakCommand.cs` rolls the sheet's Stealth figure against 1–100, so a
   * sheet that says `Stealth: 0` never passes — and a Mage rerolled from a
   * Ninja kept `movement.sneak` and spent one refused `sn` on every step of
   * every lap (todo 104). Said once; an unread figure still asks.
   */
  it('never asks a sheet that says Stealth 0 to sneak, and says so once', () => {
    const walk = sneaking();
    const base = at(1, 1);
    const noSkill = { ...base, progress: { ...base.progress, stealthSkill: 0 } };
    walk.start(ROUTE, noSkill);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e']);
    expect(notices.filter((line) => line === t('automation.walk.sneakNoSkill'))).toHaveLength(1);
    // The next step asks nothing and says nothing more.
    walk.onCharacter({ ...noSkill, room: { ...noSkill.room, number: 2 } });
    vi.advanceTimersByTime(200);
    expect(notices.filter((line) => line === t('automation.walk.sneakNoSkill'))).toHaveLength(1);
    walk.dispose();
  });

  it('still asks while the sheet has not said', () => {
    const walk = sneaking();
    const base = at(1, 1);
    walk.start(ROUTE, { ...base, progress: { ...base.progress, stealthSkill: null } });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['sn', 'e']);
    walk.dispose();
  });

  /*
   * `SneakCommand` does everything it does inside `if (CurrentTarget == null
   * && Room.Mobs.Count == 0)`; the `else` is one line refusing. So an `sn`
   * sent from a room with a monster in it is a command spent to be refused —
   * out of the budget the fight in that room is about to be fought with — and
   * it breaks the character's rest on the way past, because `SneakCommand`
   * clears `Resting` before it gets as far as saying no.
   */
  it('does not spend a sneak the server would refuse', () => {
    const walk = sneaking();
    walk.start(
      ROUTE,
      at(1, 1, {
        room: {
          ...structuredClone(EMPTY_CHARACTER.room),
          map: 1,
          number: 1,
          occupants: [
            {
              name: 'giant rat',
              kind: 'mob',
              disposition: 'hostile',
              uncertain: false,
              costly: 'never',
              hidden: false,
              free: false,
              charmed: false
            }
          ]
        }
      })
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /*
   * A person in the room is no bar to it, and that is the server's rule rather
   * than a kindness: `Room.Mobs` holds monsters only.
   */
  /*
   * The door work the walk does itself breaks stealth (`Door.cs` calls
   * `BreakStealth()` beside every sentence that moves a barrier), and the
   * retry behind the door is not a *fresh* send — so before 2026-09-11 the
   * ask never happened and the character stepped through in plain sight.
   * Reported with the transcript in todo 01.
   */
  it('sneaks again behind a door it just opened', () => {
    let now = at(1, 1, { stealth: 'sneaking' });
    const walk = new Walker(
      {
        ...config,
        movement: { ...config.movement, sneak: true, openDoors: true, openTries: 1 }
      },
      queue,
      { notice: (m) => notices.push(m), stateNow: () => now }
    );
    walk.start(ROUTE, now);
    vi.advanceTimersByTime(200);
    // Already sneaking, so the first step costs no `sn`.
    expect(sent).toEqual(['e']);

    // `The door is closed!`, and then the `open` that answers it.
    walk.onBlock(block('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'open e']);

    // `The door is now open.` — and the tracker has said what opening it did.
    now = at(1, 1, { stealth: 'seen' });
    walk.onBlock(block('door-changed', { barrier: 'door', state: 'open' }));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['e', 'open e', 'sn', 'e']);
    walk.dispose();
  });

  it('still sneaks with only a player in the room', () => {
    const walk = sneaking();
    walk.start(
      ROUTE,
      at(1, 1, {
        room: {
          ...structuredClone(EMPTY_CHARACTER.room),
          map: 1,
          number: 1,
          occupants: [
            {
              name: 'Soul',
              kind: 'player',
              disposition: null,
              uncertain: false,
              costly: 'never',
              hidden: false,
              free: false,
              charmed: false
            }
          ]
        }
      })
    );
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(['sn', 'e']);
    walk.dispose();
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
    walker = new Walker(config, queue, {
      holdAt: (state) => state.room.number === 1,
      willFight: () => true
    });
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
    walker = new Walker(config, queue, {
      holdAt: (state) => state.room.number !== 1,
      willFight: () => true
    });
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

/*
 * The room the character walks *into* is described before whatever followed it
 * in has arrived, so a walk that decides on the room block alone steps out of
 * a room it has not finished being told about — see `Walker.settleForFollowers`
 * for the capture and the server's own `Exits.cs:165`.
 */
describe('stepping out of a room something may have followed into', () => {
  /** A monster on the room's `Also here:` line. */
  const mob = (name: string) => ({
    name,
    kind: 'mob' as const,
    disposition: 'hostile' as const,
    uncertain: false,
    costly: 'never' as const,
    hidden: false,
    free: false,
    charmed: false
  });

  /** A room holding those occupants. */
  const holding = (map: number, number: number, ...names: string[]) =>
    at(map, number, {
      room: {
        ...structuredClone(EMPTY_CHARACTER.room),
        map,
        number,
        occupants: names.map(mob)
      }
    });

  /*
   * Auto-combat as it was on the walk this was reported from: standing down in
   * the corridor the character is walking out of — it is the room *ahead* that
   * has to be re-read, and a `holdAt` that answered yes in the start room would
   * assert the ordinary quarry beat instead of this.
   */
  function walking(world: () => CharacterState): Walker {
    return new Walker(config, queue, {
      stateNow: world,
      holdAt: (state) => state.room.number === 2 && state.room.occupants.length > 0
    });
  }

  /*
   * The reported failure, in the shape the capture has it
   * (`2026-09-23_09-33-51_festus.mudcap.jsonl`, t=1678757): saracens in the
   * room the step is leaving, a room block for the room ahead with nothing on
   * it, and the arrival sentences in the same read one statement later. The
   * step must not be on the wire before they are on the list.
   */
  it('does not step out before the followers are on the list', () => {
    let world = at(1, 1);
    walker = walking(() => world);
    walker.start(ROUTE, world);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);

    // `A tall saracen leader charges in from the east!`, with `e` in flight.
    world = holding(1, 1, 'tall saracen leader', 'angry saracen raider');
    walker.onCharacter(world);

    // The room ahead, as the server described it: empty, and about to not be.
    world = at(1, 2);
    walker.onCharacter(world);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);

    /*
     * The rest of the same read. The step out is now the ordinary quarry beat's
     * to hold — bounded by `walk.maxHolds` like every other, which is what the
     * beat's own test asserts; what this one asserts is that the decision was
     * taken against the room the arrival sentences left rather than the room
     * block that preceded them.
     */
    world = holding(1, 2, 'tall saracen leader', 'angry saracen raider');
    walker.onCharacter(world);
    vi.advanceTimersByTime(TUNING.walk.holdMs);
    expect(sent).toEqual(['e']);
    expect(walker.progress.done).toBe(1);
  });

  /*
   * The positive control on the cost: nothing can follow out of an empty room,
   * so an ordinary corridor pays nothing at all for the settle above.
   */
  it('steps straight out of a room it left empty', () => {
    let world = at(1, 1);
    walker = walking(() => world);
    walker.start(ROUTE, world);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);

    world = at(1, 2);
    walker.onCharacter(world);
    expect(sent).toEqual(['e', 'e']);
  });

  /*
   * And the bound: a monster that did not follow costs the walk the window and
   * no more. Outside `maxHolds`, which bounds a beat waiting for a quarry to be
   * engaged rather than one waiting for the server's sentence to finish.
   */
  it('walks on when the window passes and nothing followed', () => {
    let world = at(1, 1);
    walker = walking(() => world);
    walker.start(ROUTE, world);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);

    world = holding(1, 1, 'tall saracen leader');
    walker.onCharacter(world);
    world = at(1, 2);
    walker.onCharacter(world);

    vi.advanceTimersByTime(TUNING.walk.followSettleMs - 10);
    expect(sent).toEqual(['e']);
    vi.advanceTimersByTime(20);
    expect(sent).toEqual(['e', 'e']);
  });

  /*
   * And not inside a passage the realm casts a timed spell over (todo 104),
   * where `holdBeforeSending` has already returned early for every other hold.
   * Nothing in there will fight what followed, the spell is the deadline, and
   * a third of a second a room is held breath bought for no decision.
   */
  it('takes no settle under a timed spell', () => {
    let world = at(1, 1);
    walker = new Walker(config, queue, {
      stateNow: () => world,
      moveOnly: () => true,
      holdAt: (state) => state.room.number === 2 && state.room.occupants.length > 0
    });
    walker.start(ROUTE, world);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['e']);

    world = holding(1, 1, 'tall saracen leader');
    walker.onCharacter(world);
    world = at(1, 2);
    walker.onCharacter(world);
    expect(sent).toEqual(['e', 'e']);
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

  it('searches for it, holds, and sends the step again', () => {
    walker.start(hidden, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed'));
    expect(walker.progress.hold).toBe('searching');

    vi.advanceTimersByTime(TUNING.walk.searchRetryMs + 50);
    expect(sent).toEqual(['e', 'search e', 'e']);
    expect(walker.progress.status).toBe('walking');
  });

  /*
   * And it says so again on a slow clock. The barrier's hold says its line
   * once because it lasts a round and then ends the walk; this one has no
   * ceiling, so said once the reason a character is standing in a corridor at
   * 3am is a line eight hours up the scrollback.
   */
  it('repeats why it is standing still, on a slow clock', () => {
    const held = printing(['n', null]);
    const walk = new Walker(config, queue, {
      notice: (message) => notices.push(message),
      stateNow: () => held
    });
    walk.start(hidden, held);
    vi.advanceTimersByTime(TUNING.walk.searchRetryMs * 4);
    // Four searches, one line: it is not one per round.
    expect(
      notices.filter(
        (line) => line === t('automation.walk.searchHolding', { stepName: 'Second Room' })
      )
    ).toHaveLength(1);

    vi.advanceTimersByTime(TUNING.walk.searchSayEveryMs);
    expect(
      notices.filter(
        (line) => line === t('automation.walk.searchHolding', { stepName: 'Second Room' })
      ).length
    ).toBeGreaterThan(1);
    walk.dispose();
  });

  it('does not blame the edge while it is searching', () => {
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

  /*
   * And it **keeps** searching — todo 04, reported 2026-09-06.
   *
   * It used to give up after `searchTries` and strike the edge out, which is
   * the reported transcript exactly: two searches at Outer Keep 1/1368, the
   * route stopped, the corridor blacklisted, and a hand-typed `sea s` a moment
   * later answering `You found an exit to the south!`. The realm's own data
   * says a search reveals this one, so a client that stops asking has decided
   * the realm is wrong on two rolls of a skill check.
   */
  it('goes on searching rather than giving up and blaming the corridor', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(hidden, at(1, 1));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.advanceTimersByTime(50);
      pending = 1;
      walker.onBlock(block('direction-failed'));
      pending = 0;
      vi.advanceTimersByTime(TUNING.walk.searchRetryMs + 50);
    }

    expect(sent.filter((command) => command === 'search e').length).toBeGreaterThan(2);
    // Never written down: the refusal is the step the realm data described,
    // and a corridor struck out is one no route can use for the session.
    expect(refused).toEqual([]);
    // And the walk is still alive, which is the whole of what was asked for.
    expect(walker.progress.status).toBe('walking');
  });

  /*
   * *"Do not try the direction first unless it is available."* A found exit
   * joins the room's own `Obvious exits:` line — `secret passage south`, read
   * as `s` — so the room answers *is it open yet* and the step is not spent on
   * a wall the client already knows about.
   */
  /** Standing in 1/1 with the room's `Obvious exits:` line as given. */
  const printing = (...exits: Array<[string, string | null]>): CharacterState =>
    at(1, 1, {
      room: {
        ...structuredClone(EMPTY_CHARACTER.room),
        map: 1,
        number: 1,
        exits: exits.map(([direction, note]) => wireExit(direction, note))
      }
    });

  it('searches before the step when the room has not printed the exit', () => {
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(hidden, unfound);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['search e']);
    expect(walk.progress.hold).toBe('searching');
    walk.dispose();
  });

  /* And once it is printed, the step goes out with no search at all — which is
     what keeps a lap from paying for the same exit every time round. */
  it('sends the step straight away once the room prints the exit', () => {
    const found = printing(['e', 'secret passage']);
    const walk = new Walker(config, queue, { stateNow: () => found });
    walk.start(hidden, found);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /* A room the server would not describe prints no list, and an empty one is
     not a claim that the exit is missing. */
  it('does not read a dark room’s empty exit list as the exit being absent', () => {
    const dark = printing();
    const walk = new Walker(config, queue, { stateNow: () => dark });
    walk.start(hidden, dark);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /*
   * ------------------------------------------------ the room is asked again
   *
   * todo 03, reported off the wire: eleven `search s` at `Outer Keep,
   * Intersection`, seven of them answered `You found an exit to the south!`,
   * and not one step taken. The exit was found on the **first** one — and the
   * server does not reprint the room when it finds you an exit, so the
   * `Obvious exits: north, east, west` on screen never gained a south and
   * `mustSearchFirst` went on holding against a line the server had already
   * superseded.
   */
  it('asks the server to reprint the room when the search succeeds', () => {
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(hidden, unfound);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['search e']);

    walk.onBlock(block('user-search-succeeded', { direction: 'east' }));
    // A bare Enter, never `l`: a look announces itself to everybody in the room.
    expect(sent).toEqual(['search e', NUDGE]);
    walk.dispose();
  });

  /*
   * And the reprint gets a beat of its own rather than what is left of the
   * search's. A search is answered in about a round, so the remainder would
   * often be too short and the re-ask would send another search at a room whose
   * answer was still on the wire — which is the loop this exists to end.
   */
  it('measures the next beat from the reprint, not from the search', () => {
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(hidden, unfound);
    vi.advanceTimersByTime(TUNING.walk.searchRetryMs - 200);
    walk.onBlock(block('user-search-succeeded', { direction: 'east' }));
    // The search's own beat would have expired here, and nothing happens: the
    // reprint took the clock with it.
    vi.advanceTimersByTime(300);
    expect(sent).toEqual(['search e', NUDGE]);
    // And at the end of the reprint's own beat the **step** goes out, because
    // the server has said it found the exit. See `found`.
    vi.advanceTimersByTime(TUNING.walk.searchRetryMs);
    expect(sent).toEqual(['search e', NUDGE, 'e']);
    walk.dispose();
  });

  /*
   * **The server's own word is what ends the searching**, not the room's exit
   * list — which the client cannot always read. `You found an exit downwards!`
   * (`captures/005:187`) is the corpus's only successful search: it says
   * neither `down` nor `d`, and the exit it reveals prints as `open trap door
   * below`, a shape `parseExit` had no word for. Without this the walk searched
   * every 1.5s for ever, said so once every five minutes, and wrote nothing
   * down — the search rung has no ceiling (todo 04) and blames no edge.
   */
  it('stops searching on the server’s word, whatever the room lists', () => {
    const down: Route = {
      ...ROUTE,
      steps: [
        {
          ...ROUTE.steps[0]!,
          direction: 'd',
          command: 'd',
          requirement: { kind: 'hidden', raw: 'Hidden/Searchable', searchable: true }
        }
      ]
    };
    // The room lists the trapdoor the way the corpus shows it, which is a
    // direction the exit list alone would never match against `d`… except that
    // `parseExit` reads `below` now, so the fixture states the harder case: a
    // room that has not printed it at all.
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(down, unfound);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['search d']);

    walk.onBlock(block('user-search-succeeded', { direction: 'downwards' }));
    vi.advanceTimersByTime(TUNING.walk.searchRetryMs + 50);
    expect(sent).toEqual(['search d', NUDGE, 'd']);
    walk.dispose();
  });

  /*
   * And once that reprint lands with the exit in it, the step goes out — which
   * is the whole of what was stuck. Belt and braces beside `found`: this is the
   * path a lap takes on its *second* time round, where nothing searched at all
   * because the room printed the exit from the start.
   */
  it('takes the step once the reprinted room carries the exit', () => {
    let room = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => room });
    walk.start(hidden, room);
    vi.advanceTimersByTime(50);
    walk.onBlock(block('user-search-succeeded', { direction: 'east' }));
    room = printing(['n', null], ['e', 'secret passage']);
    vi.advanceTimersByTime(TUNING.walk.searchRetryMs + 50);

    expect(sent).toEqual(['search e', NUDGE, 'e']);
    expect(walk.progress.hold).toBe(null);
    walk.dispose();
  });

  /*
   * A failure asks too, every `searchRecheckEvery`th time — the other half of
   * what was asked for. A success can be missed two ways: the sentence arriving
   * in a burst while the walk was not holding, and somebody else opening the
   * way. The room is the only thing that settles either.
   */
  it('asks for a reprint every few failed searches, and not on the ones between', () => {
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(hidden, unfound);
    const every = TUNING.walk.searchRecheckEvery;
    // The first search goes out with the walk; the cadence is counted over the
    // *answers*, which is what the setting says.
    for (let answered = 1; answered <= every; answered += 1) {
      walk.onBlock(block('user-search-failed', { direction: 'east' }));
      expect(sent.filter((command) => command === NUDGE).length).toBe(answered === every ? 1 : 0);
      vi.advanceTimersByTime(TUNING.walk.searchRetryMs + 50);
    }
    walk.dispose();
  });

  /*
   * A search the *player* typed in some other direction is not this step's
   * news, and the server names the direction it searched.
   */
  it('ignores a search answered about another direction', () => {
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(hidden, unfound);
    vi.advanceTimersByTime(50);
    walk.onBlock(block('user-search-succeeded', { direction: 'south' }));

    expect(sent).toEqual(['search e']);
    walk.dispose();
  });

  /*
   * `Your search revealed nothing.` names no direction at all, and the walk is
   * holding on a search of its own — so it counts as this step's, which is the
   * behaviour before the direction was captured.
   */
  it('counts a directionless failure as this step’s', () => {
    const unfound = printing(['n', null]);
    const walk = new Walker(config, queue, { stateNow: () => unfound });
    walk.start(hidden, unfound);
    for (let answered = 0; answered < TUNING.walk.searchRecheckEvery; answered += 1) {
      walk.onBlock(block('user-search-failed'));
      vi.advanceTimersByTime(TUNING.walk.searchRetryMs + 50);
    }
    expect(sent.filter((command) => command === NUDGE).length).toBe(1);
    walk.dispose();
  });

  /* And a search answered while the walk is not searching is nobody's news. */
  it('does nothing with a search answer when it is not holding for one', () => {
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(block('user-search-succeeded', { direction: 'east' }));
    expect(sent).toEqual(['e']);
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
 * The other kind of hidden exit — todo 01, reported 2026-09-06.
 *
 * The realm said a concealed passage led south out of Small Chamber 10/4 and
 * said, in the room's own `W` column, that `pull lever` opened it. The
 * converter had dropped every one of those columns since it was written, so the
 * walk sent `s`, was told `There is no exit in that direction!` exactly as the
 * data said it would be, and struck a real corridor out of every route for the
 * session. Format 23 reads them; this is the rung that acts on them, and it is
 * `searchFor`'s in every respect that matters.
 */
describe('a hidden exit a lever opens', () => {
  const levered = (
    actions: Array<{ say: string[]; at?: { map: number; room: number } }>
  ): Route => ({
    ...ROUTE,
    steps: [
      {
        ...ROUTE.steps[0]!,
        requirement: {
          kind: 'hidden',
          raw: 'Hidden/Needs 1 Actions, any order',
          searchable: false,
          actionsNeeded: actions.length,
          actions
        }
      }
    ]
  });

  /** Standing in 1/1 with the room's `Obvious exits:` line as given. */
  const printing = (...exits: Array<[string, string | null]>): CharacterState =>
    at(1, 1, {
      room: {
        ...structuredClone(EMPTY_CHARACTER.room),
        map: 1,
        number: 1,
        exits: exits.map(([direction, note]) => wireExit(direction, note))
      }
    });

  it('pulls the lever before the step when the room has not printed the exit', () => {
    const unrevealed = printing(['n', null]);
    walker.start(levered([{ say: ['pull lever', 'move lever'] }]), unrevealed);
    vi.advanceTimersByTime(50);

    // The lever is pulled first, and the step queued behind it: no initial 'e' into the wall.
    expect(sent).toEqual(['pull lever', 'e']);
    expect(walker.progress.status).toBe('walking');
  });

  it('pulls several in order before the step when the exit is not printed', () => {
    const unrevealed = printing(['n', null]);
    walker.start(levered([{ say: ['twist knot'] }, { say: ['push knot'] }]), unrevealed);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['twist knot', 'push knot', 'e']);
  });

  it('sends the step straight away without pulling the lever when the exit is already printed', () => {
    const revealed = printing(['n', null], ['e', 'secret passage']);
    walker.start(levered([{ say: ['pull lever'] }]), revealed);
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['e']);
  });

  it('pulls the lever reactively when the room exit list was empty', () => {
    walker.start(levered([{ say: ['pull lever', 'move lever'] }]), at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed'));
    vi.advanceTimersByTime(200);

    // The realm's own spelling, not a synonym: it lists its own first.
    expect(sent).toEqual(['e', 'pull lever', 'e']);
    expect(walker.progress.status).toBe('walking');
  });

  /* `specific order` wants them in the realm's `Action#n` order, which is what
     `Requirement.actions` is sorted in; `any order` does not care, so one
     order serves both. */
  it('pulls several in the realm’s own order', () => {
    walker.start(levered([{ say: ['twist knot'] }, { say: ['push knot'] }]), at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onBlock(block('direction-failed'));
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['e', 'twist knot', 'push knot', 'e']);
  });

  it('does not blame the edge while the levers are unspent', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(levered([{ say: ['pull lever'] }]), at(1, 1));
    vi.advanceTimersByTime(50);
    pending = 1;
    walker.onBlock(block('direction-failed'));

    expect(refused).toEqual([]);
  });

  /*
   * A lever two rooms away is a detour this planner does not plan — so nothing
   * is sent, and the edge is **never** blamed: the client has not done its part
   * and has no way to, so the refusal says nothing about the corridor. Writing
   * it down is what took a real way out of every route for the session.
   */
  it('sends nothing for a lever in another room, and blames the edge', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    walker.start(levered([{ say: ['pull lever'], at: { map: 1, room: 1339 } }]), at(1, 1));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.advanceTimersByTime(50);
      pending = 1;
      walker.onBlock(block('direction-failed'));
    }

    expect(sent).toEqual(['e']);
    // Blamed: the levers are two rooms away and this planner does not detour,
    // so the leg would be replanned into the same refusal for ever.
    expect(refused).toEqual(['1/1|e']);
    expect(walker.progress.status).toBe('stopped');
  });

  /*
   * But `Hidden/Passable` — 1,000 of the shipped realm's 1,469 hidden exits —
   * **is** blamed, as it always was. That is the realm saying the exit works,
   * so a refusal there is precisely the realm-file-versus-live-server
   * disagreement `refusedEdges` records. An earlier cut of this exempted every
   * hidden exit and would have left a lap replanning the identical refused leg
   * until the loop gave up.
   */
  it('still blames a hidden exit the realm says simply works', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
    const passable: Route = {
      ...ROUTE,
      steps: [
        {
          ...ROUTE.steps[0]!,
          requirement: { kind: 'hidden', raw: 'Hidden/Passable', searchable: false }
        }
      ]
    };
    walker.start(passable, at(1, 1));
    vi.advanceTimersByTime(50);
    pending = 1;
    walker.onBlock(block('direction-failed'));

    expect(sent).toEqual(['e']);
    expect(refused).toEqual(['1/1|e']);
  });

  /*
   * And one the realm names no reachable lever for **is** blamed, on the same
   * rule: a refusal is not news only while the client still has something to
   * try, and here it has nothing. A route through it is a leg that fails
   * again, which is what `refusedEdges` exists to stop being replanned.
   */
  it('blames an exit whose levers it cannot reach', () => {
    const refused: string[] = [];
    let pending = 0;
    walker = new Walker(config, queue, {
      refused: (from, direction) => refused.push(`${from}|${direction}`),
      pendingMoves: () => pending
    });
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
    pending = 1;
    walker.onBlock(block('direction-failed'));

    expect(refused).toEqual(['1/1|e']);
  });

  /* Bounded, exactly as the searches are: one exit is worth so many rounds. */
  it('stops pulling once the budget is spent', () => {
    let pending = 0;
    walker = new Walker(config, queue, { pendingMoves: () => pending });
    walker.start(levered([{ say: ['pull lever'] }]), at(1, 1));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.advanceTimersByTime(50);
      pending = 1;
      walker.onBlock(block('direction-failed'));
    }

    expect(sent.filter((command) => command === 'pull lever')).toHaveLength(2);
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
    expect(walker.progress.reason).toBe(
      t('automation.walk.reasonDarkUnresolved', { lightLevel: 'pitch black' })
    );
    expect(notices).not.toContain(
      t('automation.walk.stopped', { reason: t('automation.walk.reasonTimeout', { command: 'e' }) })
    );
  });

  /*
   * And it waits where a light is coming, which is the ordinary case: a
   * blinding room prints no block at all, `AutoLight` lights a torch and looks
   * again, and the walker is asked one statement *before* it on the same state
   * (`SessionManager.onCharacter`). Live 2026-09-15, the walk ended 1ms before
   * `light torch` went out and 145ms before the room came back readable.
   */
  it('waits for a light that is coming, and walks on once the room can be read', () => {
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightComing: () => true
    });
    walk.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walk.onCharacter(
      at(null, null, { room: { ...structuredClone(EMPTY_CHARACTER.room), light: 'very dark' } })
    );

    expect(walk.progress.status).toBe('walking');
    expect(walk.progress.hold).toBe('dark');
    expect(notices).toContain(t('automation.walk.holdingDark'));

    // The torch is lit, the look comes back, and the room is the step's answer.
    walk.onCharacter(at(1, 2));
    vi.advanceTimersByTime(50);
    expect(moves(sent)).toEqual(['e', 'e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  /* Bounded: past the window the room is dark for a reason no light fixes. */
  it('gives up with the darkness once the window is spent', () => {
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightComing: () => true
    });
    walk.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walk.onCharacter(
      at(null, null, { room: { ...structuredClone(EMPTY_CHARACTER.room), light: 'very dark' } })
    );
    vi.advanceTimersByTime(TUNING.walk.lightWaitMs + 50);

    expect(walk.progress.status).toBe('stopped');
    expect(walk.progress.reason).toBe(
      t('automation.walk.reasonDarkUnresolved', { lightLevel: 'very dark' })
    );
    walk.dispose();
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
 * A room script names its landing per branch — `9/1291`'s `go portal` goes to
 * `9/1424` on `checkability 133 5` and names no room at all on the two
 * branches below it — and the router takes the landing it has with the guard
 * it cannot evaluate on `Requirement.unread`. So a step whose condition failed
 * puts the character somewhere the plan never named, which is the one outcome
 * the plan already admitted it could not predict.
 *
 * Live 2026-09-15: a character at rank 4 stepped into the portal, landed in
 * the Caves of Chaos two maps away, and the journey ended *That is not where
 * the route says you should be*.
 */
describe('a gate the router could not read', () => {
  const GATED: Route = {
    ...ROUTE,
    steps: [
      {
        ...ROUTE.steps[0]!,
        direction: 'portal',
        command: 'go portal',
        requirement: {
          kind: 'text',
          raw: 'go portal; checkability 133 5',
          commands: ['go portal'],
          unread: ['checkability 133 5']
        }
      },
      ROUTE.steps[1]!
    ]
  };

  /*
   * And the count is the *journey's*, across the redraw (todo 03). Reported
   * as: a ninety-five step walk to the Bank of Khazard said `2/15` after the
   * first monster, because a redrawn plan starts its own index at zero.
   */
  it('keeps counting the journey when the plan is drawn again', () => {
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      replan: () => ({
        cost: 1,
        blocked: false,
        steps: [{ ...ROUTE.steps[1]!, from: '9/1322', to: '1/3' }]
      })
    });
    walk.start(GATED, at(1, 1));
    vi.advanceTimersByTime(50);
    expect(walk.progress).toMatchObject({ done: 0, total: 2 });
    /*
     * The draw puts the character somewhere the plan never named, so the way
     * on is redrawn as one step. Nothing was *confirmed* — the landing is not
     * a room the plan holds — so the journey is still `0` walked, and the
     * total is what is left rather than having shrunk to a plan of its own.
     */
    walk.onCharacter(at(9, 1322));
    vi.advanceTimersByTime(50);
    expect(walk.progress).toMatchObject({ done: 0, total: 1 });
    walk.dispose();
  });

  /*
   * And the case it was reported from: steps walked *before* the redraw.
   *
   * The gate is the third step here, so two ordinary ones land first. Before
   * todo 03 the redraw published `0 of 1` about a journey three steps long
   * with two of them behind it — the leg's arithmetic, not the journey's.
   */
  it('counts the steps walked before the plan was drawn again', () => {
    const LATER: Route = {
      ...ROUTE,
      steps: [
        ROUTE.steps[0]!,
        { ...ROUTE.steps[1]!, to: '1/3' },
        {
          ...GATED.steps[0]!,
          from: '1/3',
          to: '1/4'
        }
      ]
    };
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      replan: () => ({
        cost: 1,
        blocked: false,
        steps: [{ ...ROUTE.steps[1]!, from: '9/1322', to: '1/4' }]
      })
    });
    walk.start(LATER, at(1, 1));
    walk.onCharacter(at(1, 2));
    walk.onCharacter(at(1, 3));
    expect(walk.progress).toMatchObject({ done: 2, total: 3 });
    vi.advanceTimersByTime(50);
    // The draw lands off the plan; the way on is one step, and the two
    // already walked are still part of this journey.
    walk.onCharacter(at(9, 1322));
    vi.advanceTimersByTime(50);
    expect(walk.progress).toMatchObject({ done: 2, total: 3 });
    walk.dispose();
  });

  it('plans again from where the gate actually put the character', () => {
    const asked: string[] = [];
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      replan: (to) => {
        asked.push(to);
        return {
          cost: 1,
          blocked: false,
          steps: [{ ...ROUTE.steps[1]!, from: '9/1322', to: '1/3' }]
        };
      }
    });
    walk.start(GATED, at(1, 1));
    vi.advanceTimersByTime(50);
    // Not `1/2`, which is where the branch the plan read would have landed.
    walk.onCharacter(at(9, 1322));
    vi.advanceTimersByTime(50);

    expect(asked).toEqual(['1/3']);
    expect(walk.progress.status).toBe('walking');
    expect(moves(sent)).toEqual(['go portal', 'e']);
    expect(notices.join(' ')).toContain('checkability 133 5');
    walk.dispose();
  });

  /* A step with every condition read is still the plan going wrong. */
  it('stops on the wrong room where nothing on the step was unreadable', () => {
    const asked: string[] = [];
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      replan: (to) => {
        asked.push(to);
        return ROUTE;
      }
    });
    walk.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walk.onCharacter(at(9, 1322));

    expect(asked).toEqual([]);
    expect(walk.progress.status).toBe('stopped');
    walk.dispose();
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
    expect(notices).toContain(
      t('automation.walk.darkLightSpent', { stepName: 'Third Room', lightName: 'glowing pearl' })
    );
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
    expect(
      notices.filter(
        (m) =>
          m ===
          t('automation.walk.darkLightSpent', {
            stepName: 'Third Room',
            lightName: 'glowing pearl'
          })
      )
    ).toHaveLength(1);
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
    expect(notices).toEqual([
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    ]);
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
    expect(notices).toEqual([
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    ]);
  });

  it('is quiet when the next step is not into the dark', () => {
    walker = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      lightSource: () => ({ state: 'spent', name: 'glowing pearl' })
    });
    walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(50);
    walker.onCharacter(at(1, 2));
    expect(notices).toEqual([
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    ]);
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
/*
 * A `rest` this client asked for, and the step that used to undo it.
 *
 * Moving breaks a rest. `rest`, `sn` and a direction were decided in the same
 * tick, from the same state, and went out one millisecond apart: the character
 * sat down and stood straight back up, seven times out of seven, and the
 * experience rate went to zero (todo 14). The two guards on *deciding* to rest
 * are still right — at the moment they run, nothing is moving the character.
 * This is the claim made after: once `rest` is out, no walk starts until the
 * server has answered.
 */
describe('a rest whose answer has not come back', () => {
  const walkerWaiting = (): { walk: Walker; land: () => void } => {
    let resting = true;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => at(1, 1),
      restInFlight: () => resting
    });
    return {
      walk,
      land: () => {
        resting = false;
      }
    };
  };

  it('holds the step rather than breaking the rest', async () => {
    const { walk } = walkerWaiting();
    expect(walk.start(ROUTE, at(1, 1))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('resting');
    // A hold, not a refusal: the walk is still on.
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });

  it('says why it paused, because a route that stops looks like a broken client', () => {
    const { walk } = walkerWaiting();
    walk.start(ROUTE, at(1, 1));
    expect(notices).toContain(t('automation.walk.restHolding'));
    walk.dispose();
  });

  /*
   * The positive control, and the half that proves it cannot deadlock: the
   * window closes on its own -- `(Resting)` arrives, or `tuning.rest.askedMs`
   * expires -- and the step goes out with nothing having nudged the walk. The
   * absence above would pass just as well on a walker that never sends at all.
   */
  it('steps once the window has closed, with nothing to nudge it', async () => {
    const { walk, land } = walkerWaiting();
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    land();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  /* Nothing claimed where nobody is counting: the behaviour before this. */
  it('does not hold at all where the session answers nothing', async () => {
    const walk = new Walker(config, queue, { stateNow: () => at(1, 1) });
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });
});

/*
 * The room read again after a kill, and the step that used to beat it (todo
 * 814). Items drop without a word, so the loot reads the floor off a reprint;
 * a step sent first puts the `get` that reprint earns in the next room.
 */
describe('a floor read whose answer has not come back', () => {
  const walkerReading = (): { walk: Walker; land: () => void } => {
    let reading = true;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => at(1, 1),
      floorInFlight: () => reading
    });
    return {
      walk,
      land: () => {
        reading = false;
      }
    };
  };

  it('holds the step until the floor has been read', async () => {
    const { walk } = walkerReading();
    expect(walk.start(ROUTE, at(1, 1))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });

  // The positive control: the window closing lets the step go with nothing to nudge it.
  it('steps once the read has landed', async () => {
    const { walk, land } = walkerReading();
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    land();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /*
   * Todo 765: the hold was re-asked only on its `walk.holdMs` beat, so a read
   * answered in a tenth of a second still cost up to a second and a half per
   * kill. The first block after it closes brings the beat forward.
   */
  it('steps on the read closing, not on the next beat', async () => {
    const { walk, land } = walkerReading();
    walk.start(ROUTE, at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    // A block while the read is still out wakes nothing.
    walk.onBlock(block('room-items'));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([]);
    land();
    walk.onBlock(block('status-line'));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['e']);
    // And once: the beat it replaced does not send the step a second time.
    await vi.advanceTimersByTimeAsync(TUNING.walk.holdMs * 2);
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });
});

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

  /*
   * Under a timed spell the way in cast (todo 104), standing still is
   * drowning: the health hold waits at the mouth and never inside, so the
   * same hurt character is walked on.
   */
  it('moves on under a timed spell rather than holding for health', async () => {
    const walk = new Walker({ ...config, health: { ...config.health, restBelow: 0.5 } }, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => hurt(0.3),
      moveOnly: () => true
    });
    expect(walk.start(ROUTE, hurt(0.3))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
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

  /* Published, not printed; the hold is the positive control for the silence. */
  it('states the hold on the card and prints nothing', () => {
    const { walk } = walkerAt(0.5);
    walk.start(ROUTE, hurt(0.3));
    expect(walk.progress.hold).toBe('health');
    expect(notices).toEqual([
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    ]);
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

  it('walks on once health is back to the ceiling, and prints nothing', async () => {
    const { walk, heal } = walkerAt(0.5, 0.8);
    walk.start(ROUTE, hurt(0.3));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);

    heal(0.85);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    expect(notices).toEqual([
      t('automation.walk.started.many', { stepCount: 2, destination: 'Third Room' })
    ]);
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
    replan?: (to: string, shortest: boolean) => Route | string
  ): { walk: Walker; move: (state: CharacterState) => void } => {
    let current = start;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current,
      // Auto-combat is fighting: the one fight a route waits out.
      willFight: () => true,
      ...(replan ? { replan } : {})
    });
    return { walk, move: (state) => (current = state) };
  };

  const fighting = (map: number, room: number): CharacterState => at(map, room, { inCombat: true });

  /*
   * Auto-combat turned off while the hold is running — todo 03, reported
   * 2026-09-06 as *"turning auto combat off during attack should continue even
   * if attacking"*.
   *
   * A fight hold waits for one of three endings and the client owns two:
   * auto-combat kills the monster, or the retreat walks out. Switching one off
   * mid-hold withdraws the reason for waiting, and on this realm walking on is
   * itself how a fight is broken — there is no `flee`.
   */
  describe('the reason for waiting withdrawn', () => {
    /** A configuration that will finish the fight it is holding for. */
    const fights: AutomationConfig = {
      ...config,
      combat: { ...config.combat, enabled: true }
    };

    /**
     * A walker on a given configuration, holding a fight that stays running.
     *
     * `stateNow` matters here rather than being ceremony: the hold re-asks on
     * a timer against the state as it is *then*, and a state that stopped
     * fighting would release the hold for the ordinary reason and prove
     * nothing about the one under test.
     */
    const holding = async (started: AutomationConfig): Promise<Walker> => {
      const walk = new Walker(started, queue, {
        notice: (message) => notices.push(message),
        stateNow: () => fighting(1, 1)
      });
      walk.start(ROUTE, at(1, 1));
      await vi.advanceTimersByTimeAsync(50);
      walk.onCharacter(fighting(1, 1));
      expect(walk.progress.hold).toBe('fight');
      notices.length = 0;
      return walk;
    };

    it('walks on when the switch that would end the fight is turned off', async () => {
      const walk = await holding(fights);

      sent.length = 0;
      walk.configure({ ...fights, combat: { ...fights.combat, enabled: false } });
      await vi.advanceTimersByTimeAsync(TUNING.walk.holdMs + 50);

      expect(notices).toContain(t('automation.walk.reasonWalkingThroughFight'));
      /*
       * The hold is **let go and the step goes out**, which is the assertion
       * that matters: `status` is `walking` for a held walk too, so asserting
       * it alone could not tell the fix from the bug — the first cut said the
       * line and then re-took the hold with its two-minute clock reset.
       */
      expect(walk.progress.hold).toBeNull();
      expect(sent).toContain('e');
      walk.dispose();
    });

    /* The retreat ends a fight by walking out too, later and hurt: no reason to stand first. */
    it('walks on though the retreat is on', async () => {
      const both: AutomationConfig = {
        ...fights,
        safety: { ...fights.safety, retreat: { ...fights.safety.retreat, enabled: true } }
      };
      const walk = await holding(both);

      sent.length = 0;
      walk.configure({ ...both, combat: { ...both.combat, enabled: false } });
      await vi.advanceTimersByTimeAsync(TUNING.walk.holdMs + 50);

      expect(walk.progress.hold).toBeNull();
      expect(sent).toContain('e');
      walk.dispose();
    });

    /*
     * Never past the escape's own move (2026-09-23, on review): walking through
     * while the escape is in flight is two moves from a room being left.
     */
    it('holds instead of walking through while an escape is in flight', async () => {
      let escaping = true;
      const walk = new Walker(config, queue, {
        notice: (message) => notices.push(message),
        stateNow: () => fighting(1, 1),
        escaping: () => escaping
      });
      walk.start(ROUTE, at(1, 1));
      await vi.advanceTimersByTimeAsync(50);
      walk.onCharacter(fighting(1, 1));
      expect(walk.progress.hold).toBe('fight');
      expect(notices).not.toContain(t('automation.walk.reasonWalkingThroughFight'));
      // The escape settles and nothing is fighting it: walked through then.
      escaping = false;
      await vi.advanceTimersByTimeAsync(TUNING.walk.holdMs + 50);
      expect(notices).toContain(t('automation.walk.reasonWalkingThroughFight'));
      walk.dispose();
    });

    it('takes the fight hold the moment the escape goes', async () => {
      const walk = new Walker(config, queue, {
        notice: (message) => notices.push(message),
        stateNow: () => fighting(1, 1)
      });
      walk.start(ROUTE, at(1, 1));
      await vi.advanceTimersByTimeAsync(50);
      walk.noteEscaped();
      expect(walk.progress.hold).toBe('fight');
      walk.dispose();
    });

    /* A follower swinging in every room is one decision, and one line. */
    it('says it walks through once a walk, not once a room', async () => {
      const walk = new Walker(config, queue, {
        notice: (message) => notices.push(message),
        stateNow: () => fighting(1, 1)
      });
      walk.start(ROUTE, at(1, 1));
      await vi.advanceTimersByTimeAsync(50);
      walk.onCharacter(fighting(1, 1));
      walk.onCharacter(fighting(1, 2));
      walk.onCharacter(fighting(1, 2));
      expect(
        notices.filter((line) => line === t('automation.walk.reasonWalkingThroughFight'))
      ).toHaveLength(1);
      walk.dispose();
    });

    /*
     * And a fight nothing is fighting from its start is walked through too
     * (2026-09-23): holding there was two minutes in the blows and then the
     * route stopped anyway. Walking on keeps the route, which is what the
     * sewer report that asked for the hold wanted.
     */
    it('walks on through a fight nothing fights, from its start', async () => {
      const walk = new Walker(config, queue, {
        notice: (message) => notices.push(message),
        stateNow: () => fighting(1, 1)
      });
      walk.start(ROUTE, at(1, 1));
      await vi.advanceTimersByTimeAsync(50);
      sent.length = 0;
      walk.onCharacter(fighting(1, 1));
      await vi.advanceTimersByTimeAsync(TUNING.walk.holdMs + 50);
      // No hold: the step already on the wire is still what it waits for.
      expect(walk.progress.hold).toBeNull();
      expect(walk.walking).toBe(true);
      expect(notices).toContain(t('automation.walk.reasonWalkingThroughFight'));
      walk.dispose();
    });
  });

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

  /* A lap's leg is planned by distance alone, and re-planned the same way. */
  it('hands the walk’s own shortest option to the re-plan', async () => {
    const asked: boolean[] = [];
    for (const shortest of [true, false]) {
      const { walk, move } = walkerThatCanPlan(at(1, 1), (_to, flag) => {
        asked.push(flag);
        return 'nowhere to go';
      });
      walk.start(ROUTE, at(1, 1), { shortest });
      await vi.advanceTimersByTimeAsync(50);
      walk.onCharacter(fighting(1, 1));
      move(at(1, 9));
      walk.onCharacter(at(1, 9));
      await vi.advanceTimersByTimeAsync(50);
      walk.dispose();
    }
    expect(asked).toEqual([true, false]);
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
    expect(notices).toContain(t('automation.walk.arrived', { stepName: 'Third Room' }));
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
      willFight: () => true,
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
      willFight: () => true,
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
      { willFight: () => true, notice: (m) => notices.push(m), stateNow: () => current }
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
    expect(notices).toContain(
      t('automation.walk.stopped', { reason: t('automation.walk.reasonFightUnending') })
    );
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
      willFight: () => true,
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

    expect(notices).toContain(t('automation.walk.superseded', { destination: 'Third Room' }));
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
      { willFight: () => true, notice: (m) => notices.push(m), stateNow: () => current }
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

/*
 * Conditions as waits — MegaMUD's `IgnoreBlind` / `IgnorePoison` defaults,
 * which wait the condition out before the script goes on. A blind character
 * cannot read the room it walks into; a held one is refused the step outright.
 * On the health hold's own terms: a hold, not an ending, re-asked on the beat.
 */
describe('waiting out a condition', () => {
  const afflicted = (over: Partial<Afflictions>): CharacterState => {
    const state = at(1, 1);
    state.afflictions = { ...NO_AFFLICTIONS, ...over };
    return state;
  };
  const walkerWith = (movement: Partial<MovementConfig>, events: Partial<WalkerEvents> = {}) => {
    let current = at(1, 1);
    const walk = new Walker({ ...config, movement: { ...config.movement, ...movement } }, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => current,
      ...events
    });
    return {
      walk,
      become: (state: CharacterState) => {
        current = state;
      }
    };
  };

  it('holds the step while blind, and walks on when sight returns', async () => {
    const { walk, become } = walkerWith({});
    expect(walk.start(ROUTE, afflicted({ blind: 'yes' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    expect(walk.progress.status).toBe('walking');
    expect(walk.progress.hold).toBe('blind');
    expect(notices).toContain(t('automation.walk.holdingBlind'));
    become(afflicted({ blind: 'no' }));
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERNAL.tuning.walk.holdMs + 600);
    expect(walk.progress.hold).toBeNull();
    expect(sent).toHaveLength(1);
    expect(notices).toContain(t('automation.walk.afflictionResumed'));
    walk.dispose();
  });

  it('walks on blind when told to', async () => {
    const { walk } = walkerWith({ walkWhileBlind: true });
    expect(walk.start(ROUTE, afflicted({ blind: 'yes' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toHaveLength(1);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  /*
   * Confusion, MegaMUD's `IgnoreConfusion` (todo 809): each command a confused
   * character sends may be thrown away before the server reads it, so a step
   * is a gamble the walk would spend and send again.
   */
  it('holds the step while confused, says so, and walks on when it clears', async () => {
    const { walk, become } = walkerWith({});
    expect(walk.start(ROUTE, afflicted({ confused: 'yes' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    expect(walk.progress.status).toBe('walking');
    expect(walk.progress.hold).toBe('confused');
    expect(notices).toContain(t('automation.walk.holdingConfused'));
    become(afflicted({ confused: 'no' }));
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERNAL.tuning.walk.holdMs + 600);
    expect(walk.progress.hold).toBeNull();
    expect(sent).toHaveLength(1);
    expect(notices).toContain(t('automation.walk.afflictionResumed'));
    walk.dispose();
  });

  it('walks on confused when told to', async () => {
    const { walk } = walkerWith({ walkWhileConfused: true });
    expect(walk.start(ROUTE, afflicted({ confused: 'yes' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toHaveLength(1);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  /* No switch for paralysis: a step while held is a command spent to be refused. */
  it('always waits while held, whatever the switches say', async () => {
    const { walk } = walkerWith({
      walkWhileBlind: true,
      walkWhilePoisoned: true,
      walkWhileConfused: true
    });
    expect(walk.start(ROUTE, afflicted({ held: 'yes' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('held');
    walk.dispose();
  });

  /*
   * Reported live 2026-09-11: `ne`, answered with `You are flat on your back!`
   * and nothing else, and eight seconds later *Walk stopped: nothing came back
   * after ne*. The client knew exactly where the character was standing the
   * whole time — the server had refused the step, not lost it — so there was
   * nothing to replan and nobody to ask.
   *
   * The realm names most of these holds and `CharacterTracker` sets the flag
   * for those (the two tests above are that path). This is the other half: a
   * spell whose row this realm does not mark, or does not carry at all. All
   * the walk has then is the *sequence* — a step, an onset, silence — and
   * `CheckForHoldPerson` is the only thing on the server that writes it.
   */
  it('holds a step an onset answered, instead of giving up on the journey', async () => {
    const { walk } = walkerWith({});
    expect(walk.start(ROUTE, afflicted({}))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['e']);

    walk.onBlock(block('spell-onset', { spells: 'knockdown' }));
    // Past the nudge and the whole step deadline, which used to stop the walk.
    await vi.advanceTimersByTimeAsync(TUNING.walk.nudgeAfterMs + config.walk.stepTimeoutMs + 100);
    expect(walk.progress.status).toBe('walking');
    expect(walk.progress.hold).toBe('held');
    expect(walk.progress.reason).toBeNull();
    // And nothing more went out for it: a hold is a wait, not a retry loop.
    expect(moves(sent)).toEqual(['e']);
    walk.dispose();
  });

  /*
   * The third word of that sequence is *silence*, and a room is its opposite.
   * Live 2026-09-12: the client's own `c prev` landed `You feel safe from
   * evil!` seven milliseconds behind a step, the step's room arrived 1.7s
   * later, and the onset — armed by the sentence, cleared by no answer — was
   * read as the *next* step went out: *Held fast* for half a minute, for a
   * spell whose row holds nothing.
   */
  it('lets an onset go once the step it followed lands', async () => {
    const { walk } = walkerWith({});
    expect(walk.start(ROUTE, afflicted({}))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['e']);

    walk.onBlock(block('spell-onset', { spells: 'holy aura|protection from evil' }));
    // The room answers the step: the sequence was step, onset, *room*.
    walk.onCharacter(at(1, 2));
    await vi.advanceTimersByTimeAsync(50);
    expect(walk.progress.hold).toBeNull();
    expect(notices).not.toContain(t('automation.walk.holdingHeld'));
    expect(moves(sent)).toEqual(['e', 'e']);

    // And what the onset armed went with the landing: the second step's
    // silence is the server's, stopped as such, not a hold inherited from it.
    await vi.advanceTimersByTimeAsync(TUNING.walk.nudgeAfterMs + config.walk.stepTimeoutMs + 100);
    expect(walk.progress.status).toBe('stopped');
    expect(walk.progress.hold).toBeNull();
    expect(walk.progress.reason).toBe(t('automation.walk.reasonTimeout', { command: 'e' }));
    walk.dispose();
  });

  /*
   * And where the realm *can* say, it is asked, and a `false` is a blessing
   * landing rather than a refusal: the sentence stays the tracker's to judge
   * (`heldByOnset`), and a step that then goes silent is stopped as silence,
   * loudly, as it was before the hold existed. The two knockdown tests above
   * are the `null` case — a realm with nothing to say — and stand.
   */
  it('does not read an onset the realm calls harmless as a refusal', async () => {
    const asked: string[][] = [];
    const { walk } = walkerWith(
      {},
      {
        spellsHold: (spells) => {
          asked.push([...spells]);
          return false;
        }
      }
    );
    expect(walk.start(ROUTE, afflicted({}))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    walk.onBlock(block('spell-onset', { spells: 'holy aura|protection from evil' }));
    expect(asked).toEqual([['holy aura', 'protection from evil']]);

    await vi.advanceTimersByTimeAsync(TUNING.walk.nudgeAfterMs + config.walk.stepTimeoutMs + 100);
    expect(walk.progress.status).toBe('stopped');
    expect(walk.progress.hold).toBeNull();
    expect(walk.progress.reason).toBe(t('automation.walk.reasonTimeout', { command: 'e' }));
    walk.dispose();
  });

  /*
   * The bound, and it asks rather than gives up — `tuning.walk.heldFallbackMs`.
   * A realm may ship a hold whose wear-off no table here pairs, and a flag
   * with no ending would stand the route still for the evening. One step
   * settles it: the server walks the character or refuses it again.
   */
  it('spends one step to find out whether a hold it cannot read is over', async () => {
    const { walk } = walkerWith({});
    expect(walk.start(ROUTE, afflicted({}))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    walk.onBlock(block('spell-onset', { spells: 'knockdown' }));
    await vi.advanceTimersByTimeAsync(TUNING.walk.nudgeAfterMs + config.walk.stepTimeoutMs + 100);
    expect(walk.progress.hold).toBe('held');

    await vi.advanceTimersByTimeAsync(TUNING.walk.heldFallbackMs + TUNING.walk.holdMs);
    expect(moves(sent)).toEqual(['e', 'e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
  });

  /*
   * The same bound on the stated flag, which is the case a cure never comes
   * for. Silent both ways: the condition has not passed, and saying it had
   * would be a claim nothing on the wire has made.
   */
  it('asks again on a stated hold nothing ever ends, without saying it passed', async () => {
    const { walk, become } = walkerWith({});
    // The beat re-asks against `stateNow`, so the flag has to still be up
    // there: this is the hold nothing ever ends, not one that quietly does.
    become(afflicted({ held: 'yes' }));
    expect(walk.start(ROUTE, afflicted({ held: 'yes' }))).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('held');

    await vi.advanceTimersByTimeAsync(TUNING.walk.heldFallbackMs + TUNING.walk.holdMs);
    expect(moves(sent)).toEqual(['e']);
    expect(notices).not.toContain(t('automation.walk.afflictionResumed'));
    walk.dispose();
  });

  /* Unknown is not yes: nobody having said the character is blind is not a reason to stand still. */
  it('does not hold on a condition nobody has stated', async () => {
    const { walk } = walkerWith({});
    expect(walk.start(ROUTE, afflicted({}))).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toHaveLength(1);
    walk.dispose();
  });
});

/*
 * ------------------------------------------------------------------ levers
 *
 * todo 01, reported off the wire: `Inner Gate`, `Obvious exits: closed gate
 * north`, a gate the realm records as `Door [301 picklocks/strength]` and a
 * character with 0 picklocks and 86 strength — and the Guardroom one room west
 * holding the lever that raises it. The client alternated `n` and `open n`
 * until its budget ran out and never mentioned the lever; the player walked
 * west and typed `pull lever` themselves.
 *
 * The route here is the reported one, shortened: 1/1 -e-> 1/2 through a gate,
 * with the lever in 1/9.
 */
describe('a way something else opens', () => {
  const GATED: Route = {
    cost: 1,
    blocked: false,
    steps: [
      {
        from: '1/1',
        to: '1/2',
        direction: 'e',
        command: 'e',
        name: 'Courtyard',
        requirement: { kind: 'door', raw: 'Door [301 picklocks/strength]', pickDifficulty: 301 },
        dark: false
      }
    ]
  };

  /** 1/1 -w-> 1/9, the one step to the room the lever is pulled in. */
  const TO_LEVER: Route = {
    cost: 1,
    blocked: false,
    steps: [
      {
        from: '1/1',
        to: '1/9',
        direction: 'w',
        command: 'w',
        name: 'Guardroom',
        requirement: null,
        dark: false
      }
    ]
  };

  /** 1/9 -e-> 1/1 -e-> 1/2, the way back and on through the gate. */
  const BACK: Route = {
    cost: 2,
    blocked: false,
    steps: [
      {
        from: '1/9',
        to: '1/1',
        direction: 'e',
        command: 'e',
        name: 'Inner Gate',
        requirement: null,
        dark: false
      },
      { ...GATED.steps[0]! }
    ]
  };

  const LEVER: RemoteLever = { at: '1/9', roomName: 'Guardroom', say: 'pull lever' };

  /**
   * A walker wired the way `SessionManager` wires one, with the two answers
   * only the world can give: what opens this exit, and a route to it.
   */
  const withLevers = (
    levers: readonly RemoteLever[],
    plans: Record<string, Route | string> = {}
  ): {
    walk: Walker;
    /** Every room a route was asked for, and every edge written off. */
    asked: string[];
    /** How the walk ended, if it did — the fact a loop books a leg on. */
    ends: Array<[boolean, string | null]>;
    /** Puts the character in a room, as a confirmed step would. */
    arrive(room: number): void;
  } => {
    const asked: string[] = [];
    const ends: Array<[boolean, string | null]> = [];
    let here = 1;
    const walk = new Walker(
      { ...config, movement: { ...config.movement, openDoors: true, openTries: 1 } },
      queue,
      {
        notice: (m) => notices.push(m),
        leversFor: () => levers,
        stateNow: () => at(1, here),
        replan: (to) => {
          asked.push(to);
          return plans[to] ?? 'no route';
        },
        // A leg between two rooms the character is in neither of, for checking
        // an all-or-nothing run before any of it is walked.
        routeBetween: (from, to) => {
          asked.push(`${from}->${to}`);
          return plans[`${from}->${to}`] ?? 'no route';
        },
        refused: (from, direction, why) => asked.push(`refused:${from}|${direction}:${why}`),
        ended: (arrived, reason) => ends.push([arrived, reason])
      }
    );
    return {
      walk,
      asked,
      ends,
      arrive: (room) => {
        here = room;
        walk.onCharacter(at(1, room));
      }
    };
  };

  /*
   * The whole errand, end to end. The gate refuses, `open` says it is locked,
   * the character cannot force it — and instead of standing there running the
   * ladder for a minute, the walk goes west, pulls the lever and comes back
   * through the gate.
   */
  it('goes and pulls the lever, then plans on to where it was going', () => {
    const { walk, asked, arrive } = withLevers([LEVER], { '1/9': TO_LEVER, '1/2': BACK });
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    // The ladder, then the detour — and no barrier hold, because the walk is
    // no longer standing at the gate.
    expect(moves(sent)).toEqual(['e', 'open e', 'w']);
    expect(asked).toEqual(['1/9']);
    expect(walk.progress).toMatchObject({ status: 'walking', hold: null });
    expect(notices).toContain(
      t('automation.walk.leverFetching', {
        phrase: LEVER.say,
        roomName: LEVER.roomName,
        stepName: 'Courtyard'
      })
    );

    // Arriving at the Guardroom is the middle of the journey: the lever goes
    // out, the way back is planned, and the walk carries on.
    arrive(9);
    // Past the queue's own acknowledgement window: four commands are already
    // out and unanswered, and this fixture feeds the queue no status lines.
    vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
    expect(moves(sent)).toEqual(['e', 'open e', 'w', 'pull lever', 'e']);
    expect(asked).toEqual(['1/9', '1/2']);
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });

  /*
   * And the arrival at the lever is **not** an arrival: `ended` is what a loop
   * books a leg on, and a lap that advanced to its next stop here would leave
   * the gate shut and the stop behind it never reached.
   */
  it('does not report the lever room as the journey ending', () => {
    const { walk, ends, arrive } = withLevers([LEVER], { '1/9': TO_LEVER, '1/2': BACK });
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);
    arrive(9);
    vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);

    expect(ends).toEqual([]);
    walk.dispose();
  });

  /*
   * Once, not once a round. A lever pulled that did not open the gate is not a
   * lever that opens it, and walking back for it again is a lap of the same
   * corridor spent on the same refusal.
   */
  it('makes the errand once per walk', () => {
    const { walk, asked, arrive } = withLevers([LEVER], { '1/9': TO_LEVER, '1/2': BACK });
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);
    arrive(9);
    vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
    // Back at the gate, still shut.
    arrive(1);
    vi.advanceTimersByTime(200);
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    // One route to the lever asked for, not two.
    expect(asked.filter((entry) => entry === '1/9').length).toBe(1);
    walk.dispose();
  });

  /*
   * The levers are in the room the character is already standing in — 21 of
   * the shipped realm's exits, whose own instruction says `Door` and never
   * mentions an action, so nothing reading the requirement could find them.
   * Pulled where they stand, and the step again behind them.
   */
  it('pulls a lever that is in this very room without walking anywhere', () => {
    const here: RemoteLever = { at: '1/1', roomName: 'Inner Gate', say: 'pull lever' };
    const { walk, asked } = withLevers([here]);
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    expect(moves(sent)).toEqual(['e', 'open e', 'pull lever', 'e']);
    expect(asked).toEqual([]);
    walk.dispose();
  });

  /*
   * A set the realm states a count for but names no ordered levers on: with no
   * `Requirement.actions` there is nothing to walk in the realm's own order,
   * and `specific order` is six of the eleven such exits. Refused, said once,
   * and the walk holds at the gate as it always did. (In the shipped realm this
   * cannot happen — `actions` is written by the same test that makes a set a
   * set — which is what makes it worth a case here rather than in the data.)
   */
  it('refuses a set of levers the realm states no order for, out loud and once', () => {
    const both: Route = {
      ...GATED,
      steps: [
        {
          ...GATED.steps[0]!,
          requirement: {
            kind: 'hidden',
            raw: 'Hidden/Needs 2 Actions, specific order',
            actionsNeeded: 2
          }
        }
      ]
    };
    const { walk, asked } = withLevers([LEVER, { ...LEVER, at: '1/8', roomName: 'Cellar' }]);
    walk.start(both, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    expect(asked).toEqual([]);
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    expect(
      notices.filter(
        (line) =>
          line === t('automation.walk.leversScattered', { stepName: 'Courtyard', roomCount: 2 })
      ).length
    ).toBe(1);
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 50);
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    expect(
      notices.filter(
        (line) =>
          line === t('automation.walk.leversScattered', { stepName: 'Courtyard', roomCount: 2 })
      ).length
    ).toBe(1);
    walk.dispose();
  });

  /*
   * The reported gate itself: `1/1331` north out of Inner Gate states **no**
   * action count, and a Guardroom on each side holds a lever. The realm not
   * having said *how many* is what makes them alternatives rather than a set,
   * and the wire settled it — the player walked into one of them, typed
   * `pull lever`, and the gate came up.
   *
   * The cheaper room wins. Both are one step here, and the router's own cost is
   * what decides, so a gatehouse whose other lever is across the map is not
   * where the walk goes.
   */
  it('takes the nearer of two levers when the realm names no count', () => {
    const far: Route = {
      cost: 9,
      blocked: false,
      steps: [
        {
          from: '1/1',
          to: '1/8',
          direction: 'n',
          command: 'n',
          name: 'Far Guardroom',
          requirement: null,
          dark: false
        }
      ]
    };
    const { walk, asked } = withLevers(
      [{ ...LEVER, at: '1/8', roomName: 'Far Guardroom' }, LEVER],
      { '1/8': far, '1/9': TO_LEVER, '1/2': BACK }
    );
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    // Both asked about, the cheaper walked.
    expect(asked).toEqual(['1/8', '1/9']);
    expect(moves(sent)).toEqual(['e', 'open e', 'w']);
    walk.dispose();
  });

  /*
   * And an alternative in the room the character is already standing in beats
   * walking anywhere at all — 2 of the shipped realm's exits put one lever on
   * each side of the door and say `Needs 1 Actions`.
   */
  it('pulls the alternative that is here rather than walking to the other', () => {
    const { walk, asked } = withLevers([
      { ...LEVER, at: '1/8', roomName: 'Far Guardroom' },
      { at: '1/1', roomName: 'Inner Gate', say: 'pull lever' }
    ]);
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    expect(asked).toEqual([]);
    expect(moves(sent)).toEqual(['e', 'open e', 'pull lever', 'e']);
    walk.dispose();
  });

  /*
   * The realm names the lever and there is no way to it. Said out loud, because
   * a walk that then stands at the gate until its rounds run out is otherwise
   * indistinguishable from one that never knew.
   */
  it('says so when the lever is named and cannot be reached', () => {
    const { walk } = withLevers([LEVER]);
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed', { barrier: 'gate' }));
    vi.advanceTimersByTime(200);
    walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
    vi.advanceTimersByTime(200);

    expect(notices).toContain(
      t('automation.walk.leverUnreachable', {
        phrase: LEVER.say,
        roomName: LEVER.roomName,
        reason: 'no route'
      })
    );
    expect(walk.progress).toMatchObject({ status: 'walking', hold: 'barrier' });
    walk.dispose();
  });

  /*
   * **A lever behind a lever** (todo 807). The Treetops chain five of them: the
   * walk met a second gate on its way to the first lever, could not start
   * another errand, and lapped the same rooms until its rounds ran out. A gate
   * met on an errand's way is pushed onto it, and the invariant the old single
   * slot protected holds: no lever room's arrival is the journey's, and the
   * inner errand's arrival is never read as the outer one's.
   */
  it('fetches a lever that is itself behind a lever, and arrives only at the end', () => {
    const step = (from: string, to: string, direction: Direction, name: string): RouteStep => ({
      from,
      to,
      direction,
      command: direction,
      name,
      requirement: null,
      dark: false
    });
    const route = (...steps: RouteStep[]): Route => ({ cost: steps.length, blocked: false, steps });
    // 1/1 -e-> 1/2 is the gate; its lever is in the Guardroom, 1/1 -w-> 1/9 —
    // and that way is shut too, by a chain in the Cellar, 1/1 -s-> 1/7.
    const plans: Record<string, Route> = {
      '1/1>1/9': route(step('1/1', '1/9', 'w', 'Guardroom')),
      '1/1>1/7': route(step('1/1', '1/7', 's', 'Cellar')),
      '1/7>1/9': route(step('1/7', '1/1', 'n', 'Inner Gate'), step('1/1', '1/9', 'w', 'Guardroom')),
      '1/9>1/2': BACK
    };
    const levers: Record<string, RemoteLever[]> = {
      e: [LEVER],
      w: [{ at: '1/7', roomName: 'Cellar', say: 'pull chain' }]
    };
    const ends: Array<[boolean, string | null]> = [];
    let here = 1;
    const walk = new Walker(
      { ...config, movement: { ...config.movement, openDoors: true, openTries: 1 } },
      queue,
      {
        notice: (m) => notices.push(m),
        leversFor: (_from, direction) => levers[direction] ?? [],
        stateNow: () => at(1, here),
        replan: (to) => plans[`1/${here}>${to}`] ?? 'no route',
        ended: (arrived, reason) => ends.push([arrived, reason])
      }
    );
    const arrive = (room: number): void => {
      here = room;
      walk.onCharacter(at(1, room));
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
    };
    const locked = (): void => {
      walk.onBlock(block('direction-failed', { barrier: 'gate' }));
      vi.advanceTimersByTime(200);
      walk.onBlock(block('open-failed', { barrier: 'gate', reason: 'locked' }));
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
    };

    walk.start(GATED, at(1, 1));
    locked();
    expect(moves(sent)).toEqual(['e', 'open e', 'w']);
    // The way to the Guardroom is shut as well: fetch the chain first.
    locked();
    expect(moves(sent).slice(-2)).toEqual(['open w', 's']);

    // The Cellar is the inner errand's room: its chain, and back towards the
    // Guardroom — not the outer lever, and not an arrival.
    arrive(7);
    expect(moves(sent).slice(-2)).toEqual(['pull chain', 'n']);
    expect(moves(sent)).not.toContain('pull lever');
    arrive(1);
    arrive(9);
    // The Guardroom is the outer errand's: its lever, then the way on.
    expect(moves(sent).slice(-2)).toEqual(['pull lever', 'e']);
    expect(ends).toEqual([]);
    arrive(1);
    arrive(2);
    expect(ends).toEqual([[true, null]]);
    walk.dispose();
  });

  /*
   * `There is no exit in that direction!` is the other way this exit answers —
   * a remote-action exit is the fourth of that sentence's four causes — and the
   * edge must **not** be written off while the client still has the lever to
   * try. Blaming it is what took a real corridor out of every route for a
   * session in the report this rung was written for.
   */
  it('does not blame the edge while a lever it has not pulled is named', () => {
    const { walk, asked } = withLevers([LEVER], { '1/9': TO_LEVER, '1/2': BACK });
    walk.start(GATED, at(1, 1));
    walk.onBlock(block('direction-failed'));
    vi.advanceTimersByTime(200);

    expect(asked).toEqual(['1/9']);
    expect(asked.some((entry) => entry.startsWith('refused:'))).toBe(false);
    walk.dispose();
  });

  /*
   * ------------------------------------------------------ a round of levers
   *
   * todo 04, and the reporter guessed right that it was todo 01's: `Crypt,
   * Stone Hallway` 1/1056 leaves north through `Hidden/Needs 2 Actions, any
   * order` with one lever in 1/1038 and another in 1/1044. Todo 01 taught the
   * client to fetch **one** lever and refused this shape; the report is that
   * refusal, one room further on — the walk stopped and the console said the
   * realm data had promised an exit that did not exist, about an exit that
   * does, with both its levers in the file.
   */
  describe('levers the realm spreads over several rooms', () => {
    /** The reported exit: two levers, two rooms, the realm's own order. */
    const SET: Route = {
      ...GATED,
      steps: [
        {
          ...GATED.steps[0]!,
          requirement: {
            kind: 'hidden',
            raw: 'Hidden/Needs 2 Actions, any order',
            actionsNeeded: 2,
            actions: [
              { say: ['pull lever'], at: { map: 1, room: 8 } },
              { say: ['pull lever'], at: { map: 1, room: 9 } }
            ]
          }
        }
      ]
    };

    const step = (from: string, to: string, direction: string, name: string): Route => ({
      cost: 1,
      blocked: false,
      steps: [
        {
          from,
          to,
          direction: direction as Route['steps'][number]['direction'],
          command: direction,
          name,
          requirement: null,
          dark: false
        }
      ]
    });

    const WALKABLE = {
      '1/8': step('1/1', '1/8', 'n', 'First Lever'),
      '1/9': step('1/8', '1/9', 'e', 'Second Lever'),
      '1/8->1/9': step('1/8', '1/9', 'e', 'Second Lever'),
      '1/9->1/1': step('1/9', 's', 's', 'Inner Gate'),
      '1/2': step('1/9', '1/2', 'e', 'Courtyard')
    };

    const LEVERS: RemoteLever[] = [
      { at: '1/8', roomName: 'First Lever', say: 'pull lever' },
      { at: '1/9', roomName: 'Second Lever', say: 'pull lever' }
    ];

    /*
     * The whole round: to the first lever, pull, on to the second, pull, then
     * the journey the errand interrupted.
     */
    it('walks the rooms in the realm’s own order and pulls each lever', () => {
      const { walk, asked, arrive } = withLevers(LEVERS, WALKABLE);
      walk.start(SET, at(1, 1));
      walk.onBlock(block('direction-failed'));
      vi.advanceTimersByTime(200);

      // Checked whole before the first lever: leg one from here, the rest
      // between rooms the character is not in yet, and the way back to the gate.
      expect(asked).toEqual(['1/8', '1/8->1/9', '1/9->1/1']);
      expect(moves(sent)).toEqual(['e', 'n']);

      arrive(8);
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
      expect(moves(sent)).toEqual(['e', 'n', 'pull lever', 'e']);

      arrive(9);
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
      expect(moves(sent)).toEqual(['e', 'n', 'pull lever', 'e', 'pull lever', 'e']);
      expect(walk.progress.status).toBe('walking');
      walk.dispose();
    });

    /* And none of it is an arrival: a loop reads `ended` to book its leg. */
    it('reports no ending while the round is being walked', () => {
      const { walk, ends, arrive } = withLevers(LEVERS, WALKABLE);
      walk.start(SET, at(1, 1));
      walk.onBlock(block('direction-failed'));
      vi.advanceTimersByTime(200);
      arrive(8);
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);
      arrive(9);
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);

      expect(ends).toEqual([]);
      walk.dispose();
    });

    /*
     * All or nothing: a leg that cannot be walked means the round buys nothing,
     * and the levers that *are* reachable would be commands spent on a passage
     * that stays shut — `buildRealm`'s own reason for refusing a half-matched
     * list. Nothing is sent, and it is said once.
     */
    it('refuses the whole round when one leg cannot be walked', () => {
      const { walk, asked } = withLevers(LEVERS, {
        '1/8': WALKABLE['1/8'],
        '1/9->1/1': WALKABLE['1/9->1/1']
        // and no route from the first lever to the second
      });
      walk.start(SET, at(1, 1));
      walk.onBlock(block('direction-failed'));
      vi.advanceTimersByTime(200);

      expect(moves(sent)).toEqual(['e']);
      expect(walk.progress.status).toBe('stopped');
      expect(
        notices.filter(
          (line) =>
            line ===
            t('automation.walk.leverRunRefused', {
              stepName: 'Courtyard',
              roomCount: 2,
              reason: 'no route'
            })
        ).length
      ).toBe(1);
      // And the corridor is written down as **shut**, not as one the realm data
      // invented: the exit is real and the way is closed.
      expect(asked).toContain('refused:1/1|e:shut');
      walk.dispose();
    });

    /* And the way back to the gate is part of the check, or the levers buy a
       room the character cannot leave for the exit they opened. */
    it('refuses when the last lever’s room cannot get back to the gate', () => {
      const { walk } = withLevers(LEVERS, {
        '1/8': WALKABLE['1/8'],
        '1/8->1/9': WALKABLE['1/8->1/9']
      });
      walk.start(SET, at(1, 1));
      walk.onBlock(block('direction-failed'));
      vi.advanceTimersByTime(200);

      expect(moves(sent)).toEqual(['e']);
      expect(
        notices.filter(
          (line) =>
            line ===
            t('automation.walk.leverRunRefused', {
              stepName: 'Courtyard',
              roomCount: 2,
              reason: 'no route'
            })
        ).length
      ).toBe(1);
      walk.dispose();
    });

    /*
     * Two levers in one room are one visit. The realm's order between them is
     * the order they are queued in, which is what `specific order` wants.
     */
    it('pulls two levers in one room on one visit', () => {
      const pair: Route = {
        ...SET,
        steps: [
          {
            ...SET.steps[0]!,
            requirement: {
              kind: 'hidden',
              raw: 'Hidden/Needs 2 Actions, specific order',
              actionsNeeded: 2,
              actions: [
                { say: ['pull red'], at: { map: 1, room: 8 } },
                { say: ['pull blue'], at: { map: 1, room: 8 } }
              ]
            }
          }
        ]
      };
      const { walk, arrive } = withLevers(
        [
          { at: '1/8', roomName: 'Lever Room', say: 'pull red' },
          { at: '1/8', roomName: 'Lever Room', say: 'pull blue' }
        ],
        { '1/8': WALKABLE['1/8'], '1/8->1/1': WALKABLE['1/9->1/1'], '1/2': WALKABLE['1/2'] }
      );
      walk.start(pair, at(1, 1));
      walk.onBlock(block('direction-failed'));
      vi.advanceTimersByTime(200);
      arrive(8);
      vi.advanceTimersByTime(config.pacing.ackTimeoutMs + 200);

      expect(moves(sent)).toEqual(['e', 'n', 'pull red', 'pull blue', 'e']);
      walk.dispose();
    });
  });
});

/*
 * Resting before a trap (todo 01, 2026-09-10). A trap is the one gate on a
 * route that is walked into and taken, and the walk was taking it at whatever
 * health it happened to have: `restBelow` stops a walk at a share of the bar,
 * and a 36-damage trap does not care what the bar is. The floor slides with
 * the trap — its damage plus the share of maximum `restBeforeTraps` keeps after
 * it, or the share the router priced the lair beyond at, whichever is more —
 * and `Recovery` reads the figure off `restingFor` and sits the character down
 * to it.
 */
describe('resting before a trap', () => {
  const trapped = (over: Partial<RouteStep> = {}): Route => ({
    cost: 2,
    blocked: false,
    steps: [
      {
        ...ROUTE.steps[0]!,
        requirement: { kind: 'trap', raw: 'Trap, 36 damage', damage: 36 },
        ...over
      },
      ROUTE.steps[1]!
    ]
  });

  /** A 165-point character standing in 1/1 at `hp`. */
  const withHp = (hp: number | null, hpMax: number | null = 165): CharacterState => {
    const state = at(1, 1);
    state.vitals = { ...state.vitals, hp, hpMax };
    return state;
  };

  const walkerKeeping = (share: number): { walk: Walker; heal: (hp: number) => void } => {
    let current = withHp(165);
    const walk = new Walker(
      { ...config, health: { ...config.health, restBelow: 0, restBeforeTraps: share } },
      queue,
      { notice: (m) => notices.push(m), stateNow: () => current }
    );
    return {
      walk,
      heal: (hp) => {
        current = withHp(hp);
      }
    };
  };

  it('holds the step at 100 of 165 before a 36-damage trap, wanting 110', async () => {
    const { walk } = walkerKeeping(0.45);
    expect(walk.start(trapped(), withHp(100))).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);
    expect(walk.progress.hold).toBe('trap');
    // 36 + 0.45 × 165 = 110.25, rounded up: the figure `Recovery` rests to.
    expect(walk.restingFor).toBe(111);
    expect(notices).toContain(
      t('automation.walk.trapHolding', {
        stepName: 'Second Room',
        damage: 36,
        needed: 111,
        hp: 100
      })
    );
    walk.dispose();
  });

  it('walks on once health reaches the figure, and says so', async () => {
    const { walk, heal } = walkerKeeping(0.45);
    walk.start(trapped(), withHp(100));
    heal(111);
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERNAL.tuning.walk.holdMs + 50);
    expect(sent).toEqual(['e']);
    expect(walk.progress.hold).toBeNull();
    expect(walk.restingFor).toBeNull();
    expect(notices).toContain(t('automation.walk.trapResumed', { stepName: 'Second Room' }));
    walk.dispose();
  });

  it('walks straight through at the figure', async () => {
    const { walk } = walkerKeeping(0.45);
    walk.start(trapped(), withHp(111));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /* A trap into a lair is a fight fought on what the trap left: the lair's
     own share is kept where it is the larger. */
  it('keeps the lair’s share beyond the trap where that is more', async () => {
    const { walk } = walkerKeeping(0.45);
    walk.start(trapped({ danger: 0.6, lairDamage: 99 }), withHp(120));
    await vi.advanceTimersByTimeAsync(50);
    // 36 + 99: the lair's figure in points, never its share of a bar read at
    // planning time.
    expect(walk.restingFor).toBe(135);
    walk.dispose();
  });

  it('caps the figure at the maximum for a trap the bar cannot cover', async () => {
    const { walk } = walkerKeeping(0.45);
    walk.start(
      trapped({ requirement: { kind: 'trap', raw: 'Trap, 400 damage', damage: 400 } }),
      withHp(160)
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(walk.restingFor).toBe(165);
    walk.dispose();
  });

  it('does not hold at all when the share is 0', async () => {
    const { walk } = walkerKeeping(0);
    walk.start(trapped(), withHp(10));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  /* Unknown is not low: a trap the realm gives no figure for, and a bar nobody
     has read, both hold nothing rather than holding for ever. */
  it('does not hold on a trap with no stated damage, nor without a maximum', async () => {
    const { walk } = walkerKeeping(0.45);
    walk.start(trapped({ requirement: { kind: 'trap', raw: 'Trap' } }), withHp(10));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.stop('done', true);
    sent = [];
    walk.start(trapped(), withHp(10, null));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });

  it('does not hold a step with no trap on it', async () => {
    const { walk } = walkerKeeping(0.45);
    walk.start(ROUTE, withHp(10));
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(['e']);
    walk.dispose();
  });
});

describe('a step that hands the character to a draw', () => {
  const LANDING = { spell: 596, name: 'asylum', map: 9, low: 10, high: 12 };

  /**
   * One step west that scatters, with the destination it is expected to reach.
   *
   * The requirement is what makes it two room blocks rather than one — see
   * `movesTwice` — so it is on the step exactly as the router puts it there.
   */
  const drawn = (moves: number): Route => ({
    cost: 1 + moves,
    blocked: false,
    steps: [
      {
        from: '1/1',
        to: '9/99',
        direction: 'w',
        command: 'w',
        requirement: {
          kind: 'cast',
          raw: 'Cast: pre-0, post-596',
          castPost: 596,
          spellEffect: 'scatters',
          landing: LANDING
        },
        name: "Old Man's Cell",
        dark: false,
        scatter: { landing: LANDING, rooms: 3, moves }
      }
    ]
  });

  /*
   * **The first block is the room the exit table names, and acting on it is
   * the bug.** `CastExit.TryMoveThroughExit` describes that room and then
   * casts, so the character is in it for no time at all; the walk has to wait
   * for the second block, which is where the spell actually put them.
   */
  it('waits out the first of the two blocks a cast exit prints', async () => {
    const asked: string[] = [];
    let inFlight = 0;
    let where = at(1, 1);
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => where,
      pendingMoves: () => inFlight,
      replan: (to) => {
        asked.push(to);
        return { steps: [], cost: 0, blocked: true, reason: 'no' };
      }
    });
    walk.start(drawn(4), at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['w']);

    // The table's room, with the teleport's own block still on the wire.
    inFlight = 1;
    where = at(9, 10);
    walk.onCharacter(at(9, 10));
    await vi.advanceTimersByTimeAsync(50);
    expect(asked).toEqual([]);
    expect(walk.progress.status).toBe('walking');
    walk.dispose();
  });

  /*
   * The realm put the character somewhere the plan never named, which on a
   * scatter step is the step *working*. The wrong-room guard would read it as
   * the route desynchronising and stop the journey; instead the way on is
   * planned from where the character actually is, which is the only thing the
   * client can do after a draw and exactly what a player does.
   */
  it('plans again from wherever it landed instead of stopping', async () => {
    const asked: string[] = [];
    const onward: Route = {
      cost: 1,
      blocked: false,
      steps: [
        {
          from: '9/11',
          to: '9/99',
          direction: 'n',
          command: 'n',
          name: "Old Man's Cell",
          requirement: null,
          dark: false
        }
      ]
    };
    let inFlight = 0;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => at(9, 11),
      pendingMoves: () => inFlight,
      replan: (to) => {
        asked.push(to);
        return onward;
      }
    });
    walk.start(drawn(4), at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    inFlight = 1;
    walk.onCharacter(at(9, 10));
    await vi.advanceTimersByTimeAsync(10);
    // Not 9/10, which is the only room the plan could ever have named.
    inFlight = 0;
    walk.onCharacter(at(9, 11));
    await vi.advanceTimersByTimeAsync(50);

    expect(asked).toEqual(['9/99']);
    expect(walk.progress.status).toBe('walking');
    expect(moves(sent)).toEqual(['w', 'n']);
    expect(notices).toContain(
      t('automation.walk.scattered', { spellName: LANDING.name, roomName: '9/11' })
    );
    walk.dispose();
  });

  /*
   * And one time in three the draw lands on the room the walk was for, which
   * is an arrival and not a replan — `RouteStep.to` on a scatter step is the
   * destination, so the ordinary path already handles it.
   */
  it('arrives when the draw lands on the destination', async () => {
    let planned = 0;
    let inFlight = 0;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => at(9, 99),
      pendingMoves: () => inFlight,
      replan: () => {
        planned += 1;
        return 'should not be asked';
      }
    });
    walk.start(drawn(4), at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    inFlight = 1;
    walk.onCharacter(at(9, 10));
    await vi.advanceTimersByTimeAsync(10);
    inFlight = 0;
    walk.onCharacter(at(9, 99));
    await vi.advanceTimersByTimeAsync(50);

    expect(planned).toBe(0);
    expect(walk.progress.status).toBe('arrived');
    walk.dispose();
  });

  /*
   * **Asking is only half of it; the client has to wait for the answer.**
   *
   * Measured on the wire 2026-09-14: the walk asked, said so, and the very
   * next status line fell through to *I can no longer tell which room you are
   * in* and stopped the journey — before `rm` had been answered. No signature
   * among the asylum's twenty-four landings is held by one room, so this is
   * every arrival there, not a corner.
   */
  it('waits for the rm it asked for rather than stopping on the next line', async () => {
    let asks = 0;
    let inFlight = 0;
    let where = at(null, null);
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => where,
      pendingMoves: () => inFlight,
      locate: () => {
        asks += 1;
      },
      replan: () => ({
        steps: [
          {
            from: '9/11',
            to: '9/99',
            direction: 'n',
            command: 'n',
            name: "Old Man's Cell",
            requirement: null,
            dark: false
          }
        ],
        cost: 1,
        blocked: false
      })
    });
    walk.start(drawn(4), at(1, 1));
    await vi.advanceTimersByTimeAsync(50);

    // The landing: named, but four of the draw's rooms share its signature.
    const lost = at(null, null, {
      room: { ...structuredClone(EMPTY_CHARACTER.room), ambiguous: 4 }
    });
    walk.onCharacter(lost);
    await vi.advanceTimersByTimeAsync(10);
    expect(asks).toBe(1);
    expect(walk.progress.status).toBe('walking');

    // A second status line before the answer used to stop the walk here.
    walk.onCharacter(lost);
    await vi.advanceTimersByTimeAsync(10);
    expect(asks).toBe(1);
    expect(walk.progress.status).toBe('walking');

    // And the answer arrives, so the journey carries on.
    where = at(9, 11);
    walk.onCharacter(at(9, 11));
    await vi.advanceTimersByTimeAsync(50);
    expect(walk.progress.status).toBe('walking');
    expect(moves(sent)).toEqual(['w', 'n']);
    walk.dispose();
  });

  /*
   * A draw that lands somewhere the destination cannot be reached from ends
   * the walk with the router's own reason. The realm can do this — the way out
   * of the Warped Asylum is one room of a hundred and eight — and a walk that
   * kept stepping would be sending directions from a room it has no plan for.
   */
  it('stops with the router\u2019s reason when the landing leads nowhere', async () => {
    let inFlight = 0;
    const walk = new Walker(config, queue, {
      notice: (m) => notices.push(m),
      stateNow: () => at(9, 12),
      pendingMoves: () => inFlight,
      replan: () => ({ steps: [], cost: 0, blocked: true, reason: 'No way there at all' })
    });
    walk.start(drawn(4), at(1, 1));
    await vi.advanceTimersByTimeAsync(50);
    inFlight = 1;
    walk.onCharacter(at(9, 10));
    await vi.advanceTimersByTimeAsync(10);
    inFlight = 0;
    walk.onCharacter(at(9, 12));
    await vi.advanceTimersByTimeAsync(50);

    expect(walk.progress.status).toBe('stopped');
    expect(walk.progress.reason).toBe('No way there at all');
    walk.dispose();
  });
});
