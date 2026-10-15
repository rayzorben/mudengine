import { beforeEach, describe, expect, it } from 'vitest';

import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import type { WorldItem } from '../../../shared/world';
import type { Intent } from '../CommandQueue';
import { ItemCharges } from '../ItemCharges';

// gmud.zip's cloak of faith (3 uses, 3 back each new day, kept) and bone necklace (10, 5 back).
const ITEMS: Record<string, WorldItem> = {
  'cloak of faith': {
    id: 1,
    name: 'cloak of faith',
    uses: 3,
    retains: true,
    abilities: [[121, 3]]
  },
  'bone necklace': { id: 2, name: 'bone necklace', uses: 10, retains: true, abilities: [[121, 5]] }
};

let seq = 0;
function block(type: BlockType, groups: Record<string, string> = {}): Block {
  seq += 1;
  return {
    seq,
    at: 0,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

let queued: Intent[];
let charges: ItemCharges;
/** `automation.asks.itemUses`, as the session's settings say it. */
let itemUses: boolean;

beforeEach(() => {
  queued = [];
  itemUses = true;
  charges = new ItemCharges(
    {
      enqueue: (intent) => {
        queued.push(intent);
        return true;
      }
    },
    () => ({ itemsNamed: (names) => Object.fromEntries(names.map((name) => [name, ITEMS[name]])) }),
    () => ({ asks: { itemUses } })
  );
});

/** The queue sending what was proposed, in order. */
const sendAll = (): void => {
  for (const intent of queued.splice(0)) intent.onSent?.();
};

describe('the uses left on a charged item', () => {
  it('takes a Uses remaining line only for a look it sent', () => {
    charges.onBlock(block('item-uses-left', { uses: '2' }));
    expect(charges.usesLeft('cloak of faith')).toBeNull();
    // The positive control: the same line after a look went out.
    charges.look('cloak of faith', { reason: 'test' });
    sendAll();
    charges.onBlock(block('item-uses-left', { uses: '2' }));
    expect(charges.usesLeft('cloak of faith')).toBe(2);
  });

  it('pairs answers with looks in the order they went, each told its own', () => {
    const heard: string[] = [];
    charges.look('cloak of faith', { reason: 'test' }, (uses) => heard.push(`cloak ${uses}`));
    charges.look('bone necklace', { reason: 'test' }, (uses) => heard.push(`necklace ${uses}`));
    expect(queued.map((intent) => intent.command)).toEqual([
      'look cloak of faith',
      'look bone necklace'
    ]);
    sendAll();
    charges.onBlock(block('item-uses-left', { uses: '1' }));
    charges.onBlock(block('item-uses-left', { uses: '7' }));
    expect(heard).toEqual(['cloak 1', 'necklace 7']);
    expect(charges.usesLeft('bone necklace')).toBe(7);
  });

  it('drops a look at an item no longer carried, so the next answer is its own', () => {
    charges.look('cloak of faith', { reason: 'test' });
    charges.look('bone necklace', { reason: 'test' });
    sendAll();
    charges.onBlock(block('target-missing', { target: 'cloak of faith' }));
    charges.onBlock(block('item-uses-left', { uses: '4' }));
    expect(charges.usesLeft('bone necklace')).toBe(4);
    expect(charges.usesLeft('cloak of faith')).toBeNull();
  });

  it('counts a landed use down, and none left on the server saying so', () => {
    charges.look('cloak of faith (Back)', { reason: 'test' });
    sendAll();
    charges.onBlock(block('item-uses-left', { uses: '2' }));
    charges.used('cloak of faith');
    expect(charges.usesLeft('cloak of faith')).toBe(1);
    charges.onBlock(block('item-used-up', { item: 'cloak of faith' }));
    expect(charges.usesLeft('cloak of faith')).toBe(0);
  });

  it('refills at the new day by the realm’s Recharge', () => {
    charges.onBlock(block('item-used-up', { item: 'cloak of faith' }));
    charges.look('bone necklace', { reason: 'test' });
    sendAll();
    charges.onBlock(block('item-uses-left', { uses: '1' }));
    charges.onBlock(block('realm-cleanup'));
    expect(charges.usesLeft('cloak of faith')).toBe(3);
    expect(charges.usesLeft('bone necklace')).toBe(6);
  });

  it('looks once a session while the count is unknown', () => {
    charges.lookOnce('cloak of faith', 'test');
    charges.lookOnce('cloak of faith', 'test');
    expect(queued).toHaveLength(1);
    charges.reset();
    charges.lookOnce('cloak of faith', 'test');
    expect(queued).toHaveLength(2);
  });

  it('looks at nothing while Look at Charged Items is off', () => {
    itemUses = false;
    charges.lookOnce('cloak of faith', 'test');
    expect(queued).toEqual([]);
    // The positive control: the same unknown count, the setting on.
    itemUses = true;
    charges.lookOnce('cloak of faith', 'test');
    expect(queued.map((intent) => intent.command)).toEqual(['look cloak of faith']);
  });
});
