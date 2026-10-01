import fs from 'node:fs';
import { tuning } from '../../../app/tuning';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Block } from '../../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../../shared/config';
import type { KonamiBrief } from '../../../../shared/konamiBrief';
import { NO_EXCLUSIONS } from '../../../../shared/hunting';
import type { KonamiLesson } from '../../../../shared/konamiLessons';
import type { HistoryEntry } from '../../../../shared/konamiHistory';
import type { KonamiActivity, KonamiRecords } from '../../../../shared/konamiRecords';
import type { RoadFacts, RoadMark } from '../../../../shared/konamiRoad';
import { damageReport, lastFight } from '../incident';
import { KonamiPlanner, type PlannerFacts, type PlannerHands } from '../KonamiPlanner';

/** A provider on disk, as the player's would be: it answers the goal from `globalThis`. */
function providerFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konami-'));
  const file = path.join(dir, 'provider.mjs');
  fs.writeFileSync(
    file,
    `export const provider = {
      name: 'test provider',
      async ask(request) {
        const goal = globalThis.__konamiGoal ?? 'hunt_0';
        globalThis.__konamiAsked = (globalThis.__konamiAsked ?? 0) + 1;
        if (globalThis.__konamiFail) throw new Error('400 max_tokens_exceeded');
        const answers = {};
        for (const [name, q] of Object.entries(request.questions)) {
          answers[name] = q.type === 'noul'
            ? { type: 'noul', noul: 0.9 }
            : { type: 'choice', choice: name === 'goal' ? goal : (globalThis.__konamiChoices?.[name] ?? Object.keys(q.criteria)[0]), confidence: 0.6, probabilities: name === 'goal' ? { [goal]: 0.6, wait: 0.3 } : {} };
        }
        return { model: 'test', answers };
      }
    };`
  );
  return file;
}

const BRIEF = {
  at: 0,
  character: {
    level: 3,
    exp: 0,
    hpMax: 100,
    armourClass: 0,
    levelReady: false,
    trainCost: null,
    cash: { onHand: 0, banks: [], total: 0 },
    spells: [],
    stats: {},
    worn: []
  },
  settings: { attack: 'aa' },
  history: [],
  hunting: {
    spots: [
      {
        key: 'lair:a',
        name: 'fierce zombie',
        exp: { perHour: 9000, ceilingPerHour: null, perCycle: 300 },
        cash: { perHour: null },
        survival: { worstShare: 0.1 },
        steps: 3,
        fight: null,
        route: null,
        history: [],
        mobs: []
      }
    ],
    leftOut: []
  },
  gear: [],
  attacks: [],
  openers: [],
  canSneak: false
} as unknown as KonamiBrief;

function inRealm(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 1 },
    vitals: { ...base.vitals, hp: 100, hpMax: 100 },
    progress: { ...base.progress, level: 3 },
    inventory: { ...base.inventory, wealth: 0 },
    ...over
  };
}

const block = (type: string, groups: Record<string, string> = {}, at = Date.now()): Block =>
  ({ type, groups, text: `${type} line`, at }) as unknown as Block;

let state: CharacterState;
let steered: Array<string | null | undefined>;
let relayers: number;
let journal: string[];
let incidents: Array<{ kind: string; files: Record<string, string> }>;
let hunting: boolean;
let logged: string[];
let briefRefusal: string | null;
let learned: KonamiLesson[];
let unsimulated: number;
let briefLessons: KonamiLesson[][];
let activity: KonamiActivity | null;
let trainRefusal: { why: string; at: number } | null;
let trainReady: boolean;
let written: HistoryEntry[];
/** A road from level 3: one ground, a table to level 5, training at 100 copper. */
const ROAD: RoadFacts = {
  thresholds: [
    { level: 4, exp: 1_000 },
    { level: 5, exp: 3_000 }
  ],
  trainCosts: [
    { level: 3, copper: 100 },
    { level: 4, copper: 150 }
  ],
  grounds: [{ key: 'lair:a', name: 'fierce zombie', expPerHour: 9000, copperPerHour: 500 }],
  gear: []
};

/** A second ground beside the zombie's, so a brief without the first still asks. */
const secondGround = (brief: KonamiBrief): void => {
  brief.hunting.spots.push({ ...brief.hunting.spots[0]!, key: 'lair:b', name: 'orc' });
};

