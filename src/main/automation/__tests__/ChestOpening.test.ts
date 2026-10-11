import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChestOpening, chestTyped, chestYield } from '../ChestOpening';
import { CommandQueue } from '../CommandQueue';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const item = (name: string, more: Partial<CarriedItem> = {}): CarriedItem => ({
  name,
  source: 'hybrid',
  slot: null,
  equipped: false,
  charges: null,
  ...more
});
const box = item('wooden box', { kind: 'container' });

function holding(items: CarriedItem[], wealth: number | null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', inventory: { ...base.inventory, items, wealth } };
}

let sent: string[];
let said: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  said = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const drain = (): void => void vi.advanceTimersByTime(500);

describe('which open is a chest', () => {
  it('takes the one carried container the word names, as the server matches it', () => {
    expect(chestTyped('open box', [item('torch'), box])).toBe('wooden box');
    expect(chestTyped('ope wooden', [box])).toBe('wooden box');
  });

  it('leaves a door, a word naming nothing carried, and two different chests alone', () => {
    expect(chestTyped('open n', [box])).toBeNull();
    expect(chestTyped('open', [box])).toBeNull();
    // `OpenCommand` tries an exit first, so a direction is a door even beside a chest it names.
    const dark = item('dark chest', { kind: 'container' });
    expect(chestTyped('open d', [dark])).toBeNull();
    expect(chestTyped('open down', [dark])).toBeNull();
    expect(chestTyped('open dark', [dark])).toBe('dark chest');
    expect(chestTyped('open box', [item('box of nails')])).toBeNull();
    const silver = item('silver box', { kind: 'container' });
    expect(chestTyped('open box', [box, silver])).toBeNull();
    // Two of the same chest are one stack: the server opens one of them.
    expect(chestTyped('open box', [box, box])).toBe('wooden box');
  });
});

describe('what a chest gave', () => {
  it('counts what the pack holds more of, and the purse’s move', () => {
    const found = chestYield(
      'wooden box',
      { carried: [box, item('ruby')], wealth: 100 },
      { items: [item('ruby'), item('ruby'), item('obsidian stone')], wealth: 160 }
    );
    expect(found).toEqual({
      chest: 'wooden box',
      items: [
        { name: 'ruby', count: 1 },
        { name: 'obsidian stone', count: 1 }
      ],
      copper: 60
    });
  });

  it('leaves the copper unknown where either purse is unread', () => {
    expect(
      chestYield('wooden box', { carried: [box], wealth: null }, { items: [], wealth: 5 }).copper
    ).toBeNull();
  });
});

describe('asking the pack after an open', () => {
  it('sends an `i` behind the open and reports what the listing gained', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open box', holding([box], 100));
    drain();
    expect(sent).toEqual(['i']);
    opening.onListing(holding([item('ruby')], 100));
    expect(said).toEqual([t('automation.chest.items', { chest: 'wooden box', items: 'ruby' })]);
  });

  it('asks with automation switched off, since the player typed the open', () => {
    queue.dispose();
    queue = new CommandQueue(
      { ...automation, enabled: false },
      { send: (command) => sent.push(command) }
    );
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open box', holding([box], 100));
    drain();
    expect(sent).toEqual(['i']);
  });

  it('answers two opens before the `i` with one listing', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    const silver = item('silver box', { kind: 'container' });
    queue.noteTyping(true);
    opening.sent('open wooden', holding([box, silver], 100));
    opening.sent('open silver', holding([silver], 100));
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual(['i']);
    opening.onListing(holding([item('ruby')], 160));
    expect(said).toEqual([
      t('automation.chest.found', {
        chest: ['wooden box', 'silver box'].join(t('automation.chest.and')),
        items: 'ruby',
        copper: '60'
      })
    ]);
  });

  it('compares a second open after the first one’s `i` with the first one’s listing', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open box', holding([box, box], 100));
    drain();
    opening.sent('open box', holding([box, box], 100));
    drain();
    expect(sent).toEqual(['i', 'i']);
    opening.onListing(holding([box, item('ruby')], 100));
    opening.onListing(holding([item('ruby'), item('ruby')], 130));
    expect(said).toEqual([
      t('automation.chest.items', { chest: 'wooden box', items: 'ruby' }),
      t('automation.chest.found', { chest: 'wooden box', items: 'ruby', copper: '30' })
    ]);
  });

  it('says the copper is unknown where the purse was unread, never that nothing came out', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open box', holding([box], null));
    drain();
    opening.onListing(holding([], 40));
    opening.sent('open box', holding([box], null));
    drain();
    opening.onListing(holding([item('ruby')], 40));
    expect(said).toEqual([
      t('automation.chest.coinsUnknown', { chest: 'wooden box' }),
      t('automation.chest.itemsCoinsUnknown', { chest: 'wooden box', items: 'ruby' })
    ]);
  });

  it('says it cannot tell when the listing before an open expired unanswered', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open box', holding([box, box], 100));
    drain();
    vi.advanceTimersByTime(6_000);
    opening.sent('open box', holding([box, box], 100));
    drain();
    expect(sent).toEqual(['i', 'i']);
    // Past the first open's expiry, before the second's.
    vi.advanceTimersByTime(5_000);
    opening.onListing(holding([item('ruby')], 100));
    expect(said).toEqual([t('automation.chest.unread', { chest: 'wooden box' })]);
  });

  it('says when nothing came out', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open box', holding([box], 100));
    drain();
    opening.onListing(holding([], 100));
    expect(said).toEqual([t('automation.chest.nothing', { chest: 'wooden box' })]);
  });

  it('reads no listing that arrived before its own `i` went out', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    // A half-typed line holds the queue, so the `i` waits.
    queue.noteTyping(true);
    opening.sent('open box', holding([box], 100));
    drain();
    expect(sent).toEqual([]);
    opening.onListing(holding([item('ruby')], 100));
    expect(said).toEqual([]);
    // Positive control: once the `i` is out, the same listing is read.
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual(['i']);
    opening.onListing(holding([item('ruby')], 100));
    expect(said).toHaveLength(1);
  });

  it('asks nothing for a door', () => {
    const opening = new ChestOpening(queue, { notice: (message) => said.push(message) });
    opening.sent('open n', holding([box], 100));
    opening.sent('open box', holding([box], 100));
    drain();
    // Positive control: the chest's open did reach the queue.
    expect(sent).toEqual(['i']);
  });
});
