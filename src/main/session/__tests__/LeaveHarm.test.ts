import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { t } from '../../app/i18n';
import { setTuning, tuning } from '../../app/tuning';
import type { Intent } from '../../automation/CommandQueue';
import { LeaveHarm, type LeaveHarmParts } from '../LeaveHarm';
import { RoomHazards, type RoomHazardsParts } from '../RoomHazards';
import { WorldGraph } from '../../world/WorldGraph';
import { wardOf } from '../../../shared/spellWard';
import type { Block } from '../../../shared/blocks';
import type { SafetyDecision } from '../../../shared/automation';
import {
  EMPTY_CHARACTER,
  NO_FIGHT_SIGNS,
  type ActiveBuff,
  type CharacterState,
  type FightSigns,
  type RoomOccupant
} from '../../../shared/character';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { DecisionKind } from '../../../shared/decisionSettings';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import type { Route, RouteStep, TrailStep } from '../../../shared/world';

/*
 * Todo 20261103-0140-01, `run6-river.jsonl`: the walk's first step `s` from
 * Halls of Training, Entrance (1/289) put Vaelor in The Silver River, the walk
 * stopped, the rest was refused, and the river took him from 63 to -4.
 */
const RIVER = '1/2605';
const HALLS = '1/289';

function at(room: string, hp: number, extra: Partial<CharacterState> = {}): CharacterState {
  const [map, number] = room.split('/').map(Number);
  return {
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 115 },
    room: {
      ...EMPTY_CHARACTER.room,
      name: room === RIVER ? 'The Silver River' : 'Halls of Training, Entrance',
      map: map ?? null,
      number: number ?? null
    },
    ...extra
  };
}

const step = (from: string, direction: RouteStep['direction'], to: string): RouteStep => ({
  from,
  to,
  direction,
  command: direction,
  name: to,
  requirement: null,
  dark: false
});

function rig(
  options: {
    hurts?: (room: string) => string | null;
    came?: TrailStep | null;
    nearest?: Route | null;
    walker?: LeaveHarmParts['walker'];
    held?: readonly string[];
  } = {}
) {
  const sent: Intent[] = [];
  const notices: string[] = [];
  const kinds: Array<DecisionKind | undefined> = [];
  const decisions: SafetyDecision[] = [];
  const tracker = {
    pendingMoves: 0,
    wayBackFrom: (room: string): TrailStep | null =>
      room === RIVER
        ? options.came === undefined
          ? { from: HALLS, direction: 's', to: RIVER }
          : options.came
        : null
  };
  const nearestRoom = vi.fn(() => options.nearest ?? null);
  const parts: LeaveHarmParts = {
    tracker,
    world: { byId: () => undefined },
    hazards: {
      roomHurts: (room) => (options.hurts ?? ((r) => (r === RIVER ? 'river damage' : null)))(room)
    },
    errands: { nearestRoom },
    queue: { enqueue: (intent) => sent.push(intent) > 0 },
    walker: options.walker ?? { walking: false, holding: null }
  };
  const escaping = { now: false };
  const leave = new LeaveHarm(parts, {
    config: () => ({ ...DEFAULT_CONFIG.automation, enabled: true }),
    escaping: () => escaping.now,
    waitedForHere: () => options.held ?? [],
    notice: (message, kind) => {
      notices.push(message);
      kinds.push(kind);
    },
    decided: (decision) => void decisions.push(decision)
  });
  return { leave, sent, notices, kinds, decisions, tracker, escaping, nearestRoom };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_793_691_810_971);
  setTuning(DEFAULT_INTERNAL.tuning);
});

