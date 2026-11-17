/**
 * How much of a character's conversation log is held in memory, and the shape
 * a stretch of it travels in. Main's `TalkLog` and the window's view apply the
 * one rule, so an attach hands over what the card will keep.
 */
import type { Block } from './blocks';
import { HOUR_MS } from './values';

/**
 * A stretch of the log, oldest first. `start` is how many lines the log holds
 * before the first of `blocks`: the next page back is asked for by it, and 0
 * is the log's first line.
 */
export interface TalkPage {
  blocks: Block[];
  start: number;
}

/** A log with nothing kept, or nothing older to hand over. */
export const NO_TALK_PAGE: Readonly<TalkPage> = { blocks: [], start: 0 };

/** The three figures the rule reads: `tuning.view`'s, as `talkKeepOf` names them. */
export interface TalkKeep {
  /** Lines kept however old they are. */
  least: number;
  /** Lines kept however recent they are, unless `least` is higher. */
  most: number;
  /** Past `least`, a line is kept while it is this recent. */
  hours: number;
}

/** The rule's figures out of the view tuning both sides read. */
export function talkKeepOf(view: {
  talkLimit: number;
  talkKeepMost: number;
  talkKeepHours: number;
}): TalkKeep {
  return { least: view.talkLimit, most: view.talkKeepMost, hours: view.talkKeepHours };
}

/**
 * How many of the oldest lines go. `blocks` is oldest first, so the lines that
 * have aged out are a run at the front and the scan stops at the first that
 * has not.
 */
export function talkExcess(
  blocks: readonly Pick<Block, 'at'>[],
  now: number,
  keep: TalkKeep
): number {
  const spare = blocks.length - keep.least;
  if (spare <= 0) return 0;
  const cutoff = now - keep.hours * HOUR_MS;
  let aged = 0;
  while (aged < spare && blocks[aged]!.at < cutoff) aged += 1;
  return Math.max(aged, blocks.length - Math.max(keep.most, keep.least));
}
