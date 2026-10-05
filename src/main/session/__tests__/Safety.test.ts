import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { Safety, type SafetyParts } from '../Safety';
import { HangUpWatch, type HangUpAssessment } from '../../automation/HangUp';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { classifyOccupant } from '../../../shared/mobs';
import type { MobRule } from '../../../shared/mobRules';
import type { Survival } from '../../../shared/survival';
import type { ConnectionEnd, ConnectionState } from '../../../shared/types';

const LINK: ConnectionState = {
  phase: 'connected',
  target: null,
  connectedAt: 1000,
  detail: null,
  endedBy: null,
  negotiated: {
    localEnabled: [],
    remoteEnabled: [],
    binary: false,
    suppressGoAhead: false,
    remoteEcho: false
  }
};

const stalker: RoomOccupant = classifyOccupant('stalker', {
  players: new Set<string>(),
  mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
});

/** An ordinary monster: no row names it. */
const orc: RoomOccupant = classifyOccupant('orc', {
  players: new Set<string>(),
  mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
});

/** A character at full health in a room holding `occupants`. */
function standing(occupants: RoomOccupant[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 100, hpMax: 100 },
    room: { ...base.room, name: 'A Road', occupants }
  };
}

function automation(
  hangUp: Partial<AutomationConfig['safety']['hangUp']>,
  mobRules: MobRule[]
): AutomationConfig {
  const d = DEFAULT_CONFIG.automation;
  return {
    ...d,
    enabled: true,
    combat: { ...d.combat, mobRules },
    safety: { ...d.safety, hangUp: { ...d.safety.hangUp, ...hangUp } }
  };
}

function build(
  config: AutomationConfig,
  state: CharacterState,
  assessment: HangUpAssessment = { clean: true, reasons: [], clearInMs: null },
  danger: { fight?: Survival | null; percent?: number | null } = {},
  run: { unanswered: boolean; landings?: number } = { unanswered: false }
) {
  const notices: string[] = [];
  const decisions: SafetyDecision[] = [];
  const hungUp: ConnectionEnd[] = [];
  const watch = new HangUpWatch();
  const parts: SafetyParts = {
    tracker: { current: state },
    hangUp: {
      assess: () => assessment,
      clean: () => assessment.clean,
      monsterNear: (here, now) => watch.monsterNear(here, now)
    },
    realmMenu: {
      penalty:
        danger.percent === undefined || danger.percent === null
          ? null
          : { realm: 'Paradigm', percent: danger.percent },
      noteCommand: () => null
    },
    queue: { enqueue: () => true },
    travel: {
      runFromPlayer: () => undefined,
      get escapeUnanswered() {
        return run.unanswered;
      },
      get landings() {
        return run.landings ?? 0;
      }
    },
    client: { connected: true },
    publisher: { state: LINK, noteSafety: (decision) => void decisions.push(decision) },
    grounded: { down: false }
  };
  const safety = new Safety(parts, {
    config: () => config,
    disconnect: (by) => void hungUp.push(by),
    notice: (message) => void notices.push(message)
  });
  return { safety, notices, decisions, hungUp };
}

/*
 * Todo 818: a monster whose row says `hangup` — MegaMUD's *Hangup* — is a
 * reason to hang up of its own, under the same switch and the realm's same
 * penalty. The fork disconnected with the switch off.
 */
describe('hanging up on a monster its row names', () => {
  const rows: MobRule[] = [{ mob: 'stalker', treat: 'hangup' }];

  it('does nothing with the switch off, and says so once', () => {
    const state = standing([stalker]);
    const { safety, notices, decisions, hungUp } = build(
      automation({ enabled: false }, rows),
      state
    );
    safety.considerHangingUp(state);
    safety.considerHangingUp(state);
    expect(hungUp).toEqual([]);
    const why = t('session.safety.whyStalker', { mob: 'stalker' });
    const reason = t('session.safety.hangUpOffReason');
    expect(notices).toEqual([t('session.safety.hangUpSwitchedOff', { why, reason })]);
    expect(decisions).toEqual([
      expect.objectContaining({ action: 'hang up', acted: false, refused: reason })
    ]);
  });

  it('hangs up with the switch on, where the realm charges nothing (the control)', () => {
    const state = standing([stalker]);
    const { safety, decisions, hungUp } = build(
      automation({ enabled: true, penalties: false }, rows),
      state
    );
    safety.considerHangingUp(state);
    expect(hungUp).toEqual(['client']);
    expect(decisions.at(-1)).toMatchObject({
      action: 'hang up',
      acted: true,
      because: t('session.safety.whyStalker', { mob: 'stalker' })
    });
  });

  it('keeps to the realm’s penalty: refused while the hang-up would be charged', () => {
    const state = standing([stalker]);
    const { safety, hungUp, decisions } = build(
      automation({ enabled: true, penalties: true }, rows),
      state,
      { clean: false, reasons: ['stalker attacks on sight'], clearInMs: null }
    );
    safety.considerHangingUp(state);
    expect(hungUp).toEqual([]);
    expect(decisions.at(-1)).toMatchObject({ acted: false, refused: 'stalker attacks on sight' });
  });

  it('does nothing where no row names what is here', () => {
    const state = standing([stalker]);
    const { safety, notices, hungUp } = build(
      automation({ enabled: true, penalties: false }, []),
      state
    );
    safety.considerHangingUp(state);
    expect(hungUp).toEqual([]);
    expect(notices).toEqual([]);
  });
});

