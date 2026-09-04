import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { CardId, CardLayoutApi, FloatState } from '../hooks/useCardLayout';
import { t } from '../lib/i18n';

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
  const [resizing, setResizing] = useState(false);

  /*
   * What the move handler reads, carried outside the resize effect's
   * dependencies. Every `sizeFloat` produces a new layout api, so an effect
   * depending on `layout` would tear its window listeners down and reattach
   * them on every pointermove of the very gesture they serve; the ref keeps the
   * values live while the effect runs once per gesture.
   */
  const live = useRef({ layout, x: float.x, y: float.y });
  useEffect(() => {
    live.current = { layout, x: float.x, y: float.y };
  });

  /*
   * The corner grip.
   *
   * Sized from where the pointer *is* rather than from an accumulated delta, so
   * a resize that overshoots and comes back lands under the pointer instead of
   * drifting away from it.
   */
  const onGrip = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Refuses the caret as well as the browser's own drag, exactly as the card
    // header does.
    event.preventDefault();
    event.stopPropagation();
    setResizing(true);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent): void => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      const { x, y } = live.current;
      live.current.layout.sizeFloat(float.id, {
        w: (event.clientX - box.left) / box.width - x,
        h: (event.clientY - box.top) / box.height - y
      });
    };
    const stop = (): void => setResizing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [resizing, boxRef, float.id]);

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
      style={{
        left: `${float.x * 100}%`,
        top: `${float.y * 100}%`,
        width: `${float.w * 100}%`,
        height: `${float.h * 100}%`
      }}
    >
      {children}
      <span
        aria-hidden="true"
        className="float-grip"
        onPointerDown={onGrip}
        title={t('cards.float.resizeTooltip')}
      />
    </div>
  );
}
