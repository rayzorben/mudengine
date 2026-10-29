import { describe, expect, it, vi } from 'vitest';
import { Terminal, type IDecorationOptions } from '@xterm/xterm';

import { consoleWriter } from '../console';
import { drawMarks } from '../consoleMarks';
import { lineIdOf } from '@shared/stamps';
import { GLYPH_CELLS } from '@shared/template';
import type { TerminalMark } from '@shared/types';

/*
 * Todo 143: a marked line carries its id in the text, and its mark is drawn
 * on the row that id was parsed on, now or later. A real xterm, headless, with
 * the decorations it was asked for recorded as the console asked for them.
 */
const BANK: TerminalMark = {
  icon: 'bank',
  label: 'Bank of Godfrey',
  actions: [{ label: 'Deposit All', title: 'Deposit', act: 'deposit-all' }]
};
const GLYPH_ONLY: TerminalMark = { icon: 'bank', label: 'Bank of Godfrey' };

const parsed = (term: Terminal, bytes = ''): Promise<void> =>
  new Promise((done) => term.write(bytes, done));

function console80() {
  const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  const asked: Array<{ options: IDecorationOptions; line: number; disposed: () => boolean }> = [];
  const register = term.registerDecoration.bind(term);
  vi.spyOn(term, 'registerDecoration').mockImplementation((options) => {
    const decoration = register(options);
    let gone = false;
    decoration?.onDispose(() => (gone = true));
    asked.push({ options, line: options.marker.line, disposed: () => gone });
    return decoration;
  });
  const marks = drawMarks(term, { glyph: () => '', send: () => {}, act: () => {} });
  const live = () => asked.filter((entry) => !entry.disposed());
  return { term, marks, asked, live };
}

describe('a marked line in the console', () => {
  it("draws the glyph after the line's text and the buttons after the glyph", async () => {
    const { term, marks, live } = console80();
    await parsed(term, `Town\r\n${lineIdOf('k1.1')}\x1b[1;33mBank of Godfrey\x1b[0m\r\n`);
    marks.apply([{ id: 'k1.1', mark: BANK }]);
    // The line's own cells are the server's: nothing was written into the row.
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe('Bank of Godfrey');
    expect(live().map((entry) => [entry.line, entry.options.x])).toEqual([
      [1, 16],
      [1, 16 + GLYPH_CELLS + 1]
    ]);
  });

  it('lands a later change on the row its id was parsed on, and takes the buttons off', async () => {
    const { term, marks, live } = console80();
    await parsed(term, `${lineIdOf('k1.1')}Bank of Godfrey\r\nObvious exits: north\r\n`);
    marks.apply([{ id: 'k1.1', mark: BANK }]);
    // The positive control: the buttons are there before the change.
    expect(live()).toHaveLength(2);
    await parsed(term, 'North Road\r\nObvious exits: south\r\n');
    marks.apply([{ id: 'k1.1', mark: GLYPH_ONLY }]);
    expect(live().map((entry) => [entry.line, entry.options.x])).toEqual([[0, 16]]);
    marks.apply([{ id: 'k1.1', mark: null }]);
    expect(live()).toEqual([]);
  });

  it('waits for a line still queued behind the writer before drawing its mark', async () => {
    const { term, marks, live } = console80();
    const writer = consoleWriter(term);
    writer.write(`${lineIdOf('k1.2')}Sewer Grate\r\n`);
    writer.settled(() =>
      marks.apply([{ id: 'k1.2', mark: { label: 'Sewer Grate', actions: [] } }])
    );
    writer.settled(() =>
      marks.apply([
        {
          id: 'k1.2',
          mark: {
            label: 'Sewer Grate',
            actions: [{ label: 'go manhole', title: 'go manhole', commands: ['go manhole'] }]
          }
        }
      ])
    );
    await parsed(term);
    await new Promise((done) => writer.settled(() => done(undefined)));
    expect(live().map((entry) => [entry.line, entry.options.x])).toEqual([[0, 12]]);
  });

  it('draws nothing for an id it never parsed', async () => {
    const { term, marks, asked } = console80();
    await parsed(term, 'Town\r\n');
    marks.apply([{ id: 'k1.9', mark: BANK }]);
    expect(asked).toEqual([]);
  });

  it('finds the line again by its id after a refill', async () => {
    const { term, marks, live } = console80();
    const page = `Town\r\n${lineIdOf('k1.1')}Bank of Godfrey\r\n`;
    await parsed(term, page);
    marks.apply([{ id: 'k1.1', mark: BANK }]);
    term.reset();
    await parsed(term, `Older\r\n${page}`);
    marks.apply([{ id: 'k1.1', mark: GLYPH_ONLY }]);
    expect(live().map((entry) => [entry.line, entry.options.x])).toEqual([[2, 16]]);
  });

  it('draws nothing for a line the reset took and the refill did not bring back', async () => {
    const { term, marks, live } = console80();
    await parsed(term, `${lineIdOf('k1.1')}Bank of Godfrey\r\n`);
    marks.apply([{ id: 'k1.1', mark: BANK }]);
    // The positive control: the line was drawn on before the reset.
    expect(live()).toHaveLength(2);
    term.reset();
    marks.cleared();
    await parsed(term, 'Town\r\nNorth Road\r\n');
    // Leaving the bank takes its buttons off, a push for a line no longer held.
    marks.push([{ id: 'k1.1', mark: GLYPH_ONLY }]);
    expect(live()).toEqual([]);
  });
});

