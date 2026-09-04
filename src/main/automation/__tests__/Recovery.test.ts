import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Recovery } from '../Recovery';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG, type AutomationConfig, type HealthConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const health = (over: Partial<HealthConfig> = {}): HealthConfig => ({
  ...DEFAULT_CONFIG.automation.health,
  ...over
});

function state(
  over: Partial<CharacterState['vitals']> & Partial<CharacterState> = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  const { hp, hpMax, mana, manaMax, resting, meditating, ...rest } = over as Record<string, never> &
    Partial<CharacterState>;
  return {
    ...base,
    phase: 'in-game',
    ...rest,
    vitals: {
      ...base.vitals,
      ...(hp === undefined ? {} : { hp }),
      ...(hpMax === undefined ? {} : { hpMax }),
      ...(mana === undefined ? {} : { mana }),
      ...(manaMax === undefined ? {} : { manaMax }),
      ...(resting === undefined ? {} : { resting }),
      ...(meditating === undefined ? {} : { meditating })
    }
  };
}

/**
 * A fight with somebody in it.
 *
 * Spelled out rather than defaulted, because the whole of `fightIsHere` turns
 * on the difference between a combat flag with participants behind it and one
 * without: a test that got them for free could not tell the two apart.
 */
function fighting(over: Partial<CharacterState['combat']> = {}): CharacterState['combat'] {
  return { ...structuredClone(EMPTY_CHARACTER.combat), ...over };
}

/**
 * A room with one monster standing in it, of a kind `countThreats` is blind to.
 *
 * The disposition matters and is the point. `countThreats`, the guard *below*
 * `fightIsHere`, counts only `attacksOnSight === true`, so a `hostile` monster
 * makes these cases pass whether `fightIsHere` works or not — which is how two
 * of them passed against the broken predicate when they were first written.
 * `passive` and `null` (the realm cannot place it, or the alignment-dependent
 * answer with no `who` read yet) are the two the threat count is silent about,
 * so they isolate the thing under test.
 */
function withMob(name: string, disposition: 'passive' | null = null): CharacterState['room'] {
  const room = structuredClone(EMPTY_CHARACTER.room);
  room.occupants = [
    {
      name,
      kind: 'mob',
      disposition,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    }
  ];
  return room;
}

let sent: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config: HealthConfig, enabled = true): Recovery =>
  new Recovery(config, enabled, queue);

/** Runs the queue's pacing forward so whatever was proposed reaches `sent`. */
const drain = (): void => void vi.advanceTimersByTime(500);

