import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestRunner, type QuestRunPlanner } from '../QuestRunner';
import { CommandQueue } from '../CommandQueue';
import { tuning } from '../../app/tuning';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import type {
  PlanItem,
  PlanStep,
  Quest,
  QuestPlan,
  QuestRunProgress,
  QuestWatched
} from '../../../shared/quests';
import type { Route } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  // Wide enough that a dozen tries of one roll are never held for a prompt.
  pacing: { window: 64, minGapMs: 0, ackTimeoutMs: 1000 }
};

/*
 * One chain of two steps: ask the sage for `hello` at 1/2 (rank 0 → 1), then
 * carry a torch to the smith at 1/3 and say `forge` (rank 1 → 2). The second
 * step rolls, as the red book does, so it is the one asked again.
 */
const QUEST: Quest = {
  id: 134,
  name: 'TestQuest',
  steps: [
    {
      block: 10,
      who: 'Sage',
      room: '1/2',
      say: ['hello'],
      needs: [],
      takes: [],
      gives: [],
      from: 0,
      to: 1
    },
    {
      block: 11,
      who: 'Smith',
      room: '1/3',
      say: ['forge'],
      needs: [
        { kind: 'item', id: 55, name: 'torch' },
        { kind: 'skill', stat: 'intellect', value: 30 }
      ],
      takes: [{ id: 55, name: 'torch' }],
      gives: [],
      from: 1,
      to: 2
    }
  ]
};

const STEP_ONE: PlanStep = {
  block: 10,
  act: { verb: 'ask', who: 'Sage', say: 'hello' },
  items: [],
  at: { room: '1/2', place: 'Middle Road' },
  reachable: true,
  moves: 1,
  snags: []
};

const STEP_TWO: PlanStep = {
  block: 11,
  act: { verb: 'ask', who: 'Smith', say: 'forge' },
  items: [
    {
      id: 55,
      name: 'torch',
      held: false,
      hand: true,
      source: {
        how: 'buy',
        shops: ['General Store'],
        at: { room: '1/4', place: 'General Store' },
        detour: 2
      }
    }
  ],
  at: { room: '1/3', place: 'Forge' },
  reachable: true,
  moves: 1,
  snags: []
};

const plan = (...steps: PlanStep[]): QuestPlan => ({
  block: steps.at(-1)?.block ?? 10,
  from: '1/1',
  fromRank: null,
  stated: false,
  steps,
  reachable: true,
  moves: steps.length
});

