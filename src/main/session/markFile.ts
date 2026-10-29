/**
 * The record `MarkBook` is kept in, beside a character's backscroll segments:
 * one JSON row per change, appended a few bytes at a time off the main
 * thread, and written whole only when opened, when closed and when it has
 * grown well past what the book holds (todo 143). No row carries anything
 * pressable (`pressless`). Each row names when it was made (`seq`), so a row
 * landing late, after the record was written whole, never outranks a newer one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { lineIdAt } from '../../shared/stamps';
import {
  MARK_ICONS,
  TERMINAL_ACTIONS,
  type LineId,
  type MarkChange,
  type TerminalMark
} from '../../shared/types';
import { isRecord } from '../../shared/values';

/** The file beside a character's backscroll segments. */
export const MARKS_FILE = 'marks.jsonl';

/** One row: a line's mark as of `seq`, which is an id's shape and sorts as one (`seqOrder`). */
export interface MarkRow extends MarkChange {
  seq: string;
}

/** What the record holds: each line's latest mark and the rows that could not be read; or why it could not be read at all. */
export type ReadMarks =
  | {
      kept: Array<{ id: LineId; mark: TerminalMark; seq: string }>;
      skipped: number;
      newest: number;
    }
  | { failed: unknown };

/** Where a seq or id sorts: when its book was opened, then its count. */
export function seqOrder(seq: string): [number, number] {
  const [opened = '', count = ''] = seq.split('.');
  return [parseInt(opened, 36), parseInt(count, 36)];
}

const later = (a: string, b: string): boolean => {
  const [ao, ac] = seqOrder(a);
  const [bo, bc] = seqOrder(b);
  return ao > bo || (ao === bo && ac >= bc);
};

export interface MarkRecordEvents {
  /** A write failed; the rows stay owed and the next change tries again. */
  failed(error: unknown): void;
}

export class MarkRecord {
  private pending: string[] = [];
  private writing = false;
  private closed = false;
  /** Rows in the file, so it is written whole once it holds far more than the book. */
  private rows = 0;
  /** Each whole write's own temporary file, so a close never shares one with a rewrite in the air. */
  private wholes = 0;

  /**
   * @param snapshot The book as it stands, for a whole write.
   * @param cap Rows the file may hold before it is written whole again.
   */
  constructor(
    readonly file: string,
    private readonly snapshot: () => MarkRow[],
    private readonly cap: () => number,
    private readonly events: MarkRecordEvents
  ) {}

  /** Reads the record and keeps each line's latest row. Synchronous: once, when the character is loaded. */
  read(): ReadMarks {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { kept: [], skipped: 0, newest: 0 };
      return { failed: error };
    }
    const latest = new Map<LineId, MarkRow>();
    let skipped = 0;
    let newest = 0;
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const row = asMarkRow(parsed(line));
      // A row cut short by a crash, or one this client did not write.
      if (row === null) {
        skipped += 1;
        continue;
      }
      newest = Math.max(newest, seqOrder(row.seq)[0], seqOrder(row.id)[0]);
      const was = latest.get(row.id);
      if (was === undefined || later(row.seq, was.seq)) latest.set(row.id, row);
    }
    const kept: Array<{ id: LineId; mark: TerminalMark; seq: string }> = [];
    for (const { id, mark, seq } of latest.values()) {
      const still = mark === null ? null : pressless(mark);
      if (still !== null) kept.push({ id, mark: still, seq });
    }
    return { kept, skipped, newest };
  }

  /** One change, appended once the write before it has landed. */
  append(row: MarkRow): void {
    if (this.closed) return;
    this.pending.push(`${JSON.stringify(kept(row))}\n`);
    this.pump();
  }

  /** The record written whole, synchronously: at open, and at a quit or an unload. */
  writeWhole(): void {
    this.pending = [];
    const rows = this.snapshot().map((row) => `${JSON.stringify(kept(row))}\n`);
    const temporary = this.temporary();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, rows.join(''), 'utf8');
      fs.renameSync(temporary, this.file);
      this.rows = rows.length;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      this.events.failed(error);
    }
  }

  /** Written whole and closed; a row still in the air outranks nothing (`seq`). */
  close(): void {
    if (this.closed) return;
    this.writeWhole();
    this.closed = true;
  }

  private pump(): void {
    if (this.writing || this.closed || this.pending.length === 0) return;
    this.writing = true;
    const whole = this.rows + this.pending.length > this.cap();
    const rows = whole
      ? this.snapshot().map((row) => `${JSON.stringify(kept(row))}\n`)
      : this.pending;
    this.pending = [];
    const done = whole
      ? this.replace(rows.join(''))
      : fs.promises.appendFile(this.file, rows.join(''), 'utf8');
    done.then(
      () => {
        this.rows = whole ? rows.length : this.rows + rows.length;
        this.writing = false;
        this.pump();
      },
      (error: unknown) => {
        this.writing = false;
        // Closed since: the whole record was written then, and nothing here is owed.
        if (this.closed) return;
        // Owed still, ahead of anything changed since; the next change tries again.
        if (!whole) this.pending = [...rows, ...this.pending];
        this.events.failed(error);
      }
    );
  }

  /** The record written whole off the thread; a close meanwhile wrote a newer one, which stands. */
  private async replace(text: string): Promise<void> {
    const temporary = this.temporary();
    await fs.promises.writeFile(temporary, text, 'utf8');
    if (this.closed) {
      await fs.promises.rm(temporary, { force: true });
      return;
    }
    await fs.promises.rename(temporary, this.file);
  }

  private temporary(): string {
    this.wholes += 1;
    return `${this.file}.tmp-${process.pid}-${this.wholes}`;
  }
}

