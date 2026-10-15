/**
 * Talk in the game view (todo 140): which lines the feed over the map shows,
 * and which are for this character. A telepath to it, a say addressed to it,
 * or a line naming it is for it, and stays in the feed until the Talk panel
 * is opened; everything else fades. The panel is the Talk card itself, so
 * the whole conversation and the composer are the card's.
 */
import type { Block } from '@shared/blocks';
import { mentions } from '@shared/mentions';
import { isOwnName } from '@shared/players';

/** Lines the feed shows at once. */
export const FEED_LINES = 6;

/** Whether a line was said to this character, or names it. */
export function forYou(block: Block, self: string | null): boolean {
  const speaker = block.groups['player'];
  const said = block.groups['message'];
  // A receipt (`--- Telepath Sent to X ---`) is this character's own; it carries no message.
  if (said === undefined || (speaker !== undefined && isOwnName(self, speaker))) return false;
  if (block.type === 'conversation-telepath') return true;
  const target = block.groups['target'];
  if (block.type === 'conversation-directed' && target !== undefined && isOwnName(self, target))
    return true;
  return mentions(block, self);
}

/**
 * Where the feed starts: after the newest line seen with the panel open, and
 * never before the view came up (`since`), so the backlog the card restores
 * from disk stays in the panel.
 */
export interface FeedStart {
  seen: number;
  since: number;
}

const fresh = (block: Block, start: FeedStart): boolean =>
  block.seq > start.seen && block.at >= start.since;

/** What the feed shows: the newest lines said since the start, the last `FEED_LINES` of them. */
export function feedOf(talk: readonly Block[], start: FeedStart): Block[] {
  return talk
    .filter((block) => block.domain === 'conversation' && fresh(block, start))
    .slice(-FEED_LINES);
}

/** How many lines for this character arrived since the start. */
export function unreadFor(talk: readonly Block[], start: FeedStart, self: string | null): number {
  return talk.filter((block) => fresh(block, start) && forYou(block, self)).length;
}
