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
  pool: null,
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

/*
 * Todo 20261024-1900-01: a member's `@held` is freed with the freedom box's
 * spell, as MegaMUD's members do, while they stand here and until their `@ok`.
 */
describe('freeing a held party member', () => {
  const freeing: SpellsConfig = {
    ...spells,
    cures: { ...spells.cures, freedom: 'freedom' }
  };
  const standing = (members: PartyMember[], here: string[]): CharacterState => {
    const base = state(...members);
    return {
      ...base,
      room: {
        ...base.room,
        occupants: here.map((name) => ({ name, kind: 'player' }) as never)
      }
    };
  };
  const freer = (config: SpellsConfig = freeing): PartyCures =>
    new PartyCures(config, true, { queue, realmSpell: () => null, family: () => null });

  it('casts freedom on a member who said @held and stands here, on any family', () => {
    const cures = freer();
    const room = standing([member('Killa', null), member('Yang', null)], ['Killa', 'Yang']);
    // Positive control: nothing before the word.
    cures.onCharacter(room);
    expect(sent).toEqual([]);
    cures.memberHeld('Killa', true);
    cures.onCharacter(room);
    expect(sent).toEqual(['freedom Killa']);
    expect(kinds).toEqual(['cure-party']);
  });

  it('frees nobody who is not in the room, or not in the party', () => {
    const cures = freer();
    cures.memberHeld('Killa', true);
    cures.memberHeld('Stranger', true);
    cures.onCharacter(standing([member('Killa', null)], ['Stranger']));
    expect(sent).toEqual([]);
    // Positive control: Killa walks in.
    cures.onCharacter(standing([member('Killa', null)], ['Stranger', 'Killa']));
    expect(sent).toEqual(['freedom Killa']);
  });

  it('stops at the member’s @ok, and a minute after the last @held', () => {
    const cures = freer();
    const room = standing([member('Killa', null)], ['Killa']);
    cures.memberHeld('Killa', true);
    cures.memberHeld('Killa', false);
    cures.onCharacter(room);
    expect(sent).toEqual([]);
    cures.memberHeld('Killa', true);
    vi.advanceTimersByTime(tuning().spells.partyHeldMs + 1);
    cures.onCharacter(room);
    expect(sent).toEqual([]);
    // Positive control: said again, it is cast.
    cures.memberHeld('Killa', true);
    cures.onCharacter(room);
    expect(sent).toEqual(['freedom Killa']);
  });

  it('casts nothing with Heal Party off', () => {
    const cures = freer({ ...freeing, healParty: false });
    cures.memberHeld('Killa', true);
    cures.onCharacter(standing([member('Killa', null)], ['Killa']));
    expect(sent).toEqual([]);
    // Positive control: switched on, the same word is answered.
    cures.configure({ ...freeing, healParty: true }, true);
    cures.onCharacter(standing([member('Killa', null)], ['Killa']));
    expect(sent).toEqual(['freedom Killa']);
  });
});