describe('sitting down', () => {
  it('rests below the threshold it was given', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 20, hpMax: 100 }));
    drain();
    expect(sent).toEqual(['rest']);
  });

  it('does nothing above it', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 80, hpMax: 100 }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Stated rather than inherited from the shipped default, which is 0.35 since
   * the loop's health hold folded into this pair (2026-09-02). The claim being
   * made is about the threshold, not about what the client happens to ship
   * with -- a test that reads "off" out of the defaults asserts the default and
   * calls it the behaviour.
   */
  it('does nothing at all when the threshold is off', () => {
    make(health({ restBelow: 0, restTo: 0 })).onCharacter(state({ hp: 1, hpMax: 100 }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Unknown is not low. A maximum that has not arrived yet must never start
   * anything — the same rule that stops a meter painting red and a character
   * running from a fight it was winning.
   */
  it('does not rest on a health figure with no maximum behind it', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 3 }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Being attacked breaks a rest, so one sent during a fight is a command spent
   * to be told so — out of the same budget the fight is being fought with.
   *
   * The test is what is *swinging*, so both halves are asserted: what this
   * character is attacking, and what is attacking it.
   */
  it('never rests while it is attacking something', () => {
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, inCombat: true, combat: fighting({ target: 'cave worm' }) })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('never rests while something is attacking it', () => {
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, inCombat: true, combat: fighting({ attackers: ['cave worm'] }) })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Something swinging at a character that was never formally engaged. The
   * guard this replaced read the combat flag alone and let this through.
   */
  it('never rests while something is swinging with no combat flag up', () => {
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, inCombat: false, combat: fighting({ attackers: ['cave worm'] }) })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The reported delay, and the whole reason `fightIsHere` exists.
   *
   * After an escape the server leaves the combat flag up for a median 3,493ms
   * (44 retreats, measured) while the character stands a room away with
   * nothing swinging at it — and `CharacterTracker` has already cleared the
   * fight's participants on the confirmed move. Resting there is accepted by
   * the server, measured on a hand-typed `rest` in that very window
   * (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl` t=94683), so waiting the
   * flag out spent three and a half seconds of a hurt character's time for
   * nothing.
   */
  it('rests with the combat flag still up once the fight is behind it', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 10, hpMax: 100, inCombat: true }));
    drain();
    expect(sent).toEqual(['rest']);
  });

  /*
   * The three ways a real fight has the flag up and *nothing recorded behind
   * it*, all found by review before this shipped. Reading an empty pair as
   * "the fight is over" would have rested in the middle of every one.
   *
   * What tells them apart from an escape is the room: the thing being fought is
   * standing in it. So each of these asserts silence with an occupant present,
   * against the case above, which is the same flag with an empty room — and
   * each occupant is one `countThreats` cannot see, or the guard below would
   * be what refused and these would pass with the predicate broken.
   */
  it('never rests on the opening round of a fight a spell started', () => {
    // `Cast` is not in ATTACK_COMMANDS, so no target is bound and no blow has
    // landed yet: the flag is the only thing that has been said. This realm's
    // mystics open every fight this way.
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, inCombat: true, room: withMob('cave worm') })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('never rests after a kill in a room that held two', () => {
    // `died` drops the dead name from both fields, and no `*Combat Off*` comes
    // while the survivor is still engaged.
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, inCombat: true, room: withMob('big thug') })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('never rests in a fight it started with something that would not have attacked', () => {
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, inCombat: true, room: withMob('giant rat', 'passive') })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /* The status line says `(Resting)`, so nothing needs asking again. */
  it('does not ask twice while the status line says it is already resting', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 10, hpMax: 100, resting: true }));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing before the character is in the realm', () => {
    make(health({ restBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, phase: 'authenticating' })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing while automation as a whole is off', () => {
    make(health({ restBelow: 0.5 }), false).onCharacter(state({ hp: 10, hpMax: 100 }));
    drain();
    expect(sent).toEqual([]);
  });
});

describe('a character that is already resting', () => {
  /*
   * The regression this whole describe exists for (2026-08-27,
   * `logs/2026-08-27_21-24-03_main.mudcap.jsonl`). A `restUntil` threshold sent
   * `l` on reaching it, believing a look would stand the character up. It does
   * not, so the flag stayed set, so the same status line was answered the same
   * way 431 times in fourteen seconds.
   *
   * Full health and resting is precisely the state that produced it, and the
   * only right answer is silence: resting blocks nothing, and the first step of
   * a walk or the first swing of a fight ends it without a command being spent.
   */
  it('sends nothing at full health', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 100, hpMax: 100, resting: true }));
    drain();
    expect(sent).toEqual([]);
  });

  it('sends nothing when hurt, rather than a second rest', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 20, hpMax: 100, resting: true }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The status line carries no maximum on this realm, so an unknown one is the
   * ordinary case rather than the exotic one — and it was what made the loop
   * fire even for a character below its threshold. Unknown must not start
   * anything here either.
   */
  it('sends nothing when no maximum ever arrived', () => {
    make(health({ restBelow: 0.5 })).onCharacter(state({ hp: 12, resting: true }));
    drain();
    expect(sent).toEqual([]);
  });

  /* The same, however many status lines arrive: there is no state to escalate. */
  it('stays silent across a burst of status lines', () => {
    const recovery = make(health({ restBelow: 0.5 }));
    for (let i = 0; i < 20; i += 1) {
      recovery.onCharacter(state({ hp: 101, hpMax: 101, resting: true }));
      drain();
    }
    expect(sent).toEqual([]);
  });

  it('sends nothing while meditating either', () => {
    make(health({ meditateBelow: 0.5 })).onCharacter(
      state({ mana: 100, manaMax: 100, meditating: true })
    );
    drain();
    expect(sent).toEqual([]);
  });
});

describe('having asked, before the flag has arrived', () => {
  /*
   * The burst this exists for (2026-09-02,
   * `logs/2026-09-02_09-08-19_festus.mudcap.jsonl`). Eight probe answers were
   * outstanding at login, so eight status lines came back before the first
   * `rest` was answered — and `(Resting)` is the *server's* answer, so on every
   * one of them the state still said "not resting" and the threshold still said
   * "sit down". Eight `You are now resting.` inside 80ms, seven of them spent
   * from the same budget a fight is fought with.
   *
   * The state guard is right and simply had nothing to say yet; what it needed
   * behind it is a memory of having asked.
   */
  it('asks once across a burst of status lines that predate the answer', () => {
    const recovery = make(health({ restBelow: 0.5 }));
    // Ten milliseconds apart, as the capture has them: all eight answers landed
    // inside 80ms, which is well inside the window a `rest` is trusted in.
    for (let i = 0; i < 8; i += 1) {
      recovery.onCharacter(state({ hp: 30, hpMax: 80 }));
      vi.advanceTimersByTime(10);
    }
    drain();
    expect(sent).toEqual(['rest']);
  });

  /*
   * Bounded, not permanent: a `rest` the server swallowed leaves the flag down
   * for ever, and a memory with no deadline behind it would leave the character
   * standing for ever with it. `rest.askedMs` is the window.
   */
  it('asks again once the window has lapsed with no flag', () => {
    const recovery = make(health({ restBelow: 0.5 }));
    recovery.onCharacter(state({ hp: 30, hpMax: 80 }));
    drain();
    vi.advanceTimersByTime(4000);
    recovery.onCharacter(state({ hp: 30, hpMax: 80 }));
    drain();
    expect(sent).toEqual(['rest', 'rest']);
  });

  /*
   * And released by the postcondition rather than by the clock: a rest confirmed
   * and then broken on the next line is re-proposed on that line, not after the
   * remainder of a timer that has already been answered.
   */
  it('is released the moment the flag arrives, so a break is answered at once', () => {
    const recovery = make(health({ restBelow: 0.5 }));
    recovery.onCharacter(state({ hp: 30, hpMax: 80 }));
    drain();
    recovery.onCharacter(state({ hp: 32, hpMax: 80, resting: true }));
    drain();
    recovery.onCharacter(state({ hp: 32, hpMax: 80 }));
    drain();
    expect(sent).toEqual(['rest', 'rest']);
  });
});

describe('the resting ceiling', () => {
  /*
   * `restBelow` describes how a rest *begins*; the server keeps a character
   * sitting long past it for free, so the first thing to break one above the
   * floor left the character standing for the whole recovery. Casting is one of
   * those things (2026-09-02: `c swan` answered a `(Resting)` prompt and the
   * flag was gone from every prompt after it), and standing regenerates six
   * times slower. `restTo` is what makes it rest, heal, rest, heal.
   */
  it('sits back down above the floor once a rest has been broken', () => {
    const recovery = make(health({ restBelow: 0.5, restTo: 0.9 }));
    // Sat down under the floor, and the flag confirms it.
    recovery.onCharacter(state({ hp: 30, hpMax: 80, resting: true }));
    drain();
    // A cast breaks it at 60% — above `restBelow`, below `restTo`.
    recovery.onCharacter(state({ hp: 48, hpMax: 80 }));
    drain();
    expect(sent).toEqual(['rest']);
  });

  /* And stops at the ceiling rather than at the next thing to break a rest. */
  it('stops asking at the ceiling', () => {
    const recovery = make(health({ restBelow: 0.5, restTo: 0.9 }));
    recovery.onCharacter(state({ hp: 30, hpMax: 80, resting: true }));
    drain();
    recovery.onCharacter(state({ hp: 76, hpMax: 80 }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Off is off: 0 is the single sit-down at the floor, which is what this
   * module did before the pair existed.
   */
  it('does nothing above the floor when the ceiling is 0', () => {
    const recovery = make(health({ restBelow: 0.5, restTo: 0 }));
    recovery.onCharacter(state({ hp: 30, hpMax: 80, resting: true }));
    drain();
    recovery.onCharacter(state({ hp: 48, hpMax: 80 }));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Armed by the wire, not by the proposal: a rest the *player* typed is one
   * they want the benefit of, and the ceiling carries it on the same way.
   */
  it('carries on a rest the client never proposed', () => {
    const recovery = make(health({ restBelow: 0, restTo: 0.9 }));
    recovery.onCharacter(state({ hp: 48, hpMax: 80, resting: true }));
    drain();
    recovery.onCharacter(state({ hp: 54, hpMax: 80 }));
    drain();
    expect(sent).toEqual(['rest']);
  });

  /*
   * Unknown is not low, for continuing a stretch of resting as well as for
   * starting one — and the stretch is *ended* rather than left open on a figure
   * nothing has restated.
   */
  it('does not carry on without a maximum, and does not resume when one returns', () => {
    const recovery = make(health({ restBelow: 0.5, restTo: 0.9 }));
    recovery.onCharacter(state({ hp: 30, hpMax: 80, resting: true }));
    drain();
    recovery.onCharacter(state({ hp: 48 }));
    drain();
    expect(sent).toEqual([]);
    recovery.onCharacter(state({ hp: 48, hpMax: 80 }));
    drain();
    expect(sent).toEqual([]);
  });

  /* A new session rests nobody on the strength of the last one. */
  it('forgets the stretch on reset', () => {
    const recovery = make(health({ restBelow: 0.5, restTo: 0.9 }));
    recovery.onCharacter(state({ hp: 30, hpMax: 80, resting: true }));
    drain();
    recovery.reset();
    recovery.onCharacter(state({ hp: 48, hpMax: 80 }));
    drain();
    expect(sent).toEqual([]);
  });
});

describe('meditating', () => {
  it('meditates on low mana', () => {
    make(health({ meditateBelow: 0.5 })).onCharacter(state({ mana: 10, manaMax: 100 }));
    drain();
    expect(sent).toEqual(['med']);
  });

  /*
   * A warrior's status line carries no `MA=` at all, and `med` for one is
   * answered `Your command had no effect.` — in the room, once per status line,
   * for as long as the setting was on.
   */
  it('never meditates for a class with no mana', () => {
    make(health({ meditateBelow: 0.5 })).onCharacter(state({ hp: 30, hpMax: 30 }));
    drain();
    expect(sent).toEqual([]);
  });

  /* Health first: the one that decides whether the character is alive. */
  it('rests rather than meditating when both are low', () => {
    make(health({ restBelow: 0.5, meditateBelow: 0.5 })).onCharacter(
      state({ hp: 10, hpMax: 100, mana: 10, manaMax: 100 })
    );
    drain();
    expect(sent).toEqual(['rest']);
  });
});

describe('with a threat in the room', () => {
  it('does not sit down while something that attacks on sight is here', () => {
    const auto = make(health({ restBelow: 0.5 }));
    const threat = {
      name: 'giant rat',
      kind: 'mob' as const,
      disposition: 'hostile' as const,
      uncertain: false,
      costly: 'never' as const,
      charmed: false,
      hidden: false,
      free: false
    };
    const hurt = state({ hp: 10, hpMax: 100 });
    auto.onCharacter({ ...hurt, room: { ...hurt.room, occupants: [threat] } });
    drain();
    expect(sent).toEqual([]);
    auto.onCharacter(hurt);
    drain();
    expect(sent).toEqual(['rest']);
  });
});

/* Sitting down because the leader has: out of combat, and `med` only with mana. */
describe('resting with the leader', () => {
  const member = (
    name: string,
    activity: { state: 'resting' } | { state: 'meditating' } | null
  ) => ({
    name,
    activity,
    className: null,
    health: 1,
    invited: false,
    vitals: null,
    mana: null,
    rank: null
  });
  const together = (activity: { state: 'resting' } | { state: 'meditating' } | null) => ({
    following: 'Soul',
    members: [member('Vaelor', null), member('Soul', activity)],
    engaged: {},
    threatened: {}
  });
  const withLeader = (): Recovery =>
    new Recovery({ ...DEFAULT_CONFIG.automation.health }, true, queue, {
      assistLeader: false,
      defendParty: false,
      restWithLeader: true
    });

  it('rests when the leader rests', () => {
    withLeader().onCharacter(state({ hp: 100, hpMax: 100, party: together({ state: 'resting' }) }));
    drain();
    expect(sent).toEqual(['rest']);
  });

  it('meditates with the leader only as a class with mana', () => {
    withLeader().onCharacter(
      state({
        hp: 100,
        hpMax: 100,
        mana: null,
        manaMax: null,
        party: together({ state: 'meditating' })
      })
    );
    drain();
    expect(sent).toEqual([]);
    withLeader().onCharacter(
      state({
        hp: 100,
        hpMax: 100,
        mana: 50,
        manaMax: 50,
        party: together({ state: 'meditating' })
      })
    );
    drain();
    expect(sent).toEqual(['med']);
  });

  it('does nothing while the leader is up, in a fight, or when not asked', () => {
    withLeader().onCharacter(state({ hp: 100, hpMax: 100, party: together(null) }));
    withLeader().onCharacter(
      state({
        hp: 100,
        hpMax: 100,
        inCombat: true,
        // A fight with something in it: the flag on its own is the *stale* one
        // an escape leaves behind, and sitting down in that is the point of
        // `fightIsHere`.
        combat: fighting({ target: 'cave worm' }),
        party: together({ state: 'resting' })
      })
    );
    new Recovery({ ...DEFAULT_CONFIG.automation.health }, true, queue).onCharacter(
      state({ hp: 100, hpMax: 100, party: together({ state: 'resting' }) })
    );
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * Captured 2026-09-04 on the sanctioned realm: a mystic's `med` answered
 * `Your command had no effect.` on every status line for as long as its Kai
 * was under `meditateBelow` — one refused command every three seconds, all
 * evening. `askedUntil` bounds a rest the server swallowed; this is the
 * server *answering*, and the answer is read.
 */
describe('a verb the realm refuses', () => {
  const low = (): CharacterState => state({ hp: 334, hpMax: 334, mana: 0, manaMax: 30 });

  it('stops proposing med once the realm says it had no effect, and says so once', () => {
    const notices: string[] = [];
    const recovery = new Recovery(health({ meditateBelow: 0.3 }), true, queue, undefined, {
      notice: (message) => notices.push(message)
    });
    recovery.onCharacter(low());
    drain();
    expect(sent).toEqual(['med']);

    recovery.noteNoEffect('med');
    recovery.noteNoEffect('med');
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(4000);
      recovery.onCharacter(low());
    }
    drain();
    expect(sent).toEqual(['med']);
    expect(notices).toEqual([t('automation.recovery.verbRefused', { verb: 'med' })]);
  });

  it("is not moved by a refusal of somebody else's command", () => {
    const recovery = make(health({ meditateBelow: 0.3 }));
    recovery.noteNoEffect('flee');
    recovery.noteNoEffect(null);
    recovery.onCharacter(low());
    drain();
    expect(sent).toEqual(['med']);
  });

  /*
   * `captures/009:141`: `hid` echoed at the prompt, `bs k` typed ahead and
   * echoed on a bare line, and `Your command had no effect.` for the second.
   * A refusal of `med` that arrives with no `med` outstanding — before one
   * was proposed, or after the answer's deadline — is somebody else's.
   */
  it('honours a refusal only while its own ask is outstanding', () => {
    const recovery = make(health({ meditateBelow: 0.3 }));
    recovery.noteNoEffect('med');
    recovery.onCharacter(low());
    drain();
    expect(sent).toEqual(['med']);
    vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.rest.askedMs + 1);
    recovery.noteNoEffect('med');
    recovery.onCharacter(low());
    drain();
    expect(sent).toEqual(['med', 'med']);
  });

  it('asks again on a new connection', () => {
    const recovery = make(health({ meditateBelow: 0.3 }));
    recovery.onCharacter(low());
    drain();
    recovery.noteNoEffect('med');
    vi.advanceTimersByTime(4000);
    recovery.onCharacter(low());
    drain();
    expect(sent).toEqual(['med']);
    recovery.reset();
    recovery.onCharacter(low());
    drain();
    expect(sent).toEqual(['med', 'med']);
  });
});
