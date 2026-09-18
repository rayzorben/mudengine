import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Backscroll } from '../Backscroll';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-backscroll-'));
  file = path.join(dir, 'backscroll', 'vaelor.log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Backscroll', () => {
  it('replays what it was given, verbatim', () => {
    const scroll = new Backscroll({ lines: 100 });
    scroll.write('one\r\n');
    // Escape sequences are kept exactly: the in-place status repaint only
    // replays correctly because nothing here normalises it away.
    scroll.write('\x1b[79D\x1b[K[HP=30]:');
    expect(scroll.text).toBe('one\r\n\x1b[79D\x1b[K[HP=30]:');
  });

  /* The cap is the terminal's own `terminal.scrollback`, in lines, so nothing
     is replayed that the terminal would not keep. */
  it('keeps the newest lines up to the cap and drops the oldest', () => {
    const scroll = new Backscroll({ lines: 5 });
    for (let i = 0; i < 40; i += 1) scroll.write(`line ${i}\n`);
    expect(scroll.lines).toBe(5);
    expect(scroll.text).toBe('line 35\nline 36\nline 37\nline 38\nline 39\n');
  });

  it('counts the unterminated tail as part of the line it is on, not as a line', () => {
    const scroll = new Backscroll({ lines: 2 });
    scroll.write('a\nb\nc\n');
    scroll.write('[HP=30]:');
    expect(scroll.text).toBe('b\nc\n[HP=30]:');
  });

  it('cuts one chunk larger than the whole cap at a line boundary', () => {
    // One chunk holding more lines than the cap, so trimming has to cut inside it.
    const written = 'aaaa\n\x1b[31mbbbb\n\x1b[0mcccc\n';
    const scroll = new Backscroll({ lines: 2 });
    scroll.write(written);

    const kept = scroll.text;
    expect(kept).toBe('\x1b[31mbbbb\n\x1b[0mcccc\n');
    // Whatever survived begins immediately after a newline, so replaying it
    // into a fresh terminal can never resume halfway through an escape
    // sequence. Beginning with a *complete* sequence is fine and expected.
    expect(written[written.length - kept.length - 1]).toBe('\n');
  });

  it('keeps the newest output rather than emptying itself', () => {
    const scroll = new Backscroll({ lines: 1 });
    scroll.write('old\n');
    // A chunk holding more lines than the cap: the cap protects memory and
    // the launch's replay, and it must not cost the live screen.
    scroll.write('a longer chunk than the cap allows\nwith the live line last\n');
    expect(scroll.text).toBe('with the live line last\n');
  });

  /*
   * The realm repaints its prompt unprompted every thirty seconds, with no
   * newline, so an idle character grew the tail by a chunk a repaint with no
   * cap behind it. A repaint erases the row it lands on; what it erased goes.
   */
  it('drops the row a status repaint erases, so an idle prompt does not accumulate', () => {
    const scroll = new Backscroll({ lines: 100 });
    scroll.write('Newhaven Village Entrance\r\n');
    scroll.write('[HP=30]:');
    for (let i = 0; i < 50; i += 1) {
      scroll.write('\x1b[79D\x1b[K');
      scroll.write('[HP=30]:');
    }
    expect(scroll.text).toBe('Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:');
  });

  it('keeps a row the repaint cannot reach, and one a carriage return has folded', () => {
    const wide = new Backscroll({ lines: 100 });
    wide.write(`${'x'.repeat(100)}`);
    wide.write('\x1b[79D\x1b[K[HP=30]:');
    expect(wide.text).toBe(`${'x'.repeat(100)}\x1b[79D\x1b[K[HP=30]:`);

    const folded = new Backscroll({ lines: 100 });
    folded.write('abc\rdef');
    folded.write('\x1b[79D\x1b[K[HP=30]:');
    expect(folded.text).toBe('abc\rdef\x1b[79D\x1b[K[HP=30]:');
  });

  it('keeps only the live line at a cap of zero', () => {
    const scroll = new Backscroll({ lines: 0 });
    scroll.write('one\ntwo\n');
    scroll.write('[HP=30]:');
    expect(scroll.text).toBe('[HP=30]:');
  });

  it('trims to a smaller cap the moment it is set', () => {
    const scroll = new Backscroll({ lines: 10 });
    for (let i = 0; i < 10; i += 1) scroll.write(`line ${i}\n`);
    scroll.setLimit(2);
    expect(scroll.text).toBe('line 8\nline 9\n');
  });
});

