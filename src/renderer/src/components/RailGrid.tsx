/**
 * The card rail's grid (todo 09): each card in the cells `railGrid` arranges
 * it in, in reading order, and the dashed landing box where a dragged card
 * would go. The cards a group has hidden take no cells, so the rest are
 * arranged around what is drawn. See `mudengine-ui` › `parts/cards.md`,
 * *The card rail is a grid*.
 */
import { memo, useLayoutEffect, useMemo, type CSSProperties, type ReactNode } from 'react';

import type { DragState } from '../hooks/useCardDrag';
import { useCardResize } from '../hooks/useCardResize';
import type { RailGrid as Grid } from '../hooks/useRailGrid';
import type { CardId, CardLayoutApi } from '../lib/cards';
import { NARROWEST_RAIL, onRail } from '../lib/railCards';
import { t } from '../lib/i18n';
import { arrange, bottomOf, sameBox, type GridBox } from '../lib/railGrid';
import ResizeHandles from './ResizeHandles';

export interface RailGridProps {
  layout: Pick<CardLayoutApi, 'rail' | 'spots' | 'sizes' | 'columns' | 'isRolled' | 'placeOnRail'>;
  render(id: CardId): ReactNode;
  grid: Pick<Grid, 'ref' | 'columns' | 'showing' | 'publish' | 'view'>;
  /**
   * The drag in flight, if any: the grid draws where the card in hand would
   * land, and offers a screen of empty rows below its cards.
   */
  drag: DragState | null;
}

/** Where a box goes in the CSS grid, which counts lines from one. */
function area(box: GridBox): CSSProperties {
  return {
    gridColumn: `${box.x + 1} / span ${box.w}`,
    gridRow: `${box.y + 1} / span ${box.h}`
  };
}

function RailGrid({ layout, render, grid, drag }: RailGridProps) {
  const { rail, spots, sizes, columns: keptOn, isRolled } = layout;
  // The handles on every corner and side of a card, in whole cells.
  const resize = useCardResize(layout, grid.view);
  // Before the grid is measured it is the rail's narrowest track.
  const columns = grid.columns ?? NARROWEST_RAIL;

  const drawn = useMemo(() => {
    const cards = rail.flatMap((id) => {
      const element = render(id);
      return element === null ? [] : [{ id, element }];
    });
    const { width, cards: onGrid } = onRail(
      cards.map(({ id }) => id),
      { spots, sizes, columns: keptOn },
      columns
    );
    const boxes = arrange(onGrid, columns);
    const byPlace = (a: CardId, b: CardId): number => {
      const one = boxes.get(a)!;
      const two = boxes.get(b)!;
      return one.y - two.y || one.x - two.x;
    };
    return {
      boxes,
      width,
      // Reading order, so Tab and a screen reader go along the rows as drawn.
      cards: cards.sort((a, b) => byPlace(a.id, b.id))
    };
  }, [rail, spots, sizes, keptOn, render, columns]);

  const { publish } = grid;
  useLayoutEffect(() => publish(drawn.boxes, drawn.width), [publish, drawn.boxes, drawn.width]);

  const dragging = drag?.live === true;
  const landing =
    dragging && drag.target.where === 'grid' ? { id: drag.id, box: drag.target.box } : null;
  const own = landing ? drawn.boxes.get(landing.id) : undefined;
  // A drop into the card's own cells changes nothing: the dimmed card is the
  // landing box, and a second one beside it would read as two places.
  const slot = landing && !(own && sameBox(own, landing.box)) ? landing.box : null;
  const bottom = Math.max(bottomOf(drawn.boxes.values()), slot ? slot.y + slot.h : 0);
  const rows = dragging ? bottom + grid.showing : bottom;

  return (
    <div
      className="rail-grid"
      ref={grid.ref}
      style={{ '--rail-columns': columns, '--rail-rows': rows } as CSSProperties}
    >
      {drawn.cards.map(({ id, element }) => (
        <div className="rail-cell" data-rail-card={id} key={id} style={area(drawn.boxes.get(id)!)}>
          {element}
          {/*
            Not on a rolled card: its height is its heading, so a handle
            there would write a size nothing draws. Its cells are kept and
            come back with it.
          */}
          {!isRolled(id) && (
            <ResizeHandles
              card={id}
              onGrab={resize.begin}
              onReset={resize.reset}
              title={t('cards.header.resizeHint')}
            />
          )}
        </div>
      ))}
      {slot && <div className="rail-slot" style={area(slot)} />}
    </div>
  );
}

export default memo(RailGrid);
