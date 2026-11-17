import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_TALK, TalkLog } from '../TalkLog';
import type { Block } from '../../../shared/blocks';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { NO_TALK_PAGE, type TalkPage } from '../../../shared/talkLog';

let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talklog-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = DAY / 24;
const NOW = Date.parse('2026-09-01T12:00:00Z');

function said(at: number, text: string): Block {
  return {
    seq: 1,
    at,
    type: 'conversation-gossip',
    domain: 'conversation',
    groups: { player: 'Soul', message: text },
    text,
    terminator: 'newline',
    confidence: 0.9
  };
}

describe('the conversation log', () => {
  it('restores what an earlier session appended, oldest first', () => {
    const file = path.join(dir, 'vaelor.jsonl');
    const first = new TalkLog(file, 365, {}, () => NOW);
    first.append(said(NOW - 1000, 'hello'));
    first.append(said(NOW - 500, 'again'));
    first.dispose();

    const second = new TalkLog(file, 365, {}, () => NOW);
    expect(second.backlog().blocks.map((block) => block.text)).toEqual(['hello', 'again']);
  });

  it('writes on a timer, not on the parse path, and flushes on dispose', () => {
    const file = path.join(dir, 'vaelor.jsonl');
    const log = new TalkLog(file, 365, {}, () => NOW);
    log.append(said(NOW, 'hi'));
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(2500);
    expect(fs.readFileSync(file, 'utf8')).toContain('hi');
  });

  it('drops what has aged out when it opens, on disk as well as in memory', () => {
    const file = path.join(dir, 'vaelor.jsonl');
    const first = new TalkLog(file, 365, {}, () => NOW);
    first.append(said(NOW - 400 * DAY, 'ancient'));
    first.append(said(NOW - 1 * DAY, 'recent'));
    first.dispose();

    const second = new TalkLog(file, 365, {}, () => NOW);
    expect(second.backlog().blocks.map((block) => block.text)).toEqual(['recent']);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('ancient');
  });

  it('reads past a torn last line — what a crash mid-append leaves', () => {
    const file = path.join(dir, 'vaelor.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(said(NOW, 'whole'))}\n{"seq":2,"at":${NOW}`, 'utf8');
    const log = new TalkLog(file, 365, {}, () => NOW);
    expect(log.backlog().blocks.map((block) => block.text)).toEqual(['whole']);
  });

  it('answers with an empty backlog when there is no file yet, and says nothing', () => {
    const notices: string[] = [];
    const log = new TalkLog(
      path.join(dir, 'fresh.jsonl'),
      365,
      { notice: (message) => notices.push(message) },
      () => NOW
    );
    expect(log.backlog()).toEqual(NO_TALK_PAGE);
    expect(notices).toEqual([]);
  });

  it('says out loud when a log that exists cannot be read', () => {
    const notices: string[] = [];
    // A directory where the file should be: readFileSync fails with EISDIR,
    // which must not be mistaken for the silent first run.
    const blocked = path.join(dir, 'vaelor.jsonl');
    fs.mkdirSync(blocked);
    const log = new TalkLog(
      blocked,
      365,
      { notice: (message) => notices.push(message) },
      () => NOW
    );
    expect(log.backlog()).toEqual(NO_TALK_PAGE);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('could not be read');
  });

  it('reports a directory that cannot be written once, and keeps the session', () => {
    const notices: string[] = [];
    // A path under a file is unwritable on every platform.
    const blocked = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocked, 'x', 'utf8');
    const log = new TalkLog(path.join(blocked, 'vaelor.jsonl'), 365, {
      notice: (message) => notices.push(message)
    });
    log.append(said(NOW, 'one'));
    log.flush();
    log.append(said(NOW, 'two'));
    log.flush();
    expect(notices).toHaveLength(1);
  });

  it('NO_TALK writes and restores nothing', async () => {
    NO_TALK.append(said(NOW, 'ignored'));
    expect(NO_TALK.backlog()).toEqual(NO_TALK_PAGE);
    expect(await NO_TALK.page(10)).toEqual(NO_TALK_PAGE);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  /** A log of `count` lines `gapMs` apart, the last one said at `NOW`, written and reopened. */
  function reopened(count: number, gapMs: number): TalkLog {
    const file = path.join(dir, 'festus.jsonl');
    const lines = Array.from({ length: count }, (_, index) =>
      JSON.stringify(said(NOW - (count - 1 - index) * gapMs, `line ${index}`))
    );
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return new TalkLog(file, 365, {}, () => NOW);
  }
  const texts = (page: TalkPage): string[] => page.blocks.map((block) => block.text);

  it('keeps two days of talk past the line count, and says where its tail starts', () => {
    // An hour apart: lines 0–651 are older than 48 hours, and 500 are kept however old.
    const view = DEFAULT_INTERNAL.tuning.view;
    expect(reopened(700, HOUR).backlog().start).toBe(700 - view.talkLimit);
    fs.rmSync(path.join(dir, 'festus.jsonl'));
    // A minute apart: all 700 are inside the two days.
    expect(reopened(700, 60_000).backlog().start).toBe(0);
  });

  it('reads the page before a line off the disk, back to the first line', async () => {
    const log = reopened(1200, DAY / 10);
    const tail = log.backlog();
    expect(tail.start).toBe(700);

    const page = await log.page(tail.start);
    expect(page.start).toBe(200);
    expect(texts(page)).toHaveLength(500);
    expect(texts(page)[0]).toBe('line 200');
    expect(texts(page)[499]).toBe('line 699');

    const first = await log.page(page.start);
    expect(first.start).toBe(0);
    expect(texts(first)).toEqual(Array.from({ length: 200 }, (_, index) => `line ${index}`));
    expect(await log.page(0)).toEqual(NO_TALK_PAGE);
  });

  it('numbers a line said this session after the ones on disk, written or not', async () => {
    const log = reopened(3, 1000);
    log.append(said(NOW, 'held, with a snowman ☃'));
    log.append(said(NOW, 'newest'));
    expect(log.backlog().start).toBe(0);
    // Asked before the timer wrote them: the page writes what is held first.
    expect(texts(await log.page(5))).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'held, with a snowman ☃',
      'newest'
    ]);
    expect(texts(await log.page(4))).toHaveLength(4);
  });

  it('hands over nothing older once a write has failed', async () => {
    const notices: string[] = [];
    const blocked = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocked, 'x', 'utf8');
    const log = new TalkLog(path.join(blocked, 'vaelor.jsonl'), 365, {
      notice: (message) => notices.push(message)
    });
    log.append(said(NOW, 'one'));
    expect(await log.page(1)).toEqual(NO_TALK_PAGE);
    expect(notices).toHaveLength(1);
    // What was said is still on the card.
    expect(texts(log.backlog())).toEqual(['one']);
  });
});
