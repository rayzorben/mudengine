import { describe, expect, it } from 'vitest';

import { linesOf, placeAt, rowOf, rowsOf, type Row } from '../readBack';

/** Rows from lines, each wider than `cols` drawn on as many rows as it takes. */
function drawn(lines: string[], cols = 80): Row[] {
  const rows: Row[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      rows.push({ text: '', wrapped: false });
      continue;
    }
    for (let at = 0; at < line.length; at += cols) {
      rows.push({ text: line.slice(at, at + cols), wrapped: at > 0 });
    }
  }
  return rows;
}

const numbered = (count: number, from = 0): string[] =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`);

describe('rows joined into lines', () => {
  it('starts a line on every row that does not continue the one above', () => {
    expect(linesOf(drawn(['a', 'b']))).toEqual([
      { text: 'a', row: 0 },
      { text: 'b', row: 1 }
    ]);
  });

  it('joins a wrapped line back together, keeping its first row', () => {
    const long = 'x'.repeat(170);
    expect(linesOf(drawn(['a', long, 'b']))).toEqual([
      { text: 'a', row: 0 },
      { text: long, row: 1 },
      { text: 'b', row: 4 }
    ]);
  });

  it('reads a first row marked wrapped as a line, and nothing as nothing', () => {
    expect(linesOf([{ text: 'tail', wrapped: true }])).toEqual([{ text: 'tail', row: 0 }]);
    expect(linesOf([])).toEqual([]);
  });

  it('keeps empty lines, which the game prints between blocks', () => {
    expect(linesOf(drawn(['a', '', 'b'])).map((line) => line.text)).toEqual(['a', '', 'b']);
  });
});

describe('the reader’s place', () => {
  const lines = linesOf(drawn(numbered(10)));

  it('is the line at the top of the view, counted from the last', () => {
    expect(placeAt(lines, 0)).toEqual({ fromEnd: 9, texts: ['line 0', 'line 1', 'line 2'] });
    expect(placeAt(lines, 1)?.fromEnd).toBe(8);
    expect(placeAt(lines, 9)).toEqual({ fromEnd: 0, texts: ['line 9'] });
  });

  it('on a wrapped line’s second row is that line', () => {
    const wrapped = linesOf(drawn(['a', 'y'.repeat(100), 'b']));
    expect(placeAt(wrapped, 2)).toEqual({ fromEnd: 1, texts: ['y'.repeat(100), 'b'] });
  });

  it('past the last row is the last line, and there is none with nothing drawn', () => {
    expect(placeAt(lines, 50)?.fromEnd).toBe(0);
    expect(placeAt([], 0)).toBeNull();
  });

  it('counts the prompt with no newline after it as the last line', () => {
    const withPrompt = linesOf(drawn([...numbered(3), '[HP=316/369]:']));
    expect(placeAt(withPrompt, 2)).toEqual({ fromEnd: 1, texts: ['line 2', '[HP=316/369]:'] });
  });
});

describe('finding the place in the copy', () => {
  it('is the same line when nothing arrived in between', () => {
    const live = linesOf(drawn(numbered(300, 700)));
    const copy = linesOf(drawn(numbered(1000)));
    const place = placeAt(live, 0)!;
    expect(copy[lineIndex(copy, rowOf(copy, place, 50))]!.text).toBe('line 700');
  });

  it('is further from the end by what arrived after the place was taken', () => {
    const live = linesOf(drawn(numbered(300, 700)));
    const copy = linesOf(drawn(numbered(1004)));
    const place = placeAt(live, 0)!;
    expect(copy[lineIndex(copy, rowOf(copy, place, 50))]!.text).toBe('line 700');
  });

  it('tells a repeated line apart by the lines after it', () => {
    const swing = 'The fierce demonhunter swings at you!';
    const fight = ['a', swing, swing, 'b', swing, swing, swing, 'c', 'prompt'];
    const live = linesOf(drawn(fight.slice(4)));
    const copy = linesOf(drawn(['older', ...fight, 'new', 'newer']));
    const place = placeAt(live, 0)!;
    const index = lineIndex(copy, rowOf(copy, place, 20));
    expect(index).toBe(5);
    expect(copy.slice(index, index + 4).map((line) => line.text)).toEqual([
      swing,
      swing,
      swing,
      'c'
    ]);
  });

  it('lands on a wrapped line’s first row, with the copy drawn narrower', () => {
    const lines = ['a', 'z'.repeat(120), 'b', 'c'];
    const live = linesOf(drawn(lines, 80));
    const copy = linesOf(drawn(['older', ...lines], 60));
    const row = rowOf(copy, placeAt(live, 1)!, 10);
    expect(row).toBe(2);
  });

  it('is not found when its lines are not within reach', () => {
    const live = linesOf(drawn(numbered(10, 500)));
    const copy = linesOf(drawn(numbered(400)));
    expect(rowOf(copy, placeAt(live, 0)!, 50)).toBeNull();
    // The positive control: within reach it is.
    expect(rowOf(linesOf(drawn(numbered(600))), placeAt(live, 0)!, 200)).not.toBeNull();
  });

  it('finds nothing in an empty copy', () => {
    expect(rowOf([], { fromEnd: 0, texts: ['a'] }, 10)).toBeNull();
  });
});

/** The line a row returned by `rowOf` starts. */
function lineIndex(lines: ReturnType<typeof linesOf>, row: number | null): number {
  if (row === null) throw new Error('not found');
  return lines.findIndex((line) => line.row === row);
}

describe('a buffer’s rows', () => {
  it('reads each row trimmed, with whether it continues the one above', () => {
    const lines = [
      { isWrapped: false, text: 'first   ' },
      { isWrapped: true, text: 'wrapped' },
      { isWrapped: false, text: '' }
    ];
    const buffer = {
      length: lines.length,
      getLine: (row: number) => {
        const line = lines[row];
        return line === undefined
          ? undefined
          : {
              isWrapped: line.isWrapped,
              translateToString: (trim: boolean) => (trim ? line.text.trimEnd() : line.text)
            };
      }
    };
    expect(rowsOf(buffer)).toEqual([
      { text: 'first', wrapped: false },
      { text: 'wrapped', wrapped: true },
      { text: '', wrapped: false }
    ]);
  });
});
