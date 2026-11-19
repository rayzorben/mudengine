import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecoveredLoot } from '../RecoveredLoot';
import { t } from '../../app/i18n';
import { CommandQueue } from '../../automation/CommandQueue';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { coinReader, type CoinNames } from '../../../shared/coins';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';

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

describe('what recover takes out of another player’s corpse', () => {
  let state: CharacterState;
  let notices: string[];
  let sent: string[];
  let connected: boolean;
  let queue: CommandQueue;
  let loot: RecoveredLoot;

  const lootFor = (coins: CoinNames): RecoveredLoot =>
    new RecoveredLoot(
      queue,
      () => state,
      { coins: coinReader(coins) },
      (message) => notices.push(message)
    );

  /** Festus's wire, 2026-11-19, cut to five of its lines. */
  const recover = (player: string): void => {
    loot.onBlock(block('user-picks-through-corpse', { player }));
    loot.onBlock(block('user-gets-coins', { count: '4', coin: 'silver nobles' }));
    loot.onBlock(block('user-gets-coins', { count: '51', coin: 'gold crowns' }));
    loot.onBlock(block('player-gets', { item: 'moonstone ring' }));
    loot.onBlock(block('player-gets', { item: 'silver ring' }));
    loot.onBlock(block('player-gets', { item: 'silver ring' }));
    loot.onBlock(block('user-recovers-corpse', { player }));
  };
  /** The server's prompt after one command's answer: the next command goes. */
  const prompts = (count = 1): void => {
    for (let i = 0; i < count; i += 1) {
      vi.advanceTimersByTime(50);
      queue.notePrompt();
      loot.onBlock(block('status-line'));
    }
    vi.advanceTimersByTime(50);
  };
  const give = (player: string): void => loot.answer({ kind: 'give', player });
  const listed = (): string[] => {
    notices = [];
    loot.answer({ kind: 'list' });
    return notices;
  };
  const carrying = (things: string, player = 'Cretin'): string =>
    t('session.return.carrying', { player, things });
  const everything = '51 gold crowns, 4 silver nobles, moonstone ring, 2 silver ring';

  beforeEach(() => {
    vi.useFakeTimers();
    state = { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game', name: 'Festus' };
    notices = [];
    sent = [];
    connected = true;
    queue = new CommandQueue(
      { ...DEFAULT_CONFIG.automation, pacing: { window: 1, minGapMs: 10, ackTimeoutMs: 30_000 } },
      { send: (command) => sent.push(command), connected: () => connected }
    );
    loot = lootFor({});
  });

  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it('is given back by return a prompt at a time, coins by their whole name', () => {
    recover('Cretin');
    expect(notices).toEqual([t('session.return.filed', { player: 'Cretin', word: 'cretin' })]);
    give('cretin');
    expect(sent).toEqual(['give 51 gold crowns to Cretin']);
    prompts(3);
    expect(sent).toEqual([
      'give 51 gold crowns to Cretin',
      'give 4 silver nobles to Cretin',
      'give moonstone ring to Cretin',
      'give 2 silver ring to Cretin'
    ]);
  });

  it('gives each thing once when return is typed twice', () => {
    recover('Cretin');
    give('cretin');
    give('cretin');
    prompts(6);
    // The gold was on the wire at the second return, and the rest was queued once over.
    expect(sent).toEqual([
      'give 51 gold crowns to Cretin',
      'give 4 silver nobles to Cretin',
      'give moonstone ring to Cretin',
      'give 2 silver ring to Cretin'
    ]);
  });

  it('is listed by return alone, and forgotten as the server says each was given', () => {
    recover('Cretin');
    loot.onBlock(block('user-gives', { count: '51', coin: 'gold crowns', target: 'Cretin' }));
    loot.onBlock(block('user-gives', { item: 'moonstone ring', target: 'Cretin' }));
    loot.onBlock(block('user-gives', { count: '2', item: 'silver ring', target: 'Cretin' }));
    expect(listed()).toEqual([carrying('4 silver nobles')]);
    loot.onBlock(block('user-gives', { count: '4', coin: 'silver nobles', target: 'Cretin' }));
    expect(notices).toContain(t('session.return.returned', { player: 'Cretin' }));
    notices = [];
    give('cretin');
    expect(notices).toEqual([t('session.return.nobody', { player: 'cretin' })]);
    expect(sent).toEqual([]);
  });

  it('keeps what the server did not hand over, and forgets a give it says cannot be made', () => {
    recover('Cretin');
    give('cre');
    // The gold is sent and nothing answers it but the prompt.
    prompts();
    loot.onBlock(block('user-gives-nothing', { what: '4 silver nobles' }));
    expect(notices).toContain(
      t('session.return.refused', { player: 'Cretin', things: '4 silver nobles' })
    );
    prompts(2);
    loot.onBlock(block('user-gives-nothing', { what: '2 silver ring' }));
    prompts();
    expect(sent).toHaveLength(4);
    expect(listed()).toEqual([carrying('51 gold crowns, moonstone ring')]);
  });

  it('forgets nothing on a refusal that comes after the give’s own prompt', () => {
    recover('Cretin');
    give('cretin');
    prompts(4);
    // Positive control: all four went, and the test above forgets on the same line in time.
    expect(sent).toHaveLength(4);
    loot.onBlock(block('user-gives-nothing', { what: '4 silver nobles' }));
    loot.onBlock(block('user-gives-nothing', { what: '2 silver ring' }));
    expect(listed()).toEqual([carrying(everything)]);
  });

  it('forgets nothing on a refusal of a give typed by hand', () => {
    recover('Cretin');
    recover('Crank');
    loot.onBlock(block('user-gives-nothing', { what: '2 silver ring' }));
    loot.onBlock(block('user-gives-nothing', { what: '4 silver nobles' }));
    expect(listed()).toEqual([carrying(everything), carrying(everything, 'Crank')]);
  });

  it('does not send a give for what a listed pack no longer holds, and says so', () => {
    recover('Cretin');
    state = {
      ...state,
      inventory: {
        ...state.inventory,
        listedAt: 1,
        coins: { ...state.inventory.coins, gold: 51, silver: 0 },
        items: [wireItem('moonstone ring'), wireItem('silver ring')]
      }
    };
    notices = [];
    give('cretin');
    prompts(2);
    expect(sent).toEqual([
      'give 51 gold crowns to Cretin',
      'give moonstone ring to Cretin',
      'give silver ring to Cretin'
    ]);
    expect(notices).toEqual([
      t('session.return.gone', { player: 'Cretin', things: '4 silver nobles, silver ring' })
    ]);
  });

  it('files nothing from the character’s own corpse, an unread name’s, or a get', () => {
    recover('Festus');
    state = { ...state, name: null };
    recover('Cretin');
    loot.onBlock(block('player-gets', { item: 'torch' }));
    expect(listed()).toEqual([t('session.return.none')]);
    // Positive control: with the name read, another player's corpse is filed by the same lines.
    state = { ...state, name: 'Festus' };
    recover('Cretin');
    expect(notices).toContain(t('session.return.filed', { player: 'Cretin', word: 'cretin' }));
  });

  it('names the players a short name could be, and sends nothing', () => {
    recover('Cretin');
    recover('Crank');
    notices = [];
    give('cr');
    expect(notices).toEqual([
      t('session.return.several', { name: 'cr', players: 'Cretin, Crank' })
    ]);
    expect(sent).toEqual([]);
  });

  it('keeps the files through a reconnect, and closes a recover it cut off', () => {
    recover('Cretin');
    loot.onBlock(block('user-picks-through-corpse', { player: 'Crank' }));
    loot.reset();
    loot.onBlock(block('player-gets', { item: 'torch' }));
    expect(listed()).toEqual([carrying(everything)]);
  });

  it('says so and keeps the files where the queue takes nothing', () => {
    recover('Cretin');
    connected = false;
    notices = [];
    give('cretin');
    expect(notices).toEqual([
      t('session.macro.restRefused', { command: 'give 51 gold crowns to Cretin' })
    ]);
    expect(sent).toEqual([]);
    expect(listed()).toEqual([carrying(everything)]);
  });

  it('sends a realm’s own coin name, and reads its refusal spelled the stock way', () => {
    loot = lootFor({ runic: 'dime bag' });
    loot.onBlock(block('user-picks-through-corpse', { player: 'Cretin' }));
    loot.onBlock(block('user-gets-coins', { count: '2', coin: 'runic coins' }));
    loot.onBlock(block('user-recovers-corpse', { player: 'Cretin' }));
    give('cretin');
    expect(sent).toEqual(['give 2 dime bags to Cretin']);
    loot.onBlock(block('user-gives-nothing', { what: '2 runic coins' }));
    expect(listed()).toEqual([t('session.return.none')]);
  });
});
