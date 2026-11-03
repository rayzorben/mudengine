/**
 * Each character's open record (`Belongings`), one per session, for the realm
 * it is playing. Every way a record stops being used goes through `release`:
 * a dial to another realm, a tab closed, and quitting. Closing is what writes
 * the deferred totals and settles a running online clock, so a record dropped
 * any other way books the time after it as time online.
 *
 * A tab closed while connected gets no socket close, so the session's own
 * leaving never settles the clock (2026-11-03); `mudengine-session` › the
 * running totals.
 */
import type { SessionId } from '../../shared/ipc';

/** What a kept record needs to be kept here: the realm it is for, and a close. */
export interface ClosingRecord {
  readonly realm: string;
  /** Writes anything outstanding and settles the online clock. Safe to call twice. */
  close(): void;
}

export class OpenRecords<R extends ClosingRecord> {
  private readonly open = new Map<SessionId, R>();

  /** `label` names the kind of record in a quit's report of one that failed to close. */
  constructor(private readonly label: string) {}

  /** The record open for this session, whatever realm it is for. */
  get(id: SessionId): R | undefined {
    return this.open.get(id);
  }

  /** The session's record for `realm`, closing one open for another realm first. */
  at(id: SessionId, realm: string, create: () => R): R {
    const existing = this.open.get(id);
    if (existing?.realm === realm) return existing;
    this.release(id);
    const record = create();
    this.open.set(id, record);
    return record;
  }

  /** Close and drop the session's record, if it has one open. */
  release(id: SessionId): void {
    const record = this.open.get(id);
    this.open.delete(id);
    record?.close();
  }

  /**
   * Quitting: release every record, each through `settle`, so one that
   * throws leaves the rest still closed.
   */
  releaseAll(settle: (what: string, step: () => void) => void): void {
    for (const id of [...this.open.keys()]) settle(`${this.label} ${id}`, () => this.release(id));
  }
}
