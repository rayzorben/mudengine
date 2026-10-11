/**
 * Whether a line of talk is aimed at this character: `@Festus`, any case, said
 * by somebody else (todo 29). One test read by the notice, the tab's mark and
 * the Talk card's Mentions toggle, so the three agree.
 *
 * Every `@word` in captures/ is a MegaMUD remote (`@health`, `@kill Gambit`,
 * 143 of 143, `todo/29-at-words-in-captures.mjs`); a line the remotes grammar
 * reads as one is a remote call, never a mention. The realm echoes a
 * character's own gossip and gangpath back to it under its own name
 * (GreaterMUD `CommManager.cs`, `SendGossip(inPlayer, …)`), so the speaker's
 * own lines are left out.
 */
import type { Block } from './blocks';
import { rowAsks, type AlertRule, type Notice } from './notifications';
import { telepathNotice } from './characterNotices';
import { isOwnName } from './players';
import { parseRemoteCall } from './remotes';

/**
 * An `@word` opening a word: the start, a space, a bracket or a quote before
 * it. Inside an address (`mail@festus.net`, `site/@festus`) it is not somebody
 * calling out. Names are one `\w+` word on every realm (`patterns.ts`), so the
 * word is read whole and compared by `isOwnName`: `@Festuss` is not `@Festus`.
 */
const AT_WORD = /(?<=^|[\s(\[{"'])@(\w+)/g;

/** Where each `@name` sits in `text`, as `[start, end)` pairs; none for an unread name. */
export function mentionSpans(text: string, self: string | null): Array<[number, number]> {
  if (self === null || self.length === 0) return [];
  return [...text.matchAll(AT_WORD)]
    .filter((hit) => isOwnName(self, hit[1] ?? ''))
    .map((hit) => [hit.index, hit.index + hit[0].length]);
}

/** Whether this block is somebody else's talk with `@self` in what they said. */
export function mentions(block: Block, self: string | null): boolean {
  if (block.domain !== 'conversation') return false;
  // A receipt carries the recipient and no message; an emote is the server's sentence.
  const said = block.groups['message'];
  if (said === undefined) return false;
  const speaker = block.groups['player'];
  // `You say`, `You yell`: this character's own line has no speaker.
  if (speaker === undefined && /^You\b/.test(block.text.trimStart())) return false;
  if (speaker !== undefined && isOwnName(self, speaker)) return false;
  if (parseRemoteCall(said) !== null) return false;
  return mentionSpans(said, self).length > 0;
}

/**
 * The notice a mention is worth: the server's own line, which names who and on
 * which channel. Only while an enabled row names `mentioned` (`rowAsks`), as
 * `telepathNotice`: a mention without one stays on the Talk card and the tab.
 */
export function mentionNotice(
  block: Block,
  self: string | null,
  rules: readonly AlertRule[]
): Notice | null {
  if (!rowAsks(rules, 'mentioned')) return null;
  // A telepath the telepath row raises (`telepathNotice`) is not raised twice.
  if (telepathNotice(block, rules) !== null) return null;
  if (!mentions(block, self)) return null;
  return {
    id: `mention-${block.seq}`,
    at: block.at,
    severity: 'info',
    channel: 'talk',
    desktop: 'mentioned',
    event: 'mentioned',
    text: block.text.trim()
  };
}
