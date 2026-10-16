import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkBook } from '../MarkBook';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { MARKS_FILE, asMarkChange } from '../markFile';
import { lineIdOf } from '../../../shared/stamps';
import type { MarkChange, TerminalMark } from '../../../shared/types';

const BANK: TerminalMark = {
  icon: 'bank',
  label: 'Bank of Godfrey',
  actions: [{ label: 'Deposit All', title: 'Deposit', act: 'deposit-all' }]
};
const GLYPH: TerminalMark = { icon: 'bank', label: 'Bank of Godfrey' };
const GRATE: TerminalMark = {
  label: 'Sewer Grate',
  actions: [{ label: 'go manhole', title: 'go manhole', commands: ['go manhole'] }]
};

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markbook-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The record's rows as they stand on disk. */
const rows = (): string[] =>
  fs
    .readFileSync(path.join(dir, MARKS_FILE), 'utf8')
    .split('\n')
    .filter((row) => row.length > 0);

function book(lines = 10) {
  const pushed: MarkChange[][] = [];
  const problems: string[] = [];
  const marks = new MarkBook({
    lines,
    file: path.join(dir, MARKS_FILE),
    changed: (changes) => pushed.push(changes),
    onProblem: (message) => problems.push(message)
  });
  return { marks, pushed, problems };
}

