import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { PartyListing } from '../PartyListing';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/* The party-change ask's own word, so the two coalesce as one listing. */
const PAR = DEFAULT_CONFIG.automation.onPartyChange;

/* Todo 831: MegaMUD's Par Frequency and Send PAR After Combat Round. */
describe('the party listing on a clock', () => {
  let sent: string[];
  let queue: CommandQueue;
  let at: number;
  const config = (party: Partial<AutomationConfig['party']>): AutomationConfig => ({
    ...DEFAULT_CONFIG.automation,
    pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 },
    party: { ...DEFAULT_CONFIG.automation.party, ...party }
  });
  const state = (fighting = false, members = ['Vaelor', 'Soul']): CharacterState => {
    const base = structuredClone(EMPTY_CHARACTER);
    return {
      ...base,
      phase: 'in-game',
      name: 'Vaelor',
      inCombat: fighting,
      combat: { ...base.combat, target: fighting ? 'orc' : null },
      party: {
        ...base.party,
        members: members.map((name) => ({
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
  };
  const listing = (party: Partial<AutomationConfig['party']>): PartyListing =>
    new PartyListing(
      queue,
      () => config(party),
      () => at
    );
  const drain = (): void => void vi.advanceTimersByTime(500);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    at = 0;
    queue = new CommandQueue(config({}), { send: (command) => sent.push(command) });
  });
  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it('asks every period in a fight and twice that out of one', () => {
    const par = listing({ parSeconds: 15 });
    par.onCharacter(state(true));
    drain();
    at = 14_999;
    par.onCharacter(state(true));
    drain();
    expect(sent).toEqual([PAR]);
    at = 15_000;
    par.onCharacter(state(true));
    drain();
    at = 15_000 + 29_999;
    par.onCharacter(state(false));
    drain();
    expect(sent).toEqual([PAR, PAR]);
    at = 45_000;
    par.onCharacter(state(false));
    drain();
    expect(sent).toEqual([PAR, PAR, PAR]);
  });

  it('asks after a round only when told to, and never alone or at 0', () => {
    listing({ parAfterRound: true }).afterRound(state(true));
    drain();
    expect(sent).toEqual([PAR]);
    listing({ parAfterRound: false }).afterRound(state(true));
    listing({ parSeconds: 0 }).onCharacter(state(true));
    listing({ parSeconds: 15, parAfterRound: true }).onCharacter(state(true, ['Vaelor']));
    drain();
    expect(sent).toEqual([PAR]);
  });
});
