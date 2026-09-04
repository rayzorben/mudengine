import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../app/i18n';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

import { LoopRunner, type LoopPlanner } from '../LoopRunner';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { Loop } from '../../../shared/loops';
import type { Route } from '../../../shared/world';

const loop: Loop = { name: 'Arena', stops: [{ room: 'Arena' }, { room: 'Road' }] };

const route = (name: string): Route => ({
  steps: [
    { from: '1/1', to: '1/2', direction: 'n', command: 'n', name, requirement: null, dark: false }
  ],
  cost: 1,
  blocked: false
});

function state(over: Partial<CharacterState> = {}): CharacterState {
  return { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game', ...over };
}

/** A planner that records what was asked for and answers as told. */
function planner(over: Partial<LoopPlanner> = {}) {
  const walked: string[] = [];
  const base: LoopPlanner = {
    routeTo: (stop) => route(stop.name),
    walk: (r) => {
      walked.push(r.steps.at(-1)!.name);
      return null;
    },
    here: () => false,
    moveInFlight: () => false,
    walking: () => false,
    // The stops of the fixture loop, so what the map would mark is testable
    // without a realm behind it.
    roomOf: (stop) => (stop.name === 'Arena' ? '1/10' : stop.name === 'Road' ? '1/11' : null),
    ...over
  };
  return { planner: base, walked };
}

describe('starting a loop', () => {
  it('walks to the first stop and says what it is doing', () => {
    const { planner: p, walked } = planner();
    const notices: string[] = [];
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    expect(runner.start(loop, state())).toBeNull();
    expect(walked).toEqual(['Arena']);
    expect(runner.progress).toMatchObject({ status: 'running', name: 'Arena', stop: 1, stops: 2 });
    expect(notices[0]).toContain('2 stops');
  });

  it('starts from the stop it is already standing in', () => {
    const { planner: p, walked } = planner({ here: (stop) => stop.name === 'Road' });
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    // Standing in Road: the next place to be is Arena, not a walk back to it.
    expect(walked).toEqual(['Arena']);
  });

  it('refuses outside the realm', () => {
    const { planner: p } = planner();
    expect(new LoopRunner(p, {}).start(loop, state({ phase: 'unknown' }))).toBe(
      'Not in the realm.'
    );
  });

  /* Captured live 2026-09-01: a loop started with combat running planned its
     first leg immediately and the walker stepped out of the fight, leaving
     the room's coins to be asked for from the wrong room. The fight is the
     point: nothing is planned until it is over. */
  it('started mid-fight, it clears the room before walking', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    expect(runner.start(loop, state({ inCombat: true }))).toBeNull();
    expect(walked).toEqual([]);
    // Started and held, and the card says which hold it is.
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'fight' });
    // Another round of the same fight moves nothing.
    runner.onCharacter(state({ inCombat: true }));
    expect(walked).toEqual([]);
    // *Combat Off*: now the leg goes out.
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
  });

  /* The fighting guard reads the loop's own flag, and the walker reads the
     tracker; if they ever disagree, the walker's combat refusal is a fight to
     wait out — the distinction `onWalkEnded` already draws — never a stop to
     give up on. */
  it('waits out a walker combat refusal instead of skipping the stop', () => {
    const walked: string[] = [];
    let fighting = true;
    const p: LoopPlanner = {
      routeTo: (stop) => route(stop.name),
      walk: (r) => {
        if (fighting) return t('automation.walk.refusalInCombat');
        walked.push(r.steps.at(-1)!.name);
        return null;
      },
      here: () => false,
      moveInFlight: () => false,
      walking: () => false,
      roomOf: () => null
    };
    const runner = new LoopRunner(p, {});
    // The loop believed no fight was on; the walker knew better.
    expect(runner.start(loop, state())).toBeNull();
    expect(walked).toEqual([]);
    // Still pointed at the same stop — nothing was counted against it.
    expect(runner.progress).toMatchObject({ status: 'running', stop: 1, hold: 'fight' });
    fighting = false;
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
  });
});

