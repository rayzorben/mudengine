import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Routines } from '../Routines';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/** Nothing sends: what matters here is what was *queued* and in which band. */
function make(overrides: Partial<AutomationConfig> = {}): {
  routines: Routines;
  queue: CommandQueue;
  notices: string[];
} {
  const config: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    ...overrides
  };
  const notices: string[] = [];
  // A window of zero holds everything: the queue is being inspected, not drained.
  const queue = new CommandQueue(
    { ...config, pacing: { ...config.pacing, window: 0 } },
    { send: () => {} }
  );
  return {
    routines: new Routines(config, queue, { notice: (m) => notices.push(m) }),
    queue,
    notices
  };
}

const inRealm: CharacterState = { ...EMPTY_CHARACTER, phase: 'in-game' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/*
 * The realm answers almost nothing unprompted: no health maximum, no level, no
 * inventory. The entry probe is how a freshly connected client stops showing
 * dashes.
 */
describe('asking the realm on the way in', () => {
  it('asks once, on the transition into the realm', () => {
    const { routines, queue } = make();
    routines.onCharacter(inRealm);
    const asked = queue.snapshot.pending.length;
    expect(asked).toBeGreaterThan(0);
    routines.onCharacter(inRealm);
    expect(queue.snapshot.pending).toHaveLength(asked);
  });

  it('asks nothing before the realm is reached', () => {
    const { routines, queue } = make();
    routines.onCharacter({ ...EMPTY_CHARACTER, phase: 'authenticating' });
    expect(queue.snapshot.pending).toHaveLength(0);
  });

  it('says nothing while automation is off', () => {
    const { routines, queue } = make({ enabled: false });
    routines.onCharacter(inRealm);
    expect(queue.snapshot.pending).toHaveLength(0);
  });
});

/*
 * The party roster is the only place another character's health is visible, and
 * it is only as current as the last `party` — so a card that waits for somebody
 * to type one is a card that is empty at exactly the moment it became worth
 * having.
 */
describe('asking what the party is', () => {
  it('asks when the party changes', () => {
    const { routines, queue } = make();
    routines.onPartyChanged();
    expect(queue.snapshot.pending.map((intent) => intent.command)).toContain('party');
  });

  /* Somebody inviting three people in one breath asks once. */
  it('asks once however many times it changes', () => {
    const { routines, queue } = make();
    routines.onPartyChanged();
    routines.onPartyChanged();
    routines.onPartyChanged();
    expect(queue.snapshot.pending.filter((i) => i.command === 'party')).toHaveLength(1);
  });

  it('asks in the probe band, below anything the player is doing', () => {
    const { routines, queue } = make();
    routines.onPartyChanged();
    expect(queue.snapshot.pending.find((i) => i.command === 'party')?.priority).toBe('probe');
  });

  it('says nothing when automation is off', () => {
    const { routines, queue } = make({ enabled: false });
    routines.onPartyChanged();
    expect(queue.snapshot.pending).toHaveLength(0);
  });

  /* An empty setting is somebody saying "never ask", which is a real answer. */
  it('says nothing when the command is empty', () => {
    const { routines, queue } = make({ onPartyChange: '' });
    routines.onPartyChanged();
    expect(queue.snapshot.pending).toHaveLength(0);
  });
});

/*
 * A name arriving without a listing to explain it -- entering the realm, or
 * walking into a room -- is worth resolving. Asking `who` per arrival would be
 * one per adventurer in a busy room, so it is debounced rather than deferred:
 * the first asks, and every arrival inside the window is answered by that same
 * listing.
 *
 * It waited for the idle tick alone until 2026-09-02, which needed
 * `idle.enabled` *and* a character that had stopped doing anything -- so a
 * character that fights and walks all evening never asked, and the roster
 * stayed as stale as the last listing left it.
 */
describe('the roster catch-up', () => {
  const idling = (afterSeconds = 5) => ({
    idle: { enabled: true, afterSeconds, command: 'l' },
    onEnterRealm: []
  });

  const quiet = { idle: { enabled: false, afterSeconds: 5, command: 'l' }, onEnterRealm: [] };

  /*
   * Counted at the *proposal*, not in the pending list: the queue coalesces on
   * `idle:who`, so two decisions a minute apart are one pending intent while
   * nothing is draining — which is right for the wire and useless for telling
   * "asked twice" from "asked once". Coalescing has its own tests.
   */
  const asking = (queue: CommandQueue): (() => number) => {
    const spy = vi.spyOn(queue, 'enqueue');
    return () => spy.mock.calls.filter(([intent]) => intent.command === 'who').length;
  };

  it('asks straight away rather than waiting for the character to go quiet', () => {
    const { routines, queue } = make(idling());
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    expect(whos()).toBe(1);
  });

  /*
   * The reported bug as a test: a character that never goes idle at all. With
   * the catch-up on the idle tick this asked nothing for the whole session, so
   * a `who` on screen and a record saying "offline" agreed with each other.
   */
  it('asks even with the idle keep-alive switched off entirely', () => {
    const { routines, queue } = make(quiet);
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    expect(whos()).toBe(1);
  });

  it('asks in the idle band, below anything the player or a rule is doing', () => {
    const { routines, queue } = make(idling(5));
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    expect(queue.snapshot.pending.find((i) => i.command === 'who')?.priority).toBe('idle');
  });

  /* One `who` answers every unlisted arrival, however many there were. */
  it('coalesces a whole room of arrivals into one `who`', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    routines.onRosterUnknown();
    routines.onRosterUnknown();
    vi.advanceTimersByTime(6000);
    expect(whos()).toBe(1);
  });

  /*
   * The debounce, and why it is one: a second arrival a few seconds after a
   * listing answered the first is real news, and still must not spend a second
   * command.
   */
  it('does not ask twice inside the window, even after a listing answered', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    routines.onWhoListing();
    vi.advanceTimersByTime(6000);
    routines.onRosterUnknown();
    expect(whos()).toBe(1);
  });

  it('asks again once the window has passed', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    routines.onWhoListing();
    vi.advanceTimersByTime(61_000);
    routines.onRosterUnknown();
    expect(whos()).toBe(2);
  });

  /*
   * An arrival inside the window raises the flag and sends nothing; the idle
   * tick is one of the two things that drain it once the window opens, which
   * is why quiet is still where the command is preferably spent.
   */
  it('drains a flag raised inside the window on the next idle tick', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    routines.onWhoListing();
    vi.advanceTimersByTime(6000);
    routines.onRosterUnknown();
    expect(whos()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(whos()).toBe(2);
  });

  /* And a state change is the other, for a character that never goes quiet. */
  it('drains it on the next character state change too', () => {
    const { routines, queue } = make(quiet);
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    routines.onWhoListing();
    routines.onRosterUnknown();
    expect(whos()).toBe(1);
    vi.advanceTimersByTime(61_000);
    routines.onCharacter(inRealm);
    expect(whos()).toBe(2);
  });

  it('asks nothing when nobody unlisted has arrived', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    vi.advanceTimersByTime(6000);
    expect(whos()).toBe(0);
  });

  /*
   * The switch. On the idle tick alone this was gated twice by accident of
   * where it lived — `armIdle` arms nothing unless `enabled` and
   * `idle.enabled` are both on. Moving it off that tick took both away, and
   * what was left holding it was the command queue refusing a non-`user` band
   * while automation is off: true, and the wrong place for the only copy of a
   * decision.
   */
  it('asks nothing at all while automation is off', () => {
    const { routines, queue } = make({ ...idling(5), enabled: false });
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    vi.advanceTimersByTime(6000);
    expect(whos()).toBe(0);
  });

  it('asks nothing before the realm is reached', () => {
    // `probed` gates it: a `who` sent at a login menu is typed into whatever
    // the menu was asking for.
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onRosterUnknown();
    expect(whos()).toBe(0);
  });

  it('does not ask because of a listing on its own', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onWhoListing();
    vi.advanceTimersByTime(6000);
    expect(whos()).toBe(0);
  });

  it('forgets on a new connection', () => {
    const { routines, queue } = make(idling(5));
    const whos = asking(queue);
    routines.onCharacter(inRealm);
    routines.onRosterUnknown();
    const asked = whos();
    routines.reset();
    routines.onCharacter(inRealm);
    vi.advanceTimersByTime(6000);
    expect(whos()).toBe(asked);
  });
});

