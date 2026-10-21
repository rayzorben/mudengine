/**
 * What a keeper has asked the art server for (todo 20261019-0931-01,
 * 20261020-2015-01): each key once, done or under way, and of those the ones
 * the server did not answer, which are asked again on the next entry to the
 * realm. One policy for portraits and room pictures.
 */
import type { SessionPhase } from '../../shared/character';

export class AskLedger {
  private readonly asked = new Set<string>();
  private readonly unanswered = new Set<string>();
  private inRealm = false;

  /** Reads each state's phase; true on the entry to the realm, when the unanswered are forgiven. */
  entered(phase: SessionPhase): boolean {
    const entered = phase === 'in-game' && !this.inRealm;
    this.inRealm = phase === 'in-game';
    if (entered) {
      for (const key of this.unanswered) this.asked.delete(key);
      this.unanswered.clear();
    }
    return entered;
  }

  has(key: string): boolean {
    return this.asked.has(key);
  }

  /** An ask going out. */
  begin(key: string): void {
    this.asked.add(key);
  }

  /** An ask the server did not answer. */
  failed(key: string): void {
    this.unanswered.add(key);
  }

  /** Everything may be asked again: the switch was turned back on. */
  clear(): void {
    this.asked.clear();
    this.unanswered.clear();
  }
}
