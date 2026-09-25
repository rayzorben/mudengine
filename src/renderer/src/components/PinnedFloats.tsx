/*
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/cards.md`, *A pinned
 * float stays in view whichever character is shown*.
 */
import { memo, useEffect } from 'react';

import FloatLayer from './FloatLayer';
import { useCardLayout } from '../hooks/useCardLayout';
import type { PinnedRenderer } from '../hooks/useCardRenderers';
import type { SessionId } from '@shared/ipc';

/**
 * Another character's pinned floats, drawn over the console beside the shown
 * character's. A component per character rather than a loop of hooks: each
 * layout is that character's own, read by the same hook the rail uses.
 * Memoised, since `render` is bound to this character's view and holds still
 * while only another's moves (`pinnedFor`).
 */
function PinnedFloats({
  sid,
  boxRef,
  render,
  onStreamFloat
}: {
  sid: SessionId;
  boxRef: React.RefObject<HTMLElement>;
  render: PinnedRenderer;
  /** Whether this character's pinned floats include the Stream card. */
  onStreamFloat(sid: SessionId, has: boolean): void;
}) {
  const layout = useCardLayout(sid);
  /*
   * Reported upward because the line feed is per *window*: only this component
   * reads this character's layout, and the window-level interest has to count
   * a pinned stream float or it would quietly freeze with the rail closed.
   */
  const hasStream = layout.floats.some((float) => float.pinned === true && float.id === 'stream');
  useEffect(() => {
    onStreamFloat(sid, hasStream);
    return () => onStreamFloat(sid, false);
  }, [sid, hasStream, onStreamFloat]);
  return (
    <FloatLayer
      boxRef={boxRef}
      layout={layout}
      only={(float) => float.pinned === true}
      render={(id) => render(id, layout)}
    />
  );
}

export default memo(PinnedFloats);
