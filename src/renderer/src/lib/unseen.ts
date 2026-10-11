/**
 * What has happened to a character while nobody was looking at it: the alerts
 * raised and the `@name` mentions said. The tab rail draws it; putting the
 * character on screen clears it. Out of `useSessionViews` with the mentions
 * (todo 29), so the view and the rail share one shape.
 */
import type { Block } from '@shared/blocks';
import { mentions } from '@shared/mentions';
import type { Notice } from '@shared/notifications';

export interface Unseen {
  critical: number;
  warning: number;
  /** The newest alert's line, for the tab's tooltip. */
  latest: string | null;
  /** Lines with `@name` in them, counted apart from the alerts, which are counted by severity. */
  mentions: number;
  /** The newest of those lines, as the server printed it. */
  mention: string | null;
}

export const EMPTY_UNSEEN: Unseen = {
  critical: 0,
  warning: 0,
  latest: null,
  mentions: 0,
  mention: null
};

/** Whether there is nothing to clear, so a view already clear is kept as it is. */
export function nothingUnseen(unseen: Unseen): boolean {
  return unseen.critical === 0 && unseen.warning === 0 && unseen.mentions === 0;
}

/**
 * Folds new notices into the unseen count for a character.
 *
 * A character on screen has seen them by definition, so nothing accumulates for
 * the one being played — the count exists for the other three. `info` is not
 * counted: a tab that lights up for somebody arriving in the realm is a tab
 * nobody reads, and the whole value of the mark is that it is rare.
 */
export function missed(current: Unseen, raised: readonly Notice[], shown: boolean): Unseen {
  if (shown) return nothingUnseen(current) ? current : EMPTY_UNSEEN;
  const worth = raised.filter((notice) => notice.severity !== 'info');
  if (worth.length === 0) return current;
  return {
    ...current,
    critical: current.critical + worth.filter((n) => n.severity === 'critical').length,
    warning: current.warning + worth.filter((n) => n.severity === 'warning').length,
    // The newest, for the tab's title: a number says how much and this says what.
    latest: worth[worth.length - 1]!.text
  };
}

/**
 * Counts a line that mentions the character, off the block itself rather than
 * the notice: an alert row turned off, or resting after a spammed `@name`,
 * silences the notice and not the fact that the tab should carry.
 */
export function mentionMissed(
  current: Unseen,
  block: Block,
  self: string | null,
  shown: boolean
): Unseen {
  if (shown || !mentions(block, self)) return current;
  return { ...current, mentions: current.mentions + 1, mention: block.text.trim() };
}