/*
 * festus, 2026-10-03: `nw` and the hang-up went in one millisecond at 27%,
 * the line dropped before the step, and he logged back in at 74 hp beside
 * the zombie he had run from.
 */
describe('hanging up with a run on the wire', () => {
  const hurt = (): CharacterState => {
    const state = standing([orc]);
    return { ...state, vitals: { ...state.vitals, hp: 27 } };
  };
  const config = automation({ enabled: true, penalties: false, belowHealth: 0.35 }, []);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the run, says so, then hangs up when the run did not land', () => {
    const run = { unanswered: true };
    const state = hurt();
    const { safety, notices, hungUp } = build(config, state, undefined, {}, run);
    safety.considerHangingUp(state);
    safety.considerHangingUp(state);
    expect(hungUp).toEqual([]);
    const why = t('session.safety.whyHealth', { percent: '27%' });
    expect(notices).toEqual([t('session.safety.hangUpAfterRun', { why })]);
    run.unanswered = false;
    safety.considerHangingUp(state);
    expect(hungUp).toEqual(['client']);
  });

  /* A run that ended with health back above the line leaves no wait behind for the next one. */
  it('waits again for a later run after health came back between them', () => {
    vi.useFakeTimers();
    const run = { unanswered: true };
    const low = hurt();
    const { safety, notices, hungUp } = build(config, low, undefined, {}, run);
    safety.considerHangingUp(low);
    run.unanswered = false;
    safety.considerHangingUp(standing([orc]));
    vi.advanceTimersByTime(10 * tuning().session.hangUpAfterRunMs);
    run.unanswered = true;
    safety.considerHangingUp(low);
    expect(hungUp).toEqual([]);
    expect(notices).toHaveLength(2);
  });

  it('hangs up anyway once the run has had its time', () => {
    vi.useFakeTimers();
    const state = hurt();
    const { safety, hungUp } = build(config, state, undefined, {}, { unanswered: true });
    safety.considerHangingUp(state);
    expect(hungUp).toEqual([]);
    vi.advanceTimersByTime(tuning().session.hangUpAfterRunMs);
    safety.considerHangingUp(state);
    expect(hungUp).toEqual(['client']);
  });
});

/*
 * Todo 21, festus 2026-10-03 (t=9693846): one round took him from 187 to 94
 * of 319 (29%), under the run line (40%) and the hang-up line (35%) at once.
 * The run goes first; the hang-up decides on where it lands.
 */
