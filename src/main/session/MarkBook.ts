/**
 * What each marked line in a character's console is marked with now, by the
 * line id written into its text (`LINE_OSC`), so a mark can be changed after
 * the line is on screen and comes back on every redraw (todo 143). `Marks`
 * decides what a line gets; the book records it, says what changed, and is
 * kept beside the backscroll segments (`markFile.ts`). Bounded between a live
 * console's lines and a page's (`keepFor`). `mudengine-session` ›
 * `parts/terminal.md`, *A marked line's id rides in the painted text*.
 */
import type { BackscrollPage, BackscrollText } from '../../shared/ipc';
import { lineIdsIn } from '../../shared/stamps';
import type { LineId, MarkChange, TerminalMark } from '../../shared/types';
import { errorMessage, sameJson } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { MarkRecord, type MarkRow } from './markFile';

export interface MarkBookOptions {
  /** The terminal's `terminal.scrollback`: marks kept, between a live page and a whole one (`keepFor`). */
  lines: number;
  /** The record on disk; absent, the book is kept in memory only (tests, probes). */
  file?: string;
  /** A painted line's mark changed: the push to the windows showing it. */
  changed?(changes: MarkChange[]): void;
  /** Said once, into the terminal, when the record cannot be read or written. */
  onProblem?(message: string): void;
}

/** What `Marks` is handed: an id for a line, and a change to one already issued. */
export type LineMarks = Pick<MarkBook, 'issue' | 'change' | 'forget'>;

export class MarkBook {
  private readonly marks = new Map<LineId, TerminalMark>();
  /** When each kept mark was made, so the record keeps the latest row of each line. */
  private readonly seqs = new Map<LineId, string>();
  /** Issued and not yet in a chunk: a change rides in the chunk instead of a push. */
  private readonly unpainted = new Set<LineId>();
  /** When this book was opened, after any id it read, so an id is unique against every earlier launch's. */
  private readonly opened: string;
  private count = 0;
  private made = 0;
  private limit: number;
  /** Null without a file, and for a record that could not be read, which is never written over. */
  private readonly record: MarkRecord | null = null;
  private saveFailed = false;

  constructor(private readonly options: MarkBookOptions) {
    this.limit = keepFor(options.lines);
    let newest = 0;
    const file = options.file;
    let record: MarkRecord | null = null;
    if (file !== undefined) {
      record = new MarkRecord(
        file,
        () => this.rows(),
        () => tuning().session.marksWholeAt * Math.max(this.marks.size, this.limit),
        { failed: (error) => this.problem('saveError', file, error) }
      );
      const read = record.read();
      if ('failed' in read) {
        this.problem('readError', file, read.failed);
        record = null;
      } else {
        for (const { id, mark, seq } of read.kept) {
          this.marks.set(id, mark);
          this.seqs.set(id, seq);
        }
        newest = read.newest;
        if (read.skipped > 0) {
          this.options.onProblem?.(
            t('notices.session.marks.skipped', { file, count: read.skipped })
          );
        }
        this.bound();
      }
    }
    this.opened = Math.max(Date.now(), newest + 1).toString(36);
    this.record = record;
    // Once, as the character is loaded: what was read, and only that, with nothing pressable.
    this.record?.writeWhole();
  }

  /** A new line's id, recorded with the mark it is drawn with, if any. */
  issue(mark: TerminalMark | undefined): LineId {
    this.count += 1;
    const id = `${this.opened}.${this.count.toString(36)}`;
    this.unpainted.add(id);
    if (mark !== undefined) this.put(id, mark);
    this.bound();
    return id;
  }

  /** The marks of lines going into a chunk, which from now on change by a push. */
  painted(ids: readonly LineId[]): MarkChange[] {
    const marks: MarkChange[] = [];
    for (const id of ids) {
      this.unpainted.delete(id);
      const mark = this.marks.get(id);
      if (mark !== undefined) marks.push({ id, mark });
    }
    return marks;
  }

  /** Lines marked anew, pushed once painted; a repeated change is nothing. */
  change(changes: readonly MarkChange[]): void {
    const made: MarkChange[] = [];
    for (const change of changes) {
      if (sameJson(this.marks.get(change.id) ?? null, change.mark)) continue;
      this.put(change.id, change.mark);
      made.push(change);
    }
    if (made.length === 0) return;
    this.bound();
    const pushed = made.filter((change) => !this.unpainted.has(change.id));
    if (pushed.length > 0) this.options.changed?.(pushed);
  }

  /** The page as a window is handed it: with the marks of the lines in its text. */
  pageOf(page: BackscrollText): BackscrollPage {
    const marks: MarkChange[] = [];
    for (const id of lineIdsIn(page.text)) {
      const mark = this.marks.get(id);
      if (mark !== undefined) marks.push({ id, mark });
    }
    return { ...page, marks };
  }

  /** A line that will never be painted (withheld, or drawn over): its id goes. */
  forget(id: LineId): void {
    this.unpainted.delete(id);
    if (this.marks.has(id)) this.put(id, null);
  }

  setLimit(lines: number): void {
    this.limit = keepFor(lines);
    this.bound();
  }

  /** The record written whole, synchronously, for a quit or an unload. */
  close(): void {
    this.record?.close();
  }

  /** One line's mark set or taken off, and the change appended to the record. */
  private put(id: LineId, mark: TerminalMark | null): void {
    this.made += 1;
    const seq = `${this.opened}.${this.made.toString(36)}`;
    if (mark === null) {
      this.marks.delete(id);
      this.seqs.delete(id);
    } else {
      // A changed line keeps its place in the order the bound drops by.
      this.marks.set(id, mark);
      this.seqs.set(id, seq);
    }
    this.record?.append({ id, mark, seq });
  }

  /** The book as rows, for the record written whole. */
  private rows(): MarkRow[] {
    return [...this.marks].map(([id, mark]) => ({ id, mark, seq: this.seqs.get(id) ?? id }));
  }

  /**
   * The oldest painted lines go first; a line not yet painted is about to
   * be, and stays. An id issued and never painted is let go by `forget`, and
   * past the bound by age. The record drops them when it is next written whole.
   */
  private bound(): void {
    for (const id of this.marks.keys()) {
      if (this.marks.size <= this.limit) break;
      if (this.unpainted.has(id)) continue;
      this.marks.delete(id);
      this.seqs.delete(id);
    }
    for (const id of this.unpainted) {
      if (this.unpainted.size <= this.limit) break;
      this.unpainted.delete(id);
    }
  }

  /** Said once a session each way; a failed write stays owed and the next change tries again. */
  private problem(kind: 'readError' | 'saveError', file: string, error: unknown): void {
    if (kind === 'saveError') {
      if (this.saveFailed) return;
      this.saveFailed = true;
    }
    const params = { file, message: errorMessage(error) };
    this.options.onProblem?.(
      kind === 'readError'
        ? t('notices.session.marks.readError', params)
        : t('notices.session.marks.saveError', params)
    );
  }
}

/**
 * Marks kept for a scrollback of `lines`: at least a live console's lines,
 * so a scrollback of 0 still marks what is on screen, and at most a whole
 * page's, so the record stays small. A page reaching further back draws its
 * older lines bare.
 */
function keepFor(lines: number): number {
  const { consoleLiveLines, consolePageLines } = tuning().view;
  return Math.min(Math.max(Math.trunc(lines), consoleLiveLines), consolePageLines);
}
