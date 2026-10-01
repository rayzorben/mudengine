import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { Travel, type TravelParts, type TravelSession } from '../Travel';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { NO_LOOP } from '../../../shared/loops';
import { NOT_MOVING } from '../../../shared/movement';
import { classifyOccupant } from '../../../shared/mobs';
import type { FledEntry } from '../../../shared/fled';
import type { Survival } from '../../../shared/survival';
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
function travel(
  state: CharacterState,
  walk: 'stepping' | 'held' | 'none',
  going = true,
  overrides: Partial<TravelSession> & { settings?: AutomationConfig } = {}
) {
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
    config: () => overrides.settings ?? config,
    movement:
      overrides.movement ??
      (() => (going ? { kind: 'route', moving: true, resumable: false } : { ...NOT_MOVING })),
    loopNamed: () => undefined,
    dropTyped: vi.fn(),
    notice: (message) => void notices.push(message),
    decided: (decision) => void decisions.push(decision),
    fight: overrides.fight ?? (() => null),
    fled: overrides.fled ?? (() => []),
    keepFled: overrides.keepFled ?? (() => {})
  };
  return { travel: new Travel(parts, session), sent, notices, decisions, parts };
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
      t('session.safety.escapeStaying', {
        why: t('session.safety.whyDreaded', { mob: 'black ooze' }),
        then: t('session.safety.escapeNotOpening')
      })
    ]);
  });
});

/*
 * Soul's first death: two thugs took 28 to 10 in a round; it ran one room, the
 * thug followed and took it to 6, and the cooldown held the second run until
 * the next blow had killed it. A share of maximum health (30%) also ran too
 * late for blows that size.
 */
describe('running from a fight that could kill', () => {
  const plain: AutomationConfig = { ...config, combat: { ...config.combat, mobRules: [] } };
  const thug = { survives: 0.4, worstRound: 11 } as unknown as Survival;
  const hit = (hp: number, name: string, number: number): CharacterState => {
    const state = beside();
    return {
      ...state,
      inCombat: true,
      vitals: { ...state.vitals, hp, hpMax: 34 },
      room: { ...state.room, name, map: 1, number },
      combat: { ...state.combat, attackers: ['black ooze'] }
    };
  };

  it('runs once two worst rounds could take what is left, above the share of health', () => {
    const state = hit(20, 'Dank Room', 1);
    const kept: FledEntry[][] = [];
    const { travel: moving, sent } = travel(state, 'none', true, {
      settings: plain,
      fight: () => thug,
      keepFled: (entries) => void kept.push([...entries])
    });
    moving.considerEscape(state);
    expect(sent).toEqual(['n']);
    expect(kept.map((list) => list.map((entry) => entry.name))).toEqual([['black ooze']]);
  });

  it('runs again at once from a monster that follows, though nothing walks any more', () => {
    const first = hit(10, 'Dank Room', 1);
    let going = true;
    const {
      travel: moving,
      sent,
      parts
    } = travel(first, 'none', true, {
      settings: plain,
      fight: () => thug,
      movement: () =>
        going ? { kind: 'route', moving: true, resumable: false } : { ...NOT_MOVING }
    });
    moving.considerEscape(first);
    expect(sent).toEqual(['n']);
    // Landed next door, the walk the fight stopped is gone, and the thug follows.
    const next = hit(6, 'Sewer Tunnel', 2);
    going = false;
    (parts.tracker as { current: CharacterState }).current = next;
    moving.settleEscape({ type: 'room' } as never, first.room);
    moving.considerEscape(next);
    expect(sent).toEqual(['n', 'n']);
  });
});
