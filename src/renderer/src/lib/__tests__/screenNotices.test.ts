import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';

import { noticeRows, noticeSequence } from '../console';
import { drawnBelow, screenNotices, terminalSurface } from '../screenNotices';

/*
 * Todo 02 (2026-10-03): Paradigm's stat screen leaves the cursor on the field
 * being edited, and the client's notices were written there, across the menu.
 * The bytes are the capture's, the terminal is a real xterm, and each step
 * waits for xterm to parse, as the console writer's `settled` does.
 */
const capture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/paradigm-stat-screen.json'), 'utf8')
) as { drawn: string; keystroke: string[]; saved: string[] };

const HELD =
  'Automation is paused and its queue cleared: the stat screen has the keyboard, and anything sent now would be typed into one of its fields. Your own typing still goes through.';
const NOT_NAME =
  'Not using this stat screen: it has the name open for editing, which the client never touches. Finish it by hand by pressing Enter through to SAVE.';

const parsed = (term: Terminal, bytes = ''): Promise<void> =>
  new Promise((done) => term.write(bytes, done));

const screenText = (term: Terminal): string[] => {
  const buffer = term.buffer.active;
  return Array.from(
    { length: term.rows },
    (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''
  );
};

/** The menu's rows: everything down to its lowest drawn row. */
const BOTTOM = 21;
const menuOf = (rows: string[]): string[] => rows.slice(0, BOTTOM + 1);

async function drawnScreen(rows: number) {
  const term = new Terminal({ cols: 120, rows, allowProposedApi: true });
  await parsed(term, capture.drawn);
  const notices = screenNotices(() => terminalSurface(term));
  const menu = menuOf(screenText(term));
  const cursor = { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY };
  const raise = async (message: string): Promise<void> => {
    notices.expect();
    notices.notice(message);
    await parsed(term);
  };
  /** One server chunk, bracketed as `TerminalView.write` brackets it. */
  const chunk = async (bytes: string): Promise<void> => {
    const bracketed = notices.active;
    if (bracketed) notices.lift();
    await parsed(term, bytes);
    if (bracketed) notices.settle();
    await parsed(term);
  };
  return { term, notices, menu, cursor, raise, chunk };
}

describe('a notice while the server draws a screen', () => {
  it('is a screen: the cursor sits on a field with the menu drawn below it', async () => {
    const { term, menu, cursor } = await drawnScreen(32);
    expect(menu[BOTTOM]).toMatch(/\\_+/);
    expect(cursor.y).toBeLessThan(BOTTOM);
    expect(drawnBelow(terminalSurface(term))).toBe(BOTTOM);
  });

  // The positive control: written at the cursor, as before, it covers the menu.
  it('covered the menu when written at the cursor', async () => {
    const { term, menu, cursor } = await drawnScreen(32);
    await parsed(term, noticeSequence(HELD, term.buffer.active.cursorX === 0));
    expect(menuOf(screenText(term))).not.toEqual(menu);
    expect(cursor.y).toBeLessThan(BOTTOM);
  });

  it('goes under the menu and leaves the cursor where the server put it', async () => {
    const { term, menu, cursor, raise } = await drawnScreen(32);
    await raise(HELD);
    await raise(NOT_NAME);
    const rows = screenText(term);
    expect(menuOf(rows)).toEqual(menu);
    const held = noticeRows(HELD, 120).length;
    expect(rows[BOTTOM + 1]).toContain('│ Automation is paused');
    expect(rows[BOTTOM + 1 + held]).toContain('│ Not using this stat screen');
    expect({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }).toEqual(cursor);
  });

  it('stays under the menu through a keystroke the server answers', async () => {
    const { term, menu, raise, chunk } = await drawnScreen(32);
    await raise(HELD);
    await raise(NOT_NAME);
    const before = screenText(term);
    // The server's answer clears its own message row, 23, which is a notice's row here.
    for (const bytes of capture.keystroke) await chunk(bytes);
    const rows = screenText(term);
    expect(menuOf(rows)).toEqual(menu);
    expect(rows.slice(BOTTOM + 1)).toEqual(before.slice(BOTTOM + 1));
  });

  it('goes into the text once the screen is saved, with nothing left on the rows it used', async () => {
    const { term, raise, chunk, notices } = await drawnScreen(32);
    await raise(HELD);
    await raise(NOT_NAME);
    for (const bytes of capture.saved) await chunk(bytes);
    expect(notices.active).toBe(false);
    const all = screenText(term).join('\n');
    expect(all).toContain('your suicide password');
    // Each said once, from its bar: no tail of a notice beside the server's lines.
    expect(all.split('Automation is paused').length).toBe(2);
    expect(all.split('Not using this stat screen').length).toBe(2);
    expect(all).not.toMatch(/commands\S/);
  });

  it('waits for the screen to end when the rows under the menu are full', async () => {
    const { term, menu, raise, chunk, notices } = await drawnScreen(24);
    await raise(HELD);
    await raise(NOT_NAME);
    expect(menuOf(screenText(term))).toEqual(menu);
    expect(screenText(term).join('\n')).not.toContain('Not using this stat screen');
    expect(notices.active).toBe(true);
    for (const bytes of capture.saved) await chunk(bytes);
    expect(notices.active).toBe(false);
    const all = screenText(term).join('\n');
    expect(all).toContain('Not using this stat screen');
  });
});

describe('a notice in the scrolling game', () => {
  it('is written at the cursor, as the stream always had it', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const written: string[] = [];
    await parsed(term, '[HP=74/KAI=9]:');
    const surface = (): ReturnType<typeof terminalSurface> => ({
      ...terminalSurface(term),
      write: (bytes) => {
        written.push(bytes);
        term.write(bytes);
      }
    });
    const notices = screenNotices(surface);
    notices.expect();
    notices.notice('Walking 73 steps.');
    await parsed(term);
    notices.expect();
    notices.notice('Started Goblin caves.');
    expect(written).toEqual([
      noticeSequence('Walking 73 steps.', false),
      noticeSequence('Started Goblin caves.', true)
    ]);
    expect(notices.active).toBe(false);
  });
});
