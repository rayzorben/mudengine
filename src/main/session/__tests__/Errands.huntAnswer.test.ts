import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { WorldGraph } from '../../world/WorldGraph';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { MeasuredRate } from '../../../shared/hunting';
import type { HuntingReply } from '../../../shared/huntReply';
import { NO_LORE } from '../../../shared/lore';
import type { LearnedSpawns } from '../../../shared/spawns';
import type { Odds } from '../../../shared/survival';

/*
 * The Hunting card hands back the key of the survey it holds, and is answered
 * `same` with the steps from where the character stands while nothing else
 * the survey reads has moved (todo 20261102-2305-02). A looping character
 * moves every second and a quarter, and the survey is the whole realm.
 */

/** A town and two lairs east of it in a line, and a pit under the second with no way out. */
function realm(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-answer-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const rooms = [
    { m: 1, r: 1, n: 'Town Square', x: { e: { m: 1, r: 2 } } },
    {
      m: 1,
      r: 2,
      n: 'Goblin Warren',
      x: { w: { m: 1, r: 1 }, e: { m: 1, r: 3 } },
      lair: '(Max 1): 7,',
      dl: 2
    },
    {
      m: 1,
      r: 3,
      n: 'Orc Pit',
      x: { w: { m: 1, r: 2 }, d: { m: 1, r: 4 } },
      lair: '(Max 1): 8,',
      dl: 2
    },
    { m: 1, r: 4, n: 'Pit Bottom', x: {} }
  ];
  const mob = (n: string, id: number, hp: number, xp: number) => ({
    n,
    hp,
    i: [id],
    d: 'h',
    ac: 20,
    xp,
    pf: [{ a: [[1, 1, 200, 3, 9, 1000, 0]], c: [] }]
  });
  const header = {
    v: 32,
    source: 'test',
    rooms: rooms.length,
    generatedAt: 'x',
    mobs: [mob('goblin', 7, 200, 300), mob('orc', 8, 300, 400)]
  };
  fs.writeFileSync(
    file,
    zlib.gzipSync([header, ...rooms].map((row) => JSON.stringify(row)).join('\n') + '\n')
  );
  const world = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return world;
}

const STANDING: CharacterState = {
  ...EMPTY_CHARACTER,
  name: 'Festus',
  className: 'Paladin',
  room: { ...EMPTY_CHARACTER.room, map: 1, number: 1, name: 'Town Square' },
  progress: { ...EMPTY_CHARACTER.progress, level: 10, exp: 792666, expNeeded: 5300 },
  vitals: { ...EMPTY_CHARACTER.vitals, hp: 148, hpMax: 148, mana: 5, manaMax: 26 }
};

const SAFE: Odds = { kind: 'unrun' };

/** One character's survey with every input it reads held here, so a test can move one. */
function surveying() {
  const inputs = {
    state: STANDING,
    config: DEFAULT_CONFIG.automation as AutomationConfig,
    lairsRun: 'book|0|-|0',
    rates: new Map<string, MeasuredRate>(),
    spawns: new Map<string, LearnedSpawns>(),
    kills: new Map<string, number>()
  };
  const errands = new Errands(
    {
      world: realm(),
      tracker: {
        get current() {
          return inputs.state;
        },
        pendingMoves: 0
      },
      fightRecord: {},
      combatOn: () => true,
      lore: {
        ...NO_LORE,
        hasNoEffect: () => false,
        noEffectChanges: () => 0,
        spawnsAt: (room: string) => inputs.spawns.get(room) ?? null,
        allSpawns: () => inputs.spawns,
        killExpFor: (name: string) => inputs.kills.get(name) ?? null,
        allKillExp: () => inputs.kills
      }
    } as unknown as ErrandsParts,
    {
      config: () => inputs.config,
      family: () => 'greatermud',
      odds: () => ({
        lair: () => SAFE,
        partyLair: () => SAFE,
        alone: () => {},
        get lairsRun() {
          return inputs.lairsRun;
        },
        lairsLeft: 0
      }),
      rates: () => inputs.rates,
      backstabWeapon: () => null,
      notice: () => {}
    } as unknown as ErrandsSession
  );
  const surveys = vi.spyOn(errands, 'huntingGrounds');
  return { inputs, errands, surveys };
}