describe('leaving a room that hurts every tick', () => {
  it('goes back the way it came, in the emergency band, ahead of a stopped walk', () => {
    const { leave, sent, notices, kinds, decisions } = rig();
    leave.consider(at(RIVER, 63));
    expect(sent.map((intent) => [intent.command, intent.priority, intent.decision])).toEqual([
      ['n', 'emergency', 'leave-harm']
    ]);
    expect(notices).toEqual([
      t('session.harm.leavingBack', {
        room: 'The Silver River',
        because: t('session.harm.because', { spell: 'river damage' }),
        direction: 'north',
        name: HALLS
      })
    ]);
    expect(kinds).toEqual(['leave-harm']);
    // Nothing more while the step is unanswered.
    leave.consider(at(RIVER, 46));
    expect(sent).toHaveLength(1);
    // The new room is the step taken, traced as acted.
    leave.consider(at(HALLS, 46));
    expect(decisions).toEqual([
      expect.objectContaining({
        action: 'leave',
        because: t('session.harm.because', { spell: 'river damage' }),
        acted: true
      })
    ]);
  });

  it('leaves from a walk held in the room, and leaves a walk stepping on to its next step', () => {
    const held = rig({ walker: { walking: true, holding: 'fight' } });
    held.leave.consider(at(RIVER, 63));
    expect(held.sent.map((intent) => intent.command)).toEqual(['n']);
    const stepping = rig({ walker: { walking: true, holding: null } });
    stepping.leave.consider(at(RIVER, 63));
    expect(stepping.sent).toEqual([]);
  });

  it('leaves a fight to the run, the ground to nobody, and waits on a move or a run', () => {
    const { leave, sent, tracker, escaping } = rig();
    leave.consider(at(RIVER, 63, { inCombat: true }));
    leave.consider(at(RIVER, 63, { combat: { ...EMPTY_CHARACTER.combat, attackers: ['fish'] } }));
    leave.consider(at(RIVER, -4, { mortallyWounded: true }));
    tracker.pendingMoves = 1;
    leave.consider(at(RIVER, 63));
    tracker.pendingMoves = 0;
    escaping.now = true;
    leave.consider(at(RIVER, 63));
    expect(sent).toEqual([]);
    escaping.now = false;
    leave.consider(at(RIVER, 63));
    expect(sent.map((intent) => intent.command)).toEqual(['n']);
  });

  it('heads for the nearest room that does not hurt when the way back hurts too', () => {
    const wide = (room: string) => (room === RIVER || room === HALLS ? 'river damage' : null);
    const nearest: Route = {
      steps: [step(RIVER, 'e', '1/2606'), step('1/2606', 'e', '1/2607')],
      cost: 2,
      blocked: false
    };
    const { leave, sent, notices, nearestRoom } = rig({ hurts: wide, nearest });
    leave.consider(at(RIVER, 63));
    expect(sent.map((intent) => intent.command)).toEqual(['e']);
    expect(notices).toEqual([
      t('session.harm.leavingNearest', {
        room: 'The Silver River',
        because: t('session.harm.because', { spell: 'river damage' }),
        direction: 'east',
        name: '1/2607'
      })
    ]);
    expect(nearestRoom).toHaveBeenCalledWith(expect.any(Function), tuning().roomHarm.searchSteps);
  });

  it('tries another way when the step goes unanswered', () => {
    const nearest: Route = { steps: [step(RIVER, 'w', '1/2604')], cost: 1, blocked: false };
    const { leave, sent, notices, decisions } = rig({ nearest });
    leave.consider(at(RIVER, 63));
    vi.advanceTimersByTime(tuning().session.retreatPatienceMs);
    leave.consider(at(RIVER, 46));
    expect(sent.map((intent) => intent.command)).toEqual(['n', 'w']);
    expect(notices[1]).toBe(t('session.harm.unanswered', { direction: 'north' }));
    expect(decisions).toEqual([expect.objectContaining({ action: 'leave', acted: false })]);
  });

  it('takes the one way out again when its step went unanswered', () => {
    const { leave, sent } = rig();
    leave.consider(at(RIVER, 63));
    vi.advanceTimersByTime(tuning().session.retreatPatienceMs);
    leave.consider(at(RIVER, 46));
    expect(sent.map((intent) => intent.command)).toEqual(['n', 'n']);
  });

  it('waits on a teleport on its way', () => {
    const { leave, sent, escaping } = rig();
    escaping.now = true;
    leave.consider(at(RIVER, 15));
    expect(sent).toEqual([]);
  });

  it('stays with the party it follows, and says so once', () => {
    const { leave, sent, notices, decisions } = rig();
    const following = at(RIVER, 63, {
      party: { ...EMPTY_CHARACTER.party, following: 'Brackle' }
    });
    leave.consider(following);
    leave.consider(following);
    expect(sent).toEqual([]);
    const refused = t('session.safety.escapeFollowingReason', { leader: 'Brackle' });
    expect(notices).toEqual([
      t('session.harm.staying', {
        room: 'The Silver River',
        because: t('session.harm.because', { spell: 'river damage' }),
        refused
      })
    ]);
    expect(decisions).toEqual([expect.objectContaining({ acted: false, refused })]);
  });

  /* Rayzor, 2026-11-04: each step out of a room read as hurting dropped a held Brakkle. */
  it('stays with a member the party waits on here until health is under the retreat point', () => {
    const { leave, sent, notices } = rig({ held: ['Brakkle'] });
    const refused = t('session.harm.waitingFor', { who: 'Brakkle' });
    // 63 of 115 is over the 30% floor.
    leave.consider(at(RIVER, 63));
    leave.consider(at(RIVER, 50));
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      t('session.harm.staying', {
        room: 'The Silver River',
        because: t('session.harm.because', { spell: 'river damage' }),
        refused
      })
    ]);
    // Under it, the step goes and says who was left.
    leave.consider(at(RIVER, 30));
    expect(sent.map((intent) => intent.command)).toEqual(['n']);
    expect(notices.at(-1)).toBe(t('session.harm.leftBehind', { who: 'Brakkle' }));
  });

  it('steps out with a member held here when its maximum health is unknown', () => {
    const { leave, sent } = rig({ held: ['Brakkle'] });
    const unknown = at(RIVER, 63);
    leave.consider({ ...unknown, vitals: { ...unknown.vitals, hpMax: null } });
    expect(sent.map((intent) => intent.command)).toEqual(['n']);
  });

  it('says once that no way leads out of it', () => {
    const { leave, sent, notices } = rig({ came: null });
    leave.consider(at(RIVER, 63));
    leave.consider(at(RIVER, 46));
    expect(sent).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(t('session.harm.noWay', { steps: tuning().roomHarm.searchSteps }));
  });

  it('does nothing in a room that does not hurt', () => {
    const { leave, sent, notices } = rig();
    leave.consider(at(HALLS, 20));
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });
});

