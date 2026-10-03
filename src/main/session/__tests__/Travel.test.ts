import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { personStop } from '../../automation/personStop';
import { Travel, type TravelParts, type TravelSession } from '../Travel';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { NO_LOOP } from '../../../shared/loops';
import { NOT_MOVING } from '../../../shared/movement';
import { classifyOccupant } from '../../../shared/mobs';
import type { FledEntry } from '../../../shared/fled';
import { IDLE_WALK } from '../../../shared/walk';
import type { Route } from '../../../shared/world';

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
  master = { on: true, writes: true },
  overrides: Partial<TravelSession> & { settings?: AutomationConfig } = {}
) {
  const sent: string[] = [];
  const switched: boolean[] = [];
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
      planTo: vi.fn(() => null),
      routeBetween: vi.fn(() => t('session.loop.noRealmData')),
      travellerNow: vi.fn(),
      lapTraveller: vi.fn(),
      askCountersFor: vi.fn(),
      findStop: vi.fn(),
      shun: vi.fn()
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
      strayedFrom: null,
      place: null
    },
    combat: { willFight: true, alsoFight: vi.fn(), stopFighting: vi.fn() },
    supplies: { current: null, considerBeforeRoute: vi.fn(), abandon: vi.fn() },
    trainLevel: { busy: false, abandon: vi.fn() },
    outgrown: { busy: false, abandon: vi.fn() },
    stashFetch: { busy: false, abandon: vi.fn() },
    hunt: { noteStopped: vi.fn(), noteLapStopped: vi.fn() },
    itemErrand: { running: false, collect: vi.fn(), abandon: vi.fn() },
    questRunner: { running: false, abandon: vi.fn() },
    light: { beforeRoute: () => false, beforeLap: vi.fn() }
  };
  const settings = overrides.settings ?? config;
  // The combat switch as the file holds it, and every write of it.
  const combat = { on: settings.combat.enabled, flips: [] as boolean[] };
  const session: TravelSession = {
    config: () => ({
      ...settings,
      enabled: master.on,
      combat: { ...settings.combat, enabled: combat.on }
    }),
    movement:
      overrides.movement ??
      (() => (going ? { kind: 'route', moving: true, resumable: false } : { ...NOT_MOVING })),
    loopNamed: () => undefined,
    dropTyped: vi.fn(),
    notice: (message) => void notices.push(message),
    decided: (decision) => void decisions.push(decision),
    fled: overrides.fled ?? (() => []),
    keepFled: overrides.keepFled ?? (() => {}),
    driven: overrides.driven ?? (() => false),
    switchAutomation: (name, on) => {
      if (name === 'combat') {
        combat.flips.push(on);
        if (master.writes) combat.on = on;
        return master.writes;
      }
      switched.push(on);
      if (master.writes) master.on = on;
      return master.writes;
    }
  };
  return { travel: new Travel(parts, session), parts, sent, notices, decisions, switched, combat };
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

  /* 2026-10-02: scripted, standing in a fight at login before its first step, and killed. */
  it('runs where an extension is scripting the character, standing still between steps', () => {
    const state = beside();
    const { travel: scripted, sent } = travel(state, 'none', false, undefined, {
      driven: () => true
    });
    scripted.considerEscape(state);
    expect(sent).toEqual(['n']);
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
 * the next blow had killed it. The run is the player's rule, the share of
 * health (2026-10-02, the user: a fight is tried, never given up on what the
 * simulator predicts).
 */
describe('running from a fight', () => {
  const plain: AutomationConfig = { ...config, combat: { ...config.combat, mobRules: [] } };
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

  it('runs below the share of health set, and not above it', () => {
    const healthy = hit(20, 'Dank Room', 1);
    const kept: FledEntry[][] = [];
    const {
      travel: moving,
      sent,
      parts
    } = travel(healthy, 'none', true, undefined, {
      settings: plain,
      keepFled: (entries) => void kept.push([...entries])
    });
    moving.considerEscape(healthy);
    expect(sent).toEqual([]);
    const hurt = hit(8, 'Dank Room', 1);
    (parts.tracker as { current: CharacterState }).current = hurt;
    moving.considerEscape(hurt);
    expect(sent).toEqual(['n']);
    expect(kept.map((list) => list.map((entry) => entry.name))).toEqual([['black ooze']]);
  });

  /* Todo 73: and the room it ran out of is kept out of, so nothing walks it back in. */
  it('keeps the room it ran out of off every route for a while', () => {
    const state = hit(8, 'Dank Room', 1);
    const { travel: moving, parts } = travel(state, 'none', true, undefined, {
      settings: plain
    });
    moving.considerEscape(state);
    expect(parts.errands.shun).toHaveBeenCalledWith('1/1');
  });

  it('runs again at once from a monster that follows, though nothing walks any more', () => {
    const first = hit(10, 'Dank Room', 1);
    let going = true;
    const {
      travel: moving,
      sent,
      parts
    } = travel(first, 'none', true, undefined, {
      settings: plain,
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

  it('waits out the cooldown in a room nothing followed it into', () => {
    const first = hit(10, 'Dank Room', 1);
    const {
      travel: moving,
      sent,
      parts
    } = travel(first, 'none', true, undefined, {
      settings: plain
    });
    moving.considerEscape(first);
    const empty = { ...hit(6, 'Weapons Shop', 2), combat: { ...first.combat, attackers: [] } };
    (parts.tracker as { current: CharacterState }).current = empty;
    moving.settleEscape({ type: 'room' } as never, first.room);
    moving.considerEscape(empty);
    expect(sent).toEqual(['n']);
  });
});

/* A follower leaves running away to the leader, even with a lap of its own running. */
describe('running away while following', () => {
  it('stays with the party and says so once', () => {
    const base = beside();
    const state: CharacterState = {
      ...base,
      inCombat: true,
      vitals: { ...base.vitals, hp: 5 },
      party: { ...base.party, following: 'Brackle' }
    };
    const { travel: follower, sent, notices, decisions } = travel(state, 'held');
    follower.considerEscape(state);
    follower.considerEscape(state);
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      t('session.safety.escapeFollowing', {
        why: t('session.safety.whyHealth', { percent: '5%' }),
        leader: 'Brackle',
        then: t('session.safety.escapeStanding')
      })
    ]);
    expect(decisions.map((decision) => decision.acted)).toEqual([false]);
  });

  it('runs once nobody is being followed', () => {
    const base = beside();
    const state: CharacterState = { ...base, inCombat: true, vitals: { ...base.vitals, hp: 5 } };
    const { travel: alone, sent } = travel(state, 'held');
    alone.considerEscape(state);
    expect(sent).toEqual(['n']);
  });
});

/*
 * Todo 03: a character hung up hurt, the player turned automation off to log
 * back in, then sent it to a room to run there. The press turns it back on.
 */
describe('a route asked for with automation off', () => {
  const route: Route = { steps: [], cost: 0, blocked: false };
  const items = [{ id: 1, name: 'rope' }];

  it('turns automation on, says so, and walks', () => {
    const master = { on: false, writes: true };
    const { travel: moving, parts, notices, switched } = travel(beside(), 'none', false, master);
    vi.mocked(parts.itemErrand.collect).mockImplementation(() => {
      // Positive control: the walk is asked for after the switch is read back.
      expect(master.on).toBe(true);
      return null;
    });
    expect(moving.collectThenWalk(items, route)).toBeNull();
    expect(switched).toEqual([true]);
    expect(notices).toEqual([t('session.walk.automationOn')]);
  });

  it('puts the switch back when the walk is refused anyway', () => {
    const master = { on: false, writes: true };
    const { travel: moving, parts, notices, switched } = travel(beside(), 'none', false, master);
    vi.mocked(parts.itemErrand.collect).mockReturnValue('no way there');
    expect(moving.collectThenWalk(items, route)).toBe('no way there');
    expect(switched).toEqual([true, false]);
    expect(master.on).toBe(false);
    expect(notices).toEqual([]);
  });

  it('refuses out loud when the file will not take the write', () => {
    const master = { on: false, writes: false };
    const { travel: moving, parts, switched } = travel(beside(), 'none', false, master);
    expect(moving.collectThenWalk(items, route)).toBe(t('session.walk.automationNotOn'));
    expect(switched).toEqual([true]);
    expect(parts.itemErrand.collect).not.toHaveBeenCalled();
  });

  it('touches nothing when automation is already on', () => {
    const { travel: moving, parts, notices, switched } = travel(beside(), 'none', false);
    vi.mocked(parts.itemErrand.collect).mockReturnValue(null);
    expect(moving.collectThenWalk(items, route)).toBeNull();
    expect(switched).toEqual([]);
    expect(notices).toEqual([]);
  });
});

/* A key the panel says to fetch is fetched where the navigation engine plans it. */
describe('collecting before a walk', () => {
  it("fetches a key the plan gets from the plan's source, and the rest as asked", () => {
    const { travel: moving, parts } = travel(beside(), 'none', true);
    const step = {
      kind: 'kill',
      item: { id: 1, name: 'rope' },
      monster: 'troll',
      room: '1/9',
      roomName: 'Cave',
      odds: { kind: 'win', survives: null }
    } as const;
    const route: Route = {
      steps: [
        {
          from: '1/1',
          to: '1/5',
          direction: 'n',
          command: 'n',
          name: 'Gate',
          requirement: null,
          dark: false
        }
      ],
      cost: 1,
      blocked: false
    };
    vi.mocked(parts.errands.planTo).mockReturnValue({
      kind: 'plan',
      steps: [{ kind: 'walk', route }, step],
      cost: 1
    });
    vi.mocked(parts.itemErrand.collect).mockReturnValue(null);
    const items = [
      { id: 1, name: 'rope' },
      { id: 2, name: 'torch' }
    ];
    expect(moving.collectThenWalk(items, route)).toBeNull();
    expect(parts.errands.planTo).toHaveBeenCalledWith('1/5');
    expect(vi.mocked(parts.itemErrand.collect).mock.calls[0]?.[0]).toEqual([
      { id: 1, name: 'rope', from: { step, moves: 1 } },
      { id: 2, name: 'torch' }
    ]);
  });
});

/*
 * Run it (todo 06): auto-combat off for the way there, and back on when the
 * run arrives (the user, 2026-10-03). Nothing else writes the switch.
 */
describe('a route run with auto-combat off', () => {
  const ROUTE = {
    steps: [{ from: '1/1', to: '1/2' }],
    cost: 1,
    blocked: false
  } as unknown as Route;
  const fighting = { ...config, combat: { ...config.combat, enabled: true } };

  function running(settings: AutomationConfig) {
    const made = travel(beside(), 'stepping', false, { on: true, writes: true }, { settings });
    // As the walker does: every accepted start says so through `destination`.
    made.parts.walker.start = vi.fn(() => {
      made.travel.walkStarted();
      return null;
    });
    made.parts.supplies.considerBeforeRoute = () => null;
    made.parts.light.beforeRoute = () => false;
    return made;
  }

  it('turns it off at the start and back on at the arrival', () => {
    const { travel: moving, combat, notices } = running(fighting);
    expect(moving.walkRoute(ROUTE, true)).toBeNull();
    expect(combat.flips).toEqual([false]);
    expect(notices).toContain(t('automation.combat.runningCombatOff'));
    moving.walkEnded(true);
    expect(combat.flips).toEqual([false, true]);
    expect(notices).toContain(t('automation.combat.onAfterRun'));
  });

  /* A walk home after an escape replaces the run without ending it. */
  it('leaves it off when another walk replaced the run and arrives', () => {
    const { travel: moving, combat } = running(fighting);
    moving.walkRoute(ROUTE, true);
    expect(combat.flips).toEqual([false]);
    moving.walkStarted();
    moving.walkEnded(true);
    expect(combat.flips).toEqual([false]);
  });

  /* A room the way must empty is fought on any odds while the asked walk runs (2026-10-03). */
  it('fights the rooms the asked route must empty, and lets them go when it ends', () => {
    const { travel: moving, parts } = running(config);
    const clearing: Route = {
      ...ROUTE,
      fights: [
        { monsters: ['hydra'], roomName: 'Pit', item: null, odds: { kind: 'lose', survives: 0.2 } },
        { monsters: ['troll'], roomName: 'Cave', item: 'iron key', odds: { kind: 'unread' } }
      ]
    };
    expect(moving.walkRoute(clearing)).toBeNull();
    expect(parts.combat.alsoFight).toHaveBeenCalledWith('hydra');
    expect(parts.combat.alsoFight).not.toHaveBeenCalledWith('troll');
    moving.walkEnded(true);
    expect(parts.combat.stopFighting).toHaveBeenCalledWith('hydra');
  });

  it('leaves it off when the run stops short', () => {
    const { travel: moving, combat } = running(fighting);
    moving.walkRoute(ROUTE, true);
    moving.walkEnded(false);
    expect(combat.flips).toEqual([false]);
    expect(combat.on).toBe(false);
  });

  it('never writes it for a route walked rather than run', () => {
    const { travel: moving, combat } = running(config);
    // Positive control: the walk started.
    expect(moving.walkRoute(ROUTE)).toBeNull();
    expect(moving.walkIsAsked).toBe(true);
    moving.walkEnded(true);
    expect(combat.flips).toEqual([]);
  });
});

/* Todo 11: a light the dark rooms want is bought before the route and the lap. */
describe('a light bought before the dark', () => {
  const ROUTE = {
    steps: [{ from: '1/1', to: '1/2' }],
    cost: 1,
    blocked: false
  } as unknown as Route;

  it('hands the route to the light, and walks it now only when nothing is bought', () => {
    const state = beside();
    const { travel: moving, parts } = travel(state, 'none', false);
    parts.supplies.considerBeforeRoute = () => null;
    const beforeRoute = vi.fn(() => true);
    parts.light.beforeRoute = beforeRoute;
    expect(moving.walkRoute(ROUTE, true)).toBeNull();
    expect(beforeRoute).toHaveBeenCalledWith(ROUTE, state, true);
    expect(parts.walker.start).not.toHaveBeenCalled();
    parts.light.beforeRoute = () => false;
    moving.walkRoute(ROUTE);
    expect(parts.walker.start).toHaveBeenCalledWith(ROUTE, state);
  });

  it('asks for a lap once it has started, and not for one refused', () => {
    const state = beside();
    const { travel: looping, parts } = travel(state, 'none', false);
    const loop = { name: 'crypt', stops: [{ room: 'Crypt 1/3' }] };
    parts.loops.start = () => 'no';
    looping.startLoop(loop);
    expect(parts.light.beforeLap).not.toHaveBeenCalled();
    parts.loops.start = () => null;
    expect(looping.startLoop(loop)).toEqual({ started: true });
    expect(parts.light.beforeLap).toHaveBeenCalledWith(loop, state);
  });
});

/*
 * Todo 15: a stop during the trip to the shop before a route. The trip ends on
 * the walk's ending and lets go synchronously, which walked the character on
 * to the route's destination: the stop started a walk.
 */
describe('a stop on the way to the shop before a route', () => {
  const route = {
    steps: [{ from: '1/1', to: '1/2', command: 'n', name: 'Town Gates' }],
    blocked: false
  } as unknown as Route;

  it('stays put, and says the route it was owed is not walked on to', () => {
    const { travel: going, parts, notices } = travel(beside(), 'stepping');
    vi.mocked(parts.supplies.considerBeforeRoute).mockReturnValue({
      item: { name: 'torch' },
      shopName: 'General Store'
    } as unknown as ReturnType<typeof parts.supplies.considerBeforeRoute>);
    expect(going.walkRoute(route)).toBeNull();
    // The trip's own ending, as `Supplies.finish` releases it.
    vi.mocked(parts.walker.stop).mockImplementation(() => going.walkOnAfterErrand());

    going.stopMoving('Brackle');

    expect(parts.errands.planFromHere).not.toHaveBeenCalled();
    expect(parts.walker.start).not.toHaveBeenCalled();
    expect(notices).toContain(
      t('session.walk.notResumed', { destination: 'Town Gates', reason: personStop('Brackle') })
    );
  });
});