describe('going round', () => {
  it('dwells at each stop, then heads for the next, and counts a lap', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(true, null, state());
    // Standing in the lair is the point of visiting it: nothing moves until
    // the dwell lapses, so a monster at home has a character to swing at.
    expect(walked).toEqual(['Arena']);
    vi.advanceTimersByTime(2_100);
    expect(walked).toEqual(['Arena', 'Road']);
    runner.onWalkEnded(true, null, state());
    vi.advanceTimersByTime(2_100);
    expect(walked).toEqual(['Arena', 'Road', 'Arena']);
    expect(runner.progress.laps).toBe(1);
  });

  it('holds the dwell open while a fight runs', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(true, null, state());
    runner.onCharacter(state({ inCombat: true }));
    vi.advanceTimersByTime(10_000);
    // The dwell lapsed mid-fight; nothing moved.
    expect(walked).toEqual(['Arena']);
    // The fight ends and the loop moves on.
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('waits out a fight and plans again from where it ended up', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(false, t('automation.walk.reasonCombat'), state({ inCombat: true }));
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(state({ inCombat: true }));
    expect(walked).toEqual(['Arena']);
    // The fight is over: plan again, for the same stop it never reached.
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Arena']);
    expect(runner.progress.status).toBe('running');
  });

  /*
   * The reason half of that gate, pinned on its own. It used to be a substring
   * match on `combat`, and rewording the walker's reason broke it silently:
   * the flag carried the branch, so the test above went on passing with both
   * halves handed in together. A leg that ends *after* `*Combat Off*` has only
   * the reason, and booking it as a failure skips the lair the loop came for.
   */
  it('waits out a fight reported after the flag has cleared', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(false, t('automation.walk.reasonCombat'), state({ inCombat: false }));

    expect(runner.progress.status).toBe('running');
    // Waiting, not failed: the same stop is planned again, never skipped.
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  it('lingers longer where a stop asks for it', () => {
    let clock = 1_000_000;
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {}, () => clock);
    runner.start({ name: 'L', stops: [{ room: 'Arena', linger: 30 }, { room: 'Road' }] }, state());
    runner.onWalkEnded(true, null, state());
    expect(walked).toEqual(['Arena']);
    clock += 10_000;
    vi.advanceTimersByTime(10_000);
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
    clock += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(walked).toEqual(['Arena', 'Road']);
  });
});

describe('when it cannot get there', () => {
  it('skips a stop whose walk the game refused, and keeps the loop', () => {
    const notices: string[] = [];
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    expect(walked).toEqual(['Arena']);
    // The walk to Arena failed outright — a refused exit, not a fight.
    runner.onWalkEnded(false, 'the game refused s', state());
    // The loop moves on to Road rather than replanning the same failure.
    expect(walked).toEqual(['Arena', 'Road']);
    expect(runner.progress.status).toBe('running');
    expect(notices.some((m) => m.startsWith('Skipping'))).toBe(true);
  });

  it('tries the next stop, and gives up after three failures in a row', () => {
    const notices: string[] = [];
    const { planner: p, walked } = planner({ routeTo: () => 'no route' });
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    expect(walked).toEqual([]);
    expect(runner.progress.status).toBe('stopped');
    expect(notices.at(-1)).toContain('no route');
  });

  /*
   * The reported failure, at the level it is decided.
   *
   * A loop walked a penniless character into a 5-gold toll gate over and over,
   * because `wealth` was never handed to the router and the toll's price was
   * never read — so the route came back *unblocked* and there was nothing to
   * stop. With both fixed the route is blocked, `Walker.start` refuses it, and
   * the loop stops naming the number the player can act on rather than
   * grinding against a gate.
   */
  it('stops and names the gate when a stop is behind one it cannot pay', () => {
    const notices: string[] = [];
    const { planner: p, walked } = planner({
      walk: () => 'Town Gates charges a toll of 5 gold, and you have nothing'
    });
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    expect(walked).toEqual([]);
    expect(runner.progress.status).toBe('stopped');
    expect(runner.progress.reason).toContain('5 gold');
  });

  it('stops when the character leaves the realm', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onCharacter(state({ phase: 'unknown' }));
    expect(runner.progress).toMatchObject({
      status: 'stopped',
      reason: 'the character left the realm'
    });
  });

  it('yields to the player', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.notePlayerMoved();
    // The dictionary, not the words: the copy is the user's to reword.
    expect(runner.progress).toMatchObject({
      status: 'stopped',
      reason: t('automation.walk.reasonPlayerTookOver')
    });
  });
});

describe('losing its place', () => {
  it('asks where it is and tries again, rather than dying of a missing fact', () => {
    let located = 0;
    let lost = true;
    const { planner: p, walked } = planner({
      routeTo: (stop) => (lost ? 'I cannot tell which room you are in.' : route(stop.name))
    });
    const runner = new LoopRunner(p, { locate: () => (located += 1) });
    runner.start(loop, state());
    expect(located).toBe(1);
    expect(walked).toEqual([]);
    expect(runner.progress.status).toBe('running');
    // The rm answered and the room resolved; the retry plans and walks.
    lost = false;
    vi.advanceTimersByTime(2_600);
    expect(walked).toEqual(['Arena']);
  });

  it('gives up after enough unanswered asks', () => {
    let located = 0;
    const { planner: p } = planner({
      routeTo: () => 'I cannot tell which room you are in.'
    });
    const runner = new LoopRunner(p, { locate: () => (located += 1) });
    runner.start(loop, state());
    for (let i = 0; i < 12; i += 1) vi.advanceTimersByTime(2_600);
    expect(located).toBe(5);
    expect(runner.progress.status).toBe('stopped');
  });
});

