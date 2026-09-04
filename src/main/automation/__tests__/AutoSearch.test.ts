import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoSearch } from '../AutoSearch';
import { wireExit } from '../../../shared/entities';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type SearchConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const config = (over: Partial<SearchConfig> = {}): SearchConfig => ({
  enabled: true,
  tries: 1,
  ...over
});

/** A character standing in a room the realm has placed, unless told otherwise. */
function state(
  room: Partial<CharacterState['room']> = {},
  over: Partial<CharacterState> = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 90, hpMax: 100 },
    room: { ...base.room, map: 1, number: 2150, name: 'Newhaven, Village Entrance', ...room },
    ...over
  };
}

let sent: string[];
let queue: CommandQueue;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

describe('searching a room the client arrives in', () => {
  it('sends a bare search, once', () => {
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state());
    expect(sent).toEqual(['search']);
  });

  /*
   * The room the character is standing in produces a status line every few
   * hundred milliseconds, and a `look` or a fight's courtesy reprint produces
   * the whole room again. None of those is a new room, and a search on each
   * would be the entire command budget.
   */
  it('does not search the same room again on the next status line', () => {
    const search = new AutoSearch(config(), true, queue);
    for (let i = 0; i < 20; i += 1) search.onCharacter(state());
    expect(sent).toEqual(['search']);
  });

  it('searches the next room, and again on coming back', () => {
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state());
    search.onCharacter(state({ number: 2151, name: 'Newhaven, Narrow Road' }));
    search.onCharacter(state());
    expect(sent).toEqual(['search', 'search', 'search']);
  });

  it('spends the configured number of tries and no more', () => {
    const search = new AutoSearch(config({ tries: 3 }), true, queue);
    for (let i = 0; i < 10; i += 1) search.onCharacter(state());
    expect(sent).toEqual(['search', 'search', 'search']);
  });
});

describe('when it will not search', () => {
  it('does nothing with the switch off', () => {
    const search = new AutoSearch(config({ enabled: false }), true, queue);
    search.onCharacter(state());
    expect(sent).toEqual([]);
  });

  it('does nothing with automation off', () => {
    const search = new AutoSearch(config(), false, queue);
    search.onCharacter(state());
    expect(sent).toEqual([]);
  });

  /* A command spent mid-round is one the fight paid for, and nothing found by
     it can be used until the fight is over. */
  it('does not search in a fight, and searches once it ends', () => {
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state({}, { inCombat: true }));
    expect(sent).toEqual([]);
    search.onCharacter(state());
    expect(sent).toEqual(['search']);
  });

  /* Unmeasured rather than settled, like `AutoLoot`: whether `search` breaks a
     rest has never been asked of the wire, and waiting costs only the wait. */
  it('does not search while resting or meditating', () => {
    const base = state();
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter({ ...base, vitals: { ...base.vitals, resting: true } });
    search.onCharacter({ ...base, vitals: { ...base.vitals, meditating: true } });
    expect(sent).toEqual([]);
  });

  it('does nothing out of the realm', () => {
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state({}, { phase: 'authenticating' }));
    expect(sent).toEqual([]);
  });

  /*
   * A room the client cannot identify at all is one it cannot remember having
   * searched, so searching it would be the per-status-line failure above
   * wearing a different hat.
   */
  it('does not search a room it cannot name or place', () => {
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state({ map: null, number: null, name: null }));
    expect(sent).toEqual([]);
  });

  /*
   * A room with no coordinates is still a room when it has a name and exits —
   * the same pair the resolver uses to tell one Sewer Tunnel from another —
   * and it is searched once like any other.
   */
  it('searches an unplaced room by its name and exits', () => {
    const unplaced = {
      map: null,
      number: null,
      name: 'Sewer Tunnel',
      exits: [wireExit('n')]
    };
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state(unplaced));
    search.onCharacter(state(unplaced));
    expect(sent).toEqual(['search']);
    // A differently-shaped Sewer Tunnel is a different room.
    search.onCharacter(state({ ...unplaced, exits: [wireExit('s')] }));
    expect(sent).toEqual(['search', 'search']);
  });
});

/*
 * The budget belongs to the room, not to the switch: turning it on halfway
 * along a corridor must not find a counter the walk before it had spent.
 */
describe('turning it on', () => {
  it('gives the room it is turned on in its full budget', () => {
    const search = new AutoSearch(config({ enabled: false }), true, queue);
    search.onCharacter(state());
    search.configure(config(), true);
    search.onCharacter(state());
    expect(sent).toEqual(['search']);
  });

  /* A room remembered across a closed socket would be one this character never
     searched in this life. */
  it('forgets the room on reset', () => {
    const search = new AutoSearch(config(), true, queue);
    search.onCharacter(state());
    search.reset();
    search.onCharacter(state());
    expect(sent).toEqual(['search', 'search']);
  });
});
