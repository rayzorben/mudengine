import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecoveredCorpse } from '../RecoveredCorpse';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { wireItem } from '../../../shared/entities';
import { t } from '../../app/i18n';

const automation = (over: Partial<AutomationConfig['movement']> = {}): AutomationConfig => ({
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 },
  movement: { ...DEFAULT_CONFIG.automation.movement, ...over }
});

/** Back in the pack by `You took`, none of it on, the helm never came back. */
function recovered(): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Probe',
    loadout: [
      { slot: 'Weapon Hand', item: 'short sword', at: 1 },
      { slot: 'Torso', item: 'leather armour', at: 1 },
      { slot: 'Head', item: 'leather cap', at: 1 }
    ],
    inventory: {
      ...base.inventory,
      listedAt: 2,
      items: [wireItem('short sword'), wireItem('leather armour')]
    }
  };
}

const said = (player: string, text = `You have recovered the corpse of ${player}.`): Block => ({
  seq: 1,
  at: 0,
  type: 'user-recovers-corpse',
  domain: 'items',
  groups: { player },
  text,
  confidence: 1,
  terminator: 'newline'
});

let sent: string[];
let notices: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  queue = new CommandQueue(automation(), { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = automation()): RecoveredCorpse =>
  new RecoveredCorpse(config, queue, recovered, { notice: (m) => notices.push(m) });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('the gear after recover corpse', () => {
  it('puts back on what came back, and says what did not, as the button does', () => {
    make().onBlock(said('Probe'));
    drain();
    expect(sent).toEqual(['wear short sword', 'wear leather armour']);
    expect(notices[0]).toBe(t('automation.recoveredCorpse.dressing'));
    expect(notices[1]).toBe(t('automation.gear.missing', { count: 1, items: 'leather cap' }));
  });

  it('reads the corpse that remains the same way, the pack holding what it could carry', () => {
    make().onBlock(said('probe', 'The corpse of probe remains.'));
    drain();
    expect(sent).toHaveLength(2);
  });

  it("leaves a friend's corpse alone: that is not this character's gear", () => {
    const corpse = make();
    corpse.onBlock(said('Soul'));
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
    corpse.onBlock(said('Probe'));
    drain();
    expect(sent).toHaveLength(2);
  });

  it('does nothing with the switch off, or automation off, until switched back on', () => {
    const corpse = make(automation({ reequipOnRecover: false }));
    corpse.onBlock(said('Probe'));
    corpse.configure({ ...automation(), enabled: false });
    corpse.onBlock(said('Probe'));
    drain();
    expect(sent).toEqual([]);
    corpse.configure(automation());
    corpse.onBlock(said('Probe'));
    drain();
    expect(sent).toHaveLength(2);
  });
});
