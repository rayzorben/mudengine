import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_TALK, TalkLog } from '../TalkLog';
import type { Block } from '../../../shared/blocks';

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
const NOW = Date.parse('2026-09-01T12:00:00Z');

function said(at: number, text: string): Block {
  return {
    seq: 1,
    at,
    type: 'conversation-gossip',
    domain: 'conversation',
    groups: { player: 'Soul', message: text },
    text,
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
    expect(second.backlog().map((block) => block.text)).toEqual(['hello', 'again']);
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
    expect(second.backlog().map((block) => block.text)).toEqual(['recent']);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('ancient');
  });

  it('reads past a torn last line — what a crash mid-append leaves', () => {
    const file = path.join(dir, 'vaelor.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(said(NOW, 'whole'))}\n{"seq":2,"at":${NOW}`, 'utf8');
    const log = new TalkLog(file, 365, {}, () => NOW);
    expect(log.backlog().map((block) => block.text)).toEqual(['whole']);
  });

  it('answers with an empty backlog when there is no file yet, and says nothing', () => {
    const notices: string[] = [];
    const log = new TalkLog(
      path.join(dir, 'fresh.jsonl'),
      365,
      { notice: (message) => notices.push(message) },
      () => NOW
    );
    expect(log.backlog()).toEqual([]);
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
    expect(log.backlog()).toEqual([]);
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

  it('NO_TALK writes and restores nothing', () => {
    NO_TALK.append(said(NOW, 'ignored'));
    expect(NO_TALK.backlog()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
