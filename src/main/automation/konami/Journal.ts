/**
 * The planner's decisions: the last `tuning.konami.journal` kept for the
 * death and stuck logs, and every one written as a line of JSON through the
 * character's records (todo 56). An outcome is written as its own line when
 * it lands, so the file is a log and never rewritten.
 */
import type { KonamiDecision, KonamiOutcome, KonamiRecords } from '../../../shared/konamiRecords';

export class Journal {
  private readonly kept: KonamiDecision[] = [];

  constructor(
    private readonly records: KonamiRecords | null,
    private readonly size: () => number
  ) {}

  /** Newest last. */
  get decisions(): readonly KonamiDecision[] {
    return this.kept;
  }

  /**
   * The plan standing: the newest decision that made one. An ask that failed
   * is kept and listed, but stands for nothing, so the plan before it runs on
   * and is reviewed and settled as if it had not been asked.
   */
  get latest(): KonamiDecision | null {
    for (let at = this.kept.length - 1; at >= 0; at -= 1) {
      if (this.kept[at]!.outcome !== 'failed') return this.kept[at]!;
    }
    return null;
  }

  add(decision: KonamiDecision): void {
    this.kept.push(decision);
    const over = this.kept.length - Math.max(1, this.size());
    if (over > 0) this.kept.splice(0, over);
    // The brief stays in memory for the death logs; the file holds what was sent (todo 65).
    this.records?.journal(JSON.stringify({ kind: 'decision', ...decision, brief: undefined }));
  }

  /** What became of the newest decision; said once, since an outcome is final. */
  settle(outcome: KonamiOutcome, why: string | null = null): void {
    const decision = this.latest;
    if (decision === null || decision.outcome !== 'applied') return;
    decision.outcome = outcome;
    decision.outcomeWhy = why;
    decision.settledAt = Date.now();
    this.records?.journal(
      JSON.stringify({ kind: 'outcome', id: decision.id, outcome, why, at: decision.settledAt })
    );
  }
}