describe('losing its place mid-walk', () => {
  it('asks where it is instead of counting a failure against the stop', () => {
    let located = 0;
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, { locate: () => (located += 1) });
    runner.start(loop, state());
    expect(walked).toEqual(['Arena']);
    // The walk died of a lost location — the stop itself was never at fault.
    runner.onWalkEnded(false, 'I can no longer tell which room you are in', state());
    expect(located).toBe(1);
    expect(runner.progress.status).toBe('running');
    // The rm answered; the same stop is planned again.
    vi.advanceTimersByTime(2_600);
    expect(walked).toEqual(['Arena', 'Arena']);
  });
});

/*
 * Running away is a hold, not an ending.
 *
 * The lap must not walk on at once — the room it ran out of is one room away,
 * and an escape's `e` answered by the loop's `w` two seconds later
 * is the measured death spiral (`logs/2026-09-02_09-58-25_festus...`). But it
 * must walk on eventually: a lap ends when the player stops it, when the
 * character dies, or when its stops fail wholesale, and automation working is
 * none of the three.
 */
describe('holding after an escape', () => {
  const at = (hp: number): CharacterState =>
    state({ vitals: { ...structuredClone(EMPTY_CHARACTER).vitals, hp, hpMax: 100 } });

  it('stands still for the settle and then walks the lap on', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, at(100));
    runner.onWalkEnded(true, null, at(100));
    runner.noteEscaped();
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'retreated', stop: 1 });
    // The dwell lapsing is not the hold lifting.
    vi.advanceTimersByTime(5_000);
    runner.onCharacter(at(100));
    expect(walked).toEqual(['Arena']);
    // Past the settle, and healthy: the lap picks up where it left off.
    vi.advanceTimersByTime(4_000);
    runner.onCharacter(at(100));
    expect(runner.progress.hold).toBeNull();
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /* Run away *and* hurt is the ordinary case, and the health ceiling outlives
     the settle: walking on at 40% is walking back into what the escape was for. */
  it('waits for the health as well as the clock', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, at(100));
    runner.onWalkEnded(true, null, at(40));
    runner.noteEscaped();
    vi.advanceTimersByTime(30_000);
    runner.onCharacter(at(40));
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(at(80));
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /* A `safe-haven` escape walks the character home while the loop is held. That
     walk is not the lap's: it is neither an arrival at the stop nor the stop
     failing, and nothing of the loop's own may be planned across it. */
  it('leaves the retreat walk alone, and does not plan across it', () => {
    let retreating = true;
    const { planner: p, walked } = planner({ walking: () => retreating });
    const runner = new LoopRunner(p, {});
    runner.start(loop, at(100));
    runner.onWalkEnded(true, null, at(100));
    runner.noteEscaped();
    // The retreat arrives somewhere the lap never chose.
    runner.onWalkEnded(true, null, at(100));
    expect(runner.progress).toMatchObject({ hold: 'retreated', stop: 1, laps: 0 });
    vi.advanceTimersByTime(30_000);
    runner.onCharacter(at(100));
    expect(walked).toEqual(['Arena']);
    retreating = false;
    runner.onCharacter(at(100));
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /* The player asking for the lap back outranks the beat it is taking — and
     `resume` plans afresh for the stop it is pointed at, as it always has. */
  it('lets go when the player resumes a paused loop', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, at(100));
    runner.onWalkEnded(true, null, at(100));
    runner.noteEscaped();
    runner.pause();
    expect(runner.resume(at(100))).toBeNull();
    expect(runner.progress.hold).toBeNull();
    expect(walked).toEqual(['Arena', 'Arena']);
  });
});

