import { describe, expect, it, vi } from 'vitest';

import { Travel, type TravelParts, type TravelSession } from '../Travel';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { NO_LOOP } from '../../../shared/loops';
import { NOT_MOVING } from '../../../shared/movement';
import { classifyOccupant } from '../../../shared/mobs';
import { IDLE_WALK } from '../../../shared/walk';

const ooze: RoomOccupant = classifyOccupant('black ooze', {
  players: new Set<string>(),
  mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
});

/** Standing in a room with two ways out and the monster in it, out of any fight. */
function beside(): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 100, hpMax: 100 },
    room: {
      ...base.room,
      name: 'Rat Cellar',
      occupants: [ooze],
      exits: ['n', 's'].map((direction) => ({
        direction,
        note: null,
        targetMap: null,
        targetRoom: null,
        targetName: null,
        requirement: null
      }))
    }
  };
}

const config: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  combat: {
    ...DEFAULT_CONFIG.automation.combat,
    mobRules: [{ mob: 'black ooze', treat: 'escape' }]
  },
  safety: {
    ...DEFAULT_CONFIG.automation.safety,
    retreat: { ...DEFAULT_CONFIG.automation.safety.retreat, enabled: true }
  }
};

/** Travel over whole-port doubles; `walk` says whether a walk is stepping or held. */
function travel(state: CharacterState, walk: 'stepping' | 'held' | 'none', going = true) {
  const sent: string[] = [];
  const notices: string[] = [];
  const decisions: SafetyDecision[] = [];
  const parts: TravelParts = {
    tracker: {
      current: state,
      pendingMoves: 0,
      trail: [],
      wayBackFrom: () => null,
      retraced: vi.fn()
    },
    world: undefined,
    errands: {
      planFromHere: vi.fn(),
      travellerNow: vi.fn(),
      lapTraveller: vi.fn(),
      askCountersFor: vi.fn(),
      findStop: vi.fn()
    },
    queue: {
      enqueue: (intent) => {
        sent.push(intent.command);
        return true;
      }
    },
    walker: {
      start: vi.fn(),
      stop: vi.fn(),
      walking: walk !== 'none',
      holding: walk === 'held' ? 'fight' : null,
      progress: IDLE_WALK,
      journey: null,
      unfinished: null,
      noteEscaped: vi.fn()
    },
    loops: {
      progress: NO_LOOP,
      start: vi.fn(),
      stop: vi.fn(),
      resume: vi.fn(),
      restate: vi.fn(),
      noteEscaped: vi.fn(),
      noteOnline: vi.fn(),
      carried: false,
      heading: null,
      strayedFrom: null
    },
    combat: { willFight: true, declineWhileTravelling: vi.fn() },
    combatLease: { lending: false, run: vi.fn(), onWalkEnded: vi.fn() },
    supplies: { current: null, considerBeforeRoute: vi.fn(), abandon: vi.fn() },
    trainLevel: { busy: false, abandon: vi.fn() },
    hunt: { noteStopped: vi.fn(), noteLapStopped: vi.fn() },
    itemErrand: { running: false, collect: vi.fn(), abandon: vi.fn() },
    questRunner: { running: false, abandon: vi.fn() }
  };
  const session: TravelSession = {
    config: () => config,
    movement: () => (going ? { kind: 'route', moving: true, resumable: false } : { ...NOT_MOVING }),
    loopNamed: () => undefined,
    dropTyped: vi.fn(),
    notice: (message) => void notices.push(message),
    decided: (decision) => void decisions.push(decision)
  };
  return { travel: new Travel(parts, session), sent, notices, decisions };
}

/*
 * Todo 818: out of a fight, a walk still stepping leaves the room by its own
 * next step, so the escape a row asks for is for a character standing there.
 */
describe('escaping a monster its row names, out of a fight', () => {
  it('runs while the walk is held here', () => {
    const state = beside();
    const { travel: moving, sent } = travel(state, 'held');
    moving.considerEscape(state);
    expect(sent).toEqual(['n']);
  });

  it('leaves it to a walk still stepping out of the room', () => {
    const state = beside();
    const { travel: moving, sent, notices } = travel(state, 'stepping');
    moving.considerEscape(state);
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  /*
   * Nothing is taking the character anywhere, so it stays — and out of a fight
   * the sentence does not claim it is standing and fighting (818, on review).
   */
  it('stays where nothing is taking it, without claiming a fight', () => {
    const state = beside();
    const { travel: idle, sent, notices } = travel(state, 'none', false);
    idle.considerEscape(state);
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      'Not running: black ooze is here, and its row says to escape, but nothing is taking this ' +
        'character anywhere, so it stays where it is. Nothing is opened beside it.'
    ]);
  });
});