function keyOf(reply: HuntingReply): string {
  if (reply.key === null) throw new Error('a kept survey has a key');
  return reply.key;
}

/** The character a step from where it stood, as the tracker hands it over. */
const at = (state: CharacterState, room: number, name: string): CharacterState => ({
  ...state,
  room: { ...state.room, number: room, name },
  updatedAt: (state.updatedAt ?? 0) + 1
});

describe("the Hunting card's answer", () => {
  it('is the steps alone after a move, and the survey is not run again', () => {
    const { inputs, errands, surveys } = surveying();
    const first = errands.huntingAnswer(null, null);
    expect(first.kind).toBe('whole');
    // Positive control: the first ask ran the survey, and it lists both lairs.
    expect(surveys).toHaveBeenCalledTimes(1);
    if (first.kind !== 'whole') throw new Error('whole');
    const rooms = [...first.advice.spots, ...first.advice.unmeasured].flatMap((spot) =>
      spot.rooms.map((room) => `${room.id}:${room.steps}`)
    );
    expect(rooms).toEqual(expect.arrayContaining(['1/2:1', '1/3:2']));

    inputs.state = at(inputs.state, 2, 'Goblin Warren');
    const moved = errands.huntingAnswer(keyOf(first), null);
    expect(moved.kind).toBe('same');
    if (moved.kind !== 'same') throw new Error('same');
    expect(moved.key).toBe(first.key);
    expect(moved.moved.from).toEqual({ id: '1/2', name: 'Goblin Warren' });
    expect(moved.moved.steps).toContain(0);
    expect(surveys).toHaveBeenCalledTimes(1);
  });

  it('is the steps alone while the character rests and its experience climbs', () => {
    const { inputs, errands, surveys } = surveying();
    const first = errands.huntingAnswer(null, null);
    expect(surveys).toHaveBeenCalledTimes(1);
    inputs.state = {
      ...at(inputs.state, 2, 'Goblin Warren'),
      vitals: { ...inputs.state.vitals, hp: 90, resting: true },
      progress: { ...inputs.state.progress, exp: 793000, expNeeded: 5000, expThisSession: 300 }
    };
    expect(errands.huntingAnswer(keyOf(first), null).kind).toBe('same');
    expect(surveys).toHaveBeenCalledTimes(1);
    // Positive control: the level ready to train is read, so it is a new survey.
    inputs.state = { ...inputs.state, progress: { ...inputs.state.progress, expNeeded: 0 } };
    expect(errands.huntingAnswer(keyOf(first), null).kind).toBe('whole');
    expect(surveys).toHaveBeenCalledTimes(2);
  });

  it('is the kept survey, moved, for a card that holds none, still without a survey', () => {
    const { inputs, errands, surveys } = surveying();
    const first = errands.huntingAnswer(null, null);
    expect(surveys).toHaveBeenCalledTimes(1);
    inputs.state = at(inputs.state, 2, 'Goblin Warren');
    const other = errands.huntingAnswer(null, null);
    expect(other.kind).toBe('whole');
    if (other.kind !== 'whole') throw new Error('whole');
    expect(other.key).toBe(first.key);
    expect(other.advice.from?.id).toBe('1/2');
    expect(surveys).toHaveBeenCalledTimes(1);
  });

  it('is the whole survey to a card holding a key no longer kept', () => {
    const { errands, surveys } = surveying();
    errands.huntingAnswer(null, null);
    const stale = errands.huntingAnswer('0', null);
    expect(stale.kind).toBe('whole');
    // Answered from the survey kept, which the first ask ran.
    expect(surveys).toHaveBeenCalledTimes(1);
  });

  /*
   * One move per family the survey reads besides the room: each is a new
   * survey under a new key. The control for each is the `same` answer the
   * unchanged inputs gave the same card a line before.
   */
  const families: Array<[string, (inputs: ReturnType<typeof surveying>['inputs']) => void]> = [
    [
      'the gear changes',
      (inputs) => {
        inputs.state = {
          ...inputs.state,
          inventory: {
            ...inputs.state.inventory,
            items: [
              ...inputs.state.inventory.items,
              {
                name: 'broadsword',
                quantity: 1,
                slot: 'Weapon Hand'
              } as unknown as CharacterState['inventory']['items'][number]
            ]
          } as CharacterState['inventory']
        };
      }
    ],
    [
      'the level rises',
      (inputs) => {
        inputs.state = {
          ...inputs.state,
          progress: { ...inputs.state.progress, level: 11 }
        };
      }
    ],
    [
      'the odds book runs a fight',
      (inputs) => {
        inputs.lairsRun = 'book|1|-|0';
      }
    ],
    [
      'a rate is measured',
      (inputs) => {
        inputs.rates = new Map([
          ['1/2', { perHour: 40000, minutes: 30, level: 10, at: Date.now() }]
        ]);
      }
    ],
    [
      'a refill is timed',
      (inputs) => {
        inputs.spawns = new Map([
          ['1/3', { refills: [20, 22, 21], seen: { orc: 3 }, at: Date.now() }]
        ]);
      }
    ],
    [
      'the hunting settings change',
      (inputs) => {
        inputs.config = {
          ...inputs.config,
          hunting: {
            ...inputs.config.hunting,
            maxDamageShare: inputs.config.hunting.maxDamageShare / 2
          }
        };
      }
    ],
    [
      'the attack spell changes',
      (inputs) => {
        inputs.config = {
          ...inputs.config,
          spells: { ...inputs.config.spells, attack: 'mmis' }
        };
      }
    ],
    [
      'a kill pays the realm’s own figure',
      (inputs) => {
        inputs.kills = new Map([['goblin', 450]]);
      }
    ]
  ];

  it.each(families)('is a new survey when %s', (_family, change) => {
    const { inputs, errands, surveys } = surveying();
    const first = errands.huntingAnswer(null, null);
    inputs.state = at(inputs.state, 2, 'Goblin Warren');
    const control = errands.huntingAnswer(keyOf(first), null);
    expect(control.kind).toBe('same');
    expect(surveys).toHaveBeenCalledTimes(1);

    change(inputs);
    const next = errands.huntingAnswer(keyOf(first), null);
    expect(next.kind).toBe('whole');
    expect(next.key).not.toBe(first.key);
    expect(surveys).toHaveBeenCalledTimes(2);
  });

  it('is a new survey once a rate kept is too old to say anything', () => {
    vi.useFakeTimers();
    try {
      const { inputs, errands, surveys } = surveying();
      inputs.rates = new Map([['1/2', { perHour: 40000, minutes: 30, level: 10, at: Date.now() }]]);
      const first = errands.huntingAnswer(null, null);
      const control = errands.huntingAnswer(keyOf(first), null);
      expect(control.kind).toBe('same');
      vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.hunting.measuredForgetMs + 1);
      expect(errands.huntingAnswer(keyOf(first), null).kind).toBe('whole');
      expect(surveys).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a new survey from a room whose reach is not the one surveyed', () => {
    const { inputs, errands, surveys } = surveying();
    const first = errands.huntingAnswer(null, null);
    // Positive control: a room inside the same reach is the steps alone.
    inputs.state = at(inputs.state, 3, 'Orc Pit');
    expect(errands.huntingAnswer(keyOf(first), null).kind).toBe('same');
    // The pit has no way out, so nothing surveyed is reached from it.
    inputs.state = at(inputs.state, 4, 'Pit Bottom');
    expect(errands.huntingAnswer(keyOf(first), null).kind).toBe('whole');
    expect(surveys).toHaveBeenCalledTimes(2);
  });

  it('is never kept for a refusal', () => {
    const { inputs, errands } = surveying();
    inputs.state = at(inputs.state, 99, 'Nowhere');
    const refused = errands.huntingAnswer(null, null);
    expect(refused).toMatchObject({ kind: 'whole', key: null });
    if (refused.kind !== 'whole') throw new Error('whole');
    expect(refused.advice.refusal).not.toBeNull();
  });
});
