/**
 * What each monster did to the character, written beside its fight log as
 * `harm.jsonl.gz` (todo 26): one appended gzip member a flush, held and
 * written as `FightLog`'s rows are (`HeldRows`), in a file the fight log does
 * not touch. The prediction is the session's (`predict`, the odds book's
 * `predict`), asked through a lookup because the log outlives a session and
 * the book does not. `scripts/harm-report.mjs` reads it; an extension reads
 * the last ones settled through `taken`.
 */
import path from 'node:path';

import type { CharacterState } from '../../shared/character';
import type { HarmPrediction, HarmRecord, HarmSink } from '../../shared/harm';
import { tuning } from '../app/tuning';
import { HeldRows } from './heldRows';
import { appendJsonLines } from './segmentFiles';

/** The file in a character's fight-log directory. Not a segment name, so the fight log never lists it. */
export const HARM_FILE = 'harm.jsonl.gz';

export interface HarmLogEvents {
  notice?(message: string): void;
  /** The session's prediction for a monster as printed; null with no session or realm. */
  predict(mob: string, state: CharacterState): HarmPrediction | null;
}

export class HarmLog implements HarmSink {
  private readonly rows: HeldRows<HarmRecord>;
  /** The last records settled, written or not, for `taken`: capped like what is held. */
  private recent: HarmRecord[] = [];

  constructor(
    dir: string,
    private readonly events: HarmLogEvents
  ) {
    this.rows = new HeldRows({
      dir,
      write: (rows) => {
        appendJsonLines(path.join(dir, HARM_FILE), rows);
        return true;
      },
      notice: events.notice
    });
  }

  harm(record: HarmRecord): void {
    this.rows.hold(record);
    this.recent.push(record);
    if (this.recent.length > tuning().records.fightsHeld) this.recent.shift();
  }

  predict(mob: string, state: CharacterState): HarmPrediction | null {
    return this.events.predict(mob, state);
  }

  taken(since: number): readonly HarmRecord[] {
    return this.recent.filter((record) => record.at >= since);
  }

  /** Writes what is held. On the timer, and once on the way out. */
  flush(): void {
    this.rows.flush();
  }

  dispose(): void {
    this.flush();
  }
}
