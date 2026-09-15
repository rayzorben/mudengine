/**
 * A window on the realm: the neighbourhood around a room, fetched for what
 * the window can see, zoomed by the wheel and dragged by the hand, with the
 * legend under it.
 *
 * The Map card and the loop builder each carried their own copy of this —
 * measure the box, turn the size into a radius, fetch, drop a late answer —
 * and each zoomed differently, which is two maps that had begun to disagree
 * about what a wheel does. This is the one place the map is *looked at*;
 * what is drawn on it stays `MapPlan`'s, and what a click on a room means
 * stays the card's.
 *
 * **Every surface that draws a map draws this one** (2026-09-14): the card,
 * the loop builder, and the route panel's picture of where a route ends,
 * which until then drew `MapPlan` on its own, fitted, with no wheel, no pan,
 * no legend and — the report that started it — no quick view under the
 * pointer. A surface hands in what is *its* (where the eye starts, what marks
 * are on the rooms, what a click means) and nothing about how a map behaves.
 *
 * The legend belongs here for the same reason: it is the key to what this
 * component draws, so a map drawn without one was a picture with a private
 * vocabulary. Which keys it lists follows the marks — a builder's rings are
 * keyed on a builder's map and nowhere else, because a key to a mark the
 * picture never makes is a key to nothing.
 *
 * Five decisions:
 *
 * - **Zoom is pixels per room, and a wheel keeps the room under the pointer
 *   under the pointer** (`zoomedAt`). The picture used to be fitted — zooming
 *   out meant fetching a wider neighbourhood and scaling it down — and a
 *   fitted picture cannot zoom about a point, because there is nothing to
 *   pan. The zoom is the card's to hold (the Map card keeps it as its density
 *   setting; the builder opens at the densest end), so it arrives as a prop.
 * - **It stops zooming out where the fetch stops** (`zoomFloor`). Main will
 *   walk `mapRadiusMax` rooms each way and no further, and a window wider
 *   than that at the zoom asked for would show blank space around the rooms
 *   it has. So the smallest a room is drawn is whichever is larger: the
 *   slider's dense end, or the size at which the widest fetch spans the box.
 *   On a rail card they are the same number; in a large float *densest* is
 *   as dense as can be filled.
 * - **A drag on nothing pans.** A room and a way out keep their clicks; the
 *   background between them takes the hand. Told apart at the press by what
 *   was pressed, not by movement afterwards: a drag that began on a room and
 *   suppressed its click on the way would be a room that sometimes does not
 *   pick, and `dragSlop` is what separates a click on nothing from a pan.
 * - **The window decides the fetch, and the pan is kept on the drawing.** The
 *   radius asked for is whatever the window reaches from the centre room
 *   (`radiusForView`), so panning towards an edge fetches past it; the pan
 *   itself stops at the edge of what was fetched (`within`) — applied to the
 *   view that is *drawn*, not only at the gesture, because a fetch can shrink
 *   the drawing under a standing pan: the radius is a path length and the
 *   reach a straight line, so a room a winding corridor put in the last
 *   fetch can be beyond the next one. Rooms keep their places across a wider
 *   fetch — breadth-first placement is a prefix of itself — so a fetch never
 *   moves what is on screen.
 * - **A new centre is a new view.** Every pick, every step the character
 *   takes and every room found recentre the picture and drop the pan, because
 *   the centre changing is the card saying *look here*. The zoom stays.
 *
 * The wheel is claimed with a native, non-passive listener, because React's
 * own is passive and `preventDefault` there is a warning rather than a
 * refusal — and a wheel over the rail's map that also scrolled the rail would
 * zoom the picture out from under the card. Over a picture with nothing on it
 * the wheel is not claimed at all: a dead patch of rail is worse than a map
 * that scrolls with it.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';

import MapPlan, { MapLegend, type MapPlanProps } from './MapPlan';
import { keepFocus } from '../lib/focus';
import {
  dragged,
  extentOf,
  NO_PAN,
  radiusForView,
  wheelFactor,
  within,
  zoomedAt,
  zoomFloor,
  type Box,
  type MapView as View
} from '../lib/mapView';
import { tuning } from '../lib/tuning';
import { EMPTY_MAP, type LocalMap } from '@shared/map';
import { errorMessage } from '@shared/values';
import { asRoomReference, type RoomId } from '@shared/world';

export interface MapViewProps extends Omit<MapPlanProps, 'map' | 'viewport'> {
  /** The room the neighbourhood is fetched around. Null draws `empty`. */
  centre: RoomId | null;
  load(map: number, room: number, radius: number): Promise<LocalMap>;
  /** Pixels one room gets. Held by the card — see the header. */
  zoom: number;
  /**
   * The wheel asked for a new zoom, already kept within the bounds; the pan
   * that keeps the pointer's room still is applied in the same event.
   */
  onZoom(perRoom: number): void;
  /** Each neighbourhood as it arrives, for the card's badge. */
  onLoaded?(map: LocalMap): void;
  /** What to show with nothing to draw — no centre, or no realm data for it. */
  empty: ReactNode;
  /** Which map this is, for the console line a failed fetch writes. */
  name: string;
}

