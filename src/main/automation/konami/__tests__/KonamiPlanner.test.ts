import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Block } from '../../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../../shared/config';
import type { KonamiBrief } from '../../../../shared/konamiBrief';
import type { KonamiRecords } from '../../../../shared/konamiRecords';
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
            : { type: 'choice', choice: name === 'goal' ? goal : Object.keys(q.criteria)[0], confidence: 0.6, probabilities: {} };
        }
        return { model: 'test', answers };
      }
    };`
  );
  return file;
}

const BRIEF = {
  at: 0,
  character: { levelReady: false, cash: { total: 0 }, spells: [], stats: {} },
  hunting: {
    spots: [
      {
        key: 'lair:a',
        name: 'fierce zombie',
        exp: { perHour: 9000, ceilingPerHour: null, perCycle: 300 },
        survival: { worstShare: 0.1 },
        steps: 3,
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

function planner(): KonamiPlanner {
  const facts: PlannerFacts = {
    state: () => state,
    brief: () => structuredClone(BRIEF),
    busy: () => false,
    hunting: () => hunting,
    buying: () => false,
    huntRefusal: () => null,
    refusals: () => ['hunt: no route'],
    realm: () => 'orohost:2427'
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
    recentLines: () => 'the last lines'
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
