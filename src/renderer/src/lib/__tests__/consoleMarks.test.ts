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
