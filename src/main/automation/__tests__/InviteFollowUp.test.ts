import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { InviteFollowUp } from '../InviteFollowUp';
import { CONFIG } from '../walk/__tests__/walking';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import type { Block } from '../../../shared/blocks';

const PAR = DEFAULT_CONFIG.automation.onPartyChange;
const AGAIN = DEFAULT_INTERNAL.tuning.remotes.inviteAgainMs;

/** Leading a party whose listing printed `invited` as `[Invited]` and `joined` as members. */
function state(
  invited: string[],
  joined: string[] = [],
  following: string | null = null
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  const row = (name: string, isInvited: boolean) => ({
    name,
    className: null,
    health: isInvited ? null : 1,
    mana: null,
    rank: null,
    activity: null,
    invited: isInvited,
    vitals: null
  });
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    party: {
      ...base.party,
      following,
      members: [
        row('Vaelor', false),
        ...joined.map((name) => row(name, false)),
        ...invited.map((name) => row(name, true))
      ]
    }
  };
}

const header = {
  type: 'party-roster',
  seq: 1,
  at: 0,
  domain: 'status',
  groups: {}
} as unknown as Block;

/* Todo 01: somebody invited who has not joined is sent @join, and par asked again, until they do. */
describe('following up an invitation', () => {
  let sent: string[];
  let asked: string[];
  let queue: CommandQueue;
  let followUps: InviteFollowUp[];
  const config = (over: Partial<AutomationConfig> = {}): AutomationConfig => ({
    ...CONFIG,
    pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 },
    ...over
  });
  const followUp = (over: Partial<AutomationConfig> = {}): InviteFollowUp => {
    const made = new InviteFollowUp(config(over), queue, {
      askJoin: (member) => asked.push(member)
    });
    followUps.push(made);
    return made;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    asked = [];
    followUps = [];
    queue = new CommandQueue(config(), { send: (command) => sent.push(command) });
  });
  afterEach(() => {
    for (const made of followUps) made.dispose();
    queue.dispose();
    vi.useRealTimers();
  });

  /** The `par` answer: its header read against the rows held, then the rows it folds in. */
  const listing = (it: InviteFollowUp, held: CharacterState, now: CharacterState): void => {
    it.onBlock(header, held);
    it.onCharacter(now);
  };

  it('sends @join at once, and par again after the wait, until the invitee joins', () => {
    const it = followUp();
    const first = state(['Soul']);
    it.onCharacter(first);
    expect(asked).toEqual(['Soul']);
    // A state inside the wait asks nothing more.
    it.onCharacter(state(['Soul']));
    vi.advanceTimersByTime(AGAIN - 1);
    expect(sent).toEqual([]);
    expect(asked).toEqual(['Soul']);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([PAR]);
    // Any other line after the wait asks nothing: the listing has not answered.
    it.onCharacter(first);
    expect(asked).toEqual(['Soul']);
    // The listing still prints [Invited]: @join again, and another par after the wait.
    const second = state(['Soul']);
    listing(it, first, second);
    expect(asked).toEqual(['Soul', 'Soul']);
    vi.advanceTimersByTime(AGAIN);
    expect(sent).toEqual([PAR, PAR]);

    // Joined: nothing more goes.
    listing(it, second, state([], ['Soul']));
    vi.advanceTimersByTime(AGAIN * 3);
    expect(sent).toEqual([PAR, PAR]);
    expect(asked).toEqual(['Soul', 'Soul']);
  });

  it('stops when the listing no longer prints the invitation', () => {
    const it = followUp();
    it.onCharacter(state(['Soul']));
    it.onCharacter(state([]));
    vi.advanceTimersByTime(AGAIN * 3);
    expect(sent).toEqual([]);
    expect(asked).toEqual(['Soul']);
  });

  it("asks a new invitee at once, and everyone still invited on the timed par's answer", () => {
    const it = followUp();
    const first = state(['Soul']);
    it.onCharacter(first);
    vi.advanceTimersByTime(AGAIN / 2);
    const both = state(['Soul', 'Yang']);
    it.onCharacter(both);
    expect(asked).toEqual(['Soul', 'Yang']);
    vi.advanceTimersByTime(AGAIN / 2);
    listing(it, both, state(['Soul', 'Yang']));
    expect(asked).toEqual(['Soul', 'Yang', 'Soul', 'Yang']);
  });

  it('asks again on the answer to its own par however soon it comes', () => {
    const it = followUp();
    const first = state(['Soul']);
    it.onCharacter(first);
    vi.advanceTimersByTime(AGAIN);
    expect(sent).toEqual([PAR]);
    // A state inside the wait re-arms the next par before the answer lands.
    it.onCharacter(first);
    listing(it, first, state(['Soul']));
    expect(asked).toEqual(['Soul', 'Soul']);
  });

  it('asks nobody with automation off, or following', () => {
    followUp({ enabled: false }).onCharacter(state(['Soul']));
    followUp().onCharacter(state(['Soul'], [], 'Yang'));
    vi.advanceTimersByTime(AGAIN * 3);
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
    // Positive control: the same listing does ask with remotes (answering) off.
    followUp({ remotes: { ...CONFIG.remotes, enabled: false } }).onCharacter(state(['Soul']));
    expect(asked).toEqual(['Soul']);
  });

  it('lets its clock go when automation is switched off', () => {
    const it = followUp();
    it.onCharacter(state(['Soul']));
    it.configure(config({ enabled: false }));
    vi.advanceTimersByTime(AGAIN * 3);
    expect(sent).toEqual([]);
  });

  it('lets its clock go on reset', () => {
    const it = followUp();
    it.onCharacter(state(['Soul']));
    it.reset();
    vi.advanceTimersByTime(AGAIN * 3);
    expect(sent).toEqual([]);
  });
});