/** A row as it is written: nothing on it can be pressed. */
function kept(row: MarkRow): MarkRow {
  return { ...row, mark: row.mark === null ? null : pressless(row.mark) };
}

function parsed(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    // Read as no row at all, and counted by the reader.
    return null;
  }
}

/**
 * A mark as it is kept for the next launch: nothing on it can be pressed.
 * Only the room stood in has live buttons, and a relaunch stands in none of
 * the rooms the backscroll shows, so a kept `go manhole` would be sent into
 * whatever room the character is in. The room a name line was printed for is
 * kept: a click on it opens a route, which sends nothing. Null where nothing
 * is left to draw or route to.
 */
export function pressless(mark: TerminalMark): TerminalMark | null {
  const inline = mark.inline?.map(({ x, icon, label }) => ({ x, icon, label }));
  const drawn = mark.icon !== undefined || (inline !== undefined && inline.length > 0);
  if (!drawn && mark.room === undefined) return null;
  return {
    ...(mark.icon !== undefined ? { icon: mark.icon } : {}),
    label: mark.label,
    ...(inline !== undefined ? { inline } : {}),
    ...(mark.room !== undefined ? { room: mark.room } : {})
  };
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isIcon = (value: unknown): boolean =>
  typeof value === 'string' && (MARK_ICONS as readonly string[]).includes(value);

/** A row of the record as a change, or null when it is not one this client wrote. */
export function asMarkChange(value: unknown): MarkChange | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  const id = lineIdAt(value['id']);
  if (id === null) return null;
  if (value['mark'] === null) return { id, mark: null };
  const mark = asTerminalMark(value['mark']);
  return mark === null ? null : { id, mark };
}

function asMarkRow(value: unknown): MarkRow | null {
  const change = asMarkChange(value);
  if (change === null || !isRecord(value) || typeof value['seq'] !== 'string') return null;
  const seq = lineIdAt(value['seq']);
  return seq === null ? null : { ...change, seq };
}

function asTerminalMark(value: unknown): TerminalMark | null {
  if (!isRecord(value) || typeof value['label'] !== 'string') return null;
  const { icon, actions, inline, room } = value;
  if (icon !== undefined && !isIcon(icon)) return null;
  if (room !== undefined && !isRoomReference(room)) return null;
  if (actions !== undefined && !(Array.isArray(actions) && actions.every(isAction))) return null;
  if (inline !== undefined && !(Array.isArray(inline) && inline.every(isGlyph))) return null;
  return value as unknown as TerminalMark;
}

function isRoomReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { map, room } = value;
  return Number.isInteger(map) && Number.isInteger(room);
}

function isAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value['label'] !== 'string') return false;
  if (typeof value['title'] !== 'string') return false;
  const act = value['act'];
  if (act !== undefined) {
    return (
      (TERMINAL_ACTIONS as readonly unknown[]).includes(act) && value['commands'] === undefined
    );
  }
  return isStrings(value['commands']);
}

function isGlyph(value: unknown): boolean {
  if (!isRecord(value) || typeof value['label'] !== 'string') return false;
  if (typeof value['x'] !== 'number' || !isIcon(value['icon'])) return false;
  return value['commands'] === undefined || isStrings(value['commands']);
}