describe('holding while hurt', () => {
  const hurt = (hp: number): CharacterState =>
    state({ vitals: { ...structuredClone(EMPTY_CHARACTER).vitals, hp, hpMax: 100 } });

  it('stands still under the floor and resumes only once mended', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, hurt(100));
    runner.onWalkEnded(true, null, hurt(30));
    runner.onCharacter(hurt(30));
    vi.advanceTimersByTime(10_000);
    // The dwell lapsed but the character is at 30%: nothing moves.
    expect(walked).toEqual(['Arena']);
    // Half-mended is not mended; hysteresis holds.
    runner.onCharacter(hurt(50));
    vi.advanceTimersByTime(5_000);
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(hurt(75));
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /*
   * The floors are the character's, not the client's: a caster pausing at 60%
   * and walking on at 90% is the configuration this exists for, and the pair
   * still behaves as a pair.
   */
  it('holds and resumes at the floors it was configured with', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.configure({
      ...DEFAULT_CONFIG.automation.health,
      restBelow: 0.6,
      restTo: 0.9
    });
    runner.start(loop, hurt(100));
    runner.onWalkEnded(true, null, hurt(55));
    runner.onCharacter(hurt(55));
    vi.advanceTimersByTime(10_000);
    // 55% would have marched under the old fixed 35%; this character pauses.
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(hurt(75));
    vi.advanceTimersByTime(5_000);
    // 75% would have resumed at the old fixed 70%; this character waits for 90.
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(hurt(90));
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /*
   * `restTo: 0` means the single sit-down to `Recovery`, and it is what
   * `statedTheRestCeiling` has written into every existing file that states a
   * health block -- so for a lap it is the *common* case rather than a corner
   * of one. Read literally it is a zero-width band: resume at exactly the
   * health it paused at, and the next hit puts it straight back. So an
   * uncapped rest resumes a margin above the floor.
   */
  it('resumes a margin above the floor when no ceiling is set', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.configure({ ...DEFAULT_CONFIG.automation.health, restBelow: 0.6, restTo: 0 });
    runner.start(loop, hurt(100));
    runner.onWalkEnded(true, null, hurt(55));
    runner.onCharacter(hurt(55));
    vi.advanceTimersByTime(10_000);
    expect(walked).toEqual(['Arena']);
    /*
     * The floor itself is *not* enough. This is the regression: touching 60
     * would have resumed the march at the very figure it paused at, and the
     * next blow would have paused it again.
     */
    runner.onCharacter(hurt(60));
    vi.advanceTimersByTime(5_000);
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(hurt(65));
    vi.advanceTimersByTime(5_000);
    expect(walked).toEqual(['Arena']);
    // 0.6 + the 0.1 margin.
    runner.onCharacter(hurt(70));
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /* A floor high enough that the margin would overshoot must still let the lap
     go again, or a character configured to rest at 95% never walks. */
  it('never asks for more than full health', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.configure({ ...DEFAULT_CONFIG.automation.health, restBelow: 0.95, restTo: 0 });
    runner.start(loop, hurt(100));
    runner.onWalkEnded(true, null, hurt(50));
    runner.onCharacter(hurt(50));
    vi.advanceTimersByTime(10_000);
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(hurt(100));
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('never pauses when told 0', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.configure({ ...DEFAULT_CONFIG.automation.health, restBelow: 0, restTo: 0 });
    runner.start(loop, hurt(100));
    runner.onWalkEnded(true, null, hurt(5));
    runner.onCharacter(hurt(5));
    vi.advanceTimersByTime(2_100);
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('an unknown maximum holds nothing', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(true, null, state());
    vi.advanceTimersByTime(2_100);
    expect(walked).toEqual(['Arena', 'Road']);
  });
});

/**
 * The places the lap still owes, which is what the map marks for a loop.
 *
 * Deliberately the *stops* and not the rooms between them: a leg is planned
 * when it is walked, so a line drawn ahead over the whole lap would be a route
 * the runner is under no obligation to take. The leg being walked draws itself
 * through `WalkProgress.path`.
 */
describe('the stops a lap still owes', () => {
  const abc: Loop = { name: 'ABC', stops: [{ room: 'A' }, { room: 'B' }, { room: 'C' }] };
  const rooms = (over: Partial<LoopPlanner> = {}) =>
    planner({
      roomOf: (stop) => ({ A: '1/1', B: '1/2', C: '1/3' })[stop.name] ?? null,
      ...over
    });

  it('lists the stop being walked to first, then the rest of the lap', () => {
    const runner = new LoopRunner(rooms().planner, {});
    runner.start(abc, state());
    expect(runner.progress.remainingStops).toEqual(['1/1', '1/2', '1/3']);
  });

  it('drops a stop as the lap reaches it', () => {
    const runner = new LoopRunner(rooms().planner, {});
    runner.start(abc, state());
    runner.skip();
    expect(runner.progress.remainingStops).toEqual(['1/2', '1/3']);
  });

  /* A lap is the list run through once, however it is walked — the same
     sentence the lap counter uses. Marking a stop twice on one map would say
     nothing about which visit is owed. */
  it('stops at the end of the lap rather than running on round the next', () => {
    const runner = new LoopRunner(rooms().planner, {});
    runner.start(abc, state());
    runner.skip();
    runner.skip();
    expect(runner.progress.remainingStops).toEqual(['1/3']);
  });

  /* A bounce loop walked back down the list owes the stops *before* it. */
  it('reads a reversed bounce loop back down its own list', () => {
    const runner = new LoopRunner(rooms().planner, {});
    runner.start({ ...abc, bounce: true }, state());
    runner.skip();
    expect(runner.progress.remainingStops).toEqual(['1/2', '1/3']);
    runner.reverse();
    expect(runner.progress.remainingStops).toEqual(['1/2', '1/1']);
  });

  /*
   * A name the realm cannot settle — thirteen rooms are called Town Gates —
   * has no room to mark, and guessing one would put a ring on a place the lap
   * is not going. The rest of the lap is still drawn.
   */
  it('leaves out a stop the realm could not place, and keeps the ones it could', () => {
    const runner = new LoopRunner(
      rooms({ roomOf: (stop) => (stop.name === 'B' ? null : { A: '1/1', C: '1/3' }[stop.name]!) })
        .planner,
      {}
    );
    runner.start(abc, state());
    expect(runner.progress.remainingStops).toEqual(['1/1', '1/3']);
  });

  /*
   * A stopped lap owes nothing. Its name and its reason survive — the card
   * still says why it ended — but a map that went on marking its stops would
   * be drawing a lap nothing is walking.
   */
  it('owes nothing once the lap has stopped, and everything again on the next one', () => {
    const runner = new LoopRunner(rooms().planner, {});
    runner.start(abc, state());
    expect(runner.progress.remainingStops).not.toEqual([]);
    runner.stop('asked');
    expect(runner.progress.remainingStops).toEqual([]);
    runner.start(abc, state());
    expect(runner.progress.remainingStops).toEqual(['1/1', '1/2', '1/3']);
  });

  /* A pause keeps the loop's place, so it keeps what the lap still owes. */
  it('keeps them while the lap is paused', () => {
    const runner = new LoopRunner(rooms().planner, {});
    runner.start(abc, state());
    runner.pause();
    expect(runner.progress.remainingStops).toEqual(['1/1', '1/2', '1/3']);
  });
});

/*
 * The card's controls. Pause keeps the loop and its place; resume plans afresh
 * from wherever the character is; skip gives up on a stop; reverse is only a
 * thing a bounce loop can do. The leg being walked is the caller's to end —
 * the runner never touches the walker — so nothing here asserts on the walker.
 */
describe('the loop card’s controls', () => {
  const bounce: Loop = {
    name: 'Bounce',
    stops: [{ room: 'A' }, { room: 'B' }, { room: 'C' }],
    bounce: true
  };

  it('pauses where it is, decides nothing while paused, and walks on from here on resume', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.pause();
    expect(runner.progress.status).toBe('paused');
    expect(runner.progress.name).toBe('Arena');
    // A fight ending or a room arriving while paused moves nothing.
    runner.onWalkEnded(true, null, state());
    runner.onCharacter(state());
    vi.advanceTimersByTime(10_000);
    expect(walked).toEqual(['Arena']);
    expect(runner.resume(state())).toBeNull();
    expect(runner.progress.status).toBe('running');
    // Planned again from where the character is, not from the pause.
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  /* Resume had the same hole a mid-fight start did: it read the fight into
     `fighting` and then planned anyway. Resumed mid-fight, the loop holds and
     walks on when the fight ends. */
  it('resumed mid-fight, it waits for the fight before walking', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.pause();
    expect(runner.resume(state({ inCombat: true }))).toBeNull();
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'fight' });
    expect(walked).toEqual(['Arena']);
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  it('refuses to resume what is not paused', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    expect(runner.resume(state())).toMatch(/not paused/i);
  });

  it('can be stopped while paused', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.pause();
    runner.stop('asked');
    expect(runner.progress.status).toBe('stopped');
  });

  it('skips the current stop and heads for the next', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    expect(runner.progress.stop).toBe(1);
    expect(runner.skip()).toBeNull();
    expect(runner.progress.stop).toBe(2);
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('while paused, skip only moves the pointer and the walk waits for resume', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.pause();
    expect(runner.skip()).toBeNull();
    expect(runner.progress.stop).toBe(2);
    expect(walked).toEqual(['Arena']);
    runner.resume(state());
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('reverses a bounce loop and refuses a plain one', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(bounce, state());
    expect(runner.progress.bounce).toBe(true);
    expect(runner.progress.forward).toBe(true);
    expect(runner.reverse()).toBeNull();
    expect(runner.progress.forward).toBe(false);

    const plain = new LoopRunner(planner().planner, {});
    plain.start(loop, state());
    expect(plain.reverse()).toMatch(/bounce/i);
  });

  it('refuses every control while nothing is looping', () => {
    const runner = new LoopRunner(planner().planner, {});
    expect(runner.skip()).toMatch(/nothing is looping/i);
    expect(runner.reverse()).toMatch(/nothing is looping/i);
    expect(runner.resume(state())).toMatch(/not paused/i);
  });

  /*
   * The dwell's end is deliberately *not* published. It was `Leaving in 2s` on
   * the card, beside a chip already saying `running`, `fighting` or `resting` —
   * the same fact twice, the second time in the words that explain it. What is
   * published is the hold, which is what the chip draws.
   */
  it('reports the stop by name and what it is holding for', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {}, () => 1_000_000);
    const fighting = state({ inCombat: true });
    runner.start(loop, state());
    expect(runner.progress.stopName).toBe('Arena');
    expect(runner.progress.startedAt).toBe(1_000_000);
    runner.onWalkEnded(true, null, state());
    runner.onCharacter(fighting);
    expect(runner.progress.hold).toBe('fight');
    runner.onCharacter(state());
    expect(runner.progress.hold).toBeNull();
  });

  it('claims experience made only from a number it had at the start', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    expect(runner.progress.expAtStart).toBeNull();
    const known = state({ progress: { ...structuredClone(EMPTY_CHARACTER).progress, exp: 4_200 } });
    const second = new LoopRunner(planner().planner, {});
    second.start(loop, known);
    expect(second.progress.expAtStart).toBe(4_200);
  });
});

