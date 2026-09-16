import { beforeEach, describe, expect, it } from 'vitest';

import { ItemErrand, type ItemPlanner, type ItemSources } from '../ItemErrand';
import { tuning } from '../../app/tuning';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import type { SupplyItem } from '../../../shared/config';
import type { Loop } from '../../../shared/loops';
import type { BuyingPlace, Route } from '../../../shared/world';

const KEY = { id: 4211, name: 'black star key' };

const OWED: Route = {
  steps: [{ from: '1/1', to: '1/2' }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

/** In the realm, carrying nothing. */
function ready(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', ...over };
}

/** In the realm with the key in the pack. */
function carrying(): CharacterState {
  const base = ready();
  return {
    ...base,
    inventory: {
      ...base.inventory,
      items: [{ name: 'black star key' }]
    } as CharacterState['inventory']
  };
}

let notices: string[];
let decisions: SafetyDecision[];
let sources: ItemSources;
let bought: SupplyItem[];
let loops: Loop[];
let walked: Route[];
let taking: string[];
let buying: boolean;
let looping: boolean;
let keptNames: string[];

function errand(over: Partial<ItemPlanner> = {}, now?: () => number): ItemErrand {
  const planner: ItemPlanner = {
    here: () => '1/1',
    sourcesOf: () => sources,
    buy: (row) => {
      bought.push(row);
      buying = true;
      return null;
    },
    buying: () => buying,
    runLoop: (loop) => {
      loops.push(loop);
      looping = true;
      return null;
    },
    looping: () => looping,
    stopLoop: () => {
      looping = false;
    },
    alsoTake: (name) => taking.push(name),
    stopTaking: (name) => {
      taking = taking.filter((entry) => entry !== name);
    },
    walk: (route) => {
      walked.push(route);
      return null;
    },
    kept: (name) => keptNames.includes(name),
    ...over
  };
  return new ItemErrand(
    planner,
    {
      notice: (message) => notices.push(message),
      decided: (decision) => decisions.push(decision)
    },
    now
  );
}

beforeEach(() => {
  notices = [];
  decisions = [];
  bought = [];
  loops = [];
  walked = [];
  taking = [];
  buying = false;
  looping = false;
  keptNames = [];
  sources = { shops: [], lairs: [] };
});

/**
 * One counter, as `WorldGraph.buyingPlaces` hands it over: a room, not a name.
 * `detour` is what stopping there adds to the journey, in plain steps.
 */
function counter(over: Partial<BuyingPlace> = {}): BuyingPlace {
  return {
    map: 1,
    room: 42,
    roomName: 'Locksmith Row',
    shop: 'Locksmith',
    markup: 100,
    detour: 6,
    moves: 12,
    ...over
  };
}

describe('collecting what a route needs', () => {
  /* The commonest case for a key: it was collected on an earlier trip. */
  it('walks straight off when the pack already holds it', () => {
    const auto = errand();
    expect(auto.collect(KEY, OWED, carrying())).toBeNull();
    expect(walked).toEqual([OWED]);
    expect(bought).toHaveLength(0);
    expect(loops).toHaveLength(0);
  });

  /*
   * Bought before found where both are known: a counter is a fixed price and a
   * walk, and a drop is a fight and a chance. The row is a session row with a
   * floor of one and is written nowhere.
   */
  it('buys it where the realm names a shop', () => {
    sources = { shops: [counter()], lairs: [] };
    const auto = errand();
    expect(auto.collect(KEY, OWED, ready())).toBeNull();
    /*
     * **Addressed by room.** `at` is what `shopRoom` resolves without asking
     * anything further; a bare `shop` name sends it back through `shopPlace`,
     * which refuses a name standing in several rooms.
     */
    expect(bought).toEqual([
      { name: 'black star key', min: 1, max: 1, shop: 'Locksmith', at: { map: 1, room: 42 } }
    ]);
    expect(walked).toHaveLength(0);

    // The pack holds it: the route the player asked for is walked.
    auto.onCharacter(carrying());
    expect(walked).toEqual([OWED]);
    expect(decisions.at(-1)).toMatchObject({ action: 'collect', acted: true });
  });

  /*
   * Found: a loop over the rooms the realm says its droppers live in, with the
   * name added to what the character picks up for as long as the errand runs.
   */
  it('hunts for it where only a monster drops it', () => {
    sources = {
      shops: [],
      lairs: [
        { id: '1/816', name: 'Graveyard', mob: 'fierce zombie', steps: 4 },
        { id: '1/833', name: 'Crypt', mob: 'fierce zombie', steps: 6 }
      ]
    };
    const auto = errand();
    expect(auto.collect(KEY, OWED, ready())).toBeNull();
    expect(loops).toHaveLength(1);
    expect(loops[0]!.stops).toEqual([{ room: 'Graveyard 1/816' }, { room: 'Crypt 1/833' }]);
    // Picked up while the errand runs, and only while it runs.
    expect(taking).toEqual(['black star key']);

    auto.onCharacter(carrying());
    expect(taking).toEqual([]);
    expect(looping).toBe(false);
    expect(walked).toEqual([OWED]);
  });

  /*
   * A key the player's own list names is kept; a thing bought for one door is
   * not, and which happened is said.
   */
  it('says whether what it collected stays in the pack', () => {
    sources = { shops: [counter()], lairs: [] };
    keptNames = ['black star key'];
    const auto = errand();
    auto.collect(KEY, OWED, ready());
    auto.onCharacter(carrying());
    expect(notices.some((line) => line.includes('stays'))).toBe(true);
  });

  it('refuses out loud where the realm names no source', () => {
    const auto = errand();
    const refused = auto.collect(KEY, OWED, ready());
    expect(refused).not.toBeNull();
    expect(walked).toHaveLength(0);
    expect(decisions.at(-1)).toMatchObject({ action: 'collect', acted: false });
  });

  /* The shopping errand gave up: the route is not walked, and it says so. */
  it('does not walk the route when the errand ends without the item', () => {
    sources = { shops: [counter()], lairs: [] };
    const auto = errand();
    auto.collect(KEY, OWED, ready());
    buying = false;
    auto.onCharacter(ready());
    expect(walked).toHaveLength(0);
    expect(decisions.at(-1)).toMatchObject({ acted: false });
  });

  /*
   * The reported failure, from the wire
   * (`logs/2026-09-14_16-00-21_festus.mudcap.jsonl`): the lap's own next step
   * went out two milliseconds after the `get` and eighty before the server
   * confirmed it, so at the moment the pack held the key there was a move
   * outstanding and `Walker.start` refused to plan across it. One attempt
   * meant the key was collected and the way it was collected for never walked.
   */
  it('keeps offering the way while a move of its own is still unanswered', () => {
    sources = { shops: [], lairs: [{ id: '1/816', name: 'Graveyard', mob: 'zombie', steps: 4 }] };
    let inFlight = true;
    const auto = errand({
      walk: (route) => {
        if (inFlight) return 'a move has not been answered yet';
        walked.push(route);
        return null;
      }
    });
    auto.collect(KEY, OWED, ready());

    // The pack holds it, and the walker cannot plan across the step in flight.
    auto.onCharacter(carrying());
    expect(walked).toHaveLength(0);
    // Said as collected all the same, because it was.
    expect(decisions.at(-1)).toMatchObject({ action: 'collect', acted: true });
    // And not reported as a failure, because it has not failed yet.
    expect(notices.some((line) => line.includes('did not start'))).toBe(false);

    // The room for that move lands: the way is planned again and walked.
    inFlight = false;
    auto.onCharacter(carrying());
    expect(walked).toEqual([OWED]);
  });

  /* And a refusal that never clears is said out loud once the window is up. */
  it('says why it gave up when the way goes on refusing', () => {
    sources = { shops: [], lairs: [{ id: '1/816', name: 'Graveyard', mob: 'zombie', steps: 4 }] };
    let clock = 0;
    const auto = errand({ walk: () => 'there is no way there' }, () => clock);
    auto.collect(KEY, OWED, ready());

    auto.onCharacter(carrying());
    expect(notices.some((line) => line.includes('there is no way there'))).toBe(false);

    // Past the window the refusal is a real one, and it is named.
    clock += tuning().walk.errandHandoverMs + 1;
    auto.onCharacter(carrying());
    expect(walked).toHaveLength(0);
    expect(notices.some((line) => line.includes('there is no way there'))).toBe(true);
  });

  /* And what it was taking is given back when the errand is abandoned. */
  it('stops taking the item when it gives up', () => {
    sources = { shops: [], lairs: [{ id: '1/816', name: 'Graveyard', mob: 'zombie', steps: 4 }] };
    const auto = errand();
    auto.collect(KEY, OWED, ready());
    expect(taking).toEqual(['black star key']);
    auto.abandon('the character died');
    expect(taking).toEqual([]);
    expect(walked).toHaveLength(0);
  });
});
