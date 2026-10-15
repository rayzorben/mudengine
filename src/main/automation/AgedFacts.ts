/**
 * What `i`, `st` and `exp` last said, asked again once it is old (`automation.asks`, todo 118).
 *
 * The broadcasts keep a listing current only as far as the client reads them
 * right: rayzor's pack held a destroyed torch as lit for 18 minutes
 * (2026-10-08) and nothing was lit until the player typed `i`. A fact no answer
 * has read yet is the entry batch's to ask, never this. `StaleFacts` owes and
 * asks what this says is due.
 */
import { readBy, type StaleFact } from '../../shared/staleness';
import type { BlockType } from '../../shared/blocks';
import { askEveryMs, type AsksConfig } from '../../shared/asks';

export class AgedFacts {
  /** When each fact was last read, or last found due. */
  private readonly readAt = new Map<StaleFact, number>();

  /** An answer read these facts, whoever asked for it. */
  answered(type: BlockType, now: number): void {
    for (const fact of readBy(type)) this.readAt.set(fact, now);
  }

  /** The facts past their age; each is due once a period until an answer reads it. 0 minutes never is. */
  due(now: number, asks: AsksConfig): StaleFact[] {
    const due: StaleFact[] = [];
    for (const [fact, at] of this.readAt) {
      const every = refreshEvery(fact, asks);
      if (now - at < every) continue;
      this.readAt.set(fact, now);
      due.push(fact);
    }
    return due;
  }

  reset(): void {
    this.readAt.clear();
  }
}

/** How old a fact may get; the `? exp` table changes only on a level, which `STALE_AFTER` owes. */
function refreshEvery(fact: StaleFact, asks: AsksConfig): number {
  switch (fact) {
    case 'pack':
      return askEveryMs(asks.inventoryMinutes);
    case 'sheet':
      return askEveryMs(asks.statsMinutes);
    case 'experience':
      return askEveryMs(asks.expMinutes);
    case 'chart':
      return Infinity;
    default: {
      const never: never = fact;
      return never;
    }
  }
}