describe('the marks of the lines in a console', () => {
  it('gives each line its own id, and hands a painted line its mark as it stands', () => {
    const { marks, pushed } = book();
    const bank = marks.issue(BANK);
    const town = marks.issue(undefined);
    expect(bank).not.toBe(town);
    // Changed before it is painted: the change rides in the chunk, and nothing is pushed.
    marks.change([{ id: bank, mark: GLYPH }]);
    expect(pushed).toEqual([]);
    expect(marks.painted([town, bank])).toEqual([{ id: bank, mark: GLYPH }]);
  });

  it('pushes a change to a painted line once, and a repeat is nothing', () => {
    const { marks, pushed } = book();
    const bank = marks.issue(BANK);
    marks.painted([bank]);
    marks.change([{ id: bank, mark: GLYPH }]);
    marks.change([{ id: bank, mark: GLYPH }]);
    marks.change([{ id: bank, mark: null }]);
    marks.change([{ id: bank, mark: null }]);
    expect(pushed).toEqual([[{ id: bank, mark: GLYPH }], [{ id: bank, mark: null }]]);
  });

  it('marks a painted line that had none, for a room placed after its name', () => {
    const { marks, pushed } = book();
    const grate = marks.issue(undefined);
    marks.painted([grate]);
    marks.change([{ id: grate, mark: GRATE }]);
    expect(pushed).toEqual([[{ id: grate, mark: GRATE }]]);
  });

  it('hands a page the marks of the lines in its text', () => {
    const { marks } = book();
    const bank = marks.issue(BANK);
    const grate = marks.issue(GRATE);
    marks.painted([bank, grate]);
    const text = `${lineIdOf(bank)}Bank of Godfrey\r\nTown\r\n`;
    expect(marks.pageOf({ text, older: 3 })).toEqual({
      text,
      older: 3,
      marks: [{ id: bank, mark: BANK }]
    });
  });

  it('keeps no more than a page of marks, the oldest painted going first', () => {
    const { consolePageLines } = DEFAULT_INTERNAL.tuning.view;
    const marks = new MarkBook({ lines: 1_000_000 });
    const ids = Array.from({ length: consolePageLines }, () => marks.issue(GLYPH));
    marks.painted(ids);
    // The positive control: a page of marks is all kept.
    expect(marks.painted(ids)).toHaveLength(consolePageLines);
    marks.painted([marks.issue(GLYPH)]);
    expect(marks.painted(ids.slice(0, 2)).map((entry) => entry.id)).toEqual([ids[1]]);
  });

  it('marks a fresh line with a scrollback of 0, and lets go of one never painted', () => {
    const { marks } = book(0);
    const bank = marks.issue(BANK);
    const town = marks.issue(GLYPH);
    marks.forget(town);
    expect(marks.painted([bank, town])).toEqual([{ id: bank, mark: BANK }]);
  });

  it('reads back what it appended at the next launch, with nothing pressable', async () => {
    const first = book();
    const bank = first.marks.issue(BANK);
    const grate = first.marks.issue(GRATE);
    const shop = first.marks.issue(BANK);
    first.marks.painted([bank, grate, shop]);
    first.marks.change([
      { id: bank, mark: { ...GLYPH, label: 'The Bank of Godfrey' } },
      { id: grate, mark: null }
    ]);
    // The positive control: this launch's line has its button.
    expect(first.marks.painted([shop])).toEqual([{ id: shop, mark: BANK }]);
    // Five changes, each its own appended row; nothing written whole since the open.
    await vi.waitFor(() => expect(rows()).toHaveLength(5));
    const next = book();
    // Nothing pressable comes back: no room an earlier launch printed is stood in.
    expect(next.marks.painted([bank, grate, shop])).toEqual([
      { id: bank, mark: { ...GLYPH, label: 'The Bank of Godfrey' } },
      { id: shop, mark: GLYPH }
    ]);
    expect(next.marks.issue(undefined)).not.toBe(bank);
    expect(next.problems).toEqual([]);
    // Written whole once, at the open: one row a line.
    expect(rows()).toHaveLength(2);
  });

  it('appends a change in bytes of its own, and writes the whole only at the open and the close', async () => {
    const { marks } = book();
    const file = path.join(dir, MARKS_FILE);
    const opened = fs.statSync(file).ino;
    const bank = marks.issue(BANK);
    marks.painted([bank]);
    for (let turn = 0; turn < 6; turn += 1) {
      marks.change([{ id: bank, mark: turn % 2 === 0 ? GLYPH : BANK }]);
    }
    await vi.waitFor(() => expect(rows()).toHaveLength(7));
    expect(fs.statSync(file).ino).toBe(opened);
    // The positive control: the close writes it whole, a file of its own.
    marks.close();
    expect(fs.statSync(file).ino).not.toBe(opened);
    expect(rows()).toHaveLength(1);
  });

  it('writes the whole again once the record holds four times what is kept', async () => {
    const { consoleLiveLines } = DEFAULT_INTERNAL.tuning.view;
    const { marks } = book(0);
    const bank = marks.issue(BANK);
    marks.painted([bank]);
    const turns = 4 * consoleLiveLines + 10;
    for (let turn = 0; turn < turns; turn += 1) {
      marks.change([{ id: bank, mark: { ...GLYPH, label: `Bank ${turn}` } }]);
    }
    await vi.waitFor(() => expect(rows().at(-1)).toContain(`Bank ${turns - 1}`));
    expect(rows().length).toBeLessThan(turns);
    expect(book().marks.painted([bank])).toEqual([
      { id: bank, mark: { ...GLYPH, label: `Bank ${turns - 1}` } }
    ]);
  });

  it('skips a torn last row and says so, and reads the rest', async () => {
    const first = book();
    const bank = first.marks.issue(BANK);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    fs.appendFileSync(path.join(dir, MARKS_FILE), '{"id":"x.1","mark":{"lab');
    const next = book();
    expect(next.marks.painted([bank])).toEqual([{ id: bank, mark: GLYPH }]);
    expect(next.problems).toHaveLength(1);
  });

  it('keeps the latest row of a line, whatever order the rows landed in', () => {
    fs.writeFileSync(
      path.join(dir, MARKS_FILE),
      [
        { id: 'k1.1', mark: { ...GLYPH, label: 'newer' }, seq: 'k2.1' },
        { id: 'k1.1', mark: { ...GLYPH, label: 'older' }, seq: 'k1.9' }
      ]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join('')
    );
    expect(book().marks.painted(['k1.1'])).toEqual([
      { id: 'k1.1', mark: { ...GLYPH, label: 'newer' } }
    ]);
  });

  it('says once when the record cannot be read, writes nothing over it, and carries on', () => {
    fs.mkdirSync(path.join(dir, MARKS_FILE));
    const { marks, problems } = book();
    const bank = marks.issue(BANK);
    marks.close();
    marks.change([{ id: bank, mark: GLYPH }]);
    marks.close();
    expect(problems).toHaveLength(1);
    expect(fs.statSync(path.join(dir, MARKS_FILE)).isDirectory()).toBe(true);
    expect(marks.painted([bank])).toEqual([{ id: bank, mark: GLYPH }]);
  });
});

describe('a row of the record', () => {
  it('is a change only when it is one this client wrote', () => {
    expect(asMarkChange({ id: 'k1.1', mark: BANK })).toEqual({ id: 'k1.1', mark: BANK });
    expect(asMarkChange({ id: 'k1.1', mark: null })).toEqual({ id: 'k1.1', mark: null });
    expect(asMarkChange({ id: 'nope', mark: null })).toBeNull();
    expect(asMarkChange({ id: 'k1.1', mark: { label: 'x', icon: 'castle' } })).toBeNull();
    expect(
      asMarkChange({ id: 'k1.1', mark: { label: 'x', actions: [{ label: 'a', title: 'b' }] } })
    ).toBeNull();
  });
});
