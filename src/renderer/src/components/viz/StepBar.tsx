/**
 * A chain of steps as one short segment each, in the progression grammar
 * (`data-progress="done|now|left"`): done filled in its tone, the next one
 * outlined in it, what is left as the track. Past `most` steps the segments
 * would be slivers, so it draws one bar filled to the share instead. Its tone
 * is `--viz` from the element it sits in. See `mudengine-ui` › `parts/viz.md`.
 */
import { memo, type CSSProperties } from 'react';

/**
 * Past this many steps one bar is drawn: sixteen on a quest tile's 200px track
 * are 10px each beside 3px gaps, and more read as a dotted line.
 */
const MOST = 16;

function StepBar({
  done,
  total,
  next = true,
  label
}: {
  done: number;
  total: number;
  /** Whether the step after the done ones is the one being worked on. */
  next?: boolean;
  label?: string;
}) {
  if (total <= 0) return null;
  if (total > MOST) {
    return (
      <span
        aria-label={label}
        className="step-bar"
        data-whole="true"
        role={label === undefined ? undefined : 'img'}
        style={{ '--share': Math.min(1, done / total) } as CSSProperties}
      />
    );
  }
  return (
    <span aria-label={label} className="step-bar" role={label === undefined ? undefined : 'img'}>
      {Array.from({ length: total }, (_, at) => (
        <i data-progress={at < done ? 'done' : at === done && next ? 'now' : 'left'} key={at} />
      ))}
    </span>
  );
}

export default memo(StepBar);
