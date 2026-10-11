import { beforeEach, describe, expect, it } from 'vitest';

import { STAT_ALL, StatAllAsk } from '../StatAllAsk';
import type { Intent } from '../CommandQueue';
import { tuning } from '../../app/tuning';
import { domainOf, type Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { keepSheet, readStatAll, statedBasis } from '../../../shared/stated';

/* Todo 45: `stat a` once per basis, out of a fight, after the change has held. */
describe('asking stat all', () => {
  let offered: Intent[];
  let notices: string[];
  let at: number;
  let ask: StatAllAsk;

  /** In the realm with `st` and `i` read, one buff up. */
  const READ: CharacterState = {
    ...structuredClone(EMPTY_CHARACTER),
    phase: 'in-game',
    name: 'Festus',
    progress: { ...EMPTY_CHARACTER.progress, level: 12, strength: 70 },
    inventory: { ...EMPTY_CHARACTER.inventory, listedAt: 1 },
    buffs: [{ spell: 'bless', by: null, appliedAt: 0 }]
  };
  const settle = (): number => (at += tuning().statAll.settleMs);
  /** Each offer the queue took, sent at once. */
  const sendAll = (): void => {
    for (const intent of offered.splice(0)) intent.onSent?.();
  };
  const answered = (state: CharacterState): CharacterState => {
    const block: Block = {
      seq: 1,
      at,
      type: 'user-stat-all',
      domain: domainOf('user-stat-all'),
      groups: {},
      text: '',
      terminator: 'newline',
      confidence: 1
    };
    ask.onBlock(block);
    const sheet = readStatAll([{ healthRegen: '6', restingRegen: '18' }], statedBasis(state))!;
    return { ...state, stated: keepSheet(state.stated, sheet) };
  };

  beforeEach(() => {
    offered = [];
    notices = [];
    at = 0;
    ask = new StatAllAsk(
      {
        offer: (intent) => {
          offered.push(intent);
          return 'queued';
        }
      },
      (message) => notices.push(message),
      () => at
    );
  });

  it('asks once the basis has held, and not before', () => {
    ask.onCharacter(READ);
    expect(offered).toEqual([]);
    settle();
    ask.onCharacter(READ);
    expect(offered.map((intent) => intent.command)).toEqual([STAT_ALL]);
  });

  it('waits for st and i to say what the basis is', () => {
    const unlisted = { ...READ, inventory: { ...READ.inventory, listedAt: null } };
    ask.onCharacter(unlisted);
    settle();
    ask.onCharacter(unlisted);
    expect(offered).toEqual([]);
  });

  it('waits for the fight to end', () => {
    const fighting = { ...READ, inCombat: true };
    ask.onCharacter(fighting);
    settle();
    ask.onCharacter(fighting);
    expect(offered).toEqual([]);
    // Positive control: the same character out of the fight is asked about.
    ask.onCharacter(READ);
    expect(offered).toHaveLength(1);
  });

  it('asks nothing while a sheet for this basis is held, and asks for a new one', () => {
    ask.onCharacter(READ);
    settle();
    ask.onCharacter(READ);
    sendAll();
    const read = answered(READ);
    ask.onCharacter(read);
    settle();
    ask.onCharacter(read);
    expect(offered).toEqual([]);
    const bare = { ...read, buffs: [] };
    ask.onCharacter(bare);
    settle();
    ask.onCharacter(bare);
    expect(offered).toHaveLength(1);
  });

  it('asks a basis once a session, answered or not', () => {
    ask.onCharacter(READ);
    settle();
    ask.onCharacter(READ);
    sendAll();
    settle();
    ask.onCharacter(READ);
    expect(offered).toEqual([]);
    ask.reset();
    ask.onCharacter(READ);
    settle();
    ask.onCharacter(READ);
    expect(offered).toHaveLength(1);
  });

  it('stops asking a realm that answers with no sheet, and says so', () => {
    const limit = tuning().statAll.unansweredAsks;
    for (let level = 1; level <= limit; level += 1) {
      const state = { ...READ, progress: { ...READ.progress, level } };
      ask.onCharacter(state);
      settle();
      ask.onCharacter(state);
      sendAll();
    }
    // The last ask has its settle to be answered; then it is said without another change.
    const last = { ...READ, progress: { ...READ.progress, level: limit } };
    ask.onCharacter(last);
    expect(notices).toEqual([]);
    settle();
    ask.onCharacter(last);
    expect(notices).toHaveLength(1);
    const next = { ...READ, progress: { ...READ.progress, level: limit + 1 } };
    ask.onCharacter(next);
    settle();
    ask.onCharacter(next);
    expect(offered).toEqual([]);
    expect(notices).toHaveLength(1);
  });
});
