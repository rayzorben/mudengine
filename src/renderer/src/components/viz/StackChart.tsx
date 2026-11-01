/**
 * Several wholes side by side, each cut into the same parts and stacked from
 * the bottom: how the room's fight stands at each round it was read at, the
 * first part (won) at the foot. A column's figure line goes under its label;
 * the legend is the split bar's, once for the chart. Tones are the split
 * bar's (`.split [data-tone]`). See `mudengine-ui` › `parts/viz.md`.
 */
import { memo } from 'react';

import type { SplitPart } from './SplitBar';

export interface StackColumn {
  key: string;
  /** Under the column, short: `3`. */
  label: string;
  /** A second line under the label, or absent. */
  note?: string;
  /** The column said in words, for the pointer and the screen reader. */
  title: string;
  parts: readonly SplitPart[];
}

function StackChart({
  columns,
  label,
  legend = true
}: {
  columns: readonly StackColumn[];
  label?: string;
  legend?: boolean;
}) {
  const first = columns[0];
  return (
    <div
      aria-label={label}
      className="split stack-chart"
      role={label === undefined ? undefined : 'group'}
    >
      <div className="stack-columns">
        {columns.map((column) => {
          const total = column.parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
          return (
            <div className="stack-column" key={column.key} title={column.title}>
              <div className="stack-bar" data-empty={total === 0}>
                {total > 0 &&
                  column.parts.map((part) =>
                    part.value > 0 ? (
                      <span data-tone={part.tone} key={part.key} style={{ flexGrow: part.value }} />
                    ) : null
                  )}
              </div>
              <span className="stack-label">{column.label}</span>
              {column.note !== undefined && <span className="stack-note">{column.note}</span>}
            </div>
          );
        })}
      </div>
      {legend && first !== undefined && (
        <ul className="split-legend">
          {first.parts.map((part) => (
            <li data-tone={part.tone} key={part.key}>
              <i aria-hidden="true" />
              <span className="split-name">{part.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default memo(StackChart);
