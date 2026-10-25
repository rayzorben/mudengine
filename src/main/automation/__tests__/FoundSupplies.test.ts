import { describe, expect, it } from 'vitest';

import { FoundSupplies } from '../FoundSupplies';
import { t } from '../../app/i18n';
import type { Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SupplyItem } from '../../../shared/packConfig';

const KEY: SupplyItem = {
  name: 'black star key',
  min: 0,
  max: 2,
  shop: '',
  at: null,
  buy: false,
  doneOnFound: true
};

const took = (item: string): Block =>
  ({ type: 'player-gets', domain: 'presence', groups: { item } }) as unknown as Block;

/** A pack holding `count` of the key, on the key ring as `i` lists keys. */
function holding(count: number): CharacterState {
  const state = structuredClone(EMPTY_CHARACTER);
  return { ...state, inventory: { ...state.inventory, keys: Array(count).fill('black star key') } };
}

// Todo 20261024-1810-01.
describe('a row done once found', () => {
  const rig = (written = true) => {
    const dropped: string[] = [];
    const said: string[] = [];
    const found = new FoundSupplies(
      { dropSupply: (name) => (dropped.push(name), written) },
      (message) => said.push(message)
    );
    return { found, dropped, said };
  };

  it('is taken off on the pick-up that brings the pack to its maximum, once', () => {
    const { found, dropped, said } = rig();
    // A state with the pack at its maximum, but no pick-up yet: nothing.
    found.onCharacter(holding(2), [KEY]);
    expect(dropped).toEqual([]);
    found.onBlock(took('black star key'), [KEY]);
    found.onCharacter(holding(1), [KEY]);
    expect(dropped).toEqual([]);
    found.onBlock(took('black star key'), [KEY]);
    found.onCharacter(holding(2), [KEY]);
    expect(dropped).toEqual(['black star key']);
    expect(said).toEqual([
      t('automation.supplies.doneOnFound', { item: 'black star key', count: 2 })
    ]);
    // Already gone from the list: a second confirmation writes nothing.
    found.onBlock(took('black star key'), []);
    found.onCharacter(holding(3), []);
    expect(dropped).toEqual(['black star key']);
  });

  it('never takes off a row without done once found, and says a failed write', () => {
    const kept = rig();
    kept.found.onBlock(took('black star key'), [{ ...KEY, doneOnFound: false }]);
    kept.found.onCharacter(holding(2), [{ ...KEY, doneOnFound: false }]);
    expect(kept.dropped).toEqual([]);
    const failed = rig(false);
    failed.found.onBlock(took('black star key'), [KEY]);
    failed.found.onCharacter(holding(2), [KEY]);
    expect(failed.said).toEqual([
      t('automation.supplies.doneOnFoundNotWritten', { item: 'black star key' })
    ]);
  });
});