describe('a page and a push that crossed it', () => {
  it('draws the push over the older mark the page carried', async () => {
    const { term, marks, live } = console80();
    const page = `${lineIdOf('k1.1')}Bank of Godfrey\r\n`;
    await parsed(term, page);
    marks.apply([{ id: 'k1.1', mark: BANK }]);
    // The character walked on while the page was on its way: the push came first.
    marks.push([{ id: 'k1.1', mark: GLYPH_ONLY }]);
    term.reset();
    await parsed(term, page);
    marks.page([{ id: 'k1.1', mark: BANK }]);
    expect(live().map((entry) => [entry.line, entry.options.x])).toEqual([[0, 16]]);
  });
});

describe('the room a name line was printed for', () => {
  const ROAD: TerminalMark = { label: 'Darkwood Forest', room: { map: 2, room: 40 } };

  it('is answered on the row the line starts on, and not on the row it folds onto', async () => {
    const { term, marks } = console80();
    // Eighty columns: the name runs past the edge and the pane folds it onto a second row.
    const name = `${'Darkwood Forest '.repeat(5)}Edge`;
    await parsed(term, `Town\r\n${lineIdOf('k1.1')}${name}\r\nObvious exits: north\r\n`);
    marks.push([{ id: 'k1.1', mark: { ...ROAD, label: name } }]);
    expect(marks.roomOn(1)).toEqual({ map: 2, room: 40 });
    // The click on the tail asks for the head's row (TerminalView); the tail has no marker.
    expect(marks.roomOn(2)).toBeNull();
    expect(marks.roomOn(0)).toBeNull();
  });

  it('is gone with the change that takes it off, and with the line once it scrolls out', async () => {
    const term = new Terminal({ cols: 80, rows: 4, scrollback: 2, allowProposedApi: true });
    const marks = drawMarks(term, { glyph: () => '', send: () => {}, act: () => {} });
    await parsed(
      term,
      `${lineIdOf('k1.1')}Darkwood Forest\r\n${lineIdOf('k1.2')}Darkwood Forest\r\n`
    );
    marks.push([
      { id: 'k1.1', mark: ROAD },
      { id: 'k1.2', mark: ROAD }
    ]);
    // The positive control: both rows carry the room before anything changes.
    expect([marks.roomOn(0), marks.roomOn(1)]).toEqual([ROAD.room, ROAD.room]);
    marks.push([{ id: 'k1.2', mark: { label: 'Darkwood Forest' } }]);
    expect(marks.roomOn(1)).toBeNull();
    await parsed(term, 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n');
    // Row 0 now holds a later line; the first name's marker went with the scrollback.
    expect(marks.roomOn(0)).toBeNull();
  });
});