/*
 * The whole point of the todo (06, 2026-09-17): quitting and opening the
 * client again used to be the one way to empty a console. What the terminal
 * would have painted is written down, and the next launch reads it back.
 */
describe('the backscroll on disk', () => {
  it('writes what it was given, and reads it back on the next launch', () => {
    const first = new Backscroll({ lines: 100, file });
    first.write('Newhaven Village Entrance\r\n');
    first.write('\x1b[79D\x1b[K[HP=30]:');
    // Deferred: the write happens on a timer, and `close()` is the flush the
    // quit path makes.
    expect(fs.existsSync(file)).toBe(false);
    first.close();
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:'
    );

    const next = new Backscroll({ lines: 100, file });
    expect(next.text).toBe('Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:');
    // And carries on from there, so the file is one continuous console.
    next.write('n\r\n');
    next.close();
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'Newhaven Village Entrance\r\n\x1b[79D\x1b[K[HP=30]:n\r\n'
    );
  });

  it('keeps only the cap of a file that held more, and rewrites the file to match', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a\nb\nc\nd\n', 'utf8');
    const scroll = new Backscroll({ lines: 2, file });
    expect(scroll.text).toBe('c\nd\n');
    // Made the buffer again on open, so the next launch reads only what it
    // will show rather than an evening to keep a screenful.
    expect(fs.readFileSync(file, 'utf8')).toBe('c\nd\n');
  });

  it('rewrites the file instead of appending once it holds twice what is kept', () => {
    const scroll = new Backscroll({ lines: 2, file });
    for (let i = 0; i < 20; i += 1) {
      scroll.write(`line ${i}\n`);
      scroll.flush();
    }
    scroll.close();
    const written = fs.readFileSync(file, 'utf8');
    // Never more than the rewrite factor times the buffer, however long the
    // session runs — and always ending in what the buffer holds.
    expect(written.endsWith('line 18\nline 19\n')).toBe(true);
    expect(written.split('\n').length).toBeLessThanOrEqual(2 * 2 + 1);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  /* A restored file is one chunk holding the whole cap, and cutting it used to
     copy the lot on every painted line (3ms a line at the shipped cap). The
     cut is a moved head now; what matters here is that it stays right. */
  it('carries on correctly line by line after a restore', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const restored = Array.from({ length: 1000 }, (_, i) => `old ${i}\n`).join('');
    fs.writeFileSync(file, restored, 'utf8');
    const scroll = new Backscroll({ lines: 1000, file });
    for (let i = 0; i < 1500; i += 1) scroll.write(`new ${i}\n`);
    const expected = [
      ...Array.from({ length: 1000 }, (_, i) => `old ${i}\n`).slice(500),
      ...Array.from({ length: 1500 }, (_, i) => `new ${i}\n`)
    ]
      .slice(-1000)
      .join('');
    expect(scroll.lines).toBe(1000);
    expect(scroll.text).toBe(expected);
    scroll.close();
    expect(fs.readFileSync(file, 'utf8').endsWith('new 1499\n')).toBe(true);
  });

  it('writes nothing at a cap of zero', () => {
    const scroll = new Backscroll({ lines: 0, file });
    scroll.write('one\n');
    scroll.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves no file behind for a session that showed nothing', () => {
    const scroll = new Backscroll({ lines: 100, file });
    scroll.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('carries on in memory when the file cannot be written, and says so once', () => {
    // A file where a directory has to be: every write to it fails.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file);
    const problems: string[] = [];
    const scroll = new Backscroll({ lines: 100, file, onProblem: (m) => problems.push(m) });
    scroll.write('one\n');
    scroll.flush();
    scroll.write('two\n');
    scroll.flush();
    expect(scroll.text).toBe('one\ntwo\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('vaelor.log');
  });

  it('starts empty and says so when the file exists and cannot be read', () => {
    fs.mkdirSync(file, { recursive: true });
    const problems: string[] = [];
    const scroll = new Backscroll({ lines: 100, file, onProblem: (m) => problems.push(m) });
    expect(scroll.text).toBe('');
    expect(problems).toHaveLength(1);
    // And writes nothing over a file this build could not read.
    scroll.write('one\n');
    scroll.close();
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(problems).toHaveLength(1);
  });
});
