import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { personStop } from '../../automation/personStop';
import { runStarted } from '../../automation/walk/startWords';
import { Travel, type TravelParts, type TravelSession } from '../Travel';
import type { SafetyDecision } from '../../../shared/automation';
import type { DecisionKind } from '../../../shared/decisionSettings';
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
  const kinds: Array<DecisionKind | undefined> = [];
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
      findStop: vi.fn(() => 'unplaced'),
      shun: vi.fn(),
      boughtTo: vi.fn(() => null),
      priceAt: vi.fn(() => null),
      legsThrough: vi.fn(() => null)
    },
    roomHazards: { stoppersAlong: vi.fn(() => []), counterFor: vi.fn(() => null) },
    queue: {
      enqueue: (intent) => {
        sent.push(intent.command);
        kinds.push(intent.decision);
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
      notePvpWindow: vi.fn(),
      noteOnline: vi.fn(),
      carried: false,
      heading: null,
      headingKind: null,
      strayedFrom: null,
      place: null
    },
    combat: { willFight: true, alsoFight: vi.fn(), stopFighting: vi.fn() },
    supplies: { current: null, considerBeforeRoute: vi.fn(), abandon: vi.fn(), fetch: vi.fn() },
    remotes: {
      stoppers: { settle: vi.fn(), askWealth: vi.fn(), purseOf: vi.fn(), forget: vi.fn() },
      ask: vi.fn(() => true)
    },
    trainLevel: { busy: false, abandon: vi.fn() },
    outgrown: { busy: false, abandon: vi.fn() },
    recoverGear: { busy: false, deciding: () => false },
    hostTrips: { busy: false, abandon: vi.fn(), stop: vi.fn() },
    areaSearch: { busy: false, abandon: vi.fn(), stop: vi.fn() },
    hunt: { noteStopped: vi.fn(), noteLapStopped: vi.fn() },
    itemErrand: { running: false, collect: vi.fn(), abandon: vi.fn() },
    questRunner: { running: false, abandon: vi.fn() },
    light: { beforeRoute: () => false, beforeLap: vi.fn() }
  };
  const settings = overrides.settings ?? config;
  // The combat switch as the file holds it, and every write of it.
  const combat = { on: settings.combat.enabled, flips: [] as boolean[] };
  // And Auto-Rest's (todo 148).
  const rest = { on: settings.health.autoRest, flips: [] as boolean[] };
  const session: TravelSession = {
    config: () => ({
      ...settings,
      enabled: master.on,
      combat: { ...settings.combat, enabled: combat.on },
      health: { ...settings.health, autoRest: rest.on }
    }),
    movement:
      overrides.movement ??
      (() => (going ? { kind: 'route', moving: true, resumable: false } : { ...NOT_MOVING })),
    loopNamed: () => undefined,
    dropTyped: vi.fn(),
    notice: (message) => void notices.push(message),
    decided: (decision) => void decisions.push(decision),
    hangUpTakesOver: overrides.hangUpTakesOver ?? (() => false),
    fled: overrides.fled ?? (() => []),
    keepFled: overrides.keepFled ?? (() => {}),
    driven: overrides.driven ?? (() => false),
    switchAutomation: (name, on) => {
      if (name === 'combat') {
        combat.flips.push(on);
        if (master.writes) combat.on = on;
        return master.writes;
      }
      if (name === 'autoRest') {
        rest.flips.push(on);
        if (master.writes) rest.on = on;
        return master.writes;
      }
      switched.push(on);
      if (master.writes) master.on = on;
      return master.writes;
    }
  };
  return {
    travel: new Travel(parts, session),
    parts,
    sent,
    kinds,
    notices,
    decisions,
    switched,
    combat,
    rest
  };
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

  /* 2026-10-06, on review: a death the gear recovery has not decided on holds trips and goes nowhere itself. */
  it('stays while the gear recovery decides, which holds every other trip', () => {
    const state = beside();
    const { travel: deciding, parts, sent } = travel(state, 'none', false);
    parts.recoverGear.deciding = () => true;
    deciding.considerEscape(state);
    expect(sent).toEqual([]);
    expect(deciding.holdsTrips()).toBe(true);
    expect(deciding.errandUnderWay()).toBe(false);
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
      kinds,
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
    expect(kinds).toEqual(['run-away']);
    expect(kept.map((list) => list.map((entry) => entry.name))).toEqual([['black ooze']]);
  });

  /* Todo 73: and the room it ran out of is kept out of a trip's route for a while (todo 19). */
  it('marks the room it ran out of for a trip to go round', () => {
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
  const switchedOff = { ...config, combat: { ...config.combat, enabled: false } };

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
    const { travel: moving, combat, notices, parts } = running(fighting);
    expect(moving.walkRoute(ROUTE, true)).toBeNull();
    expect(combat.flips).toEqual([false]);
    // One line, said here once the switch answered; the walker started quiet.
    expect(notices).toContain(runStarted(ROUTE, true));
    // And its steps are timed to the rounds (todo 00).
    expect(parts.walker.start).toHaveBeenCalledWith(ROUTE, expect.anything(), {
      offRounds: true,
      startSaid: false
    });
    moving.walkEnded(true);
    expect(combat.flips).toEqual([false, true]);
    expect(notices).toContain(t('automation.combat.onAfterRun'));
  });

  /* A walk nobody asked for, not the walk home, replaces the run without ending it. */
  it('leaves it off when another walk replaced the run and arrives', () => {
    const { travel: moving, combat } = running(fighting);
    moving.walkRoute(ROUTE, true);
    expect(combat.flips).toEqual([false]);
    moving.walkStarted();
    moving.walkEnded(true);
    expect(combat.flips).toEqual([false]);
  });

  /* Todo 145, the user's answer of 2026-10-15: the walk home gives back the run it replaced. */
  describe('when the walk home after an escape replaced the run', () => {
    const haven: AutomationConfig = {
      ...fighting,
      safety: {
        ...fighting.safety,
        retreat: { ...fighting.safety.retreat, strategy: 'safe-haven', safeHavenRoom: 'Hall 1/1' }
      }
    };

    function walkingHome() {
      const state = beside();
      const made = travel(state, 'held', true, { on: true, writes: true }, { settings: haven });
      made.parts.walker.start = vi.fn(() => {
        made.travel.walkStarted();
        return null;
      });
      made.parts.supplies.considerBeforeRoute = () => null;
      vi.mocked(made.parts.errands.findStop).mockReturnValue({ map: 1, room: 1 } as never);
      vi.mocked(made.parts.errands.routeBetween).mockReturnValue(ROUTE);
      made.travel.walkRoute(ROUTE, true);
      made.travel.considerEscape(state);
      made.travel.walkHomeIfDue({ ...state, room: { ...state.room, map: 2, number: 5 } });
      // Positive control: the run turned it off and the walk home is under way.
      expect(made.combat.flips).toEqual([false]);
      expect(made.parts.walker.start).toHaveBeenLastCalledWith(
        ROUTE,
        expect.anything(),
        expect.objectContaining({ asked: false })
      );
      expect(made.travel.walkIsAsked).toBe(false);
      return made;
    }

    it('turns it back on when the walk home arrives', () => {
      const { travel: moving, combat, notices } = walkingHome();
      moving.walkEnded(true);
      expect(combat.flips).toEqual([false, true]);
      expect(notices).toContain(t('automation.combat.onAfterRun'));
    });

    it('turns it back on when the walk home stops short out of a fight', () => {
      const { travel: moving, combat, notices } = walkingHome();
      moving.walkEnded(false);
      expect(moving.retreatArmed).toBe(false);
      expect(combat.flips).toEqual([false, true]);
      expect(notices).toContain(t('automation.combat.onAfterRunEnded'));
    });

    it('turns it back on when the player stops the walk home', () => {
      const { travel: moving, combat, parts, notices } = walkingHome();
      // As the walker does: the stop says the walk ended.
      parts.walker.stop = vi.fn(() => moving.walkEnded(false));
      moving.stopMoving();
      expect(parts.walker.stop).toHaveBeenCalled();
      expect(combat.flips).toEqual([false, true]);
      expect(notices).toContain(t('automation.combat.onAfterRunEnded'));
    });

    it('turns it back on when a death ends the walk home', () => {
      const { travel: moving, combat } = walkingHome();
      moving.stopGoingAnywhere();
      expect(combat.flips).toEqual([false, true]);
    });

    it('leaves it off while a fight cut the walk home short and arms it again', () => {
      const { travel: moving, combat, parts } = walkingHome();
      Object.assign(parts.tracker, { current: { ...parts.tracker.current, inCombat: true } });
      moving.walkEnded(false);
      expect(moving.retreatArmed).toBe(true);
      expect(combat.flips).toEqual([false]);
    });
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

  /* Todo 145: a run stopped on a spent token left Festus unable to hit back. */
  it('turns it back on when the run stops short', () => {
    const { travel: moving, combat, notices } = running(fighting);
    moving.walkRoute(ROUTE, true);
    expect(combat.flips).toEqual([false]);
    moving.walkEnded(false);
    expect(combat.flips).toEqual([false, true]);
    expect(notices).toContain(t('automation.combat.onAfterRunEnded'));
  });

  it('leaves it off when a run that never turned it off stops short', () => {
    const { travel: moving, combat, notices } = running(switchedOff);
    // Positive control: the run started, and found it already off.
    expect(moving.walkRoute(ROUTE, true)).toBeNull();
    expect(moving.walkIsAsked).toBe(true);
    expect(notices).toContain(runStarted(ROUTE, false));
    expect(notices).not.toContain(runStarted(ROUTE, true));
    moving.walkEnded(false);
    expect(combat.flips).toEqual([]);
  });

  /* Any asked route arrives with it on, walked as well as run (the user, 2026-10-08). */
  it('turns it on when a route walked rather than run arrives', () => {
    const { travel: moving, combat, notices } = running(switchedOff);
    expect(moving.walkRoute(ROUTE)).toBeNull();
    expect(moving.walkIsAsked).toBe(true);
    moving.walkEnded(true);
    expect(combat.flips).toEqual([true]);
    expect(notices).toContain(t('automation.combat.onAfterRun'));
  });

  it('leaves it off when a walked route stops short', () => {
    const { travel: moving, combat } = running(switchedOff);
    // Positive control: the walk started and is the player's.
    expect(moving.walkRoute(ROUTE)).toBeNull();
    expect(moving.walkIsAsked).toBe(true);
    moving.walkEnded(false);
    expect(combat.flips).toEqual([]);
  });

  it('leaves it off when an errand leg arrives', () => {
    const { travel: moving, combat } = running(switchedOff);
    moving.walkStarted();
    expect(moving.walkIsAsked).toBe(false);
    moving.walkEnded(true);
    expect(combat.flips).toEqual([]);
  });

  it('says so when the file will not take it at the lap', () => {
    const made = travel(
      beside(),
      'stepping',
      false,
      { on: true, writes: false },
      { settings: switchedOff }
    );
    made.travel.combatOnForLap();
    expect(made.notices).toContain(t('automation.combat.onForLapRefused'));
  });

  /* 2026-10-08: a run ended short on one launch and the next fought nothing for eight hours. */
  it('owes it back only while the run that turned it off is under way', () => {
    const { travel: moving, combat } = running(fighting);
    expect(moving.combatOffForRunNow).toBe(false);
    moving.walkRoute(ROUTE, true);
    expect(moving.combatOffForRunNow).toBe(true);
    // Stopped short, it is given back now, so nothing is owed at a relaunch.
    moving.walkEnded(false);
    expect(combat.on).toBe(true);
    expect(moving.combatOffForRunNow).toBe(false);
  });

  it('owes nothing once the switch is on, whoever turned it on', () => {
    const { travel: moving, combat } = running(fighting);
    moving.walkRoute(ROUTE, true);
    expect(moving.combatOffForRunNow).toBe(true);
    // The player turns it on from the card, past `Travel`.
    combat.on = true;
    expect(moving.combatOffForRunNow).toBe(false);
  });

  it('gives it back at the next launch, and says why', () => {
    const { travel: moving, combat, notices } = running(switchedOff);
    moving.combatBackAfterLaunch();
    expect(combat.flips).toEqual([true]);
    expect(notices).toContain(t('automation.combat.onAfterLaunch'));
    expect(moving.combatOffForRunNow).toBe(false);
  });

  it('keeps owing it when the file will not take it at the launch', () => {
    const made = travel(
      beside(),
      'stepping',
      false,
      { on: true, writes: false },
      { settings: switchedOff }
    );
    made.travel.combatBackAfterLaunch();
    expect(made.notices).toContain(t('automation.combat.onAfterLaunchRefused'));
    expect(made.travel.combatOffForRunNow).toBe(true);
  });

  it('turns it on at the lap and says so', () => {
    const { travel: moving, combat, notices } = running(switchedOff);
    moving.combatOnForLap();
    expect(combat.flips).toEqual([true]);
    expect(notices).toContain(t('automation.combat.onForLap'));
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
    expect(parts.walker.start).toHaveBeenCalledWith(ROUTE, state, {
      offRounds: false,
      startSaid: true
    });
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

/*
 * Todo 28: only a walk the player named a room for is a recent destination.
 * `startingAskedWalk` is read inside `Walker.start`, where `destination` fires.
 */
describe('which walks are recent destinations', () => {
  const ROUTE = {
    steps: [{ from: '1/1', to: '1/2' }],
    cost: 1,
    blocked: false
  } as unknown as Route;

  function watching() {
    const made = travel(
      beside(),
      'stepping',
      false,
      { on: true, writes: true },
      { settings: config }
    );
    const asked: boolean[] = [];
    made.parts.walker.start = vi.fn(() => {
      asked.push(made.travel.startingAskedWalk);
      made.travel.walkStarted();
      return null;
    });
    made.parts.supplies.considerBeforeRoute = () => null;
    made.parts.light.beforeRoute = () => false;
    return { ...made, asked };
  }

  it('counts the route the player asked for', () => {
    const { travel: moving, asked } = watching();
    expect(moving.walkRoute(ROUTE)).toBeNull();
    expect(asked).toEqual([true]);
    expect(moving.startingAskedWalk).toBe(false);
  });

  it("leaves out an errand's leg", () => {
    const { travel: moving, parts, asked } = watching();
    vi.mocked(parts.errands.planFromHere).mockReturnValue(ROUTE);
    expect(moving.walkLegTo('1/2')).toBeNull();
    // Positive control: the leg did start.
    expect(parts.walker.start).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([false]);
  });
});

/*
 * Auto-Rest turned off (todo 148) is put back on at the start of a walk or a
 * loop, on arriving and on connecting (the user, 2026-10-15), as auto-combat is.
 */
describe('auto-rest put back on', () => {
  const ROUTE = {
    steps: [{ from: '1/1', to: '1/2' }],
    cost: 1,
    blocked: false
  } as unknown as Route;
  const restOff = { ...config, health: { ...config.health, autoRest: false } };

  function made(settings: AutomationConfig, writes = true) {
    const it = travel(beside(), 'stepping', false, { on: true, writes }, { settings });
    it.parts.walker.start = vi.fn(() => {
      it.travel.walkStarted();
      return null;
    });
    it.parts.supplies.considerBeforeRoute = () => null;
    it.parts.light.beforeRoute = () => false;
    return it;
  }

  it('turns it on before a walk the player asked for, and says so', () => {
    const { travel: moving, rest, notices, parts } = made(restOff);
    parts.walker.start = vi.fn(() => {
      // The first room is judged with it on.
      expect(rest.on).toBe(true);
      moving.walkStarted();
      return null;
    });
    expect(moving.walkForPlayer(ROUTE)).toBeNull();
    expect(rest.flips).toEqual([true]);
    expect(notices).toContain(t('automation.autoRest.onForWalk'));
  });

  it('leaves it off when the walk is refused anyway', () => {
    const { travel: moving, rest, notices, parts } = made(restOff);
    parts.walker.start = vi.fn(() => 'no way');
    expect(moving.walkForPlayer(ROUTE)).toBe('no way');
    expect(rest.flips).toEqual([true, false]);
    expect(rest.on).toBe(false);
    expect(notices).not.toContain(t('automation.autoRest.onForWalk'));
  });

  it('writes nothing where it is already on', () => {
    const { travel: moving, rest, parts } = made(config);
    parts.loops.start = () => null;
    expect(moving.walkForPlayer(ROUTE)).toBeNull();
    moving.walkEnded(true);
    moving.reset();
    expect(moving.startLoop({ name: 'crypt', stops: [{ room: 'Crypt 1/3' }] })).toEqual({
      started: true
    });
    expect(rest.flips).toEqual([]);
  });

  it('turns it on at the start of a loop', () => {
    const { travel: looping, rest, notices, parts } = made(restOff);
    parts.loops.start = () => null;
    expect(looping.startLoop({ name: 'crypt', stops: [{ room: 'Crypt 1/3' }] })).toEqual({
      started: true
    });
    expect(rest.on).toBe(true);
    expect(notices).toContain(t('automation.autoRest.onForLoop'));
  });

  it('turns it on when the asked walk arrives, turned off on the way', () => {
    const { travel: moving, rest, notices } = made(config);
    expect(moving.walkForPlayer(ROUTE)).toBeNull();
    // The player turns it off from the toolbar mid-walk.
    rest.on = false;
    moving.walkEnded(true);
    expect(rest.flips).toEqual([true]);
    expect(notices).toContain(t('automation.autoRest.onArrived'));
  });

  it('leaves it off when the walk stops short', () => {
    const { travel: moving, rest } = made(config);
    expect(moving.walkForPlayer(ROUTE)).toBeNull();
    rest.on = false;
    moving.walkEnded(false);
    expect(rest.flips).toEqual([]);
  });

  it('turns it on at a connection', () => {
    const { travel: moving, rest, notices } = made(restOff);
    moving.reset();
    expect(rest.on).toBe(true);
    expect(notices).toContain(t('automation.autoRest.onConnected'));
  });

  it('says so when the file will not take it', () => {
    const { travel: moving, notices } = made(restOff, false);
    moving.reset();
    expect(notices).toContain(t('automation.autoRest.onConnectedRefused'));
  });
});

/*
 * Todo 02: a player's walk round a door whose key a shop sells buys the key
 * on the way, through the item errand, where `movement.buyKeys` allows it.
 */
describe('a walk that buys its key on the way', () => {
  const ROUND = {
    steps: [
      { from: '1/1', to: '1/2' },
      { from: '1/2', to: '1/3' },
      { from: '1/3', to: '1/9' }
    ],
    cost: 30,
    blocked: false,
    keysAhead: true
  } as unknown as Route;
  const THROUGH = {
    steps: [{ from: '1/1', to: '1/9' }],
    cost: 2,
    blocked: false
  } as unknown as Route;
  const pass = { id: 942, name: 'mine pass' };
  const buy = { kind: 'buy' as const, item: pass, room: '1/1' };

  function walking(settings: AutomationConfig) {
    const state = beside();
    const listed = { ...state, inventory: { ...state.inventory, listedAt: 1, rows: [] } };
    const made = travel(listed, 'none', false, { on: true, writes: true }, { settings });
    made.parts.supplies.considerBeforeRoute = () => null;
    made.parts.light.beforeRoute = () => false;
    made.parts.walker.start = vi.fn(() => null);
    vi.mocked(made.parts.errands.boughtTo).mockReturnValue({
      way: THROUGH,
      plan: { kind: 'plan', steps: [buy, { kind: 'walk', route: THROUGH }], cost: 2 }
    });
    vi.mocked(made.parts.errands.priceAt).mockReturnValue(100);
    vi.mocked(made.parts.itemErrand.collect).mockReturnValue(null);
    return made;
  }

  it('collects the key and walks the way through', () => {
    const { travel: moving, parts } = walking(config);
    expect(moving.walkRoute(ROUND)).toBeNull();
    expect(parts.errands.boughtTo).toHaveBeenCalledWith('1/9');
    expect(vi.mocked(parts.itemErrand.collect).mock.calls[0]?.[0]).toEqual([
      { ...pass, from: { step: buy, moves: 0 } }
    ]);
    expect(vi.mocked(parts.itemErrand.collect).mock.calls[0]?.[1]).toBe(THROUGH);
    expect(parts.walker.start).not.toHaveBeenCalled();
  });

  it('walks the way round with the setting off', () => {
    const off: AutomationConfig = {
      ...config,
      movement: { ...config.movement, buyKeys: false }
    };
    const { travel: moving, parts } = walking(off);
    moving.walkRoute(ROUND);
    expect(parts.itemErrand.collect).not.toHaveBeenCalled();
    expect(parts.walker.start).toHaveBeenCalledWith(ROUND, expect.anything(), {
      offRounds: false,
      startSaid: true
    });
  });
});

/* Todo 02: a walk held while the inventory is checked, and what ends it. */
describe('a walk held for the inventory', () => {
  const DOOR = {
    steps: [
      {
        from: '1/1',
        to: '1/9',
        name: 'Mine',
        requirement: { kind: 'item', raw: 'Item: 942', keyId: 942 }
      }
    ],
    cost: 2,
    blocked: false
  } as unknown as Route;

  function holding() {
    const state = beside();
    const unlisted = { ...state, inventory: { ...state.inventory, listedAt: null, rows: [] } };
    const made = travel(unlisted, 'none', false);
    made.parts.supplies.considerBeforeRoute = () => null;
    made.parts.light.beforeRoute = () => false;
    made.parts.walker.start = vi.fn(() => null);
    const listed = (rows: number[]): CharacterState => ({
      ...state,
      inventory: { ...state.inventory, listedAt: 1, rows }
    });
    return { ...made, listed };
  }

  it('asks for the inventory, then walks the pressed way when it holds the key', () => {
    const { travel: moving, parts, sent, listed } = holding();
    expect(moving.walkRoute(DOOR)).toBeNull();
    expect(sent).toEqual(['i']);
    expect(parts.walker.start).not.toHaveBeenCalled();
    moving.walkOnceListed(listed([942]));
    expect(parts.walker.start).toHaveBeenCalledWith(DOOR, expect.anything(), {
      offRounds: false,
      startSaid: true
    });
  });

  it('walks nowhere once the player has pressed Stop, and says so', () => {
    const { travel: moving, parts, notices, listed } = holding();
    moving.walkRoute(DOOR);
    moving.stopMoving();
    expect(notices).toContain(
      t('session.walk.notResumed', { destination: 'Mine', reason: personStop(null) })
    );
    moving.walkOnceListed(listed([942]));
    expect(parts.walker.start).not.toHaveBeenCalled();
  });

  it('walks nowhere after a death, and says so', () => {
    const { travel: moving, parts, notices, listed } = holding();
    moving.walkRoute(DOOR);
    moving.stopGoingAnywhere();
    expect(notices).toContain(t('session.walk.keys.dropped', { destination: 'Mine' }));
    moving.walkOnceListed(listed([942]));
    expect(parts.walker.start).not.toHaveBeenCalled();
  });
});
