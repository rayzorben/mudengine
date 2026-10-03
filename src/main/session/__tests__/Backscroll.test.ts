import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import { Backscroll } from '../Backscroll';
import { segmentBackscrolls } from '../backscrollMigration';

let home = '';
let dir = '';

/** Segments of `lines` lines, so a test reaches past the open one with a few writes. */
function segmentsOf(lines: number): void {
  setTuning({
    ...DEFAULT_INTERNAL.tuning,
    view: { ...DEFAULT_INTERNAL.tuning.view, consolePageLines: lines }
  });
}

const all = async (scroll: Backscroll): Promise<string> =>
  (await scroll.page(Number.POSITIVE_INFINITY)).text;

const files = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

async function opened(lines: number, after?: Promise<void>): Promise<Backscroll> {
  const scroll = new Backscroll({ lines, dir, after });
  await scroll.ready;
  return scroll;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-backscroll-'));
  dir = path.join(home, 'backscroll', 'vaelor');
  segmentsOf(4);
});

afterEach(() => {
  setTuning(DEFAULT_INTERNAL.tuning);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Backscroll', () => {
  it('replays what it was given, verbatim', async () => {
    const scroll = await opened(100);
    scroll.write('one\r\n');
    // Escape sequences are kept exactly: the in-place status repaint only
    // replays correctly because nothing here normalises it away.
    scroll.write('\x1b[79D\x1b[K[HP=30]:');
    expect(await all(scroll)).toBe('one\r\n\x1b[79D\x1b[K[HP=30]:');
  });

  /* The cap is the terminal's own `terminal.scrollback`, in lines; whole old
     segments go, and a page never reaches past the cap. */
  it('keeps the newest lines up to the cap and deletes whole old segments', async () => {
    const scroll = await opened(5);
    for (let i = 0; i < 40; i += 1) scroll.write(`line ${i}\n`);
    expect(await scroll.page(100)).toEqual({
      text: 'line 35\nline 36\nline 37\nline 38\nline 39\n',
      older: 0
    });
    scroll.close();
    // Segments of four lines: as many closed ones as still hold the cap, and
    // the open one has nothing in it yet.
    expect(files()).toEqual(['0009.log', '0010.log']);
  });

  it('hands out the newest lines as a page, reading closed segments, with how many are older', async () => {
    const scroll = await opened(100);
    for (let i = 0; i < 10; i += 1) scroll.write(`line ${i}\n`);
    scroll.write('[HP=30]:');
    expect(await scroll.page(3)).toEqual({ text: 'line 7\nline 8\nline 9\n[HP=30]:', older: 7 });
    expect(await scroll.page(6)).toEqual({
      text: 'line 4\nline 5\nline 6\nline 7\nline 8\nline 9\n[HP=30]:',
      older: 4
    });
    const whole = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('') + '[HP=30]:';
    expect(await scroll.page(10)).toEqual({ text: whole, older: 0 });
    expect(await scroll.page(50)).toEqual({ text: whole, older: 0 });
  });

  it('fixes what a page covers when it is asked, so later output is not in it', async () => {
    const scroll = await opened(100);
    for (let i = 0; i < 10; i += 1) scroll.write(`line ${i}\n`);
    const page = scroll.page(8);
    scroll.write('later\n');
    expect((await page).text).toBe(Array.from({ length: 8 }, (_, i) => `line ${i + 2}\n`).join(''));
  });

  it('counts the unterminated tail as part of the line it is on, not as a line', async () => {
    const scroll = await opened(2);
    scroll.write('a\nb\nc\n');
    scroll.write('[HP=30]:');
    expect(await all(scroll)).toBe('b\nc\n[HP=30]:');
  });

  it('ends every segment on a newline, so none starts inside an escape sequence', async () => {
    const scroll = await opened(100);
    scroll.write('aaaa\n\x1b[31mbbbb\n\x1b[0mcc');
    scroll.write('cc\nd\n\x1b[1;3');
    scroll.write('2mee\nff\n');
    scroll.close();
    for (const name of files().slice(0, -1)) {
      expect(fs.readFileSync(path.join(dir, name), 'utf8').endsWith('\n')).toBe(true);
    }
    const joined = files()
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
      .join('');
    expect(joined).toBe('aaaa\n\x1b[31mbbbb\n\x1b[0mcccc\nd\n\x1b[1;32mee\nff\n');
  });

  /*
   * The realm repaints its prompt unprompted every thirty seconds, with no
   * newline, so an idle character grew the tail by a chunk a repaint with no
   * cap behind it. A repaint erases the row it lands on; what it erased goes,
   * from memory and from the file.
   */
  it('drops the row a status repaint erases, so an idle prompt does not accumulate', async () => {
    const scroll = await opened(100);
    scroll.write('Newhaven Village Entrance\r\n');
    scroll.write('[HP=30]:');
    for (let i = 0; i < 50; i += 1) {
      scroll.write('\x1b[79D\x1b[K');
      scroll.write('[HP=30]:');
      scroll.flush();
    }
    const expected = 'Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:';
    expect(await all(scroll)).toBe(expected);
    scroll.close();
    expect(fs.readFileSync(path.join(dir, '0001.log'), 'utf8')).toBe(expected);
  });

  it('keeps a row the repaint cannot reach, and one a carriage return has folded', async () => {
    const wide = await opened(100);
    wide.write(`${'x'.repeat(100)}`);
    wide.write('\x1b[79D\x1b[K[HP=30]:');
    expect(await all(wide)).toBe(`${'x'.repeat(100)}\x1b[79D\x1b[K[HP=30]:`);

    dir = path.join(home, 'backscroll', 'other');
    const folded = await opened(100);
    folded.write('abc\rdef');
    folded.write('\x1b[79D\x1b[K[HP=30]:');
    expect(await all(folded)).toBe('abc\rdef\x1b[79D\x1b[K[HP=30]:');
  });

  it('keeps only the live line at a cap of zero, and writes nothing', async () => {
    const scroll = await opened(0);
    scroll.write('one\ntwo\n');
    scroll.write('[HP=30]:');
    expect(await all(scroll)).toBe('[HP=30]:');
    scroll.close();
    expect(files()).toEqual([]);
  });

  it('deletes whole old segments the moment a smaller cap is set', async () => {
    const scroll = await opened(100);
    for (let i = 0; i < 12; i += 1) scroll.write(`line ${i}\n`);
    scroll.flush();
    expect(files()).toEqual(['0001.log', '0002.log', '0003.log']);
    scroll.setLimit(2);
    expect(await all(scroll)).toBe('line 10\nline 11\n');
    expect(files()).toEqual(['0003.log']);
  });
});