/*
 * The idle clock used to arm only after the entry probe actually sent
 * something, so a character configured with an empty `onEnterRealm` -- a real
 * choice, not a mistake -- never got the keep-alive or the roster catch-up at
 * all, for the whole session.
 */
describe('arming the idle clock', () => {
  it('arms on entering the realm even with nothing configured to ask on the way in', () => {
    const { routines, queue } = make({
      idle: { enabled: true, afterSeconds: 5, command: 'l' },
      onEnterRealm: []
    });
    routines.onCharacter(inRealm);
    vi.advanceTimersByTime(6000);
    expect(queue.snapshot.pending.some((i) => i.command === 'l')).toBe(true);
  });

  /*
   * Idle means **this client has sent nothing**, not that the wire has been
   * quiet, and reading it the other way made the keep-alive unreachable on the
   * realms this client is for: GreaterMUD repaints its status line unprompted
   * every thirty seconds, which reset a forty-five second clock fifteen
   * seconds before it could expire, every time, for the whole session. In the
   * capture it was reported from
   * (`logs/2026-09-02_16-54-23_festus.mudcap.jsonl`) that is three repaints
   * across 140 seconds in which this client sent nothing at all, ended by the
   * player pressing Enter by hand.
   *
   * There is no inbound signal left to test with, which is the point — the
   * only way to restart the clock is to send something. So the positive
   * control is the pair: a session that sends nothing gets its keep-alive, and
   * one that is sending does not.
   */
  it('fires after the quiet period when this client has sent nothing', () => {
    const { routines, queue } = make({
      idle: { enabled: true, afterSeconds: 5, command: 'l' },
      onEnterRealm: []
    });
    routines.onCharacter(inRealm);
    // Well past three repaints, had inbound bytes still counted.
    vi.advanceTimersByTime(100_000);
    expect(queue.snapshot.pending.some((i) => i.command === 'l')).toBe(true);
  });

  it('does not fire while this client is the one talking', () => {
    const { routines, queue } = make({
      idle: { enabled: true, afterSeconds: 5, command: 'l' },
      onEnterRealm: []
    });
    routines.onCharacter(inRealm);
    // A character meditating every three seconds is not an idle one, and an
    // Enter behind that is a command spent from the budget it is recovering on.
    for (let beat = 0; beat < 20; beat += 1) {
      vi.advanceTimersByTime(3000);
      routines.noteSent();
    }
    expect(queue.snapshot.pending.some((i) => i.command === 'l')).toBe(false);
  });
});

