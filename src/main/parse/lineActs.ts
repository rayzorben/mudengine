/**
 * One framed line into the tracker: classified, split into what is acted on,
 * and applied, in the order `SessionManager` acts on it. One copy, because
 * `check:reckoning` once fed the line with the batch's rows and never the
 * batch, the tails or `collecting`, and graded a tracker that saw less than
 * the client does (todo 749). `mudengine-verify` › *Grading where the client
 * thought it was*.
 */
import type { Block, BlockType } from '../../shared/blocks';
import type { StreamLine } from '../../shared/types';
import type { CharacterTracker } from './CharacterTracker';
import type { BatchBlock, Classifier } from './Classifier';

/** One framed line, classified, and the listing it sat in. */
export interface LineRead {
  readonly block: Block;
  /** The listing this line closed, rows and all. */
  readonly batch?: BatchBlock;
  /** What the server printed after the prompt on the same line (`tailAfterPrompt`). */
  readonly tails: readonly Block[];
  /** The listing open before this line, and after it. */
  readonly batchWas: BlockType | null;
  readonly batchNow: BlockType | null;
  /**
   * Whether this line is a listing's: the header that opened one, a row, or
   * the line that closed one. `You have no keys.` inside an `i` typed
   * `unknown` read as an effect landing (2026-09-12); the classifier knows,
   * so the tracker is told.
   */
  readonly collecting: boolean;
}

/** One thing acted on: the line with the listing it closed, or one tail. */
export interface LineAct {
  readonly block: Block;
  readonly batch?: BatchBlock;
  readonly collecting: boolean;
}

/** Classifies `line`. A classifier fault throws, for the caller to report. */
export function readLine(
  classifier: Pick<Classifier, 'classify' | 'batchType'>,
  line: StreamLine
): LineRead {
  const batchWas = classifier.batchType;
  const { block, batch, tails } = classifier.classify(line);
  const batchNow = classifier.batchType;
  return {
    block,
    ...(batch ? { batch } : {}),
    tails: tails ?? [],
    batchWas,
    batchNow,
    collecting: batchWas !== null || batchNow !== null
  };
}

/**
 * The line first, then each tail in the order the server wrote them. After
 * the prompt, because the prompt releases the next queued command and a fact
 * arriving before its own acknowledgement would be credited to the command
 * ahead of it.
 */
export function actsOf(read: LineRead): LineAct[] {
  return [
    {
      block: read.block,
      ...(read.batch ? { batch: read.batch } : {}),
      collecting: read.collecting
    },
    ...read.tails.map((tail) => ({ block: tail, collecting: read.collecting }))
  ];
}

/**
 * The line, then the listing it closed. Both, never short-circuited: the
 * line that completes a stat sheet is the status line, which always changes
 * state, and `||` would skip the sheet.
 */
export function applyAct(
  tracker: Pick<CharacterTracker, 'apply'>,
  act: LineAct
): { line: boolean; batch: boolean } {
  const line = tracker.apply(act.block, undefined, act.collecting);
  const batch = act.batch ? tracker.apply(act.batch, act.batch.rows) : false;
  return { line, batch };
}

/**
 * A recorded line replayed as the client took it, with nothing to send: each
 * act applied, then stale claims written off where `Claims.settle` does it,
 * and once on arrival for the in-game tick (`reconsiderMs`) that settles
 * through a silence: at the arrival, where play's tick may lag by up to one
 * interval and credit the line to a claim just gone stale. Only the
 * write-off: the probe asks the realm, which a replay cannot, so this is the
 * client on a realm with no locate word.
 * Claims are stamped by `Date.now()`, so the caller runs the capture's clock.
 * `take` withholds an act, as `check:reckoning` withholds `Location:`.
 */
export function replayLine(
  classifier: Pick<Classifier, 'classify' | 'batchType'>,
  tracker: Pick<CharacterTracker, 'apply' | 'expireStaleClaims' | 'current'>,
  line: StreamLine,
  take: (act: LineAct) => boolean = () => true
): void {
  if (tracker.current.phase === 'in-game') tracker.expireStaleClaims(Date.now());
  for (const act of actsOf(readLine(classifier, line))) {
    if (take(act)) applyAct(tracker, act);
    tracker.expireStaleClaims(Date.now());
  }
}
