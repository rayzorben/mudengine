import { describe, expect, it } from 'vitest';

import { NO_TALK_BACKLOG, talkAttached, withEarlier, withSaid } from '../talkBacklog';
import { DRAW_NEWEST, drawnStart, lineKey, widened } from '../talkWindow';
import type { Block } from '@shared/blocks';
import type { TalkKeep } from '@shared/talkLog';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const KEEP: TalkKeep = { least: 2, most: 4, hours: 48 };

function said(seq: number, hoursAgo: number): Block {
  return {
    seq,
    at: NOW - hoursAgo * HOUR,
    type: 'conversation-gossip',
    domain: 'conversation',
    groups: { player: 'Soul', message: `line ${seq}` },
    text: `line ${seq}`,
    terminator: 'newline',
    confidence: 0.9
  };
}
const seqs = (blocks: readonly Block[]): number[] => blocks.map((block) => block.seq);

describe("the window's hold on a conversation", () => {
  it('takes an attach as main trimmed it', () => {
    const blocks = [said(7, 2), said(8, 1)];
    expect(talkAttached({ blocks, start: 40 })).toEqual({
      talk: blocks,
      talkStart: 40,
      talkLoaded: 0
    });
  });

  it('counts each line dropped off the front into where the rest starts', () => {
    const held = { talk: [said(1, 60), said(2, 50), said(3, 1)], talkStart: 10, talkLoaded: 0 };
    const next = withSaid(held, said(4, 0), KEEP);
    expect(seqs(next.talk)).toEqual([3, 4]);
    expect(next.talkStart).toBe(12);
  });

  it('joins the page before its first line on, and keeps it as lines are said', () => {
    const held = { talk: [said(3, 1), said(4, 0)], talkStart: 2, talkLoaded: 0 };
    const read = withEarlier(held, 2, { blocks: [said(1, 300), said(2, 200)], start: 0 });
    expect(seqs(read.talk)).toEqual([1, 2, 3, 4]);
    expect(read).toMatchObject({ talkStart: 0, talkLoaded: 4 });
    // Two are older than the hours and over the least: kept, because the reader loaded them.
    const next = withSaid(read, said(5, 0), KEEP);
    expect(seqs(next.talk)).toEqual([2, 3, 4, 5]);
    expect(next.talkStart).toBe(1);
  });

  it('lets go of a page asked for before the front moved', () => {
    const held = { talk: [said(4, 0)], talkStart: 3, talkLoaded: 0 };
    expect(withEarlier(held, 2, { blocks: [said(1, 9)], start: 1 })).toBe(held);
  });

  it('takes a log with nothing older as its first line', () => {
    const held = { ...NO_TALK_BACKLOG, talk: [said(4, 0)], talkStart: 3 };
    expect(withEarlier(held, 3, { blocks: [], start: 0 }).talkStart).toBe(0);
  });
});

describe('the lines the Talk card draws', () => {
  const shown = [1, 2, 3, 4, 5, 6, 7].map((seq) => said(seq, 0));

  it('draws the newest lines until the reader scrolls up', () => {
    expect(drawnStart(shown, DRAW_NEWEST, 3)).toBe(4);
    expect(drawnStart(shown.slice(0, 2), DRAW_NEWEST, 3)).toBe(0);
  });

  it('widens a page at a time from a named line, which a line said after does not move', () => {
    const wider = widened(shown, 4, 2);
    expect(wider).toEqual({ kind: 'from', key: lineKey(shown[2]!) });
    expect(drawnStart([...shown, said(8, 0)], wider, 3)).toBe(2);
  });

  it('draws every line once a page reaches the first, the next page from the log included', () => {
    const all = widened(shown, 2, 2);
    expect(all).toEqual({ kind: 'all' });
    expect(drawnStart([said(0, 9), ...shown], all, 3)).toBe(0);
  });

  it('draws the newest again when the named line has gone', () => {
    expect(drawnStart(shown.slice(4), widened(shown, 4, 2), 3)).toBe(0);
    expect(drawnStart(shown.slice(3), widened(shown, 4, 2), 3)).toBe(1);
  });
});