/*
 * Unknown is unsafe: a room the world database gives no damage still counts
 * once the server has taken health there twice out of a fight.
 */
describe('a room whose damage the world database does not list', () => {
  const hazards = (
    current: { state: CharacterState },
    signs: FightSigns = NO_FIGHT_SIGNS,
    hit: { lately: boolean } = { lately: false }
  ) =>
    new RoomHazards({
      world: undefined,
      tracker: {
        get current() {
          return current.state;
        }
      },
      errands: {} as RoomHazardsParts['errands'],
      signs,
      hangUp: { monsterHit: () => hit.lately }
    });

  it('counts once health falls twice out of a fight, and is left', () => {
    const current = { state: at(RIVER, 115) };
    const room = hazards(current);
    const { leave, sent } = rig({ hurts: (r) => room.roomHurts(r) });
    for (const hp of [115, 99, 79]) {
      current.state = at(RIVER, hp);
      room.note(current.state);
      leave.consider(current.state);
    }
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
    expect(sent.map((intent) => intent.command)).toEqual(['n']);
  });

  /* Rayzor, 2026-11-04: a poison read as the room's marked 7/745 for the session. */
  it('clears a mark once the character stands in the room unhurt long enough', () => {
    const current = { state: at(RIVER, 115) };
    const room = hazards(current);
    for (const hp of [115, 99, 79]) {
      current.state = at(RIVER, hp);
      room.note(current.state);
    }
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
    const { clearAfterMs } = tuning().roomHarm;
    vi.advanceTimersByTime(clearAfterMs - 1);
    room.note(current.state);
    // Not yet: the positive control that standing alone does not clear it early.
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
    vi.advanceTimersByTime(1);
    room.note(current.state);
    expect(room.hurtsHere(current.state)).toBeNull();
  });

  it('keeps a mark while the room goes on taking health', () => {
    const current = { state: at(RIVER, 115) };
    const room = hazards(current);
    let hp = 115;
    for (let i = 0; i < 40; i += 1) {
      current.state = at(RIVER, hp);
      room.note(current.state);
      hp -= 2;
      vi.advanceTimersByTime(1200);
    }
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
  });

  /*
   * Rayzor, 2026-11-06 00:56 on OCI, at Slum Street, Western Door: `bas w`,
   * `You take 2 damage for bashing the door!` twice, and the room was left as
   * one that hurts. A bash's cost is the character's own.
   */
  it('does not count health the character paid for its own bash', () => {
    const current = { state: at(RIVER, 157) };
    const room = hazards(current);
    room.note(current.state);
    const bash = (damage: number, hp: number): void => {
      room.observe({
        type: 'user-takes-damage',
        groups: { damage: String(damage), paidFor: 'bashing the door' }
      } as unknown as Block);
      // The bash line is read first with the figure unmoved; the fall comes on the
      // prompt after it (Rayzor at Gnome Village, OCI, 2026-11-07 17:01:58).
      room.note(current.state);
      current.state = at(RIVER, hp);
      room.note(current.state);
    };
    bash(2, 155);
    bash(1, 154);
    bash(2, 152);
    expect(room.hurtsHere(current.state)).toBeNull();
    // The positive control: the same falls with no bash line are the room's.
    for (const hp of [150, 148]) {
      current.state = at(RIVER, hp);
      room.note(current.state);
    }
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
  });

  /*
   * Rayzor, 2026-11-04 05:02:48 on OCI: walking into Cracked Plain, `The thin
   * winged horror swoops down and bites you for 7 damage!` and `Acid sears you
   * for 1 damage!` landed before `*Combat Engaged*`. Counted as the room's,
   * they sent Rayzor out of the room where he had just invited Brakkle back.
   */
  it('pauses on a monster damage line until the window passes, here or gone', () => {
    const current = { state: at(RIVER, 115) };
    const monster: RoomOccupant = {
      name: 'thin winged horror',
      kind: 'mob',
      disposition: null,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    };
    const hit = { lately: true };
    const room = hazards(current, NO_FIGHT_SIGNS, hit);
    const feed = (hps: readonly number[], occupants: RoomOccupant[]): void => {
      for (const hp of hps) {
        current.state = at(RIVER, hp);
        current.state = { ...current.state, room: { ...current.state.room, occupants } };
        room.note(current.state);
      }
    };
    // The bite and the acid on the way in, the monster still here.
    feed([115, 108, 107], [monster]);
    expect(room.hurtsHere(current.state)).toBeNull();
    // Its last blow and its death in one burst: gone by the prompt that shows the loss.
    feed([100, 95], []);
    expect(room.hurtsHere(current.state)).toBeNull();
    // The positive control: the window over, the same falls are the room's.
    hit.lately = false;
    feed([90, 85], []);
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
  });

  it('does not count health while a monster here swung lately, a miss included', () => {
    const current = { state: at(RIVER, 115) };
    const swung: FightSigns = { monsterSwung: () => true, quarry: () => false };
    const monster: RoomOccupant = {
      name: 'big bola spider',
      kind: 'mob',
      disposition: null,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    };
    const room = hazards(current, swung);
    for (const hp of [115, 108, 107]) {
      current.state = at(RIVER, hp);
      current.state = { ...current.state, room: { ...current.state.room, occupants: [monster] } };
      room.note(current.state);
    }
    expect(room.hurtsHere(current.state)).toBeNull();
    // The positive control: the room's own line reads as a miss, and nothing is here to swing.
    const river = hazards(current, swung);
    for (const hp of [80, 70, 60]) {
      current.state = at(RIVER, hp);
      river.note(current.state);
    }
    expect(river.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
  });

  it('does not count health a fight or a poison took, or a single fall', () => {
    const current = { state: at(RIVER, 115) };
    const room = hazards(current);
    const fight = { inCombat: true };
    const poison = { afflictions: { ...EMPTY_CHARACTER.afflictions, poisoned: 'yes' as const } };
    for (const [hp, extra] of [
      [115, {}],
      [99, fight],
      [79, fight],
      [60, poison],
      [50, poison],
      [40, {}]
    ] as const) {
      current.state = at(RIVER, hp, extra);
      room.note(current.state);
    }
    expect(room.hurtsHere(current.state)).toBeNull();
    // Bleeding on the ground, and a maximum that fell, are no blow from the room.
    for (const [hp, extra] of [
      [-1, { mortallyWounded: true }],
      [-2, { mortallyWounded: true }],
      [-3, { mortallyWounded: true }]
    ] as const) {
      current.state = at(RIVER, hp, extra);
      room.note(current.state);
    }
    expect(room.hurtsHere(current.state)).toBeNull();
    current.state = at(RIVER, 40);
    room.note(current.state);
    current.state = { ...at(RIVER, 30), vitals: { ...at(RIVER, 30).vitals, hpMax: 105 } };
    room.note(current.state);
    current.state = { ...at(RIVER, 20), vitals: { ...at(RIVER, 20).vitals, hpMax: 95 } };
    room.note(current.state);
    expect(room.hurtsHere(current.state)).toBeNull();
    // A new room starts again: one fall there is not two.
    current.state = at(HALLS, 40);
    room.note(current.state);
    current.state = at(HALLS, 30);
    room.note(current.state);
    expect(room.hurtsHere(current.state)).toBeNull();
    room.reset();
    expect(room.roomHurts(RIVER)).toBeNull();
  });
});

/*
 * Rayzor, 2026-11-07 20:28 on OCI: `necromancer casts rotting flesh upon you!`
 * and `You are rotting!`, then 6 a tick until `The disease dies down.`. The
 * ticks marked Amethyst Cave (9/1431) and the Catacombs west of it, and the
 * lap walked out of the necromancer's room for the rest of the session.
 */
describe('a spell up on the character that takes health each tick', () => {
  const CAVE = '9/1431';
  const graph = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-rot-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = {
      v: 80,
      source: 'test',
      rooms: 1,
      generatedAt: 'x',
      items: [],
      spells: [
        {
          id: 143,
          n: 'rotting flesh',
          dur: 10,
          ab: [
            [1, 0],
            [115, 90]
          ],
          pw: [6, 6]
        }
      ]
    };
    const room = { m: 9, r: 1431, n: 'Amethyst Cave', x: {} };
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, room].map((row) => JSON.stringify(row)).join('\n'))
    );
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  })();
  const rotting: ActiveBuff = { spell: 'rotting flesh', by: null, appliedAt: 0 };

  it("does not count the spell's ticks as the room's", () => {
    const current = { state: at(CAVE, 110) };
    const room = new RoomHazards({
      world: graph,
      tracker: {
        get current() {
          return current.state;
        }
      },
      errands: {} as RoomHazardsParts['errands'],
      signs: NO_FIGHT_SIGNS,
      hangUp: { monsterHit: () => false }
    });
    const feed = (hps: readonly number[], buffs: ActiveBuff[]): void => {
      for (const hp of hps) {
        current.state = at(CAVE, hp, { buffs });
        room.note(current.state);
        vi.advanceTimersByTime(3000);
      }
    };
    feed([110, 104, 98, 92, 86], [rotting]);
    expect(room.hurtsHere(current.state)).toBeNull();
    // The positive control: the disease down, the same falls are the room's.
    feed([80, 74], []);
    expect(room.hurtsHere(current.state)).toBe(t('session.harm.unlisted'));
  });
});

