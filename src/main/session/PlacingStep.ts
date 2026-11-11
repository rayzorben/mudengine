/**
 * A lost character on a realm with no locate word takes a step (2026-11-11).
 * Stock MajorMUD has no `rm`, so the only way to place an unplaced character
 * is the chain of rooms it walks through (`parse/roomChain.ts`). A loop or
 * route waiting for that placement walks nothing, so nothing ever placed it:
 * Yang stood thirteen hours in a Sewer Tunnel, Intersection after a relogin.
 * This sends one printed exit per arrival, never in a fight, hurt, resting or
 * with a step unanswered. See `mudengine-automation` › `parts/loops.md` ›
 * *A lost loop asks where it is*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { Recovery } from '../automation/Recovery';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Claims } from './Claims';
import type { Vocabulary } from './Vocabulary';
import {
  fightIsRunning,
  placedByServer,
  type CharacterState,
  type Room
} from '../../shared/character';
import { stillFor, type HealthConfig } from '../../shared/config';
import { asDirection, OPPOSITE, type Direction } from '../../shared/world';

export interface PlacingStepParts {
  readonly tracker: Pick<CharacterTracker, 'current' | 'pendingMoves'>;
  readonly queue: Pick<CommandQueue, 'offer'>;
  readonly vocabulary: Pick<Vocabulary, 'locateWord'>;
  readonly claims: Pick<Claims, 'askWhereIAm'>;
  readonly recovery: Pick<Recovery, 'restInFlight'>;
  /** The character's rest floors, as the loop and the route hold on them. */
  readonly health: () => HealthConfig;
}

/** The step out of one arrival, and the exits already tried from it. */
interface Stepped {
  readonly arrival: number;
  readonly at: number;
  readonly tried: ReadonlySet<Direction>;
  /** The step that brought the character into the room it left. */
  readonly came: Direction | null;
  readonly direction: Direction;
}

export class PlacingStep implements SessionModule {
  private last: Stepped | null = null;
  /** Steps since the character was last placed. */
  private steps = 0;
  private saidGaveUp = false;

  constructor(
    private readonly parts: PlacingStepParts,
    private readonly notice: (message: string) => void
  ) {}

  /**
   * The lost lap's ask: the realm's locate word where it has one, else a
   * step. `LoopRunner` counts these against `maxLocates` itself.
   */
  locate(): void {
    const ask = this.parts.claims.askWhereIAm();
    if ('refused' in ask && ask.refused === 'unavailable') this.take(false);
  }

  /**
   * A connection picked back up with a lap or route owed (`Travel.pickUpAfterLoss`),
   * asked on every line while unplaced: at most `maxLocates` steps.
   */
  step(): void {
    this.take(true);
  }

  /** The character as published: placed, the budget starts over. */
  onCharacter(state: CharacterState): void {
    if (placedByServer(state.room)) this.reset();
  }

  reset(): void {
    this.last = null;
    this.steps = 0;
    this.saidGaveUp = false;
  }

  /**
   * One step out of an unplaced room, where the realm has no locate word.
   * Paced by the arrival: a step whose room has not come back is waited for
   * up to `loop.locateWaitMs`, then counted as refused (a closed door) and
   * another exit is tried.
   */
  private take(bounded: boolean): void {
    const state = this.parts.tracker.current;
    if (placedByServer(state.room) || this.parts.vocabulary.locateWord !== null) return;
    if (this.holds(state)) return;
    const now = Date.now();
    const last = this.last;
    const sameRoom = last !== null && last.arrival === state.room.arrival;
    if (sameRoom && now - last.at < tuning().loop.locateWaitMs) return;
    if (bounded && this.steps >= tuning().loop.maxLocates) {
      if (!this.saidGaveUp) {
        this.saidGaveUp = true;
        this.notice(t('session.loop.placingGaveUp', { steps: this.steps }));
      }
      return;
    }
    const tried = sameRoom ? last.tried : new Set<Direction>();
    const came = sameRoom ? last.came : (last?.direction ?? null);
    const direction = nextExit(state.room, tried, came);
    if (direction === null) return;
    const arrival = state.room.arrival;
    this.parts.queue.offer({
      command: direction,
      priority: 'movement',
      coalesceKey: 'placing-step',
      expiresAt: now + tuning().loop.locateWaitMs,
      reason: t('session.loop.placingReason'),
      // Counted and said when it goes: one that expired in the queue tried nothing,
      // and one waiting is offered again on every line.
      onSent: () => {
        this.steps += 1;
        this.last = {
          arrival,
          at: Date.now(),
          tried: new Set([...tried, direction]),
          came,
          direction
        };
        this.notice(t('session.loop.placingStep', { direction }));
      }
    });
  }

  /**
   * What keeps the character where it stands: a fight, a step still owed, a
   * rest asked for or under way, or health or mana under the floor the loop
   * and the route stop at. A blind step is the last thing a hurt character
   * should take.
   */
  private holds(state: CharacterState): boolean {
    if (state.phase !== 'in-game' || fightIsRunning(state)) return true;
    if (state.vitals.resting || state.vitals.meditating) return true;
    if (this.parts.tracker.pendingMoves > 0 || this.parts.recovery.restInFlight) return true;
    const margin = tuning().loop.resumeMarginWhenUncapped;
    const health = this.parts.health();
    return (
      stillFor('health', state.vitals, health, false, margin) ||
      stillFor('mana', state.vitals, health, false, margin)
    );
  }
}

/**
 * A printed exit not yet tried from this arrival, avoiding the way back the
 * last step came so two rooms are not walked between; the way back only when
 * nothing else is left.
 */
function nextExit(
  room: Pick<Room, 'exits'>,
  tried: ReadonlySet<Direction>,
  came: Direction | null
): Direction | null {
  const open = room.exits
    .map((exit) => asDirection(exit.direction))
    .filter((direction): direction is Direction => direction !== null && !tried.has(direction));
  const back = came === null ? null : OPPOSITE[came];
  return open.find((direction) => direction !== back) ?? open[0] ?? null;
}
