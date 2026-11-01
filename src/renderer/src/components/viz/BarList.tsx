/**
 * A short ranked list, each row a name, a bar drawn against the largest row
 * and the figure: which channels have been talking, what the queue has been
 * sending. A row of zero keeps its name and draws no bar. Each row's colour is
 * its `tone`, read by the stylesheet (`.bar-list [data-tone]`). See
 * `mudengine-ui` › `parts/viz.md`.
 */
import { memo, type ReactNode } from 'react';

import type { VizTone } from './tones';

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** A token the stylesheet maps to a colour; absent is the accent. */
  tone?: VizTone;
}

function BarList({ rows, label }: { rows: readonly BarRow[]; label?: string }) {
  const top = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul aria-label={label} className="bar-list">
      {rows.map((row) => (
        <li data-tone={row.tone} key={row.key}>
          <span className="bar-list-name">{row.label}</span>
          <i aria-hidden="true" style={{ ['--share' as string]: row.value / top }} />
          <b>{row.value.toLocaleString()}</b>
        </li>
      ))}
    </ul>
  );
}

export default memo(BarList);