/** What the road is projected from, and the marks written to disk. */
let roadFacts: RoadFacts | null;
let marks: RoadMark[];
/** A change to the brief each ask builds, or null. */
let briefPatch: ((brief: KonamiBrief) => void) | null;

function planner(): KonamiPlanner {
  const facts: PlannerFacts = {
    state: () => state,
    brief: (_now, lessons) => {
      briefLessons.push(lessons);
      if (briefRefusal !== null) return { refusal: briefRefusal };
      const made = structuredClone(BRIEF);
      made.history = lessons;
      made.hunting.excluded = { ...NO_EXCLUSIONS, unsimulated };
      if (trainReady) Object.assign(made.character, { levelReady: true, trainCost: 0 });
      briefPatch?.(made);
      return made;
    },
    road: () => roadFacts,
    busy: () => false,
    hunting: () => hunting,
    buying: () => false,
    huntRefusal: () => null,
    trainRefusal: () => trainRefusal,
    refusals: () => ['hunt: no route'],
    realm: () => 'orohost:2427',
    activity: () => activity
  };
  const hands: PlannerHands = {
    steerHunt: (key) => steered.push(key),
    buy: () => null,
    wear: () => {},
    relayer: () => {
      relayers += 1;
    }
  };
  const records: KonamiRecords = {
    journal: (line) => journal.push(line),
    incident: (kind, _at, files) => {
      incidents.push({ kind, files: { ...files } });
      return `/tmp/${kind}`;
    },
    recentLines: () => 'the last lines',
    log: (text) => logged.push(text),
    logPath: '/tmp/konami.log',
    lesson: (row) => learned.push(row),
    lessons: () => [...learned],
    rewriteLessons: (rows) => {
      learned = [...rows];
    },
    historyLine: (entry) => void written.push(entry),
    history: () => [],
    roadMarks: () => [...marks],
    rewriteRoadMarks: (rows) => {
      marks = [...rows];
    }
  };
  return new KonamiPlanner(facts, hands, { changed: () => {}, notice: () => {} }, records, null);
}

const on = (file: string): AutomationConfig => ({
  ...DEFAULT_CONFIG.automation,
  superKonamiMode: true,
  konamiProviderPath: file
});

/** Lets the provider's promise and the loader's import settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Until the loader has an answer: a provider, or why there is none. */
async function loaded(it: KonamiPlanner): Promise<void> {
  await vi.waitFor(() => {
    const { provider, refusal } = it.snapshot();
    expect(provider !== null || refusal !== null).toBe(true);
  });
}

/** Until the provider has been asked `times` and its answer applied. */
async function asked(times: number): Promise<void> {
  await vi.waitFor(() => expect(global.__konamiAsked).toBe(times));
  await settle();
}

/** Until `count` decisions are listed, asked or decided here. */
async function decided(it: KonamiPlanner, count: number): Promise<void> {
  await vi.waitFor(() => expect(it.snapshot().decisions).toHaveLength(count));
  await settle();
}

const global = globalThis as {
  __konamiFail?: boolean;
  __konamiGoal?: string;
  __konamiAsked?: number;
  __konamiChoices?: Record<string, string>;
};

