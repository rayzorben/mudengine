/**
 * How fresh a sighting is, as four pips that go out one by one with age: lit
 * under a minute, three under a quarter hour, two under two hours, one under a
 * day, none after. Drawn beside the age in words, never instead of it. A
 * sighting that never happened is a dashed run of pips. See `mudengine-ui` ›
 * `parts/viz.md`.
 */
import { memo } from 'react';

import type { VizTone } from './tones';

/** Seconds below which each pip stays lit, freshest first. */
const STEPS = [60, 15 * 60, 2 * 3600, 24 * 3600] as const;

/** How many of the pips a sighting `seconds` old lights. */
function pipsLit(seconds: number): number {
  return STEPS.filter((limit) => seconds < limit).length;
}

function Recency({ at, now, tone = 'accent' }: { at: number | null; now: number; tone?: VizTone }) {
  const lit = at === null ? 0 : pipsLit(Math.max(0, (now - at) / 1000));
  return (
    <span
      aria-hidden="true"
      className="recency"
      data-tone={tone}
      data-unknown={at === null ? 'true' : undefined}
    >
      {STEPS.map((limit, index) => (
        <i data-lit={index < lit ? 'true' : undefined} key={limit} />
      ))}
    </span>
  );
}

export default memo(Recency);