const ROUTE: Route = {
  steps: [{ from: '1/1', to: '1/2' }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

/** In the realm, placed, with a listed pack holding what `items` names. */
function inRealm(items: string[] = [], over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: {
      ...base.room,
      map: 1,
      number: 1,
      name: 'Shore',
      occupants: []
    },
    inventory: {
      ...base.inventory,
      listedAt: 1,
      rows: [],
      items: items.map((name) => ({ name })) as CharacterState['inventory']['items']
    },
    ...over
  };
}

/** The same character with `who` standing in the room. */
function withHere(state: CharacterState, room: string, who: string[] = []): CharacterState {
  const [map, number] = room.split('/').map(Number);
  return {
    ...state,
    room: {
      ...state.room,
      map: map!,
      number: number!,
      occupants: who.map((name) => ({
        name,
        kind: 'mob' as const
      })) as CharacterState['room']['occupants']
    }
  };
}

/** An `abil` listing naming the counter at `rank`, read at `at`. */
function listed(state: CharacterState, rank: number, at: number): CharacterState {
  return { ...state, abilities: { sums: { 134: rank }, complete: true, at } };
}

let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let published: QuestRunProgress[];
let queue: CommandQueue;
let here: string | null;
let walked: Route[];
let bought: string[];
let buying: boolean;
let restock: PlanItem | null;
let fighting: string[];
let said: string[];
let watched: QuestWatched;
let questing: boolean[];
let warding: boolean[];
let clock: number;

const planner = (over: Partial<QuestRunPlanner> = {}): QuestRunPlanner => ({
  here: () => here,
  printsCounters: () => true,
  routeTo: () => ROUTE,
  walk: (route) => {
    walked.push(route);
    return null;
  },
  stopWalking: () => {},
  moveInFlight: () => false,
  walking: () => false,
  busy: () => false,
  looping: () => false,
  hold: () => {},
  release: () => {},
  buy: (row) => {
    bought.push(row.name);
    buying = true;
    return null;
  },
  buying: () => buying,
  restock: () => restock,
  hunt: () => null,
  hunting: () => false,
  abandonErrands: () => {},
  fightFor: (mob) => void fighting.push(mob),
  stopFighting: () => {},
  questing: (on) => void questing.push(on),
  warding: (on) => void warding.push(on),
  said: (command) => void said.push(command),
  watched: () => watched,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  restock = null;
  sent = [];
  notices = [];
  decisions = [];
  published = [];
  walked = [];
  bought = [];
  buying = false;
  fighting = [];
  said = [];
  watched = {};
  questing = [];
  warding = [];
  here = '1/1';
  // The runner's clock and the queue's `Date.now()` have to agree, or every
  // intent the runner stamps with an expiry is dropped as already stale.
  clock = Date.now();
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (over: Partial<QuestRunPlanner> = {}, enabled = true, on = true): QuestRunner =>
  new QuestRunner(
    { enabled: on },
    enabled,
    queue,
    planner(over),
    {
      notice: (message) => notices.push(message),
      decided: (decision) => decisions.push(decision),
      progress: (progress) => published.push(progress)
    },
    () => clock
  );

const drain = (): void => void vi.advanceTimersByTime(500);

describe('running a quest plan', () => {
  it('refuses while the switch is off, and names it', () => {
    const runner = make({}, true, false);
    const refused = runner.start(plan(STEP_ONE), QUEST, inRealm());
    expect(refused).toContain('Auto-Quest is off');
    expect(runner.running).toBe(false);
    expect(decisions.at(-1)?.acted).toBe(false);
  });

  it('walks to the step, asks, reads the counter back, and finishes', () => {
    const runner = make();
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    // Not at the sage yet: a leg is walked first, and combat is on for it.
    expect(walked).toHaveLength(1);
    expect(questing).toEqual([true]);
    expect(runner.progress.phase).toBe('walking');

    here = '1/2';
    const atSage = withHere(inRealm(), '1/2', ['Sage']);
    runner.onWalkEnded(true, null, atSage);
    drain();
    // The ask goes out with the room's own spelling, and the book is told.
    expect(sent).toContain('ask Sage hello');
    expect(said).toEqual(['ask Sage hello']);
    expect(runner.progress.phase).toBe('confirming');
    // Then the counter is asked for, once.
    runner.onCharacter(atSage);
    drain();
    expect(sent.filter((command) => command === 'abil')).toHaveLength(1);

    // A listing older than the act settles nothing; a newer one at the rank does.
    runner.onCharacter(listed(atSage, 1, clock - 10));
    expect(runner.running).toBe(true);
    clock += 100;
    runner.onCharacter(listed(atSage, 1, clock));
    expect(runner.running).toBe(false);
    expect(runner.progress.status).toBe('done');
    expect(questing).toEqual([true, false]);
    expect(published.at(-1)?.steps).toEqual([
      { block: 10, state: 'done', words: 'ask Sage hello' }
    ]);
  });

  /*
   * The reported night (2026-09-22, `logs/2026-09-21_23-47-38_festus.mudcap.jsonl`
   * t=2818844): a rest-next-door step-back was still unanswered when the run
   * asked for its next leg, `Walker.start` refused for that one moment, and
   * the whole quest ended on it. Festus then stood in a corridor until
   * morning. A refusal about *this instant* holds the run, never ends it.
   */
  it('holds the run when the walker refuses for a move in flight, and tries again', () => {
    let refusal: string | null = 'a move is already on the way';
    const runner = make({
      walk: (route) => {
        if (refusal !== null) return refusal;
        walked.push(route);
        return null;
      }
    });
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    expect(runner.running).toBe(true);
    expect(runner.progress.phase).toBe('held');
    expect(notices.at(-1)).toContain('Held up');
    expect(walked).toHaveLength(0);

    // Not a moment sooner than the clock says.
    clock += tuning().quests.retryMs - 1;
    runner.onCharacter(inRealm());
    expect(walked).toHaveLength(0);

    refusal = null;
    clock += 2;
    runner.onCharacter(inRealm());
    expect(walked).toHaveLength(1);
    expect(runner.progress.phase).toBe('walking');
  });

  it('gives up only after the setbacks run out, and says how many', () => {
    const runner = make({ walk: () => 'a move is already on the way' });
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    for (let tries = 0; tries < tuning().quests.setbacks + 1; tries += 1) {
      clock += tuning().quests.retryMs + 1;
      runner.onCharacter(inRealm());
    }
    expect(runner.running).toBe(false);
    expect(runner.progress.status).toBe('stopped');
    expect(runner.progress.reason).toContain('setbacks in a row');
  });

  /*
   * `maxLegs` is there for a way that will not work. A corridor of saracens
   * is a way that is *busy*, and six interruptions in one used to end a
   * quest that was getting there fine.
   */
  it('does not spend the leg budget on a fight', () => {
    const runner = make();
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    const fighting = {
      ...inRealm(),
      inCombat: true
    } as CharacterState;
    for (let round = 0; round < tuning().quests.maxLegs + 4; round += 1) {
      runner.onWalkEnded(false, null, fighting);
      expect(runner.progress.phase).toBe('walking');
      clock += 1000;
      runner.onCharacter(inRealm());
    }
    expect(runner.running).toBe(true);
    expect(walked.length).toBeGreaterThan(tuning().quests.maxLegs);
  });

  /*
   * The other half of the same night: `Supplies` considers the stock list
   * only while a lap runs, so a quest run never filled it and Festus reached
   * the saracens with no torch. The run asks per step, and the planner says
   * whether this leg is where it is worth the detour.
   */
  it('fills the stock list on the leg the planner names, and is done at its floor', () => {
    restock = {
      id: 55,
      name: 'torch',
      held: false,
      hand: false,
      count: 6,
      stock: 3,
      source: { how: 'buy', shops: ['General Store'], at: { room: '1/4' }, detour: 0 }
    };
    const runner = make();
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    expect(bought).toEqual(['torch']);
    expect(notices.some((line) => line.includes('Stocking up on torch'))).toBe(true);
    expect(walked).toHaveLength(0);

    // The counter had four of them, not six. The floor is what mattered.
    buying = false;
    runner.onCharacter(inRealm(['torch', 'torch', 'torch', 'torch']));
    expect(runner.running).toBe(true);
    expect(walked).toHaveLength(1);
    // And it is asked once for the step, not once per status line.
    runner.onCharacter(inRealm(['torch', 'torch', 'torch', 'torch']));
    expect(bought).toEqual(['torch']);
  });

  /*
   * Review, 2026-09-22: `Walker.stop` raises `ended` synchronously, so a
   * stall that stopped the walker while the phase was still `walking` was
   * read back as a leg to plan again — a second walk under a run that had
   * just announced it was held. The phase moves first.
   */
  it('does not start a second leg when it stops a stalled walk', () => {
    let walking = false;
    const runner = make({
      walk: (route) => {
        walked.push(route);
        walking = true;
        return null;
      },
      walking: () => walking,
      stopWalking: () => {
        walking = false;
        // The walker reports its ending inside the call, as it really does.
        runner.onWalkEnded(false, 'the walk stopped', inRealm());
      }
    });
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    expect(walked).toHaveLength(1);
    clock += tuning().quests.waitForMs + 1;
    runner.onCharacter(inRealm());
    expect(runner.progress.phase).toBe('held');
    expect(walked).toHaveLength(1);
  });

  it('times the leg from the last room reached, not from its start', () => {
    let walking = false;
    const runner = make({
      walk: (route) => {
        walked.push(route);
        walking = true;
        return null;
      },
      walking: () => walking
    });
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    // Nine minutes of walking, a room at a time: never stalled.
    for (let room = 2; room < 20; room += 1) {
      clock += tuning().quests.waitForMs / 2;
      here = `1/${room}`;
      runner.onCharacter(inRealm());
      expect(runner.progress.phase).toBe('walking');
    }
    // Standing in one room past the bound is.
    clock += tuning().quests.waitForMs + 1;
    runner.onCharacter(inRealm());
    expect(runner.progress.phase).toBe('held');
  });

  it('hears the player stop the walk while a shopping errand has the character', () => {
    restock = {
      id: 55,
      name: 'torch',
      held: false,
      hand: false,
      count: 6,
      stock: 3,
      source: { how: 'buy', shops: ['General Store'], at: { room: '1/4' }, detour: 0 }
    };
    const runner = make();
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    expect(bought).toEqual(['torch']);
    runner.onWalkEnded(false, 'you asked it to', inRealm());
    expect(runner.running).toBe(false);
    expect(runner.progress.reason).toContain('you asked it to');
  });

  /*
   * A top-up is the one row the quest does not want. A counter with nothing
   * on the shelf used to cost the run its whole setback budget and then the
   * quest itself.
   */
  it('carries on when the counter cannot fill a stock row', () => {
    restock = {
      id: 55,
      name: 'torch',
      held: false,
      hand: false,
      count: 6,
      stock: 3,
      source: { how: 'buy', shops: ['General Store'], at: { room: '1/4' }, detour: 0 }
    };
    const runner = make();
    expect(runner.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    buying = false;
    restock = null;
    runner.onCharacter(inRealm());
    expect(runner.running).toBe(true);
    expect(notices.some((line) => line.includes('Carrying on without torch'))).toBe(true);
    expect(walked).toHaveLength(1);
  });

  it('stands the monster it cannot fight down instead of waiting on it for ever', () => {
    const runner = make();
    here = '1/2';
    const atOrc = withHere(inRealm(), '1/2', ['Sage']);
    expect(
      runner.start(
        plan({ ...STEP_ONE, act: { verb: 'kill', mob: 'orc' } } as PlanStep),
        { ...QUEST, steps: [{ ...QUEST.steps[0]!, who: undefined, kill: 'orc' }] } as Quest,
        atOrc
      )
    ).toBeNull();
    const present = withHere(inRealm(), '1/2', ['orc']);
    runner.onCharacter(present);
    expect(runner.progress.phase).toBe('acting');
    clock += tuning().quests.waitForMs + 1;
    runner.onCharacter(present);
    expect(runner.progress.phase).toBe('held');
    expect(notices.at(-1)).toContain('nothing will fight it');
  });

  /*
   * The reported run (2026-09-21): the plan bought a waterskin against the
   * desert and `useWards` was off in the profile, so nothing would have
   * drunk it. A plan that bought a ward lends the switch for the run, and
   * every ending gives it back; a plan that bought none lends nothing.
   */
  it('lends the wards for a run whose plan bought one, and gives them back', () => {
    const skin: PlanStep = {
      ...STEP_TWO,
      items: [
        {
          id: 283,
          name: 'waterskin',
          held: false,
          hand: false,
          source: { how: 'buy', shops: ['General Store'], at: { room: '1/4' }, detour: 0 },
          count: 2,
          stops: 'desert spell'
        }
      ]
    };
    const runner = make();
    expect(runner.start(plan(skin), QUEST, inRealm())).toBeNull();
    expect(warding).toEqual([true]);
    runner.stop('enough');
    expect(warding).toEqual([true, false]);

    warding = [];
    const plain = make();
    plain.start(plan(STEP_ONE), QUEST, inRealm());
    plain.stop('enough');
    expect(warding).toEqual([false]);
  });

  it('stops out loud when the counter did not move on a step that does not roll', () => {
    const runner = make();
    here = '1/2';
    const atSage = withHere(inRealm(), '1/2', ['Sage']);
    runner.start(plan(STEP_ONE), QUEST, atSage);
    drain();
    expect(sent).toContain('ask Sage hello');
    clock += 100;
    runner.onCharacter(listed(atSage, 0, clock));
    expect(runner.running).toBe(false);
    expect(runner.progress.status).toBe('stopped');
    expect(runner.progress.reason).toContain('stayed at 0');
    expect(decisions.at(-1)?.refused).toContain('stayed at 0');
  });

  it('buys what the step wants first, then asks again while the roll fails, bounded', () => {
    const runner = make();
    here = '1/3';
    const atSmith = withHere(
      inRealm([], { abilities: { sums: { 134: 1 }, complete: true, at: 1 } }),
      '1/3',
      ['Smith']
    );
    runner.start(plan(STEP_TWO), QUEST, atSmith);
    // The torch is bought through the shopping errand before anything is said.
    expect(bought).toEqual(['torch']);
    expect(runner.progress.phase).toBe('fetching');
    expect(sent).not.toContain('ask Smith forge');

    // The pack holds it: the act goes out.
    buying = false;
    const holding = withHere(
      inRealm(['torch'], { abilities: { sums: { 134: 1 }, complete: true, at: 1 } }),
      '1/3',
      ['Smith']
    );
    runner.onCharacter(holding);
    drain();
    expect(sent.filter((command) => command === 'ask Smith forge')).toHaveLength(1);

    // The roll fails: each newer listing at the old rank asks again, up to the bound.
    const tries = tuning().quests.rollTries;
    for (let attempt = 1; attempt < tries; attempt += 1) {
      clock += 100;
      runner.onCharacter(listed(holding, 1, clock));
      drain();
      expect(runner.running).toBe(true);
      expect(sent.filter((command) => command === 'ask Smith forge')).toHaveLength(attempt + 1);
      expect(runner.progress.tries).toBe(attempt);
    }
    clock += 100;
    runner.onCharacter(listed(holding, 1, clock));
    expect(runner.running).toBe(false);
    expect(runner.progress.reason).toContain('never passed');
  });

  it('asks a script for an item the plan says is handed over, and reads the pack for it', () => {
    const step: PlanStep = {
      ...STEP_ONE,
      items: [
        {
          id: 77,
          name: 'heavy box',
          held: false,
          hand: true,
          source: { how: 'ask', who: 'Tolgard', say: 'favour', at: { room: '1/2', place: 'Hall' } }
        }
      ]
    };
    const runner = make();
    here = '1/2';
    const hall = withHere(inRealm(), '1/2', ['Master Trader Tolgard', 'Sage']);
    runner.start(plan(step), QUEST, hall);
    drain();
    // The handover first, spelled as the room lists him, and nothing else yet.
    expect(sent).toEqual(['ask Master Trader Tolgard favour']);
    expect(runner.progress.phase).toBe('fetching');
    expect(runner.progress.detail).toContain('heavy box');
    // The script's `giveitem` names nothing on the wire, so the pack is asked
    // for once the ask has gone out — nothing is concluded from silence.
    runner.onCharacter(hall);
    drain();
    expect(sent).toEqual(['ask Master Trader Tolgard favour', 'inventory']);
    // The listing answering it holds the box: on to the act.
    runner.noteListing('inventory');
    runner.onCharacter(withHere(inRealm(['heavy box']), '1/2', ['Master Trader Tolgard', 'Sage']));
    drain();
    expect(sent).toContain('ask Sage hello');
  });

  /*
   * Festus, 2026-09-23: Tolgard said *gives it to you*, the reply window ran
   * out with no listing asked for, and the run said the pack did not gain the
   * box and asked again. The next `i` showed it. Neither the window nor an
   * older listing is the answer; a listing asked for after the ask is.
   */
  it('never says the pack did not gain a handover without listing it first', () => {
    const step: PlanStep = {
      ...STEP_ONE,
      items: [
        {
          id: 77,
          name: 'heavy box',
          held: false,
          hand: true,
          source: { how: 'ask', who: 'Tolgard', say: 'favour', at: { room: '1/2', place: 'Hall' } }
        }
      ]
    };
    const runner = make();
    here = '1/2';
    const hall = withHere(inRealm(), '1/2', ['Master Trader Tolgard', 'Sage']);
    runner.start(plan(step), QUEST, hall);
    drain();
    runner.onCharacter(hall);
    drain();
    expect(sent.filter((command) => command === 'inventory')).toHaveLength(1);
    // The window passes with the listing unanswered: asked again, not concluded.
    clock += tuning().quests.replyMs + 1;
    runner.onCharacter(hall);
    drain();
    expect(sent.filter((command) => command === 'inventory')).toHaveLength(2);
    expect(runner.progress.phase).toBe('fetching');
    expect(notices.join('\n')).not.toContain('does not hold');
    // Somebody else's `i`, sent before the ask and answered after the run's
    // own went out, lists the pack as it was: not the answer.
    runner.noteListing('i');
    runner.onCharacter(hall);
    expect(runner.progress.phase).toBe('fetching');
    // The run's own listing, without the box: now it is a setback.
    runner.noteListing('inventory');
    runner.onCharacter(hall);
    expect(runner.progress.phase).toBe('held');
    expect(notices.at(-1)).toContain('heavy box was asked for, and the pack listed after it');
  });

  it('is put down by the player, walk and errands with it', () => {
    let stoppedWith: string | null = null;
    const runner = make({ stopWalking: (reason) => void (stoppedWith = reason) });
    runner.start(plan(STEP_ONE), QUEST, inRealm());
    expect(runner.running).toBe(true);
    runner.stop('you asked it to');
    expect(stoppedWith).toBe('you asked it to');
    expect(runner.running).toBe(false);
    expect(runner.progress.status).toBe('stopped');
    expect(notices.at(-1)).toContain('you asked it to');
  });

  it('names the run and each step for the banner, in the words the plan rows use', () => {
    const runner = make();
    const kill: PlanStep = { ...STEP_TWO, block: 12, act: { verb: 'kill', mob: 'orc' }, items: [] };
    const untraced: PlanStep = { ...STEP_TWO, block: 13, act: null, items: [] };
    expect(runner.start(plan(STEP_ONE, kill, untraced), QUEST, inRealm())).toBeNull();
    const progress = runner.progress;
    expect(progress.name).toBe('TestQuest');
    // The rank of the quest step the plan was asked for: block 13 is not a
    // quest step, so nothing states one.
    expect(progress.to).toBeNull();
    expect(progress.steps.map((step) => step.words)).toEqual(['ask Sage hello', 'kill orc', '#13']);
    expect(progress.steps.map((step) => step.state)).toEqual(['now', 'left', 'left']);
    // And a plan asked for a quest step names the rank it reaches.
    runner.stop('enough');
    const second = make();
    expect(second.start(plan(STEP_ONE), QUEST, inRealm())).toBeNull();
    expect(second.progress.to).toBe(1);
  });

  it('reads a step without a counter off a pack listed after the act', () => {
    const giving: Quest = {
      ...QUEST,
      steps: [{ ...QUEST.steps[0]!, gives: [{ kind: 'item', id: 88, name: 'blue sword' }] }]
    };
    const runner = make({ printsCounters: () => false });
    here = '1/2';
    const atSage = withHere(inRealm(), '1/2', ['Sage']);
    runner.start(plan(STEP_ONE), giving, atSage);
    drain();
    runner.onCharacter(atSage);
    drain();
    expect(sent).toEqual(['ask Sage hello', 'inventory']);
    // Silence past the reply window is not an unmoved pack.
    clock += tuning().quests.replyMs + 1;
    runner.onCharacter(atSage);
    expect(runner.running).toBe(true);
    runner.noteListing('inventory');
    runner.onCharacter(withHere(inRealm(['blue sword']), '1/2', ['Sage']));
    expect(runner.running).toBe(false);
    expect(runner.progress.status).toBe('done');
  });

  /*
   * The reviewer's case: the player's half-typed line holds the ask in the
   * queue, and the queue pushes its deadline back for as long. A lapse the run
   * read off its own clock set back at `expiresMs`, and the queue then sent
   * the ask anyway to a run no longer watching for it.
   */
  it('reads a handover lapse off the queue, never its own clock, and takes the ask back', () => {
    const step: PlanStep = {
      ...STEP_ONE,
      items: [
        {
          id: 77,
          name: 'heavy box',
          held: false,
          hand: true,
          source: { how: 'ask', who: 'Tolgard', say: 'favour', at: { room: '1/2', place: 'Hall' } }
        }
      ]
    };
    const runner = make();
    here = '1/2';
    const hall = withHere(inRealm(), '1/2', ['Master Trader Tolgard', 'Sage']);
    queue.noteTyping(true);
    runner.start(plan(step), QUEST, hall);
    drain();
    expect(sent).toEqual([]);
    clock += tuning().quests.expiresMs + 1;
    runner.onCharacter(hall);
    expect(runner.progress.phase).toBe('fetching');
    // The line committed: the ask goes out, once, and the pack is read after it.
    queue.noteTyping(false);
    drain();
    runner.onCharacter(hall);
    drain();
    expect(sent).toEqual(['ask Master Trader Tolgard favour', 'inventory']);

    // And a lapse the queue did make is one: dropped there, set back here.
    runner.stop('again');
    sent.length = 0;
    const second = make();
    queue.noteTyping(true);
    second.start(plan(step), QUEST, hall);
    queue.cancel(() => true);
    second.onCharacter(hall);
    expect(second.progress.phase).toBe('held');
    expect(notices.at(-1)).toContain('lapsed in the queue');
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual([]);
  });

  it('takes back a queued act when the run is set back', () => {
    const runner = make({ printsCounters: () => false });
    here = '1/2';
    const giving: Quest = {
      ...QUEST,
      steps: [{ ...QUEST.steps[0]!, gives: [{ kind: 'item', id: 88, name: 'blue sword' }] }]
    };
    queue.noteTyping(true);
    runner.start(plan(STEP_ONE), giving, withHere(inRealm(), '1/2', ['Sage']));
    runner.stop('enough');
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A step with an `adddelay` waits the delay before reading the pack, and the
   * wait for the listing is bounded from the first ask — measured from the
   * wire, a delay of a minute spent the whole bound before anything was asked.
   */
  it('asks for the pack after a long script delay rather than giving up unasked', () => {
    const giving: Quest = {
      ...QUEST,
      steps: [
        {
          ...QUEST.steps[0]!,
          delaySeconds: 60,
          gives: [{ kind: 'item', id: 88, name: 'blue sword' }]
        }
      ]
    };
    const runner = make({ printsCounters: () => false });
    here = '1/2';
    const atSage = withHere(inRealm(), '1/2', ['Sage']);
    runner.start(plan(STEP_ONE), giving, atSage);
    drain();
    expect(sent).toEqual(['ask Sage hello']);
    clock += 60_000 + 1;
    runner.onCharacter(atSage);
    drain();
    expect(sent).toEqual(['ask Sage hello', 'inventory']);
    expect(runner.progress.phase).not.toBe('held');
    runner.noteListing('inventory');
    runner.onCharacter(withHere(inRealm(['blue sword']), '1/2', ['Sage']));
    expect(runner.progress.status).toBe('done');
  });

  it('refuses a step the realm prints no counter for and that leaves no evidence', () => {
    const runner = make({ printsCounters: () => false });
    here = '1/2';
    const atSage = withHere(inRealm(), '1/2', ['Sage']);
    runner.start(plan(STEP_ONE), QUEST, atSage);
    drain();
    expect(sent).toContain('ask Sage hello');
    // Nothing watched, nothing in the pack to move: after the reply window it is said.
    clock += tuning().quests.replyMs + 1;
    runner.onCharacter(atSage);
    expect(runner.running).toBe(false);
    expect(runner.progress.reason).toContain('nothing on this realm says');
  });
});
