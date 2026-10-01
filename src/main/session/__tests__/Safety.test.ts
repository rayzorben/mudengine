import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { Safety, type SafetyParts } from '../Safety';
import type { HangUpAssessment } from '../../automation/HangUp';
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
  danger: { fight?: Survival | null; percent?: number | null } = {}
) {
  const notices: string[] = [];
  const decisions: SafetyDecision[] = [];
  const hungUp: ConnectionEnd[] = [];
  const parts: SafetyParts = {
    tracker: { current: state },
    hangUp: { assess: () => assessment, clean: () => assessment.clean },
    realmMenu: {
      penalty:
        danger.percent === undefined || danger.percent === null
          ? null
          : { realm: 'Paradigm', percent: danger.percent },
      noteCommand: () => null
    },
    queue: { enqueue: () => true },
    travel: { runFromPlayer: () => undefined },
    client: { connected: true },
    publisher: { state: LINK, noteSafety: (decision) => void decisions.push(decision) },
    grounded: { down: false }
  };
  const safety = new Safety(parts, {
    config: () => config,
    fight: () => danger.fight ?? null,
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
 * The last resort ahead of running: the next worst round could kill, so the
 * character leaves the realm, unless the realm's charge for an unclean hangup
 * would kill it first. Death drops everything carried (`Player.Killed`).
 */
describe('hanging up before the next round could kill', () => {
  const thugs = { survives: 0.4, worstRound: 11 } as unknown as Survival;
  const hit = (hp: number): CharacterState => {
    const state = standing([stalker]);
    return {
      ...state,
      vitals: { ...state.vitals, hp, hpMax: 34 },
      combat: { ...state.combat, attackers: ['stalker'] }
    };
  };
  const dirty: HangUpAssessment = { clean: false, reasons: ['a mob targets you'], clearInMs: null };

  it('hangs up, the hang-up switch off or on, when the next round could take what is left', () => {
    const state = hit(10);
    const { safety, hungUp, decisions } = build(automation({ enabled: false }, []), state, dirty, {
      fight: thugs,
      percent: 25
    });
    expect(safety.beforeDeath(state)).toBe(true);
    expect(hungUp).toEqual(['client']);
    expect(decisions.at(-1)).toMatchObject({ action: 'hang up', acted: true });
  });

  it('stays connected where the charge would kill, and says so once', () => {
    const state = hit(6);
    const { safety, hungUp, notices } = build(automation({}, []), state, dirty, {
      fight: thugs,
      percent: 25
    });
    expect(safety.beforeDeath(state)).toBe(false);
    expect(safety.beforeDeath(state)).toBe(false);
    expect(hungUp).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it('hangs up even below the charge where the hangup is clean', () => {
    const state = hit(6);
    const { safety, hungUp } = build(automation({}, []), state, undefined, {
      fight: thugs,
      percent: 25
    });
    expect(safety.beforeDeath(state)).toBe(true);
    expect(hungUp).toEqual(['client']);
  });

  it('does nothing while the next round could not kill, out of a fight, or with nothing known', () => {
    const healthy = hit(20);
    const idle = { ...hit(5), combat: { ...hit(5).combat, attackers: [] } };
    expect(
      build(automation({}, []), healthy, dirty, { fight: thugs }).safety.beforeDeath(healthy)
    ).toBe(false);
    expect(build(automation({}, []), idle, dirty, { fight: thugs }).safety.beforeDeath(idle)).toBe(
      false
    );
    const unknown = hit(5);
    expect(build(automation({}, []), unknown, dirty, {}).safety.beforeDeath(unknown)).toBe(false);
  });
});
