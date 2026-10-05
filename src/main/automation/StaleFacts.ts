/**
 * The facts a sentence made stale (`src/shared/staleness.ts`), owed until a
 * send carries their command or an answer reads them.
 *
 * Asked again on every status line while owed, because the stat screen's hold
 * drops what is queued and `train stats` opens it in the same breath as the
 * welcome: Soul's `exp` after level 14 was dropped that way (2026-10-05), and
 * the next level's price stayed unknown for four hours. A queued ask is the
 * same intent offered again (coalesced), so the re-offer costs nothing.
 */
import { readBy, REFRESH, type StaleFact } from '../../shared/staleness';
import type { BlockType } from '../../shared/blocks';
import type { CommandQueue } from './CommandQueue';

export class StaleFacts {
  /** Each owed fact and the words it is asked in. */
  private readonly owed = new Map<StaleFact, string>();

  constructor(private readonly queue: Pick<CommandQueue, 'offer'>) {}

  /** Owes each fact, asked for in the words of whatever made it stale. */
  owe(facts: readonly StaleFact[], reason: string): void {
    for (const fact of facts) this.owed.set(fact, reason);
    this.ask();
  }

  /** Offers what is still owed; a send pays it off. */
  ask(): void {
    for (const [fact, reason] of this.owed) {
      this.queue.offer({
        ...REFRESH[fact],
        priority: 'probe',
        reason,
        onSent: () => this.owed.delete(fact)
      });
    }
  }

  /** An answer read these facts, whoever asked for it. */
  answered(type: BlockType): void {
    for (const fact of readBy(type)) this.owed.delete(fact);
  }

  reset(): void {
    this.owed.clear();
  }
}
