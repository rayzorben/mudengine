import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { PartyListing, roundsUntilPar } from '../PartyListing';
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

  /* The user, 2026-10-10: par every few rounds, sooner the more the party is hurt. */
  const hurt = (health: number): CharacterState => {
    const base = state(true);
    const members = base.party.members.map((member) =>
      member.name === 'Soul' ? { ...member, health } : member
    );
    return { ...base, party: { ...base.party, members } };
  };
  const rounds = (par: PartyListing, ...states: CharacterState[]): number[] =>
    states.flatMap((each, round) => {
      const before = sent.length;
      par.afterRound(each);
      drain();
      return sent.length > before ? [round + 1] : [];
    });

  it('asks every parEveryRounds rounds while nobody is hurt', () => {
    const par = listing({ parEveryRounds: 5 });
    expect(rounds(par, ...Array.from({ length: 10 }, () => state(true)))).toEqual([5, 10]);
  });

  it('asks sooner the more health a member has lost since the last ask', () => {
    const par = listing({ parEveryRounds: 5 });
    // An ask to measure from, then a member losing a tenth: three rounds, not five.
    const fresh = Array.from({ length: 5 }, () => state(true));
    expect(rounds(par, ...fresh)).toEqual([5]);
    expect(rounds(par, hurt(0.95), hurt(0.9), hurt(0.9))).toEqual([3]);
    // A quarter of the bar at once: the very next round.
    expect(rounds(par, hurt(0.6))).toEqual([1]);
  });

  it('spaces the asks by the share lost', () => {
    expect(roundsUntilPar(5, 0, 0.25)).toBe(5);
    expect(roundsUntilPar(5, 0.05, 0.25)).toBe(4);
    expect(roundsUntilPar(5, 0.1, 0.25)).toBe(3);
    expect(roundsUntilPar(5, 0.25, 0.25)).toBe(1);
    expect(roundsUntilPar(5, 0.9, 0.25)).toBe(1);
  });

  it('asks nothing by the round at 0', () => {
    const seven = (): CharacterState[] => [
      state(true),
      ...Array.from({ length: 6 }, () => hurt(0.5))
    ];
    // The same rounds ask at 5 rounds apart, sooner for the hurt member.
    expect(rounds(listing({ parEveryRounds: 5 }), ...seven())).not.toEqual([]);
    expect(rounds(listing({ parEveryRounds: 0 }), ...seven())).toEqual([]);
  });
});
