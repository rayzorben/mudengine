import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoSearch } from '../AutoSearch';
import { wireExit } from '../../../shared/entities';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type SearchConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const config = (over: Partial<SearchConfig> = {}): SearchConfig => ({
  enabled: true,
  tries: 1,
  ...over
});

const monster = (name: string): RoomOccupant => ({
  name,
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
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
/**
 * The character as the send-time ask reads it (`Intent.stillWanted`).
 *
 * The proposal is made against the state `onCharacter` is handed and the send
 * may happen a round later, so the two are separate here on purpose: `at`
 * moves both together, which is the ordinary case, and a test about the gap
 * moves this one on its own.
 */
let now: CharacterState;
/** `AutoCombat.quarry`, as the session hands it in: nothing to fight unless a test says so. */
let quarry: (state: CharacterState) => boolean;
let queueSearch: (config?: SearchConfig, enabled?: boolean) => AutoSearch;
/** A status line: proposed against this state, and sent against it too. */
const at = (search: AutoSearch, said: CharacterState): void => {
  now = said;
  search.onCharacter(said);
};
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
  now = state();
  quarry = () => false;
  queueSearch = (over = config(), enabled = true) =>
    new AutoSearch(
      over,
      enabled,
      queue,
      () => now,
      (said) => quarry(said)
    );
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

describe('searching a room the client arrives in', () => {
  it('sends a bare search, once', () => {
    const search = queueSearch();
    at(search, state());
    expect(sent).toEqual(['search']);
  });

  /*
   * The room the character is standing in produces a status line every few
   * hundred milliseconds, and a `look` or a fight's courtesy reprint produces
   * the whole room again. None of those is a new room, and a search on each
   * would be the entire command budget.
   */
  it('does not search the same room again on the next status line', () => {
    const search = queueSearch();
    for (let i = 0; i < 20; i += 1) at(search, state());
    expect(sent).toEqual(['search']);
  });

  it('searches the next room, and again on coming back', () => {
    const search = queueSearch();
    at(search, state());
    at(search, state({ number: 2151, name: 'Newhaven, Narrow Road' }));
    at(search, state());
    expect(sent).toEqual(['search', 'search', 'search']);
  });

  it('spends the configured number of tries and no more', () => {
    const search = queueSearch(config({ tries: 3 }));
    for (let i = 0; i < 10; i += 1) at(search, state());
    expect(sent).toEqual(['search', 'search', 'search']);
  });
});

describe('when it will not search', () => {
  it('does nothing with the switch off', () => {
    const search = queueSearch(config({ enabled: false }));
    at(search, state());
    expect(sent).toEqual([]);
  });

  it('does nothing with automation off', () => {
    const search = queueSearch(config(), false);
    at(search, state());
    expect(sent).toEqual([]);
  });

  /* A command spent mid-round is one the fight paid for, and nothing found by
     it can be used until the fight is over. */
  it('does not search in a fight, and searches once it ends', () => {
    const search = queueSearch();
    at(search, state({}, { inCombat: true }));
    expect(sent).toEqual([]);
    at(search, state());
    expect(sent).toEqual(['search']);
  });

  /*
   * The capture this was reported from (todo 13, 2026-09-13).
   *
   * Following a party leader into a room with a quickling in it: nothing was
   * fighting when the room arrived, so a search was proposed — and auto-combat
   * proposed `aa small quickling` from the same status line, in a louder band.
   * The attack went out first, the fight started, and the search that had been
   * waiting behind it landed inside it: `You may not search while attacking!`,
   * twice in the same capture. The proposal was right when it was made; what
   * was missing was the second ask, immediately before the send.
   */
  it('drops a search the fight beat to the wire, and searches once it is over', () => {
    const search = queueSearch();
    /*
     * The player holding the floor stands in for the round the queue spends
     * waiting for a prompt's credit: the intent is queued and unsent, which is
     * the whole window this is about.
     */
    queue.noteTyping(true);
    at(search, state());
    expect(sent).toEqual([]);

    // The attack landed while it waited, so the search must not go out.
    now = state({}, { inCombat: true });
    queue.noteTyping(false);
    expect(sent).toEqual([]);

    // And the budget was not spent on the one that never went out: the first
    // status line after the fight searches the room it arrived in.
    at(search, state());
    expect(sent).toEqual(['search']);
  });

  /*
   * The same window, with the fight over by the time the queue can send: the
   * positive control for the assertion above, without which an intent dropped
   * for any other reason would read as this working.
   */
  it('still sends one the fight did not touch', () => {
    const search = queueSearch();
    queue.noteTyping(true);
    at(search, state());
    expect(sent).toEqual([]);
    queue.noteTyping(false);
    expect(sent).toEqual(['search']);
  });

  /*
   * `fightIsRunning`, not the server's flag alone: between a kill and the next
   * monster's swing the flag is down with the beast still in `attackers`, and
   * a search proposed in that instant is one the fight paid for.
   */
  it('counts something still swinging as a fight, flag or no flag', () => {
    const base = state();
    const search = queueSearch();
    at(search, {
      ...base,
      combat: { ...base.combat, attackers: ['nasty quickling'] }
    });
    expect(sent).toEqual([]);
  });

  /*
   * `festus`, 2026-09-18: dragged by its leader into a room holding a fierce
   * orc fanatic, it sent `aa fierce orc fanatic` and `search` 3ms apart — the
   * prompt closing the room released the attack's credit — and the search
   * reached the server before `*Combat Engaged*` came back. Nothing was
   * fighting yet at either ask; the monster auto-combat was opening on was.
   */
  it('fights what auto-combat would open on first, then searches', () => {
    const fanatic = monster('fierce orc fanatic');
    quarry = (said) => said.room.occupants.length > 0;
    const search = queueSearch();
    // Arrived, and the attack is proposed but unanswered.
    at(search, state({ occupants: [fanatic] }));
    // Engaged: the fight is the tracker's now, and quarry stands down.
    at(search, state({ occupants: [fanatic] }, { inCombat: true }));
    expect(sent).toEqual([]);
    // The kill takes it out of the room, and the room is searched.
    at(search, state());
    expect(sent).toEqual(['search']);
  });

  it('drops a search when a monster auto-combat would open on walks in before the send', () => {
    const search = queueSearch();
    queue.noteTyping(true);
    at(search, state());
    quarry = () => true;
    queue.noteTyping(false);
    expect(sent).toEqual([]);
  });

  /* The positive control: a monster nobody will fight is no reason to wait. */
  it('searches a room whose monster auto-combat will not open on', () => {
    const search = queueSearch();
    at(search, state({ occupants: [monster('town crier')] }));
    expect(sent).toEqual(['search']);
  });

  /* Unmeasured rather than settled, like `AutoLoot`: whether `search` breaks a
     rest has never been asked of the wire, and waiting costs only the wait. */
  it('does not search while resting or meditating', () => {
    const base = state();
    const search = queueSearch();
    at(search, { ...base, vitals: { ...base.vitals, resting: true } });
    at(search, { ...base, vitals: { ...base.vitals, meditating: true } });
    expect(sent).toEqual([]);
  });

  it('does nothing out of the realm', () => {
    const search = queueSearch();
    at(search, state({}, { phase: 'authenticating' }));
    expect(sent).toEqual([]);
  });

  /*
   * A room the client cannot identify at all is one it cannot remember having
   * searched, so searching it would be the per-status-line failure above
   * wearing a different hat.
   */
  it('does not search a room it cannot name or place', () => {
    const search = queueSearch();
    at(search, state({ map: null, number: null, name: null }));
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
    const search = queueSearch();
    at(search, state(unplaced));
    at(search, state(unplaced));
    expect(sent).toEqual(['search']);
    // A differently-shaped Sewer Tunnel is a different room.
    at(search, state({ ...unplaced, exits: [wireExit('s')] }));
    expect(sent).toEqual(['search', 'search']);
  });

  /*
   * A maze repeats its addresses on purpose: three rooms called `Secret
   * Passage` printing `east, west` in a row, walked one after another on
   * bearfather (2026-09-17). The name and the exits say one room; the arrival
   * says three, and the arrival is the only thing that can.
   */
  it('searches each room of a corridor of namesakes', () => {
    const passage = {
      map: null,
      number: null,
      name: 'Secret Passage',
      exits: [wireExit('e'), wireExit('w')]
    };
    const search = queueSearch();
    at(search, state({ ...passage, arrival: 4 }));
    at(search, state({ ...passage, arrival: 5 }));
    at(search, state({ ...passage, arrival: 6 }));
    expect(sent).toEqual(['search', 'search', 'search']);
  });

  /*
   * And the other half of the same fact: a room merely printed again — a
   * `look`, the courtesy reprint after a fight, the idle Enter — is the room
   * the character is already standing in, whatever else changed about it.
   */
  it('does not search a room the server simply printed again', () => {
    const search = queueSearch();
    at(search, state({ arrival: 7 }));
    at(search, state({ arrival: 7, occupants: [] }));
    at(search, state({ arrival: 7 }));
    expect(sent).toEqual(['search']);
  });
});

/*
 * The budget belongs to the room, not to the switch: turning it on halfway
 * along a corridor must not find a counter the walk before it had spent.
 */
describe('turning it on', () => {
  it('gives the room it is turned on in its full budget', () => {
    const search = queueSearch(config({ enabled: false }));
    at(search, state());
    search.configure(config(), true);
    at(search, state());
    expect(sent).toEqual(['search']);
  });

  /* A room remembered across a closed socket would be one this character never
     searched in this life. */
  it('forgets the room on reset', () => {
    const search = queueSearch();
    at(search, state());
    search.reset();
    at(search, state());
    expect(sent).toEqual(['search', 'search']);
  });
});