/*
 * `*Combat Off*` arrives before the room the last step reached, which is
 * exactly when a loop wants to plan the next leg. Measured 2026-08-30: it
 * planned from the room the character had left, sent that room's exit a second
 * time, and the refusal earned by the duplicate was booked against the step
 * behind it — two false edges and a dead loop in ninety seconds.
 */
describe('a move still on the wire', () => {
  it('waits rather than planning from the room being left', () => {
    let inFlight = true;
    const { planner: p, walked } = planner({ moveInFlight: () => inFlight });
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());

    expect(walked).toEqual([]);
    expect(runner.progress.status).toBe('running');

    // The room lands, which is a state change, and the leg is planned from it.
    inFlight = false;
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
  });

  it('does not count the wait as a failure against the stop', () => {
    let inFlight = true;
    const { planner: p, walked } = planner({ moveInFlight: () => inFlight });
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    // Three waits — `MAX_FAILURES` — and the loop is still running, because
    // waiting for a fact that is arriving is not a stop that could not be
    // reached.
    for (let tick = 0; tick < 3; tick += 1) runner.onCharacter(state());
    expect(runner.progress.status).toBe('running');

    inFlight = false;
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
  });

  it('asks the realm where it is when nothing lands', () => {
    const located: number[] = [];
    const { planner: p } = planner({ moveInFlight: () => true });
    const runner = new LoopRunner(p, { locate: () => located.push(1) });
    runner.start(loop, state());

    vi.advanceTimersByTime(3_000);
    expect(located).toHaveLength(1);
  });
});