/*
 * Quitting and opening the client again used to be the one way to empty a
 * console (todo 06). What the terminal would have painted is written down,
 * and the next launch reads it back.
 */
describe('the backscroll on disk', () => {
  it('writes what it was given, and reads it back on the next launch', async () => {
    const first = await opened(100);
    first.write('Newhaven Village Entrance\r\n');
    first.write('\x1b[79D\x1b[K[HP=30]:');
    // Deferred: the write happens on a timer, and `close()` is the flush the
    // quit path makes.
    expect(files()).toEqual([]);
    first.close();
    expect(fs.readFileSync(path.join(dir, '0001.log'), 'utf8')).toBe(
      'Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:'
    );

    const next = await opened(100);
    expect(await all(next)).toBe('Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:');
    // And carries on from there, so the record is one continuous console.
    next.write('n\r\n');
    next.close();
    expect(fs.readFileSync(path.join(dir, '0001.log'), 'utf8')).toBe(
      'Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:n\r\n'
    );
  });

  it('pages back through every retained line after a relaunch', async () => {
    const first = await opened(1000);
    for (let i = 0; i < 30; i += 1) first.write(`line ${i}\n`);
    first.close();
    const next = await opened(1000);
    const expected = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
    expect(await next.page(1000)).toEqual({ text: expected, older: 0 });
    expect(await next.page(9)).toEqual({
      text: expected.split('\n').slice(21).join('\n'),
      older: 21
    });
  });

  it('deletes the segments a relaunch with a smaller cap no longer keeps', async () => {
    const first = await opened(1000);
    for (let i = 0; i < 30; i += 1) first.write(`line ${i}\n`);
    first.close();
    const next = await opened(9);
    expect(await all(next)).toBe(Array.from({ length: 9 }, (_, i) => `line ${i + 21}\n`).join(''));
    expect(files()).toEqual(['0006.log', '0007.log', '0008.log']);
  });

  it('waits for the split, and a page asked meanwhile holds the record and what came since', async () => {
    let split = (): void => undefined;
    const after = new Promise<void>((resolve) => {
      split = resolve;
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0001.log'), 'a\nb\nc\nd\n');
    fs.writeFileSync(path.join(dir, '0002.log'), 'e\n');
    const scroll = new Backscroll({ lines: 100, dir, after });
    scroll.write('f\n');
    const page = scroll.page(100);
    scroll.write('g\n');
    split();
    expect(await page).toEqual({ text: 'a\nb\nc\nd\ne\nf\n', older: 0 });
    await scroll.ready;
    expect(await all(scroll)).toBe('a\nb\nc\nd\ne\nf\ng\n');
    scroll.close();
    expect(fs.readFileSync(path.join(dir, '0002.log'), 'utf8')).toBe('e\nf\ng\n');
  });

  it('adds what was painted before the record was read to its newest segment on a quick quit', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0003.log'), 'old\n');
    const scroll = new Backscroll({ lines: 100, dir, after: new Promise<void>(() => undefined) });
    scroll.write('new\n');
    scroll.close();
    expect(fs.readFileSync(path.join(dir, '0003.log'), 'utf8')).toBe('old\nnew\n');
  });

  it('leaves nothing behind for a session that showed nothing', async () => {
    const scroll = await opened(100);
    scroll.close();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('carries on in memory when the record cannot be written, and says so once', async () => {
    // A file where the directory has to be: every write under it fails.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, '');
    const problems: string[] = [];
    const scroll = new Backscroll({ lines: 100, dir, onProblem: (m) => problems.push(m) });
    await scroll.ready;
    scroll.write('one\n');
    scroll.flush();
    scroll.write('two\n');
    scroll.flush();
    expect(await all(scroll)).toBe('one\ntwo\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(dir);
  });

  it('starts empty and says so when the record exists and cannot be read', async () => {
    fs.mkdirSync(path.join(dir, '0001.log'), { recursive: true });
    fs.writeFileSync(path.join(dir, '0002.log'), 'x\n');
    const problems: string[] = [];
    const scroll = new Backscroll({ lines: 100, dir, onProblem: (m) => problems.push(m) });
    await scroll.ready;
    expect(await all(scroll)).toBe('');
    expect(problems).toHaveLength(1);
    // And writes nothing over a record this build could not read.
    scroll.write('one\n');
    scroll.close();
    expect(fs.readFileSync(path.join(dir, '0002.log'), 'utf8')).toBe('x\n');
    expect(problems).toHaveLength(1);
  });
});

describe('the startup split of an old backscroll', () => {
  const old = (): string => path.join(home, 'backscroll', 'vaelor.log');

  it('splits the old file into segments ending on newlines, keeps a copy, and says so', async () => {
    const text = `${Array.from({ length: 10 }, (_, i) => `\x1b[3${i % 8}mline ${i}\r\n`).join('')}[HP=30]:`;
    fs.mkdirSync(path.dirname(old()), { recursive: true });
    fs.writeFileSync(old(), text);
    const notes: string[] = [];
    await segmentBackscrolls(path.join(home, 'backscroll'), 4, (m) => notes.push(m));
    expect(fs.existsSync(old())).toBe(false);
    expect(fs.readFileSync(`${old()}.bak`, 'utf8')).toBe(text);
    expect(files()).toEqual(['0001.log', '0002.log', '0003.log']);
    expect(fs.readFileSync(path.join(dir, '0003.log'), 'utf8')).toBe(
      '\x1b[30mline 8\r\n\x1b[31mline 9\r\n[HP=30]:'
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(old());

    const scroll = await opened(100);
    expect(await all(scroll)).toBe(text);
    // Run again: nothing left to split, and nothing said.
    await segmentBackscrolls(path.join(home, 'backscroll'), 4, (m) => notes.push(m));
    expect(notes).toHaveLength(1);
  });

  it('puts segments a quit wrote during the split after the old file', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(old(), 'a\nb\n');
    fs.writeFileSync(path.join(dir, '0001.log'), 'c\n');
    await segmentBackscrolls(path.join(home, 'backscroll'), 4, () => undefined);
    const scroll = await opened(100);
    expect(await all(scroll)).toBe('a\nb\nc\n');
  });
});
