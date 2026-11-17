/**
 * One character's conversation as the window holds it: the lines, where they
 * sit in main's log, and how many the reader has loaded up to. Pure; the view
 * folds every change through here.
 */
import type { Block } from '@shared/blocks';
import { talkExcess, type TalkKeep, type TalkPage } from '@shared/talkLog';

export interface TalkBacklog {
  /** What has been said, oldest first. */
  talk: Block[];
  /** Lines main's log holds before the first of `talk`; 0 when none is older. */
  talkStart: number;
  /**
   * Lines the reader scrolled back to. Never fewer are kept from then, so a
   * line said while somebody reads last week does not drop the page under them.
   */
  talkLoaded: number;
}

export const NO_TALK_BACKLOG: TalkBacklog = { talk: [], talkStart: 0, talkLoaded: 0 };

/** What an attach hands over. Main trimmed it by the same rule. */
export function talkAttached(page: TalkPage): TalkBacklog {
  return { talk: page.blocks, talkStart: page.start, talkLoaded: 0 };
}

/** A line said, and the oldest dropped where the rule says so. Dated by the line's own stamp. */
export function withSaid<T extends TalkBacklog>(held: T, block: Block, keep: TalkKeep): T {
  const talk = [...held.talk, block];
  const least = Math.max(keep.least, held.talkLoaded);
  const excess = talkExcess(talk, block.at, { ...keep, least });
  if (excess === 0) return { ...held, talk };
  return { ...held, talk: talk.slice(excess), talkStart: held.talkStart + excess };
}

/**
 * The page before line `before`, joined on. A page asked for before the front
 * moved (a line dropped, another attach) no longer meets it and is let go; the
 * card asks again at the reader's next scroll.
 */
export function withEarlier<T extends TalkBacklog>(held: T, before: number, page: TalkPage): T {
  if (held.talkStart !== before) return held;
  const talk = [...page.blocks, ...held.talk];
  return { ...held, talk, talkStart: page.start, talkLoaded: talk.length };
}