describe('an errand', () => {
  /* The pack ran short and `Supplies` is walking the character to a shop:
     the lap is held, not ended, and it plans on from the shop afterwards. */
  it('holds the lap, books nothing against the stop, and walks on from wherever it ends', () => {
    const { planner: p, walked } = planner();
    const notices: string[] = [];
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    expect(walked).toEqual(['Arena']);

    runner.noteErrand();
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'errand' });
    // The errand's walk supersedes the leg; what ends here is neither an
    // arrival nor a failure.
    runner.onWalkEnded(false, 'superseded', state());
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
    expect(runner.progress.status).toBe('running');

    runner.noteErrandOver();
    expect(runner.progress.hold).toBeNull();
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Arena']);
    expect(notices.some((m) => m.includes('shop'))).toBe(true);
  });

  /* Reported 2026-09-03 as "why does it keep doing rm", and measured in
     `logs/2026-09-03_22-46-50_festus.mudcap.jsonl`: five `rm`s, exactly
     `maxLocates`, 5.0s apart to the millisecond, all inside a 31-step walk to
     a General Store. The errand began while the lap was dwelling at a stop —
     which is the only time it *can* begin, since `Supplies.consider` refuses
     while anything else has the character — and the dwell timer was the one
     way into `advance` that never asked whether the errand had it. The dwell
     lapsed, `step` consumed a stop the lap never visited, and `advance` then
     read the errand's own moves as its own swallowed one, once per two
     `locateWaitMs` until the budget ran out. On a realm without the word, each
     of those is the client saying "rm" out loud in the room. */
  it('takes the character out of a dwell without spending a stop or an rm', () => {
    let located = 0;
    // The wire is quiet until the errand's own route starts stepping — which
    // is the whole point: `Supplies` will not begin one otherwise.
    let shopping = false;
    const { planner: p, walked } = planner({ moveInFlight: () => shopping });
    const runner = new LoopRunner(p, { locate: () => (located += 1) });
    runner.start(loop, state());
    // Arrived at the first stop: the dwell is armed and the lap is standing
    // still, which is the state `Supplies` starts an errand from.
    runner.onWalkEnded(true, null, state());
    expect(walked).toEqual(['Arena']);
    runner.noteErrand();
    shopping = true;

    // The dwell lapses mid-errand, and long after it the errand's route is
    // still stepping — `moveInFlight` answers the wire, not this loop.
    vi.advanceTimersByTime(60_000);
    expect(located).toBe(0);
    expect(walked).toEqual(['Arena']);
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'errand', stop: 1 });

    // Back from the shop, and the lap goes on to the *next* stop: the dwell it
    // sat out was served, exactly as an escape's hold serves it.
    shopping = false;
    runner.noteErrandOver();
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Road']);
    expect(located).toBe(0);
  });

  it('is nothing to a loop that is not running', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.noteErrand();
    expect(runner.progress.hold).toBeNull();
    runner.noteErrandOver();
    expect(runner.progress.status).toBe('idle');
  });

  it('is outranked by the player resuming the lap', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.noteErrand();
    runner.pause();
    runner.resume(state());
    expect(runner.progress.hold).toBeNull();
    expect(walked).toEqual(['Arena', 'Arena']);
  });
});

