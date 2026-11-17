/**
 * Which of the Talk card's lines are drawn. The card holds two days of talk
 * and draws the newest `talkLimit` of it; a scroll up widens that a page at a
 * time, from a line named by its key so a line said meanwhile moves nothing.
 * Pure.
 */
import type { Block } from '@shared/blocks';

/** A line's identity in the card: its React key, and what the reader's place is kept by. */
export function lineKey(block: Pick<Block, 'seq' | 'at'>): string {
  return `${block.seq}-${block.at}`;
}

/** The newest lines, every line held, or from one line on. */
export type TalkDrawn =
  { readonly kind: 'newest' } | { readonly kind: 'all' } | { readonly kind: 'from'; key: string };

export const DRAW_NEWEST: TalkDrawn = { kind: 'newest' };
const DRAW_ALL: TalkDrawn = { kind: 'all' };

/** The index of the first line drawn. A named line that has gone draws the newest. */
export function drawnStart(shown: readonly Block[], drawn: TalkDrawn, newest: number): number {
  if (drawn.kind === 'all') return 0;
  const fallback = Math.max(0, shown.length - newest);
  if (drawn.kind === 'newest') return fallback;
  const at = shown.findIndex((block) => lineKey(block) === drawn.key);
  return at < 0 ? fallback : at;
}

/** The window one page wider than the one starting at `start`. */
export function widened(shown: readonly Block[], start: number, page: number): TalkDrawn {
  const from = start - Math.max(1, page);
  return from <= 0 ? DRAW_ALL : { kind: 'from', key: lineKey(shown[from]!) };
}
