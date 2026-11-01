/**
 * One figure set large with its name above it and an optional line under it:
 * the handful of numbers a card is read for (the rate, the time to the next
 * level, the bank balance), drawn as tiles in a `.kpis` row that wraps to the
 * card's width. An unknown figure is a dash in the quiet ink, never `0`. See
 * `mudengine-ui` › `parts/viz.md`.
 */
import { memo, type ReactNode } from 'react';

import type { KpiTone } from './tones';

function Kpi({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  /** Null while unknown. */
  value: ReactNode | null;
  hint?: ReactNode;
  /** For a figure that is itself a condition. */
  tone?: KpiTone;
}) {
  return (
    <div className="kpi" data-tone={tone}>
      <em>{label}</em>
      <b className={value === null ? 'inert' : undefined}>{value ?? '—'}</b>
      {hint !== undefined && hint !== null && <small>{hint}</small>}
    </div>
  );
}

export default memo(Kpi);