/*
 * The spellbook ask: `powers` for a character the wire calls KAI, `spells`
 * for one with mana, nothing for one the wire has said neither about — a
 * warrior's prompt simply has no mana field, and a guessed command is spoken
 * out loud in the room. Wire shapes from `npm run probe:spellbook`
 * (2026-09-01): the wrong book is refused with the right one named, which is
 * what the correction reads.
 */
describe('reading the spellbook', () => {
  const withResource = (manaType: 'MA' | 'KAI'): CharacterState => ({
    ...inRealm,
    vitals: { ...EMPTY_CHARACTER.vitals, manaType }
  });
  const commandsIn = (queue: CommandQueue): string[] =>
    queue.snapshot.pending.map((intent) => intent.command);

  it('asks nothing until the wire says which book, then asks the right one once', () => {
    const { routines, queue } = make();
    routines.onCharacter(inRealm);
    expect(commandsIn(queue)).not.toContain('spells');
    expect(commandsIn(queue)).not.toContain('powers');

    routines.onCharacter(withResource('KAI'));
    expect(commandsIn(queue)).toContain('powers');
    expect(commandsIn(queue)).not.toContain('spells');
    routines.onCharacter(withResource('KAI'));
    expect(commandsIn(queue).filter((command) => command === 'powers')).toHaveLength(1);
  });

  it('asks spells for a mana caster, behind the entry batch', () => {
    const { routines, queue } = make();
    routines.onCharacter(withResource('MA'));
    const commands = commandsIn(queue);
    // `rm` — the position fix — keeps the head of the probe band.
    expect(commands[0]).toBe(DEFAULT_CONFIG.automation.onEnterRealm[0]);
    expect(commands.at(-1)).toBe('spells');
  });

  it('asks the book the refusal names, once, and says so', () => {
    const { routines, queue, notices } = make();
    routines.onCharacter(withResource('MA'));
    const refusal = {
      type: 'spellbook-refused',
      groups: { book: 'powers' },
      at: Date.now()
    } as never;
    routines.onBlock(refusal);
    expect(commandsIn(queue)).toContain('powers');
    expect(notices.join(' ')).toContain('powers');
    // Bounded: a second refusal cannot start a loop of wrong asks.
    routines.onBlock(refusal);
    expect(commandsIn(queue).filter((command) => command === 'powers')).toHaveLength(1);
  });

  it('re-asks on a learned power, so the listing replaces the appended name', () => {
    const { routines, queue } = make();
    routines.onCharacter(withResource('KAI'));
    // Drain the coalesce key by pretending time passed is unnecessary: the
    // re-ask coalesces with the first while both are queued, which is right.
    const learned = {
      type: 'user-learns',
      groups: { kind: 'power', name: 'way of the owl' },
      at: Date.now()
    } as never;
    routines.onBlock(learned);
    expect(commandsIn(queue).filter((command) => command === 'powers')).toHaveLength(1);
  });

  it('asks nothing with automation off', () => {
    const { routines, queue } = make({ enabled: false });
    routines.onCharacter(withResource('KAI'));
    expect(commandsIn(queue)).not.toContain('powers');
  });
});

