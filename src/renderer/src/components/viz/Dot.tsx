/**
 * A mark the size of a letter before a name: a standing on the Realm card,
 * whether a player or a gang member is on. Filled for a state that holds,
 * hollow for one that does not, so the shape says it as well as the hue. It
 * always carries its word as `label`, read aloud and on hover. See
 * `mudengine-ui` › `parts/viz.md`.
 */
import { memo } from 'react';

import type { VizTone } from './tones';

function Dot({ tone, hollow = false, label }: { tone: VizTone; hollow?: boolean; label: string }) {
  return (
    <span
      aria-label={label}
      className="viz-dot"
      data-hollow={hollow ? 'true' : undefined}
      data-tone={tone}
      role="img"
      title={label}
    />
  );
}

export default memo(Dot);
