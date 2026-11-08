/**
 * The automations the Automations card switches on and off, as one module
 * the session composes: each task is a unit of its own, and this routes the
 * session's blocks, states and resets to every one and the card's switch to
 * the one it names. A new task is a unit, a `TaskId`, and a case below. See
 * `mudengine-automation` › `parts/errands.md` › *A task is switched on from
 * the Automations card*.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { TaskId, TaskView } from '../../shared/tasks';
import type { CommandQueue } from './CommandQueue';
import type { SessionModule } from './Module';
import { TreasureDig, type DigEvents } from './TreasureDig';

export interface TaskEvents extends DigEvents {
  /** Runs `start` with the master switch on, turning it on first; the refusal, or null. */
  switchedOnFor(start: () => string | null): string | null;
}

export class Tasks implements SessionModule {
  private readonly dig: TreasureDig;

  constructor(
    enabled: boolean,
    queue: Pick<CommandQueue, 'offer'>,
    private readonly events: TaskEvents
  ) {
    this.dig = new TreasureDig(enabled, queue, events);
  }

  configure(enabled: boolean): void {
    this.dig.configure(enabled);
  }

  reset(): void {
    this.dig.reset();
  }

  dispose(): void {
    this.dig.dispose();
  }

  onBlock(block: Block): void {
    this.dig.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    this.dig.onCharacter(state);
  }

  views(): TaskView[] {
    return [this.dig.view];
  }

  /** The card's switch; why it did not switch, or null. */
  set(id: TaskId, on: boolean): string | null {
    switch (id) {
      case 'treasure-dig':
        if (!on) {
          this.dig.set(false);
          return null;
        }
        return this.events.switchedOnFor(() => {
          this.dig.set(true);
          return null;
        });
      default: {
        const never: never = id;
        return never;
      }
    }
  }
}
