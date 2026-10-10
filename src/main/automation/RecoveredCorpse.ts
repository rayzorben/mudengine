/**
 * The gear back on after `recover corpse` (todo 39). The command puts what was
 * in the corpse into the pack and leaves it off, and putting it on was a
 * second press of Re-equip Gear. On the character's own corpse recovered, this
 * runs the button's own work (`restoreKit`) through the queue. See
 * `mudengine-automation` › *Putting the kit back on is four buttons and one
 * closed list*.
 */
import type { CommandQueue } from './CommandQueue';
import type { SessionModule } from './Module';
import { restoreKit } from './restoreKit';
import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { isOwnName } from '../../shared/players';
import type { AutomationConfig } from '../../shared/config';

export interface RecoveredCorpseEvents {
  notice?(message: string): void;
}

export class RecoveredCorpse implements SessionModule {
  private on: boolean;
  private enabled: boolean;

  constructor(
    automation: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly character: () => CharacterState,
    private readonly events: RecoveredCorpseEvents = {}
  ) {
    this.on = automation.movement.reequipOnRecover;
    this.enabled = automation.enabled;
  }

  configure(automation: AutomationConfig): void {
    this.on = automation.movement.reequipOnRecover;
    this.enabled = automation.enabled;
  }

  /** Nothing is decided between recoveries: each one is its own press. */
  reset(): void {}

  onBlock(block: Block): void {
    if (block.type !== 'user-recovers-corpse' || !this.on || !this.enabled) return;
    const state = this.character();
    /*
     * Only the character's own corpse: `recover` with a password empties a
     * friend's into this pack too (`RecoverCommand.cs`), and that is not this
     * character's gear coming back.
     */
    if (!isOwnName(state.name, block.groups['player'] ?? '')) return;
    const { sent, notices } = restoreKit(state, (command) =>
      this.queue.enqueue({
        command,
        priority: 'probe',
        coalesceKey: `recovered:${command.toLowerCase()}`,
        reason: t('automation.recoveredCorpse.reason')
      })
    );
    if (sent > 0) this.events.notice?.(t('automation.recoveredCorpse.dressing'));
    for (const message of notices) this.events.notice?.(message);
  }
}