beforeEach(() => {
  state = inRealm();
  steered = [];
  relayers = 0;
  journal = [];
  incidents = [];
  hunting = false;
  logged = [];
  briefRefusal = null;
  learned = [];
  unsimulated = 0;
  briefLessons = [];
  activity = null;
  trainRefusal = null;
  trainReady = false;
  written = [];
  global.__konamiGoal = 'hunt_0';
  global.__konamiChoices = {};
  briefPatch = null;
  roadFacts = null;
  marks = [];
  global.__konamiAsked = 0;
  global.__konamiFail = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the planner', () => {
  it('loads the provider, asks on entering the realm, and steers the hunt to the answer', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    expect(steered).toContain('lair:a');
    expect(relayers).toBe(1);
    expect(it.snapshot().plan?.goal).toEqual({
      kind: 'hunt',
      key: 'lair:a',
      name: 'fierce zombie'
    });
    expect(journal.some((line) => JSON.parse(line).kind === 'decision')).toBe(true);
    it.dispose();
  });

  it('says why it cannot run when no provider is found, and asks nothing', async () => {
    const it = planner();
    it.configure(on('/nowhere/provider.mjs'));
    await loaded(it);
    it.onCharacter(state);
    await settle();
    expect(it.snapshot().provider).toBeNull();
    expect(global.__konamiAsked).toBe(0);
  });

  it('waits out a fight before it asks', async () => {
    state = inRealm({ inCombat: true });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(0);
    expect(it.snapshot().pending).toBe('entered');
    state = inRealm();
    it.onCharacter(state);
    await asked(1);
    it.dispose();
  });

  it('waits for the stats and the inventory before asking on entering the realm', async () => {
    state = inRealm({ inventory: { ...EMPTY_CHARACTER.inventory, wealth: null } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(0);
    state = inRealm();
    it.onCharacter(state);
    await asked(1);
    it.dispose();
  });

  it('keeps the trigger when no brief can be built yet, and asks once one can', async () => {
    briefRefusal = 'not placed';
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(0);
    expect(it.snapshot().pending).toBe('entered');
    briefRefusal = null;
    it.onCharacter(state);
    await settle();
    // Not built again on every statline: after a tick.
    expect(global.__konamiAsked).toBe(0);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6_000 });
    it.onCharacter(state);
    vi.useRealTimers();
    await asked(1);
    it.dispose();
  });

  it('asks again when what is worn changes', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    state = inRealm({
      inventory: {
        ...state.inventory,
        items: [{ name: 'quarterstaff', equipped: true, slot: 'Weapon Hand' } as never]
      }
    });
    it.onCharacter(state);
    await asked(2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('gear');
    it.dispose();
  });

  it('writes what it sent and what came back to the running log', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    const text = logged.join('\n');
    expect(text).toContain('"questions"');
    expect(text).toContain('"answers"');
    expect(it.snapshot().log).toBe('/tmp/konami.log');
    const id = it.snapshot().decisions[0]!.id;
    expect(it.exchange(id)?.request?.questions).toHaveProperty('goal');
    it.dispose();
  });

  /* Todo 76: a ground that killed is not offered again until five levels past the death. */
  it('never offers the ground that killed it, the next brief on', async () => {
    briefPatch = secondGround;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.onBlock(block('user-dies'));
    await asked(2);
    const sent = JSON.parse(journal.at(-1)!) as {
      sent: { questions: { goal: { criteria: object } } };
    };
    const offered = JSON.stringify(sent.sent.questions.goal.criteria);
    expect(offered).not.toContain('lair:a');
    expect(offered).toContain('lair:b');
    it.dispose();
  });

  it('writes a death log with the fight in it, and asks again', async () => {
    briefPatch = secondGround;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.onBlock(block('user-hits', { target: 'you', attacker: 'fierce zombie', damage: '12' }));
    it.onBlock(block('user-dies'));
    expect(incidents.map((row) => row.kind)).toEqual(['death']);
    const fight = JSON.parse(incidents[0]!.files['fight.json']!);
    expect(fight.fight.taken).toBe(12);
    expect(incidents[0]!.files['session.log']).toBe('the last lines');
    await asked(2);
    expect(it.snapshot().decisions.map((row) => row.trigger)).toEqual(['death', 'entered']);
    it.dispose();
  });

  it('waits for the simulator to run the lairs before it asks', async () => {
    unsimulated = 40;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(0);
    expect(it.snapshot().pending).toBe('entered');
    unsimulated = 0;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6_000 });
    it.onCharacter(state);
    vi.useRealTimers();
    await asked(1);
    it.dispose();
  });

  it('keeps what a death came to, killers named, and sends it with the next brief', async () => {
    briefPatch = secondGround;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.onBlock(block('user-hits', { target: 'you', attacker: 'fierce bandit', damage: '12' }));
    it.onBlock(block('user-dies'));
    await asked(2);
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({
      outcome: 'died',
      killers: ['fierce bandit'],
      level: 3,
      goal: { kind: 'hunt', key: 'lair:a' }
    });
    expect(briefLessons.at(-1)).toHaveLength(1);
    it.dispose();
  });

  /* Soul, 2026-10-01: asked every 50 seconds, each same answer had ended a hunt of a minute. */
  it('learns one stretch from a goal given back, not one per ask', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    it.onCharacter(state);
    await asked(1);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    it.onBlock(block('user-levels'));
    await asked(2);
    expect(learned).toEqual([]);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    global.__konamiGoal = 'wait';
    it.onBlock(block('user-levels'));
    await asked(3);
    vi.useRealTimers();
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ outcome: 'replaced', goal: { key: 'lair:a' }, minutes: 20 });
    it.dispose();
  });

  it('learns the whole stretch of a goal given back when it ends in a death', async () => {
    briefPatch = secondGround;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    it.onCharacter(state);
    await asked(1);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    it.onBlock(block('user-levels'));
    await asked(2);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    it.onBlock(block('user-dies'));
    await asked(3);
    vi.useRealTimers();
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ outcome: 'died', minutes: 20 });
    it.dispose();
  });

  it('shows the odds on every goal offered, with what it was told about each spot', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    const [chosen, other] = it.snapshot().decisions[0]!.options;
    expect(chosen).toMatchObject({ goal: { kind: 'hunt', key: 'lair:a' }, p: 0.6, chosen: true });
    expect(chosen!.spot).not.toBeNull();
    expect(other).toMatchObject({ goal: { kind: 'wait' }, p: 0.3, chosen: false, spot: null });
    it.dispose();
  });

  it('turns the plan down when the player says no, remembers it, and asks again', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.veto();
    expect(steered.at(-1)).toBeNull();
    expect(it.snapshot().plan).toBeNull();
    await asked(2);
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ outcome: 'vetoed', goal: { key: 'lair:a' } });
    const [now, before] = it.snapshot().decisions;
    expect(now!.trigger).toBe('vetoed');
    expect(before!.outcome).toBe('vetoed');
    expect(briefLessons.at(-1)).toHaveLength(1);
    expect(it.snapshot().lessons[0]!.applies).toBe(true);
    it.dispose();
  });

  it('goes where the player chooses instead, and remembers the answer turned down', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.choose('wait');
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'wait' });
    expect(steered.at(-1)).toBeNull();
    const [now, before] = it.snapshot().decisions;
    expect(now).toMatchObject({ trigger: 'chosen', outcome: 'applied' });
    expect(now!.options.find((option) => option.chosen)?.goal).toEqual({ kind: 'wait' });
    expect(before!.outcome).toBe('vetoed');
    expect(learned[0]).toMatchObject({ outcome: 'vetoed', goal: { key: 'lair:a' } });
    expect(global.__konamiAsked).toBe(1);
    it.dispose();
  });

  it('forgets a lesson the player forgets, on disk and in what is sent', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.veto();
    await asked(2);
    it.forget(learned[0]!.at);
    expect(learned).toEqual([]);
    expect(it.snapshot()).toMatchObject({ lessons: [], lessonsKept: 0 });
    it.dispose();
  });

  it('writes a stuck log, and asks nothing, when standing still changes nothing to decide', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.onCharacter(state);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: Date.now() });
    // The interval was armed on real timers; the stuck clock reads `Date`.
    vi.setSystemTime(Date.now() + 35_000);
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await vi.waitFor(() => expect(incidents).toHaveLength(1));
    expect(global.__konamiAsked).toBe(1);
    expect(it.snapshot().decisions).toHaveLength(1);
    expect(incidents.map((row) => row.kind)).toEqual(['stuck']);
    expect(JSON.parse(incidents[0]!.files['refusals.json']!)).toEqual(['hunt: no route']);
    it.dispose();
  });

  it('shows what the goal is doing, trainer and room named, while the plan runs', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    activity = {
      doing: { kind: 'train', trainer: 'Gyrd', room: 'Newhaven Guild', copper: 0, training: false },
      walk: { done: 3, total: 12 }
    };
    expect(it.snapshot().activity).toEqual(activity);
    it.togglePause();
    expect(it.snapshot().activity).toBeNull();
    it.dispose();
  });

  it('trains a level that is ready without asking, since nothing else is offered', async () => {
    trainReady = true;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await decided(it, 1);
    expect(global.__konamiAsked).toBe(0);
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'train' });
    const id = it.snapshot().decisions[0]!.id;
    expect(it.exchange(id)?.request).toBeNull();
    it.dispose();
  });

  it('ends a training plan the trip refuses, and asks again', async () => {
    trainReady = true;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await decided(it, 1);
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'train' });
    trainRefusal = { why: 'the purse does not cover it', at: Date.now() };
    global.__konamiGoal = 'wait';
    it.onCharacter(state);
    await asked(1);
    expect(it.snapshot().decisions[1]?.outcome).toBe('refused');
    expect(learned.at(-1)).toMatchObject({ outcome: 'refused', goal: { kind: 'train' } });
    it.dispose();
  });

  it('keeps a training plan whose trip refused before it was chosen', async () => {
    trainReady = true;
    trainRefusal = { why: 'no cash, an hour ago', at: Date.now() - 3_600_000 };
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await decided(it, 1);
    it.onCharacter(state);
    await settle();
    expect(it.snapshot().decisions[0]?.outcome).toBe('applied');
    it.dispose();
  });

  it('ends a training plan whose trip never sets off, saying nothing', async () => {
    trainReady = true;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await decided(it, 1);
    global.__konamiGoal = 'wait';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.trainStartMs + 1 });
    it.onCharacter(state);
    vi.useRealTimers();
    await asked(1);
    expect(it.snapshot().decisions[1]?.outcome).toBe('refused');
    it.dispose();
  });

  it('asks again the moment a level becomes ready to train', async () => {
    state = inRealm({ progress: { ...inRealm().progress, expNeeded: 100 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    state = inRealm({ progress: { ...inRealm().progress, expNeeded: 0 } });
    it.onCharacter(state);
    await asked(2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('ready');
    it.dispose();
  });

  /* Todo 63: Soul at level 2, 0 copper and training at 50. */
  it('saves for the trainer, asks the hunt for the copper, and asks again once it is carried', async () => {
    briefPatch = (made) => Object.assign(made.character, { levelReady: true, trainCost: 50 });
    global.__konamiChoices = { saveFor: 'train', saveWithin: 'hours_1' };
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    expect(it.snapshot().decisions[0]?.plan).toMatchObject({
      layer: { cashPerHour: 50 },
      saving: { copper: 50, carried: true }
    });
    state = inRealm({ inventory: { ...inRealm().inventory, wealth: 49 } });
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(1);
    state = inRealm({ inventory: { ...inRealm().inventory, wealth: 55 } });
    it.onCharacter(state);
    await asked(2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('saved');
    it.dispose();
  });

  it('reviews a plan still running after the review interval, only when something changed', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    const review = tuning().konami.reviewMs;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + review + 1 });
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await settle();
    expect(global.__konamiAsked).toBe(1);
    expect(it.snapshot().decisions).toHaveLength(1);
    expect(it.snapshot().pending).toBeNull();
    // A second spot is something new to decide between.
    briefPatch = (brief) =>
      brief.hunting.spots.push({ ...brief.hunting.spots[0]!, key: 'lair:b', name: 'orc' });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * review + 2 });
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await asked(2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('review');
    it.dispose();
  });

  it('keeps the plan in hand when an ask fails, and asks again after the back-off', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    global.__konamiFail = true;
    it.askNow();
    await asked(2);
    const [failed, standing] = it.snapshot().decisions;
    expect(failed?.outcome).toBe('failed');
    expect(standing?.outcome).toBe('applied');
    expect(it.snapshot().plan?.goal).toMatchObject({ kind: 'hunt', key: 'lair:a' });
    expect(it.snapshot().pending).toBe('asked');
    global.__konamiFail = false;
    // Not before the back-off,
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(2);
    // and once it has run out.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.retryMs + 1 });
    it.onCharacter(state);
    vi.useRealTimers();
    await asked(3);
    expect(it.snapshot().decisions[0]?.outcome).toBe('applied');
    it.dispose();
  });

  it('trains a level the moment it is paid for, even while a failed ask waits', async () => {
    state = inRealm({ progress: { ...inRealm().progress, expNeeded: 100 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    global.__konamiFail = true;
    it.askNow();
    await asked(2);
    expect(it.snapshot().decisions[0]?.outcome).toBe('failed');
    trainReady = true;
    state = inRealm({ progress: { ...inRealm().progress, expNeeded: 0 } });
    it.onCharacter(state);
    await decided(it, 3);
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'train' });
    expect(global.__konamiAsked).toBe(2);
    it.dispose();
  });

  it('draws the road ahead from the facts a brief gathered', async () => {
    roadFacts = ROAD;
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    const road = it.snapshot().road;
    expect(road?.steps[0]).toMatchObject({ kind: 'hunt', goal: { key: 'lair:a' } });
    it.dispose();
  });

  it('never offers a ground declined on the road again, and keeps the no on disk', async () => {
    // The road goes to the orc's ground while the plan hunts the zombie's.
    roadFacts = {
      ...ROAD,
      grounds: [{ key: 'lair:b', name: 'orc', expPerHour: 9000, copperPerHour: 500 }]
    };
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    briefPatch = (brief) =>
      brief.hunting.spots.push({ ...brief.hunting.spots[0]!, key: 'lair:b', name: 'orc' });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.decline('hunt:lair:b', false);
    expect(marks.map((mark) => mark.key)).toEqual(['hunt:lair:b']);
    expect(learned).toHaveLength(0);
    it.askNow();
    await asked(2);
    const sent = JSON.parse(journal.at(-1)!) as {
      sent: { questions: { goal: { criteria: object } } };
    };
    expect(JSON.stringify(sent.sent.questions.goal.criteria)).not.toContain('lair:b');
    it.restore('hunt:lair:b');
    expect(marks).toEqual([]);
    it.dispose();
  });

  it('turns the plan in hand down when its goal is marked bad, and plans without it', async () => {
    roadFacts = ROAD;
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.decline('hunt:lair:a', true);
    // Its one ground gone, waiting is all that is left: decided here, nothing asked.
    await decided(it, 2);
    expect(global.__konamiAsked).toBe(1);
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'wait' });
    expect(marks[0]).toMatchObject({ key: 'hunt:lair:a', bad: true });
    expect(learned.at(-1)).toMatchObject({ outcome: 'vetoed', goal: { key: 'lair:a' } });
    expect(it.snapshot().decisions[1]?.outcome).toBe('vetoed');
    it.dispose();
  });

  it('drops the goal in hand when it is only declined, telling the provider nothing', async () => {
    roadFacts = ROAD;
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.decline('hunt:lair:a', false);
    await decided(it, 2);
    expect(learned).toHaveLength(0);
    expect(marks[0]).toMatchObject({ key: 'hunt:lair:a', bad: false });
    it.dispose();
  });

  it('draws no road from a purse not yet read', async () => {
    roadFacts = ROAD;
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    state = inRealm({ inventory: { ...inRealm().inventory, wealth: null } });
    marks = [];
    expect(it.snapshot().road?.steps ?? []).toEqual([]);
    it.dispose();
  });

  it('keeps a goal marked bad further down the road as a lesson at its level', () => {
    roadFacts = ROAD;
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    const it = planner();
    (it as unknown as { road: { learn(facts: RoadFacts): void } }).road.learn(ROAD);
    it.decline('hunt:lair:a', true);
    expect(learned.at(-1)).toMatchObject({ outcome: 'vetoed', level: 3 });
    it.dispose();
  });

  /* Todo 77: gear the purse covers is bought without asking the provider. */
  it('buys an upgrade it can afford without asking', async () => {
    briefPatch = (brief) => {
      Object.assign(brief.character, { cash: { onHand: 100, banks: [], total: 100 } });
      brief.gear = [
        {
          slot: 'Hands',
          worn: null,
          wornFigure: null,
          wornDr: null,
          ranking: 'armour',
          offers: [
            {
              item: 7,
              name: 'cotton gloves',
              figure: 10,
              ac: 10,
              dr: null,
              minLevel: null,
              shop: 'Leatherworks',
              at: { map: 1, room: 5 },
              moves: 3,
              copper: 40
            }
          ]
        }
      ];
    };
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await decided(it, 1);
    expect(global.__konamiAsked).toBe(0);
    expect(it.snapshot().plan?.goal).toMatchObject({ kind: 'buy', name: 'cotton gloves' });
    it.dispose();
  });

  /* Todo 78: about 500 an hour at a ground chosen at 4,400, and nothing noticed. */
  it('asks again when the hunt pays far under what it was chosen on', async () => {
    hunting = true;
    state = inRealm({ progress: { ...inRealm().progress, exp: 0 } });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.onCharacter(state);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await asked(2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('underpaid');
    it.dispose();
  });

  it('decides training once the copper it costs is carried, without asking', async () => {
    briefPatch = (brief) =>
      Object.assign(brief.character, {
        levelReady: true,
        trainCost: 50,
        cash: { onHand: state.inventory.wealth, banks: [], total: state.inventory.wealth }
      });
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    expect(it.snapshot().plan?.goal.kind).toBe('hunt');
    state = inRealm({ inventory: { ...inRealm().inventory, wealth: 60 } });
    it.onCharacter(state);
    await decided(it, 2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('train-affordable');
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'train' });
    expect(global.__konamiAsked).toBe(1);
    it.dispose();
  });

  it('does not review again while an ask is still waiting for its answer', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.reviewMs + 1 });
    const inner = it as unknown as { tick(): void; asking: boolean };
    inner.asking = true;
    inner.tick();
    vi.useRealTimers();
    await settle();
    expect(global.__konamiAsked).toBe(1);
    it.dispose();
  });

  it('asks nothing while automation is switched off, says so, and asks once it is on', async () => {
    const it = planner();
    it.configure({ ...on(providerFile()), enabled: false });
    await loaded(it);
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(0);
    expect(it.snapshot().automation).toBe(false);
    it.configure(on(providerFile()));
    it.onCharacter(state);
    await asked(1);
    it.dispose();
  });

  it('is not stuck while it hunts at the spot between respawns', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    activity = { doing: { kind: 'hunt', walking: false, place: 'Small Cavern' }, walk: null };
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.stuckMs + 1 });
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await settle();
    expect(global.__konamiAsked).toBe(1);
    it.dispose();
  });

  /* Soul, 2026-10-01: a lap the hunt waited on, asked about every 50 seconds for six hours. */
  it('is not stuck while a lap runs that the hunt waits on', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    activity = { doing: { kind: 'waiting', on: 'lap' }, walk: null };
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.stuckMs + 1 });
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await settle();
    expect(global.__konamiAsked).toBe(1);
    it.dispose();
  });

  it('keeps a history of the hunt it went on and what it paid', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    activity = { doing: { kind: 'hunt', walking: false, place: 'Small Cavern' }, walk: null };
    state = inRealm({ progress: { ...inRealm().progress, exp: 100 } });
    it.onCharacter(state);
    activity = null;
    state = inRealm({ progress: { ...inRealm().progress, exp: 700 } });
    it.onCharacter(state);
    expect(written.map((entry) => entry.event)).toEqual([
      { kind: 'huntStarted', place: 'Small Cavern' },
      { kind: 'hunted', place: 'Small Cavern', minutes: 0, exp: 600 }
    ]);
    expect(it.snapshot().history[0]?.event.kind).toBe('hunted');
    it.dispose();
  });

  it('pauses when the player stops the walk, rather than planning the next one', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.playerStopped();
    expect(it.snapshot().paused).toBe(true);
    it.onCharacter(state);
    await settle();
    expect(global.__konamiAsked).toBe(1);
    it.dispose();
  });

  it('takes its settings off, and gives the hunt back, when paused', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    expect(it.over(on('x')).hunting.enabled).toBe(true);
    it.togglePause();
    expect(steered.at(-1)).toBeUndefined();
    expect(it.over(on('x'))).toEqual(on('x'));
    it.dispose();
  });
});

describe('the fight a death log reports', () => {
  it('is the blows back to the last quiet minute, weighed against the prediction', () => {
    const blows = [
      { at: 0, from: 'orc', damage: 5, text: '' },
      { at: 200_000, from: 'fierce zombie', damage: 10, text: '' },
      { at: 205_000, from: 'fierce zombie', damage: 14, text: '' }
    ];
    const fight = lastFight(blows, 60_000);
    expect(fight).toHaveLength(2);
    const report = damageReport(
      fight,
      {
        key: 'lair:a',
        mobs: [{ name: 'fierce zombie', perRound: 6 }],
        survival: { worstDamagePerRoom: 12, damagePerRoom: 10, worstShare: 0.1, unknown: [] }
      } as unknown as KonamiBrief['hunting']['spots'][number],
      100,
      5
    );
    expect(report.fight).toMatchObject({ taken: 24, rounds: 1 });
    expect(report.attackers).toEqual([
      { name: 'fierce zombie', blows: 2, damage: 24, perRound: 24, predictedPerRound: 6 }
    ]);
    expect(report.predicted?.worstDamagePerRoom).toBe(12);
  });
});
