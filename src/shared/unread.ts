/**
 * Lines the parser did not read, counted per realm for the debug window
 * (todo 73). An `unknown` line is one nothing explains; a `realm-message` line
 * fits a row of the server's message table (`messages.csv`) but no frame reads
 * it, so it is a server message the parser should learn. Both are grouped by
 * shape, the way `npm run capture:analyse` groups them.
 */
import type { Block } from './blocks';

/** Which of the two a tallied line is. */
export type UnreadKind = 'unknown' | 'realm-message';

/** One shape of unread line on one realm. */
export interface UnreadLine {
  kind: UnreadKind;
  /** The line with its figures as `#` and its spacing collapsed. */
  shape: string;
  /** The latest line of this shape, whole. */
  sample: string;
  count: number;
  /** The `messages.csv` row the line fits; null for an `unknown` line. */
  message: number | null;
  /** The room the latest one arrived in, as the character knew it; each part null when unknown. */
  room: { name: string | null; map: number | null; number: number | null };
  firstAt: number;
  lastAt: number;
}

/** The port a session writes to: one realm's tally. */
export interface RealmUnread {
  observe(block: Block, room: UnreadLine['room'], at: number): void;
  /** Commonest first. */
  list(): UnreadLine[];
}

/** How long a shape may be before it is cut, so a wrapped paragraph is one key. */
const SHAPE_LENGTH = 90;

/** Collapses a line to its shape, so variants group together. */
export function shapeOf(text: string): string {
  return text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, SHAPE_LENGTH);
}

/** The kind of unread line a block is, or null for a line the parser read. */
export function unreadKind(block: Block): UnreadKind | null {
  if (block.type === 'unknown') return 'unknown';
  if (block.type === 'realm-message') return 'realm-message';
  return null;
}
