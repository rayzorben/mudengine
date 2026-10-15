import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { PartyCures } from '../PartyCures';
import { tuning } from '../../app/tuning';
import { DEFAULT_CONFIG, type AutomationConfig, type SpellsConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '../../../shared/character';
import type { RealmFamily } from '../../../shared/realm';
import type { DecisionKind } from '../../../shared/decisionSettings';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const spells: SpellsConfig = {
  ...DEFAULT_CONFIG.automation.spells,
  minMana: 0,
  healParty: true,
  cures: { ...DEFAULT_CONFIG.automation.spells.cures, poison: 'cure poison' }
};

const member = (name: string, flag: string | null): PartyMember => ({
  name,
  className: null,
  health: 1,
  mana: null,
  rank: 'front',
  activity: flag === null ? null : { state: 'unknown', flag },
  invited: false,
  vitals: null,
  sheet: null
});

function state(...members: PartyMember[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    vitals: { ...base.vitals, mana: 50, manaMax: 50 },
    party: { ...base.party, members }
  };
}

let sent: string[];
/** The setting each sent command's decision files under, in send order. */
let kinds: (DecisionKind | undefined)[];
let queue: CommandQueue;
let family: RealmFamily | null;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  kinds = [];
  family = 'greatermud';
  queue = new CommandQueue(automation, {
    send: (command, intent) => {
      sent.push(command);
      kinds.push(intent.decision);
    }
  });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (): PartyCures =>
  new PartyCures(spells, true, { queue, realmSpell: () => null, family: () => family });

describe("curing a party member's poison (todo 80)", () => {
  it('casts the poison cure on a member the GreaterMUD listing marks P, and on nobody else', () => {
    make().onCharacter(state(member('Soul', 'P'), member('Yang', null)));
    expect(sent).toEqual(['cure poison Soul']);
    expect(kinds).toEqual(['cure-party']);
  });

  it('casts nothing where the server has not told GreaterMUD', () => {
    family = null;
    make().onCharacter(state(member('Soul', 'P')));
    family = 'majormud';
    make().onCharacter(state(member('Soul', 'P')));
    expect(sent).toEqual([]);
  });

  it('waits 15 s after a cure that left the letter, then doubles the wait', () => {
    const cures = make();
    const sick = state(member('Soul', 'P'));
    cures.onCharacter(sick);
    expect(sent).toHaveLength(1);
    const { partyCureRetryMs: first } = tuning().spells;
    vi.advanceTimersByTime(first - 1);
    cures.onCharacter(sick);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    cures.onCharacter(sick);
    expect(sent).toHaveLength(2);
    // The second wait is twice the first.
    vi.advanceTimersByTime(first * 2 - 1);
    cures.onCharacter(sick);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    cures.onCharacter(sick);
    expect(sent).toHaveLength(3);
    // The letter gone, the next poisoning is cured at once.
    cures.onCharacter(state(member('Soul', null)));
    cures.onCharacter(sick);
    expect(sent).toHaveLength(4);
  });
});