describe('one decision for a health drop: the run, then the hang-up', () => {
  const config = automation({ enabled: true, penalties: false, belowHealth: 0.35 }, []);
  const at = (hp: number, attackers: string[] = []): CharacterState => {
    const state = standing([orc]);
    return {
      ...state,
      vitals: { ...state.vitals, hp, hpMax: 319 },
      combat: { ...state.combat, attackers }
    };
  };
  const ran = () => {
    const run = { unanswered: true, landings: 0 };
    const built = build(config, at(94), undefined, {}, run);
    built.safety.considerHangingUp(at(94));
    run.unanswered = false;
    run.landings = 1;
    return { ...built, run };
  };
  const why = t('session.safety.whyHealth', { percent: '29%' });

  it('does not hang up where the run got out and nothing attacks', () => {
    const { safety, notices, decisions, hungUp } = ran();
    safety.considerHangingUp(at(94));
    safety.considerHangingUp(at(96));
    expect(hungUp).toEqual([]);
    const refused = t('session.safety.hangUpRunGotOut');
    expect(notices).toEqual([
      t('session.safety.hangUpAfterRun', { why }),
      t('session.safety.hangUpNotBut', { why, refused })
    ]);
    expect(decisions.at(-1)).toMatchObject({ action: 'hang up', acted: false, refused });
  });

  it('hangs up where the run landed once it is attacked there', () => {
    const { safety, notices, hungUp } = ran();
    safety.considerHangingUp(at(94));
    expect(safety.takesOver(at(94, ['big stitched zombie']))).toBe(true);
    safety.considerHangingUp(at(94, ['big stitched zombie']));
    expect(hungUp).toEqual(['client']);
    expect(notices).toContain(t('session.safety.hangUpRunCaught', { why }));
  });

  it('hangs up where the run landed once health falls again', () => {
    const { safety, hungUp } = ran();
    safety.considerHangingUp(at(94));
    safety.considerHangingUp(at(80));
    expect(hungUp).toEqual(['client']);
  });

  /* The control for `takesOver`: nothing caught it, so a second run is not held back. */
  it('lets a second run go while nothing has caught the first', () => {
    const { safety } = ran();
    safety.considerHangingUp(at(94));
    expect(safety.takesOver(at(94))).toBe(false);
  });

  it('forgets the run once health is back over the line', () => {
    const { safety, hungUp } = ran();
    safety.considerHangingUp(at(94));
    safety.considerHangingUp(at(200));
    safety.considerHangingUp(at(100));
    expect(hungUp).toEqual(['client']);
  });

  /* A charged realm with a monster on the character: the hang-up would refuse, so the run goes. */
  it('does not take over where the hang-up would be refused', () => {
    const run = { unanswered: true, landings: 0 };
    const refusedHere = { clean: false, reasons: ['in combat'], clearInMs: null };
    const charged = automation({ enabled: true, penalties: true, belowHealth: 0.35 }, []);
    const { safety, notices, hungUp } = build(charged, at(94), refusedHere, {}, run);
    safety.considerHangingUp(at(94));
    run.unanswered = false;
    run.landings = 1;
    safety.considerHangingUp(at(94));
    expect(safety.takesOver(at(94, ['big stitched zombie']))).toBe(false);
    safety.considerHangingUp(at(94, ['big stitched zombie']));
    expect(hungUp).toEqual([]);
    expect(notices.slice(-2)).toEqual([
      t('session.safety.hangUpRunCaught', { why }),
      t('session.safety.hangUpRefused', { why, reasons: 'in combat' })
    ]);
  });
});

/*
 * Todo 01: low health is a reason to hang up only beside a monster or in a
 * fight. Reconnecting hurt into an empty room does not hang up.
 */
describe('hanging up for health only where something could hit you', () => {
  const config = automation({ enabled: true, penalties: false, belowHealth: 0.35 }, []);
  const low = (occupants: RoomOccupant[]): CharacterState => {
    const state = standing(occupants);
    return { ...state, vitals: { ...state.vitals, hp: 20 } };
  };
  const why = t('session.safety.whyHealth', { percent: '20%' });

  it('does not hang up in an empty room, and says so once', () => {
    const { safety, notices, decisions, hungUp } = build(config, low([]));
    safety.considerHangingUp(low([]));
    safety.considerHangingUp(low([]));
    expect(hungUp).toEqual([]);
    const refused = t('session.safety.hangUpNoMonster');
    expect(notices).toEqual([t('session.safety.hangUpNotBut', { why, refused })]);
    expect(decisions).toEqual([
      expect.objectContaining({ action: 'hang up', acted: false, refused })
    ]);
  });

  it('hangs up once a monster walks in', () => {
    const { safety, hungUp } = build(config, low([]));
    safety.considerHangingUp(low([]));
    expect(hungUp).toEqual([]);
    safety.considerHangingUp(low([orc]));
    expect(hungUp).toEqual(['client']);
  });

  it('counts a name it cannot place as a monster', () => {
    const stranger = classifyOccupant('Gorgo', {
      players: new Set<string>(),
      mob: () => undefined
    });
    expect(stranger.kind).toBe('unknown');
    const { safety, hungUp } = build(config, low([stranger]));
    safety.considerHangingUp(low([stranger]));
    expect(hungUp).toEqual(['client']);
  });

  it('says again when the room first seen since connecting is empty', () => {
    const unseen = low([]);
    unseen.room = { ...unseen.room, resolvedBy: 'remembered' };
    const { safety, notices, hungUp } = build(config, unseen);
    safety.considerHangingUp(unseen);
    safety.considerHangingUp(low([]));
    safety.considerHangingUp(low([]));
    expect(hungUp).toEqual([]);
    expect(notices).toEqual([
      t('session.safety.hangUpNotBut', { why, refused: t('session.safety.hangUpRoomUnseen') }),
      t('session.safety.hangUpNotBut', { why, refused: t('session.safety.hangUpNoMonster') })
    ]);
  });

  it('hangs up in a fight the room listing does not show', () => {
    const state = low([]);
    const fighting = { ...state, combat: { ...state.combat, attackers: ['thug'] } };
    const { safety, hungUp } = build(config, fighting);
    safety.considerHangingUp(fighting);
    expect(hungUp).toEqual(['client']);
  });
});
