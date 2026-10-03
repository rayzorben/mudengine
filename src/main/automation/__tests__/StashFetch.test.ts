import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asStashFetchAsk, StashFetch, type StashFetchPlanner } from '../StashFetch';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import type { SafetyDecision } from '../../../shared/automation';
import { wireItem } from '../../../shared/entities';
import type { Route } from '../../../shared/world';
import { tuning } from '../../app/tuning';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const VAULT = '1/2150';
const ROUTE = {
  steps: [{ from: '1/1', to: VAULT }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

let seq = 0;
function block(type: BlockType, groups: Record<string, string> = {}): Block {
  seq += 1;
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

function inVault(over: Partial<CharacterState['room']> = {}, pack: string[] = []): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 2150, name: 'Ganghouse, Vault', ...over },
    inventory: { ...base.inventory, listedAt: 1, items: pack.map((name) => wireItem(name)) },
    stash: [{ map: 1, room: 2150, name: 'Ganghouse, Vault', item: 'katana', count: 1, at: 1 }]
  };
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let here: string | null;
let held: number;
let released: number;

const planner = (over: Partial<StashFetchPlanner> = {}): StashFetchPlanner => ({
  here: () => here,
  routeTo: () => ROUTE,
  walk: () => null,
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  looping: () => true,
  hold: () => void (held += 1),
  release: () => void (released += 1),
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  decisions = [];
  here = '1/1';
  held = 0;
  released = 0;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<StashFetchPlanner> = {}, enabled = true): StashFetch =>
  new StashFetch(enabled, queue, planner(over), {
    notice: (m) => notices.push(m),
    decided: (d) => decisions.push(d)
  });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('fetching from a stash', () => {
  it('walks to the room as a leg, holding the lap, and reports the trip', () => {
    const fetch = make();
    expect(fetch.fetch({ room: VAULT, items: ['katana'], search: true }, inVault())).toBeNull();
    expect(held).toBe(1);
    expect(fetch.current).toEqual({ room: VAULT, items: ['katana'], stage: 'walking' });
  });

  it('searches on arrival, and takes what the search turned up', () => {
    const fetch = make();
    fetch.fetch({ room: VAULT, items: ['katana'], search: true }, inVault());
    here = VAULT;
    fetch.onWalkEnded(true, null, inVault());
    drain();
    expect(sent).toEqual(['search']);

    fetch.onBlock(block('room-hidden-items', { items: 'katana' }));
    fetch.onCharacter(inVault({ hidden: [wireItem('katana')] }));
    drain();
    expect(sent).toEqual(['search', 'get katana']);
    expect(fetch.current?.stage).toBe('taking');

    fetch.onCharacter(inVault({}, ['katana']));
    expect(fetch.busy).toBe(false);
    expect(released).toBe(1);
    expect(decisions.at(-1)).toMatchObject({ action: 'fetch from stash', acted: true });
  });

  it('searches on while one named item is still unseen, though another turned up', () => {
    const fetch = make();
    here = VAULT;
    fetch.fetch({ room: VAULT, items: ['katana', 'padded gloves'], search: true }, inVault());
    drain();
    fetch.onBlock(block('room-hidden-items', { items: 'katana' }));
    fetch.onCharacter(inVault({ hidden: [wireItem('katana')] }));
    drain();
    expect(sent).toEqual(['search', 'search']);
    fetch.onBlock(block('room-hidden-items', { items: 'katana, padded gloves' }));
    fetch.onCharacter(inVault({ hidden: [wireItem('katana'), wireItem('padded gloves')] }));
    drain();
    expect(sent.slice(2)).toEqual(['get katana', 'get padded gloves']);
  });

  it('searches again when a search finds nothing, then settles for the open floor', () => {
    const fetch = make();
    here = VAULT;
    fetch.fetch({ room: VAULT, items: ['katana'], search: true }, inVault());
    const nothing = block('user-search-failed');
    for (let at = 1; at < tuning().stashFetch.searches; at += 1) {
      drain();
      fetch.onBlock(nothing);
      fetch.onCharacter(inVault());
    }
    drain();
    expect(sent.filter((command) => command === 'search')).toHaveLength(
      tuning().stashFetch.searches
    );
    fetch.onBlock(nothing);
    fetch.onCharacter(inVault({ items: [wireItem('katana')] }));
    drain();
    expect(sent.at(-1)).toBe('get katana');
  });

  it('says so when neither the searches nor the floor hold it', () => {
    const fetch = make();
    here = VAULT;
    expect(
      fetch.fetch({ room: VAULT, items: ['katana'], search: false }, inVault())
    ).not.toBeNull();
    expect(fetch.busy).toBe(false);
    expect(released).toBe(1);
    expect(decisions.at(-1)).toMatchObject({ acted: false });
  });

  it('refuses out loud while fighting, with automation off, or already on a trip', () => {
    const fighting = { ...inVault(), inCombat: true };
    expect(make().fetch({ room: VAULT, items: ['katana'], search: true }, fighting)).not.toBeNull();
    expect(
      make({}, false).fetch({ room: VAULT, items: ['katana'], search: true }, inVault())
    ).not.toBeNull();
    const busy = make();
    busy.fetch({ room: VAULT, items: ['katana'], search: true }, inVault());
    expect(busy.fetch({ room: VAULT, items: ['katana'], search: true }, inVault())).not.toBeNull();
    expect(decisions.filter((d) => !d.acted)).toHaveLength(3);
  });

  it('refuses a route that is blocked, and gives the lap back', () => {
    const blocked = { ...ROUTE, blocked: true, reason: 'a locked door' } as Route;
    const fetch = make({ routeTo: () => blocked });
    expect(fetch.fetch({ room: VAULT, items: ['katana'], search: true }, inVault())).toBe(
      'a locked door'
    );
    expect(released).toBe(1);
    expect(fetch.busy).toBe(false);
  });

  it('is dropped by a death, and the lap goes back', () => {
    const fetch = make();
    fetch.fetch({ room: VAULT, items: ['katana'], search: true }, inVault());
    fetch.abandon();
    expect(fetch.busy).toBe(false);
    expect(released).toBe(1);
  });
});

describe("an extension's ask", () => {
  it('is read only when the room is map/room and every item a name', () => {
    expect(asStashFetchAsk({ room: '1/2150', items: ['katana'], search: true })).toEqual({
      room: VAULT,
      items: ['katana'],
      search: true
    });
    expect(asStashFetchAsk({ room: 'the vault', items: ['katana'] })).toBeNull();
    expect(asStashFetchAsk({ room: '1/2150', items: ['katana', 3] })).toBeNull();
    expect(asStashFetchAsk(null)).toBeNull();
  });
});
