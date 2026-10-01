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
import type { KonamiActivity, KonamiRecords } from '../../../../shared/konamiRecords';
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
        const answers = {};
        for (const [name, q] of Object.entries(request.questions)) {
          answers[name] = q.type === 'noul'
            ? { type: 'noul', noul: 0.9 }
            : { type: 'choice', choice: name === 'goal' ? goal : Object.keys(q.criteria)[0], confidence: 0.6, probabilities: name === 'goal' ? { [goal]: 0.6, wait: 0.3 } : {} };
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
    cash: { total: 0 },
    spells: [],
    stats: {}
  },
  settings: { attack: 'aa' },
  history: [],
  hunting: {
    spots: [
      {
        key: 'lair:a',
        name: 'fierce zombie',
        exp: { perHour: 9000, ceilingPerHour: null, perCycle: 300 },
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

function planner(): KonamiPlanner {
  const facts: PlannerFacts = {
    state: () => state,
    brief: (_now, lessons) => {
      briefLessons.push(lessons);
      if (briefRefusal !== null) return { refusal: briefRefusal };
      const made = structuredClone(BRIEF);
      made.hunting.excluded = { ...NO_EXCLUSIONS, unsimulated };
      if (trainReady) Object.assign(made.character, { levelReady: true, trainCost: 0 });
      return made;
    },
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

const global = globalThis as { __konamiGoal?: string; __konamiAsked?: number };

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
  global.__konamiGoal = 'hunt_0';
  global.__konamiAsked = 0;
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
    expect(it.exchange(id)?.request.questions).toHaveProperty('goal');
    it.dispose();
  });

  it('writes a death log with the fight in it, and asks again', async () => {
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

  it('writes a stuck log when standing still brings back the same plan', async () => {
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
    await asked(2);
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

  it('ends a training plan the trip refuses, and asks again', async () => {
    global.__konamiGoal = 'train';
    trainReady = true;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    expect(it.snapshot().plan?.goal).toEqual({ kind: 'train' });
    trainRefusal = { why: 'the purse does not cover it', at: Date.now() };
    global.__konamiGoal = 'wait';
    it.onCharacter(state);
    await asked(2);
    expect(it.snapshot().decisions[1]?.outcome).toBe('refused');
    expect(learned.at(-1)).toMatchObject({ outcome: 'refused', goal: { kind: 'train' } });
    it.dispose();
  });

  it('keeps a training plan whose trip refused before it was chosen', async () => {
    global.__konamiGoal = 'train';
    trainReady = true;
    trainRefusal = { why: 'no cash, an hour ago', at: Date.now() - 3_600_000 };
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    it.onCharacter(state);
    await settle();
    expect(it.snapshot().decisions[0]?.outcome).toBe('applied');
    it.dispose();
  });

  it('ends a training plan whose trip never sets off, saying nothing', async () => {
    global.__konamiGoal = 'train';
    trainReady = true;
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    global.__konamiGoal = 'wait';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.trainStartMs + 1 });
    it.onCharacter(state);
    vi.useRealTimers();
    await asked(2);
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

  it('reviews a plan still running after the review interval', async () => {
    const it = planner();
    it.configure(on(providerFile()));
    await loaded(it);
    it.onCharacter(state);
    await asked(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + tuning().konami.reviewMs + 1 });
    (it as unknown as { tick(): void }).tick();
    vi.useRealTimers();
    await asked(2);
    expect(it.snapshot().decisions[0]?.trigger).toBe('review');
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
