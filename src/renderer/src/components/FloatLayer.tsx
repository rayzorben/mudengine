import { useCallback, type ReactNode } from 'react';

import { useEdgeDrag } from '../hooks/useEdgeDrag';
import {
  MIN_FLOAT,
  type CardId,
  type CardLayoutApi,
  type FloatBox,
  type FloatState
} from '../lib/cards';
import { t } from '../lib/i18n';
import { stretched, type ResizeEdge } from '../lib/resizeEdge';
import ResizeHandles from './ResizeHandles';

export interface FloatLayerProps {
  layout: CardLayoutApi;
  /** The workspace the fractions are measured against. */
  boxRef: React.RefObject<HTMLElement>;
  /** Renders one card. Returns null for a card that has nothing to say yet. */
  render(id: CardId): ReactNode;
  /** Which floats to draw; absent means all of them — a pinned-only layer for another character. */
  only?(float: FloatState): boolean;
}

/**
 * The cards a player has lifted off the rail and left over the console.
 *
 * Positioned in **fractions** of the workspace rather than pixels, so the
 * arrangement survives a resize, a move to a monitor with different scaling,
 * and a change of terminal font size. That is the same rule the pane layout
 * follows and for the same reason: nothing in the layout path may hold a pixel
 * constant.
 *
 * The layer itself is inert — `pointer-events: none` — and only the cards in it
 * take the pointer. Otherwise an empty float layer would sit over the console
 * and swallow every click meant for the game, which is the worst possible way
 * to find out this feature exists.
 */
export default function FloatLayer({ layout, boxRef, render, only }: FloatLayerProps) {
  const floats = only ? layout.floats.filter(only) : layout.floats;
  if (floats.length === 0) return null;

  return (
    <div className="float-layer">
      {floats.map((float) => {
        const content = render(float.id);
        if (content === null) return null;
        return (
          <Float boxRef={boxRef} float={float} key={float.id} layout={layout}>
            {content}
          </Float>
        );
      })}
    </div>
  );
}

function Float({
  boxRef,
  float,
  layout,
  children
}: {
  boxRef: React.RefObject<HTMLElement>;
  float: FloatState;
  layout: CardLayoutApi;
  children: ReactNode;
}) {
  /*
   * A rolled card is its heading, and nothing else, wherever it is standing.
   *
   * So the wrapper stops declaring a height and takes the card's own — the
   * float's `h` is *kept*, not thrown away, and comes back the moment it is
   * rolled down again, exactly as a rail card's dragged height does. Sizing it
   * meanwhile would write a figure nothing draws.
   */
  const rolled = layout.isRolled(float.id);

  /*
   * The handles on its corners and sides, the same as a rail card's. Sized
   * from where the pointer is against the box when the handle was taken, so
   * a drag that overshoots and comes back lands under the pointer; a handle
   * on the left or top moves the corner too.
   */
  const { begin } = useEdgeDrag<FloatBox>(({ edge, x, y, from }, event) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const by = { x: (event.clientX - x) / box.width, y: (event.clientY - y) / box.height };
    layout.sizeFloat(float.id, stretched(from, edge, by, MIN_FLOAT));
  });
  const { x, y, w, h } = float;
  const onGrab = useCallback(
    (_card: CardId, edge: ResizeEdge, event: React.PointerEvent<HTMLElement>) =>
      begin(edge, event, { x, y, w, h }),
    [begin, x, y, w, h]
  );

  return (
    <div
      className="float"
      data-card-float={float.id}
      data-pinned={float.pinned ? 'true' : undefined}
      /*
       * Any press brings the card to the front — capture, so it happens before
       * the header starts a drag or a button acts. Two floats that overlap
       * paint in list order, and the one behind was unreachable until the one
       * in front was moved out of the way.
       */
      onPointerDownCapture={() => layout.raise(float.id)}
      data-rolled={rolled ? 'true' : undefined}
      style={{
        left: `${float.x * 100}%`,
        top: `${float.y * 100}%`,
        width: `${float.w * 100}%`,
        ...(rolled ? {} : { height: `${float.h * 100}%` })
      }}
    >
      {children}
      {!rolled && (
        <ResizeHandles card={float.id} onGrab={onGrab} title={t('cards.float.resizeTooltip')} />
      )}
    </div>
  );
}
