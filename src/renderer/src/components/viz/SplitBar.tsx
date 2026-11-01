/**
 * One whole cut into its parts, side by side: where the damage came from,
 * where the time went, the realm's standings. Each part is its own tone and
 * the legend names it with its share; a part of zero takes no width and stays
 * in the legend. See `mudengine-ui` › `parts/viz.md`.
 */
import { memo } from 'react';

import type { VizTone } from './tones';

export interface SplitPart {
  key: string;
  label: string;
  value: number;
  tone: VizTone;
}

function SplitBar({
  parts,
  legend = true,
  label,
  format = (value: number) => String(value)
}: {
  parts: readonly SplitPart[];
  legend?: boolean;
  label?: string;
  format?(value: number, share: number): string;
}) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  return (
    <div aria-label={label} className="split" role={label === undefined ? undefined : 'group'}>
      <div className="split-bar" data-empty={total === 0}>
        {total > 0 &&
          parts.map((part) =>
            part.value > 0 ? (
              <span
                data-tone={part.tone}
                key={part.key}
                style={{ flexGrow: part.value }}
                title={`${part.label} ${format(part.value, part.value / total)}`}
              />
            ) : null
          )}
      </div>
      {legend && (
        <ul className="split-legend">
          {parts.map((part) => (
            <li data-tone={part.tone} key={part.key}>
              <i aria-hidden="true" />
              <span className="split-name">{part.label}</span>
              <span className="split-value">{format(part.value, total > 0 ? part.value / total : 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default memo(SplitBar);