/*
 * Training is the one thing that makes `Exp needed for next level` wrong, and
 * this realm's status line carries no `Need=` field to correct it — so without
 * an ask, *Exp. needed* and *Will level in* read against the level before the
 * one the character is on, for the rest of the session.
 *
 * The sentences are from the recorded sessions: six trains across five of
 * them, each `You hand over N copper farthings to train to the next level!`,
 * and a `[HP=40/MA=8]:exp` typed by hand right after one of them, which is
 * what this replaces.
 */
describe('asking again after training', () => {
  const commandsIn = (queue: CommandQueue): string[] =>
    queue.snapshot.pending.map((intent) => intent.command);

  const trained = {
    type: 'user-trains',
    groups: { price: '250' },
    at: Date.now()
  } as never;

  it('asks the experience again, once', () => {
    const { routines, queue } = make();
    routines.onBlock(trained);
    expect(commandsIn(queue).filter((command) => command === 'exp')).toHaveLength(1);
    // Coalesced by intent: a character that trained twice in a breath asks once.
    routines.onBlock(trained);
    expect(commandsIn(queue).filter((command) => command === 'exp')).toHaveLength(1);
  });

  /*
   * In the least urgent band there is: it must never displace an attack, an
   * escape or a walk step — and a level-up is exactly the moment a character
   * is standing in a guild rather than in a fight, so nothing is lost by it
   * waiting.
   */
  it('asks in the probe band, behind anything that matters', () => {
    const { routines, queue } = make();
    routines.onBlock(trained);
    const asked = queue.snapshot.pending.find((intent) => intent.command === 'exp');
    expect(asked?.priority).toBe('probe');
  });

  /*
   * A trainer quoting its price, and both of the ways it refuses, are none of
   * them this block type — so asking one what it charges spends nothing.
   */
  it('asks nothing for a quote or a refusal', () => {
    const { routines, queue } = make();
    /*
     * `Training will cost 50 copper farthings!`, `You can not afford to
     * train!` and `You do not have the required experience necessary to
     * train!` all classify as `unknown` against the real classifier, so a
     * trainer asked what it charges spends nothing.
     */
    for (const type of ['unknown', 'command-no-effect', 'user-gains']) {
      routines.onBlock({ type, groups: {}, at: Date.now() } as never);
    }
    expect(commandsIn(queue)).not.toContain('exp');
  });

  /*
   * The welcome asks too, and the pair asks once. On this realm the two lines
   * always arrive together, so the second is free — and it is the one that
   * states the fact the figure actually depends on.
   */
  it('asks on the welcome as well, and the pair asks once', () => {
    const { routines, queue } = make();
    const levelled = { type: 'user-levels', groups: { level: '7' }, at: Date.now() } as never;
    routines.onBlock(levelled);
    expect(commandsIn(queue).filter((command) => command === 'exp')).toHaveLength(1);

    const { routines: pair, queue: both } = make();
    pair.onBlock(trained);
    pair.onBlock(levelled);
    expect(both.snapshot.pending.filter((intent) => intent.command === 'exp')).toHaveLength(1);
  });

  it('asks nothing with automation off', () => {
    const { routines, queue } = make({ enabled: false });
    routines.onBlock(trained);
    expect(commandsIn(queue)).not.toContain('exp');
  });
});
