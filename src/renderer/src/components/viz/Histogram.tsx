/**
 * Counts in bins as columns, stacked by series where there is more than one:
 * alerts over the record's span by level, players by level band. Stretched to
 * its box over a baseline; every bin keeps its slot, so an empty one reads as
 * a gap rather than closing up. Colours are the series' `tone`, read by the
 * stylesheet (`.histogram [data-tone]`). See `mudengine-ui` › `parts/viz.md`.
 */
import { memo } from 'react';

import type { VizTone } from './tones';

export interface HistogramSeries {
  key: string;
  /** A token the stylesheet maps to a colour, as `SplitBar`'s parts. */
  tone: VizTone;
  /** One count per bin; every series has the same number of bins. */
  values: readonly number[];
}

const W = 100;
const H = 32;
/** The share of a bin's slot left between columns. */
const GAP = 0.2;

function Histogram({ series, label }: { series: readonly HistogramSeries[]; label?: string }) {
  const bins = Math.max(0, ...series.map((entry) => entry.values.length));
  const totals = Array.from({ length: bins }, (_, bin) =>
    series.reduce((sum, entry) => sum + Math.max(0, entry.values[bin] ?? 0), 0)
  );
  const top = Math.max(1, ...totals);
  const slot = bins === 0 ? W : W / bins;
  const width = slot * (1 - GAP);
  return (
    <svg
      aria-label={label}
      className="histogram"
      preserveAspectRatio="none"
      role={label === undefined ? undefined : 'img'}
      viewBox={`0 0 ${W} ${H}`}
    >
      {Array.from({ length: bins }, (_, bin) => {
        let base = H;
        return (
          <g key={bin}>
            {series.map((entry) => {
              const value = Math.max(0, entry.values[bin] ?? 0);
              if (value === 0) return null;
              const height = (value / top) * H;
              base -= height;
              return (
                <rect
                  data-tone={entry.tone}
                  height={height}
                  key={entry.key}
                  width={width}
                  x={bin * slot}
                  y={base}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export default memo(Histogram);
