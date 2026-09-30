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

  get latest(): KonamiDecision | null {
    return this.kept[this.kept.length - 1] ?? null;
  }

  add(decision: KonamiDecision): void {
    this.kept.push(decision);
    const over = this.kept.length - Math.max(1, this.size());
    if (over > 0) this.kept.splice(0, over);
    this.records?.journal(JSON.stringify({ kind: 'decision', ...decision }));
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
