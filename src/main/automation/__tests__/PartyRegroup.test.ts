import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { PartyRegroup } from '../PartyRegroup';
import { Walker } from '../Walker';
import { CONFIG, routeOf, stepOf } from '../walk/__tests__/walking';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const PAR = DEFAULT_CONFIG.automation.onPartyChange;
const TUNING = DEFAULT_INTERNAL.tuning;

const occupant = (name: string): RoomOccupant => ({
  name,
  kind: 'player',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

/** Leading `members` in `room`, with `here` standing in it (every member, unless said). */
function state(
  room: string,
  members: string[],
  here: string[] = members,
  following: string | null = null
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  const [map, number] = room.split('/').map(Number);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    room: { ...base.room, map: map!, number: number!, occupants: here.map(occupant) },
    party: {
      ...base.party,
      following,
      members: ['Vaelor', ...members].map((name) => ({
        name,
        className: null,
        health: 1,
        mana: null,
        rank: null,
        activity: null,
        invited: false,
        vitals: null
      }))
    }
  };
}

/** The far side of the portal every case here goes through. */
const far = state('3/681', [], []);

const listing = {
  type: 'party-roster',
  seq: 1,
  at: 0,
  domain: 'status',
  groups: {}
} as unknown as Block;

/* Todo 839: the leader says @party before a portal, and waits for the party on the far side. */
describe('leading the party through a portal', () => {
  let sent: string[];
  let queue: CommandQueue;
  const config = (party: Partial<AutomationConfig['party']> = {}): AutomationConfig => ({
    ...CONFIG,
    pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 },
    party: { ...DEFAULT_CONFIG.automation.party, ...party }
  });
  const drain = (): void => void vi.advanceTimersByTime(500);
  const regroup = (party: Partial<AutomationConfig['party']> = {}): PartyRegroup =>
    new PartyRegroup(config(party), queue);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    queue = new CommandQueue(config(), { send: (command) => sent.push(command) });
  });
  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it('says @party before a portal, and nothing before a compass step', () => {
    const it = regroup();
    it.stepping('n', 'n', '3/26', state('3/25', ['Soul']));
    expect(it.regrouping(far)).toBe(false);
    it.stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul']));
    drain();
    expect(sent).toEqual(['.@party go vortex']);
    // Held from the step, not the landing (see the walker's order below), and
    // never in the room being left.
    expect(it.regrouping(far)).toBe(true);
    expect(it.regrouping(state('3/25', ['Soul']))).toBe(false);
    it.dispose();
  });

  it('says nothing following, alone, switched off, or with nobody here to hear it', () => {
    regroup().stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul'], ['Soul'], 'Soul'));
    regroup().stepping('go vortex', 'portal', '3/681', state('3/25', []));
    regroup({ relayPortals: false }).stepping(
      'go vortex',
      'portal',
      '3/681',
      state('3/25', ['Soul'])
    );
    regroup().stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul'], []));
    drain();
    expect(sent).toEqual([]);
  });

  it('asks for the listing on landing, invites back a member here and out of the party, and waits', () => {
    const it = regroup();
    it.stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul', 'Yang']));
    it.onCharacter(state('3/681', [], []));
    drain();
    expect(sent).toEqual(['.@party go vortex', PAR]);
    expect(it.regrouping(far)).toBe(true);

    // Before the listing answers, the roster is the old room's: nothing is judged.
    it.onCharacter(state('3/681', [], ['Soul']));
    drain();
    expect(sent).toEqual(['.@party go vortex', PAR]);

    it.onBlock(listing);
    it.onCharacter(state('3/681', [], ['Soul']));
    it.onCharacter(state('3/681', [], ['Soul']));
    drain();
    expect(sent).toEqual(['.@party go vortex', PAR, 'invite Soul']);
    expect(it.regrouping(far)).toBe(true);

    it.onCharacter(state('3/681', ['Soul', 'Yang']));
    expect(it.regrouping(far)).toBe(false);
  });

  it('gives the wait up after regroupMinutes, and never waits at 0', () => {
    const it = regroup({ regroupMinutes: 1 });
    it.stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul']));
    it.onCharacter(state('3/681', [], []));
    expect(it.regrouping(far)).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(it.regrouping(far)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(it.regrouping(far)).toBe(false);

    const none = regroup({ regroupMinutes: 0 });
    none.stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul']));
    none.onCharacter(state('3/681', [], []));
    expect(none.regrouping(far)).toBe(false);
  });

  it('stops waiting when the character is somewhere the portal does not lead', () => {
    const it = regroup();
    it.stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul']));
    it.onCharacter(state('3/681', [], []));
    it.onCharacter(state('3/682', [], []));
    expect(it.regrouping(far)).toBe(false);

    it.stepping('go vortex', 'portal', '3/681', state('3/25', ['Soul']));
    it.onCharacter(state('3/999', [], []));
    expect(it.regrouping(far)).toBe(false);
  });

  /* A fight recalls the queued step: sent again, the party is not told twice once it heard. */
  it('says @party once for a step sent again, and again only if the say never went', () => {
    const it = regroup();
    const near = state('3/25', ['Soul']);
    it.stepping('go vortex', 'portal', '3/681', near);
    drain();
    it.stepping('go vortex', 'portal', '3/681', near);
    drain();
    expect(sent).toEqual(['.@party go vortex']);

    const other = regroup();
    other.stepping('go vortex', 'portal', '3/681', near);
    // Taken back before it reached the wire, as `Walker.cancelQueued` does.
    queue.cancel((intent) => intent.priority === 'movement');
    other.stepping('go vortex', 'portal', '3/681', near);
    drain();
    expect(sent).toEqual(['.@party go vortex', '.@party go vortex']);
    it.dispose();
    other.dispose();
  });

  /*
   * `SessionManager` hands each state to the walker before `Remotes`, so the
   * step out of the landing is decided before the regroup hears of the
   * landing. The hold has to be in place from the portal step (review).
   */
  it('holds the step out of the landing, in the session order', () => {
    const it = regroup();
    let now = state('1/1', ['Soul']);
    const walk = new Walker(config(), queue, {
      stateNow: () => now,
      stepping: (command, direction, to) => it.stepping(command, direction, to, now),
      regrouping: (at) => it.regrouping(at)
    });
    const route = routeOf(
      stepOf(1, 2, 'e', { direction: 'portal', command: 'go vortex' }),
      stepOf(2, 3, 'e')
    );
    walk.start(route, now);
    drain();
    expect(sent).toEqual(['.@party go vortex', 'go vortex']);

    now = state('1/2', [], []);
    walk.onCharacter(now);
    it.onCharacter(now);
    vi.advanceTimersByTime(TUNING.walk.holdMs * 2);
    expect(sent).toEqual(['.@party go vortex', 'go vortex', PAR]);
    expect(walk.progress.hold).toBe('party');

    it.onBlock(listing);
    now = state('1/2', ['Soul']);
    walk.onCharacter(now);
    it.onCharacter(now);
    vi.advanceTimersByTime(TUNING.walk.holdMs + 50);
    expect(sent).toEqual(['.@party go vortex', 'go vortex', PAR, 'e']);
    expect(walk.progress.hold).toBeNull();
    walk.dispose();
    it.dispose();
  });
});
