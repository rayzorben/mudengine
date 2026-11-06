/**
 * Out of a room that hurts the character every tick (todo 20261103-0140-01).
 * Vaelor's walk stopped in the Silver River, the rest there was refused, and
 * nothing else moved him: 63 to -4 in five seconds. Out of a fight, wherever
 * a walk stopped or nothing takes the character anywhere, this sends one step
 * through the command queue: back the way it came where that room does not
 * hurt, else the first step towards the nearest room that does not
 * (`Navigation.nearestRoom`). A fight is the run's (`Travel.considerEscape`),
 * a follower's leader decides, and every refusal is said and traced. A
 * member the party waits on here is stayed with until health is under
 * `safety.retreat.belowHealth`, unknown counting as under (the user,
 * 2026-11-05: Rayzor's steps dropped a held Brakkle five times).
 * `mudengine-automation` › `parts/safety.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import { healthFraction, type SafetyDecision } from '../../shared/automation';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import {
  DIRECTION_NAME,
  OPPOSITE,
  roomAddress,
  type Direction,
  type RoomId
} from '../../shared/world';
import type { Errands } from './Errands';
import type { RoomHazards } from './RoomHazards';

const DECISION: DecisionKind = 'leave-harm';
const ACTION = 'leave';

export interface LeaveHarmParts {
  readonly tracker: Pick<CharacterTracker, 'pendingMoves' | 'wayBackFrom'>;
  readonly world: Pick<WorldGraph, 'byId'> | undefined;
  readonly hazards: Pick<RoomHazards, 'roomHurts'>;
  readonly errands: Pick<Errands, 'nearestRoom'>;
  readonly queue: Pick<CommandQueue, 'enqueue'>;
  readonly walker: Pick<Walker, 'walking' | 'holding'>;
}

export interface LeaveHarmSession {
  config(): AutomationConfig;
  /** A run or the realm's teleport has the character. */
  escaping(): boolean;
  /** The members the party's stop waits on who stand here (`PartyWait.waitedForHere`). */
  waitedForHere(state: CharacterState): readonly string[];
  notice: NoticeSink;
  decided(decision: SafetyDecision): void;
}

/** One step out: where it leads, and whether it is the way the character came. */
interface Way {
  direction: Direction;
  command: string;
  to: RoomId;
  back: boolean;
}

/** A step sent and not yet answered by a new room. */
interface Leaving {
  from: RoomId;
  direction: Direction;
  because: string;
  deadline: number;
}

export class LeaveHarm implements SessionModule {
  private leaving: Leaving | null = null;
  /** Directions out of one room that went unanswered, so the next try prefers another way. */
  private tried: { room: RoomId; directions: Set<Direction> } | null = null;
  /** The room and reason a refusal was said for, so it is said once. */
  private said: string | null = null;

