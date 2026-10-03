import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
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
  danger: { fight?: Survival | null; percent?: number | null } = {},
  run: { unanswered: boolean } = { unanswered: false }
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
    travel: {
      runFromPlayer: () => undefined,
      get escapeUnanswered() {
        return run.unanswered;
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
    const state = standing([]);
    return { ...state, vitals: { ...state.vitals, hp: 27 } };
  };
  const config = automation({ enabled: true, penalties: false, belowHealth: 0.35 }, []);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the run to land, says so, then hangs up where it landed', () => {
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
    safety.considerHangingUp(standing([]));
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
