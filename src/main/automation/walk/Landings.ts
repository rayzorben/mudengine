/**
 * Where a step that moves by script or spell landed: a draw, a portal, a room
 * script with conditions or a chance. The world database names one landing and
 * the server can put the character in a room whose name and exits several
 * rooms share (orohost's `dig grave` lands in 1/9478, one of 44 named Musty
 * Grottos, where gmud.zip's spell 5078 says 1/9462). One `rm` per step places
 * it. A draw, a condition or a chance landing elsewhere is planned again from
 * there; a plain portal landing elsewhere stops as a wrong room. The why is
 * `mudengine-automation` › `parts/walking.md`.
 */
import type { CharacterState } from '../../../shared/character';
import { gatesWords } from '../../../shared/gateWords';
import { roomAddress, type RouteStep } from '../../../shared/world';
import { t } from '../../app/i18n';
import { byChance } from './ChanceWays';
import type { WalkerEvents, WalkInFlight } from './ports';
import { scriptGated } from './RoomCommands';

/**
 * Whether landing somewhere other than `step.to` is the step working rather
 * than the route lost: the plan admitted it could not predict the landing.
 */
export function landsUnpromised(step: RouteStep): boolean {
  return step.scatter !== undefined || scriptGated(step);
}

/** Whether the step is answered by the room a script or spell puts the character in. */
function movesByScript(step: RouteStep): boolean {
  return step.direction === 'portal' || landsUnpromised(step);
}

export class Landings {
  /**
   * When this step spent its one `rm`, or null. A moment rather than a flag:
   * the walk has to wait for the answer as well as ask (2026-09-14, the walk
   * asked and stopped on the next status line, before `rm` was answered).
   */
  private askedAt: number | null = null;

  constructor(
    private readonly events: Pick<WalkerEvents, 'locate' | 'notice'>,
    private readonly walk: Pick<WalkInFlight, 'quiet' | 'step'>
  ) {}

  /** A step went out: its `rm` is its own. */
  sent(): void {
    this.askedAt = null;
  }

  /**
   * One `rm` when the step in flight lands where the client cannot place it.
   * True while that answer is awaited; the step's deadline stays armed, so a
   * realm with no locate word stops as it did before.
   */
  ask(state: CharacterState): boolean {
    const step = this.walk.step();
    if (step === undefined || this.events.locate === undefined) return false;
    if (!movesByScript(step) || roomAddress(state.room) !== null) return false;
    if (this.askedAt !== null) return true;
    this.askedAt = Date.now();
    this.events.locate();
    if (!this.walk.quiet()) {
      this.events.notice?.(
        step.scatter !== undefined
          ? t('automation.walk.scatteredUnplaced', { spellName: step.scatter.landing.name })
          : t('automation.walk.landingUnplaced', { command: step.command })
      );
    }
    return true;
  }

  /** What is said when `step` put the character in `roomName` rather than `step.to`. */
  elsewhere(step: RouteStep, roomName: string): string {
    if (step.scatter !== undefined) {
      return t('automation.walk.scattered', { spellName: step.scatter.landing.name, roomName });
    }
    const gates = step.requirement?.gates ?? [];
    // A condition the client could not read chose the branch; a chance landed elsewhere.
    if (gates.length > 0 && !byChance(step)) {
      return t('automation.walk.gateMissed', { condition: gatesWords(gates, t), roomName });
    }
    return t('automation.walk.landedElsewhere', {
      command: step.command,
      stepName: step.name,
      roomName
    });
  }
}