  constructor(
    private readonly parts: LeaveHarmParts,
    private readonly session: LeaveHarmSession,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** A step out is on its way and the room has not changed yet. */
  get underWay(): boolean {
    return this.leaving !== null;
  }

  reset(): void {
    this.leaving = null;
    this.tried = null;
    this.said = null;
  }

  /** Every status line. */
  consider(state: CharacterState): void {
    const here = roomAddress(state.room);
    if (this.leaving !== null && !this.settled(here)) return;
    if (!this.session.config().enabled || state.phase !== 'in-game' || here === null) return;
    const spell = this.parts.hazards.roomHurts(here, state);
    if (spell === null) {
      this.said = null;
      return;
    }
    // Nothing is sent from the ground, and a fight is the run's to leave.
    if (state.mortallyWounded || fightIsRunning(state)) return;
    // Something else is moving the character: a step on the wire, a run, a walk stepping on.
    const { tracker, walker } = this.parts;
    if (tracker.pendingMoves > 0 || this.session.escaping()) return;
    if (walker.walking && walker.holding === null) return;

    const room = state.room.name ?? here;
    const because = t('session.harm.because', { spell });
    const leader = state.party.following;
    if (leader !== null) {
      this.refuse(here, room, because, t('session.safety.escapeFollowingReason', { leader }));
      return;
    }
    const held = this.session.waitedForHere(state);
    const who = held.join(', ');
    const fraction = healthFraction(state);
    const floor = this.session.config().safety.retreat.belowHealth;
    if (held.length > 0 && fraction !== null && fraction >= floor) {
      this.refuse(here, room, because, t('session.harm.waitingFor', { who }));
      return;
    }
    const way = this.wayOut(here, state);
    if (way === null) {
      const steps = tuning().roomHarm.searchSteps;
      this.refuse(here, room, because, t('session.harm.noWay', { steps }));
      return;
    }
    this.said = null;
    const name = this.parts.world?.byId(way.to)?.name ?? way.to;
    const direction = DIRECTION_NAME[way.direction];
    this.session.notice(
      way.back
        ? t('session.harm.leavingBack', { room, because, direction, name })
        : t('session.harm.leavingNearest', { room, because, direction, name }),
      DECISION
    );
    if (held.length > 0) this.session.notice(t('session.harm.leftBehind', { who }), DECISION);
    this.leaving = {
      from: here,
      direction: way.direction,
      because,
      deadline: this.now() + tuning().session.retreatPatienceMs
    };
    this.parts.queue.enqueue({
      command: way.command,
      priority: 'emergency',
      coalesceKey: 'leave-harm',
      reason: t('session.harm.reason', { spell }),
      decision: DECISION
    });
  }

  /**
   * The step's answer: a new room is the step taken; nothing by the deadline
   * marks that direction tried. True once no step is waiting.
   */
  private settled(here: RoomId | null): boolean {
    const leaving = this.leaving;
    if (leaving === null) return true;
    const at = this.now();
    if (here !== null && here !== leaving.from) {
      this.leaving = null;
      this.session.decided({ at, action: ACTION, because: leaving.because, acted: true });
      return true;
    }
    if (at < leaving.deadline) return false;
    this.leaving = null;
    const directions =
      this.tried?.room === leaving.from ? this.tried.directions : new Set<Direction>();
    directions.add(leaving.direction);
    this.tried = { room: leaving.from, directions };
    const direction = DIRECTION_NAME[leaving.direction];
    const refused = t('session.harm.unansweredReason', { direction });
    this.session.notice(t('session.harm.unanswered', { direction }), DECISION);
    this.session.decided({ at, action: ACTION, because: leaving.because, acted: false, refused });
    return true;
  }

  /**
   * Back the way the character came when that room does not hurt, else the
   * first step towards the nearest room that does not; null where neither.
   * A way that went unanswered from here is taken again only when it is the
   * last one left: a step the lag swallowed is still the way out.
   */
  private wayOut(here: RoomId, state: CharacterState): Way | null {
    const tried = this.tried?.room === here ? this.tried.directions : new Set<Direction>();
    const safe = (room: RoomId): boolean => this.parts.hazards.roomHurts(room, state) === null;
    const ways: Way[] = [];
    const came = this.parts.tracker.wayBackFrom(here);
    if (came !== null && safe(came.from)) {
      const direction = OPPOSITE[came.direction];
      ways.push({ direction, command: direction, to: came.from, back: true });
    }
    const route = this.parts.errands.nearestRoom(safe, tuning().roomHarm.searchSteps);
    const first = route?.steps[0];
    const last = route?.steps.at(-1);
    if (first !== undefined && last !== undefined && first.direction !== 'portal') {
      const { direction, command } = first;
      ways.push({ direction, command, to: last.to, back: false });
    }
    return ways.find((way) => !tried.has(way.direction)) ?? ways[0] ?? null;
  }

  /** Staying in a room that hurts, said and traced once per room and reason. */
  private refuse(here: RoomId, room: string, because: string, refused: string): void {
    const key = `${here}|${refused}`;
    if (this.said === key) return;
    this.said = key;
    this.session.notice(t('session.harm.staying', { room, because, refused }), DECISION);
    this.session.decided({ at: this.now(), action: ACTION, because, acted: false, refused });
  }
}