/*
 * The character stands wherever the socket went, with whatever was in the
 * room; a router rebooting is none of the three things that end a lap. Before
 * this the leg the socket ended was booked as a failed stop and the next dial
 * reset the loop to nothing, so a character dialled back in stood in a lair
 * all night with the lap gone from the card.
 */
describe('losing the connection', () => {
  it('holds the lap, books nothing against the stop, and walks on from here when the character is back', () => {
    const { planner: p, walked } = planner();
    const notices: string[] = [];
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    expect(walked).toEqual(['Arena']);

    runner.noteOffline();
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'offline', stop: 1 });
    expect(runner.carried).toBe(true);
    expect(notices).toContain(t('automation.loops.heldOffline'));
    // The walker is stopped after the hold is taken: the leg the socket ended
    // is not a failed stop, so the lap is still pointed at Arena.
    runner.onWalkEnded(
      false,
      t('session.walk.stoppedConnectionClosed'),
      state({ phase: 'unknown' })
    );
    expect(runner.progress).toMatchObject({ status: 'running', stop: 1, hold: 'offline' });
    // Neither the closed socket nor the next connection's login screens are
    // the character leaving the realm.
    runner.onCharacter(state({ phase: 'unknown' }));
    expect(runner.progress.status).toBe('running');
    expect(walked).toEqual(['Arena']);

    runner.noteOnline();
    expect(runner.carried).toBe(false);
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Arena']);
    expect(runner.progress).toMatchObject({ status: 'running', hold: null, stop: 1 });
    expect(notices).toContain(t('automation.loops.walkingOnAfterReconnect'));
  });

  it('a dwell the loss interrupted goes on to the next stop when the character is back', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(true, null, state());
    runner.noteOffline();
    // The dwell lapses while offline, and nothing is planned into a closed socket.
    vi.advanceTimersByTime(5_000);
    expect(walked).toEqual(['Arena']);
    runner.noteOnline();
    runner.onCharacter(state());
    // The stop was reached before the loss, so the lap goes on to Road rather
    // than walking back into the one it was standing in.
    expect(walked).toEqual(['Arena', 'Road']);
  });

  /* `noteOffline` puts the dwell's timer down, and an empty lair at night
     changes nothing for minutes — so the timer has to come back with the
     character, for whatever is left of the dwell. */
  it('gives an interrupted dwell its timer back for what is left of it', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.onWalkEnded(true, null, state());
    runner.noteOffline();
    vi.advanceTimersByTime(500);
    runner.noteOnline();
    runner.onCharacter(state());
    // 1.5s of the 2s dwell remain, and the stream says nothing more.
    expect(walked).toEqual(['Arena']);
    vi.advanceTimersByTime(1_600);
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('a paused lap stays paused across it, and resumes by hand from here', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.pause();
    runner.noteOffline();
    expect(runner.carried).toBe(true);
    // A paused loop is not waiting for anything, so it reports no hold.
    expect(runner.progress).toMatchObject({ status: 'paused', hold: null });
    expect(runner.resume(state({ phase: 'unknown' }))).toBe(
      t('automation.loops.refusalNotInRealm')
    );
    runner.noteOnline();
    expect(runner.carried).toBe(false);
    expect(runner.progress.status).toBe('paused');
    expect(runner.resume(state())).toBeNull();
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  /* Back in the realm but not yet placed: the card offers Resume, and a leg
     planned from an unknown room would spend the locate budget on a question
     the entry probe has already asked. */
  it('resumed before the character is placed, it waits to be', () => {
    const { planner: p, walked } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.pause();
    runner.noteOffline();
    expect(runner.resume(state())).toBeNull();
    expect(runner.progress).toMatchObject({ status: 'running', hold: 'offline' });
    expect(walked).toEqual(['Arena']);
    runner.noteOnline();
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  /* `Supplies.abandon` releases the loop after the socket has gone; the loop
     must not announce walking on from a shop it never reached. */
  it('lets an errand the loss ended go, silently', () => {
    const { planner: p } = planner();
    const notices: string[] = [];
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    runner.noteErrand();
    expect(runner.progress.hold).toBe('errand');
    runner.noteOffline();
    expect(runner.progress.hold).toBe('offline');
    runner.noteErrandOver();
    expect(notices).not.toContain(t('automation.loops.walkingOnAfterErrand'));
    expect(runner.progress.hold).toBe('offline');
  });

  /* Before the loss the player's route had superseded the leg and the lap sat
     dormant under it; the pick-up hands the route back to the walker first,
     and waking the lap here would plan a leg straight over it. */
  it('stays dormant under a route that has the character, and wakes when it ends', () => {
    let walking = false;
    const { planner: p, walked } = planner({ walking: () => walking });
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    expect(walked).toEqual(['Arena']);
    runner.noteOffline();
    walking = true;
    runner.noteOnline();
    runner.onCharacter(state());
    expect(walked).toEqual(['Arena']);
    expect(runner.progress).toMatchObject({ status: 'running', hold: null });
    // The route arrives; the lap books it as before and goes on from there.
    walking = false;
    runner.onWalkEnded(true, null, state());
    vi.advanceTimersByTime(2_100);
    expect(walked).toEqual(['Arena', 'Road']);
  });

  it('does not claim to walk on while the health floor still holds it', () => {
    const { planner: p, walked } = planner();
    const notices: string[] = [];
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.configure({ ...DEFAULT_CONFIG.automation.health, restBelow: 0.5, restTo: 0.8 });
    runner.start(loop, state());
    const hurt = state({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 100 } });
    runner.onCharacter(hurt);
    expect(runner.progress.hold).toBe('health');
    runner.noteOffline();
    runner.noteOnline();
    runner.onCharacter(hurt);
    expect(notices).not.toContain(t('automation.loops.walkingOnAfterReconnect'));
    expect(runner.progress.hold).toBe('health');
    expect(walked).toEqual(['Arena']);
    // Mended is the line that says it walks on, as it always was.
    runner.onCharacter(state({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 90, hpMax: 100 } }));
    expect(notices).toContain(t('automation.loops.mended'));
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  /* The beat's clock is a pre-outage timestamp, so it would let go on the
     first line back with a second, contradictory line about the retreat. */
  it('ends the beat after an escape with the socket', () => {
    const { planner: p, walked } = planner();
    const notices: string[] = [];
    const runner = new LoopRunner(p, { notice: (m) => notices.push(m) });
    runner.start(loop, state());
    runner.noteEscaped();
    expect(runner.progress.hold).toBe('retreated');
    runner.noteOffline();
    runner.noteOnline();
    runner.onCharacter(state());
    expect(notices).not.toContain(t('automation.loops.walkingOnAfterEscape'));
    expect(walked).toEqual(['Arena', 'Arena']);
  });

  it('is put down by the player, offline or not', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.start(loop, state());
    runner.noteOffline();
    runner.stop(t('session.walk.stoppedByPlayer'));
    expect(runner.carried).toBe(false);
    expect(runner.progress.status).toBe('stopped');
  });

  it('is nothing to a loop that is not running', () => {
    const { planner: p } = planner();
    const runner = new LoopRunner(p, {});
    runner.noteOffline();
    expect(runner.carried).toBe(false);
    expect(runner.progress.status).toBe('idle');
  });
});
