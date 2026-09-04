/**
 * The clock behind `automation.events`.
 *
 * One owned interval, like the config watcher and for the same reason: it is
 * checked against what actually fired rather than trusted to fire on time,
 * so a laptop that slept, a session that was disconnected, or a queue holding
 * a half-typed line cannot leave an event stuck.
 *
 * Everything it decides goes to `CommandQueue` in the `probe` band — the same
 * band the keep-alive and resting use. An event is the least urgent thing in
 * the client: it must never displace an attack, an escape or a walk step.
 */
import { dueAt, type ScheduledEvent } from '../../shared/events';
import type { CommandQueue } from './CommandQueue';
import type { CharacterState } from '../../shared/character';
import { tuning } from '../app/tuning';

export class Events {
  private timer: NodeJS.Timeout | null = null;
  private state: CharacterState | null = null;
  private startedAt = 0;
  private readonly last = new Map<string, number>();

  constructor(
    private events: ScheduledEvent[],
    private enabled: boolean,
    private readonly queue: CommandQueue,
    /*
     * No notice hook. One was wired from `SessionManager` and never called from
     * here for as long as it existed — an event held during a fight fires after
     * it, which is the configured behaviour rather than a decline worth
     * announcing. A callback nothing calls reads as though the client speaks
     * when it does not.
     */
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(events: ScheduledEvent[], enabled: boolean): void {
    this.events = events;
    this.enabled = enabled;
    this.arm();
  }

  /** New connection: nothing has fired yet, and nothing fires retroactively. */
  reset(): void {
    this.last.clear();
    this.startedAt = 0;
    this.stop();
  }

  onCharacter(state: CharacterState): void {
    this.state = state;
    if (state.phase !== 'in-game') {
      this.stop();
      return;
    }
    if (this.startedAt === 0) this.startedAt = this.now();
    this.arm();
  }

  dispose(): void {
    this.stop();
  }

  /** Checked from the timer; separated so a test can drive it directly. */
  check(): void {
    const state = this.state;
    if (!this.enabled || !state || state.phase !== 'in-game') return;
    const now = this.now();
    for (const event of this.events) {
      if (state.inCombat && event.inCombat !== true) continue;
      if (!dueAt(event, now, this.last.get(event.name) ?? 0, this.startedAt)) continue;
      this.last.set(event.name, now);
      this.queue.enqueue({
        command: event.command,
        priority: 'probe',
        // By name, never by text: two events may send the same command for
        // different reasons, and one of them being dropped is a silent loss.
        coalesceKey: `event:${event.name}`,
        expiresAt: now + tuning().events.expiresMs,
        reason: `event: ${event.name}`
      });
    }
  }

  private arm(): void {
    if (this.timer !== null) return;
    if (!this.enabled || this.events.length === 0) return;
    this.timer = setInterval(() => this.check(), tuning().events.tickMs);
    // Never hold the process open for a clock nobody is watching.
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
