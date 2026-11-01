/**
 * Counts in time order as columns, stretched to the box: how many lines were
 * said in each slice of the backlog, how many commands went out each minute.
 * A count is a whole thing, so it is a column rather than a line through the
 * points between. A zero is a stub on the floor, so an empty slice still
 * reads as time that passed. See `mudengine-ui` › `parts/viz.md`.
 */
import { memo } from 'react';

import type { VizTone } from './tones';

const H = 32;

function Columns({
  values,
  tone = 'accent',
  label
}: {
  values: readonly number[];
  tone?: VizTone;
  label?: string;
}) {
  const top = Math.max(1, ...values);
  const width = Math.max(1, values.length);
  return (
    <svg
      aria-label={label}
      className="columns"
      data-tone={tone}
      preserveAspectRatio="none"
      role={label === undefined ? undefined : 'img'}
      viewBox={`0 0 ${width} ${H}`}
    >
      {values.map((value, at) => {
        const tall = value > 0 ? Math.max(2, (value / top) * H) : 0.75;
        return (
          <rect
            data-zero={value === 0 || undefined}
            height={tall}
            key={at}
            width={0.72}
            x={at + 0.14}
            y={H - tall}
          />
        );
      })}
    </svg>
  );
}

export default memo(Columns);