const NO_BOX: Box = { width: 0, height: 0 };

function MapView({ centre, load, zoom, onZoom, onLoaded, empty, name, ...picture }: MapViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Box>(NO_BOX);
  const [map, setMap] = useState<LocalMap>(EMPTY_MAP);
  /*
   * The pan, keyed on the centre it was made from: a new centre reads as no
   * pan without an effect having to notice and reset it a frame late, which
   * would draw one frame of the new neighbourhood through the old eye.
   */
  const [panned, setPanned] = useState<{ centre: RoomId | null; pan: View['pan'] }>({
    centre,
    pan: NO_PAN
  });
  const pan = panned.centre === centre ? panned.pan : NO_PAN;
  const setPan = useCallback((next: View['pan']) => setPanned({ centre, pan: next }), [centre]);
  const extent = useMemo(() => extentOf(map.cells), [map]);
  const { mapRadiusMin, mapRadiusMax, mapRoomPixelsDense, mapRoomPixelsSparse } = tuning();
  const bounds = useMemo(
    () => ({ min: zoomFloor(size, mapRoomPixelsDense, mapRadiusMax), max: mapRoomPixelsSparse }),
    [size, mapRoomPixelsDense, mapRadiusMax, mapRoomPixelsSparse]
  );
  /* What is drawn: the zoom inside its bounds, the pan inside the drawing. */
  const view = useMemo<View>(
    () => within({ perRoom: Math.min(bounds.max, Math.max(bounds.min, zoom)), pan }, extent),
    [bounds, zoom, pan, extent]
  );
  const viewport = useMemo(() => ({ view, box: size }), [view, size]);
  const [panning, setPanning] = useState(false);

  /*
   * Measured from the laid-out element and re-measured whenever that changes.
   * A railed map has a declared height and settles once; a float is dragged,
   * and every drag is a new answer. `ResizeObserver` rather than a window
   * resize listener: a float is resized without the window changing at all,
   * and a splitter drag changes the rail's width with the window fixed.
   */
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const radius = radiusForView(view, size, mapRadiusMin, mapRadiusMax);

  /* The latest of what the fetch reports to, read from inside its promise. */
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;

  useEffect(() => {
    if (centre === null) {
      setMap(EMPTY_MAP);
      loaded.current?.(EMPTY_MAP);
      return;
    }
    const reference = asRoomReference(centre);
    if (reference === null) {
      // A centre that cannot be read is refused out loud, and the previous
      // neighbourhood is not left drawn under it: an empty picture refuses
      // where a stale one lies.
      console.error(`[${name}] map centre ${centre} is not a room reference`);
      setMap(EMPTY_MAP);
      loaded.current?.(EMPTY_MAP);
      return;
    }
    let live = true;
    void load(reference.map, reference.room, radius)
      .then((next) => {
        // The centre can change while this is in flight; a late answer must
        // not paint a map of somewhere the eye has already left.
        if (!live) return;
        setMap(next);
        loaded.current?.(next);
      })
      .catch((error) => {
        // A failed fetch must not leave the previous neighbourhood on screen
        // with the marks in the wrong places. The cause has no room on the
        // card, so it goes to the console rather than nowhere.
        console.error(`[${name}] map around ${centre}: ${errorMessage(error)}`);
        if (!live) return;
        setMap(EMPTY_MAP);
        loaded.current?.(EMPTY_MAP);
      });
    return () => {
      live = false;
    };
  }, [centre, load, name, radius]);

  /*
   * The wheel, read off refs: the listener is registered once, and what it
   * needs — the view, its bounds, the drawing's extent, where to report —
   * moves under it.
   */
  const drawn = map.cells.length > 0;
  const latest = useRef({ view, bounds, extent, drawn, onZoom, setPan });
  latest.current = { view, bounds, extent, drawn, onZoom, setPan };
  useEffect(() => {
    const node = box.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      const current = latest.current;
      if (!current.drawn) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const next = zoomedAt(
        current.view,
        { width: rect.width, height: rect.height },
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        wheelFactor(event.deltaY, tuning().mapZoomStepPercent),
        current.bounds
      );
      if (next === current.view) return;
      const kept = within(next, current.extent);
      // Both in one event, so React commits them together: the pan alone at
      // the old zoom would draw one frame with the pointer's room elsewhere.
      current.setPan(kept.pan);
      current.onZoom(kept.perRoom);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  /*
   * The drag. Begun on the background only — a room or a way out is a
   * control with a click of its own — and stated from where it began, so a
   * long drag cannot drift. Captured, so a hand that leaves the box mid-drag
   * keeps dragging, and released on the way out whatever happens.
   */
  const drag = useRef<{ pointer: number; x: number; y: number; from: View; live: boolean } | null>(
    null
  );
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !drawn) return;
    const target = event.target as Element;
    if (target.closest('.map-room, .map-away') !== null) return;
    // The caret stays in the console. Cancelling the press stops the
    // selection a drag would otherwise sweep; `keepFocus` on the mouse event
    // below stops the focus move, whichever of the two the browser hangs it
    // on.
    event.preventDefault();
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: view,
      live: false
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer already gone — released between the press and this line,
      // or an event with no live pointer behind it — cannot be captured, and
      // the drag then simply ends where the box does.
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const at = drag.current;
    if (at === null || event.pointerId !== at.pointer) return;
    const dx = event.clientX - at.x;
    const dy = event.clientY - at.y;
    // A press that has not travelled is a click on nothing, not a pan.
    if (!at.live) {
      const slop = tuning().dragSlop;
      if (Math.abs(dx) <= slop && Math.abs(dy) <= slop) return;
      at.live = true;
      setPanning(true);
    }
    setPan(within(dragged(at.from, dx, dy), extent).pan);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const at = drag.current;
    if (at === null || event.pointerId !== at.pointer) return;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    /*
     * The box the legend is measured *out* of: the view inside takes what the
     * legend leaves, which is what makes a map dragged bigger show more rooms
     * rather than the same rooms drawn larger. The surface around it places
     * this element; it never sizes it.
     */
    <div className="map-box">
      <div
        className="map-view"
        data-panning={panning ? 'true' : undefined}
        onMouseDown={keepFocus}
        onPointerCancel={onPointerEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        ref={box}
      >
        {drawn ? <MapPlan {...picture} map={map} viewport={viewport} /> : empty}
      </div>
      {/* The builder's own keys where the builder's own marks are, which is
          the one thing the legend asks of the surface — and it asks the
          picture's props rather than the surface, so the two cannot disagree. */}
      <MapLegend builder={picture.marks !== undefined} />
    </div>
  );
}

export default memo(MapView);