/*
 * Rayzor, 2026-11-06: walked out of every lava room "magma heat hurts in this
 * room" with the phoenix feather on his neck. Magma heat (526) states 45 a
 * tick and names no stopper; the feather negates it (`Items.NegateSpell`),
 * and the server skips the whole cast for its wearer (`Spell.cs:970-1060`).
 */
describe('a room whose spell a worn item negates', () => {
  const LAVA = '7/982';
  const graph = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lava-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const header = {
      v: 80,
      source: 'test',
      rooms: 1,
      generatedAt: 'x',
      items: [{ id: 1000, n: 'phoenix feather', worn: 8, neg: [218, 526] }],
      spells: [{ id: 526, n: 'magma heat', hz: { d: 45 } }]
    };
    const room = { m: 7, r: 982, n: 'Lava Pool', sp: 526, x: {} };
    fs.writeFileSync(
      file,
      zlib.gzipSync([header, room].map((row) => JSON.stringify(row)).join('\n'))
    );
    const loaded = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return loaded;
  })();
  const standing = (equipped: boolean): CharacterState => {
    const feather = graph.buildItemEntity('phoenix feather', {
      slot: equipped ? 'Neck' : null,
      equipped
    });
    return at(LAVA, 161, {
      inventory: { ...EMPTY_CHARACTER.inventory, items: [feather], listedAt: 1, rows: [1000] }
    });
  };
  const hazards = (state: CharacterState) =>
    new RoomHazards({
      world: graph,
      tracker: { current: state },
      errands: {
        spellsUp: () => [],
        wardNow: (now: CharacterState) => wardOf(now.inventory.items, null)
      } as unknown as RoomHazardsParts['errands'],
      signs: NO_FIGHT_SIGNS,
      hangUp: { monsterHit: () => false }
    });

  it('hurts while the feather is only carried', () => {
    const state = standing(false);
    expect(hazards(state).roomHurts(LAVA, state)).toBe('magma heat');
  });

  it('does not hurt, and is not left, while the feather is worn', () => {
    const state = standing(true);
    const room = hazards(state);
    expect(room.roomHurts(LAVA, state)).toBeNull();
    const { leave, sent, notices } = rig({ hurts: (r) => room.roomHurts(r, state) });
    leave.consider(state);
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });
});
