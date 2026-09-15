import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import MapView from './MapView';
import { t } from '../lib/i18n';
import { densityFor } from '../lib/mapView';
import { tuning } from '../lib/tuning';
import { DEFAULT_MAP_DENSITY, EMPTY_MAP, roomPixelsFor, type LocalMap } from '@shared/map';
import type { CharacterState } from '@shared/character';
import type { LoopProgress } from '@shared/loops';
import type { WalkProgress } from '@shared/walk';
import { roomId, type RoomId } from '@shared/world';
import { roomsWithFinds, type Find } from '@shared/finds';

export interface MapCardProps extends CardChrome {
  character: CharacterState;
  /**
   * The neighbourhood around a room, out to `radius` rooms.
   *
   * The radius is the view's, measured from its own laid-out box and the zoom
   * it is at — see `radiusForView`. It used to be main's default of five
   * whatever the card was drawn in, so a floating map dragged bigger drew the
   * same rooms larger.
   */
  load(map: number, room: number, radius: number): Promise<LocalMap>;
  /**
   * Where this character is headed, so the map can draw it.
   *
   * Both, because they answer the question in two different shapes: a route
   * is a list of steps and draws as a line along them, and a loop is a list
   * of *places* and draws as marks on the ones the lap still owes. A loop's
   * leg arrives as the walk, so the two are drawn together rather than one
   * replacing the other — the line is this leg and the marks are the rest of
   * the lap.
   *
   * This character's own, like every other prop here: a pinned float draws
   * the route of the character it belongs to, not the one on screen.
   */
  walk: WalkProgress;
  loop: LoopProgress;
  /**
   * The rooms this realm's find log names, marked with a dot.
   *
   * The realm's, not this character's, so a room a second character searched
   * is marked here too — which is the whole reason the log is kept per realm.
   * See `src/shared/finds.ts`.
   */
  finds: readonly Find[];
  /**
   * Open the loop builder. Null on a pinned float, where the builder is the
   * shown character's and a control that opened it for somebody else would
   * plan on the wrong realm — so the action is not drawn at all.
   */
  onBuild: (() => void) | null;
  /**
   * A pointer came to rest on a room, or left it. Passed straight through to
   * the picture, which owns the dwell; what opens and how long it lingers is
   * the window's. Null on a pinned float, for `onBuild`'s reason.
   */
  onPeek: ((room: RoomId, at: SVGGElement, settled: boolean) => void) | null;
  onPeekEnd: (() => void) | null;
}

/**
 * The streets around the character, drawn from the realm data.
 *
 * The data has no coordinates — only which exit leads where — so the layout is
 * derived by walking directions outward from where the character is standing.
 * It is therefore a *projection*, not a floor plan, and the card says how many
 * rooms it could not place rather than drawing a confident picture that is
 * wrong: a MUD is not Euclidean, and two exits can lead to the same place.
 *
 * Looked at through `MapView`, which every map in the client shares: the wheel
 * zooms about the pointer, a drag on the background pans, a pointer at rest
 * on a room opens what the realm knows about it, the neighbourhood fetched is
 * whatever the window can see, and the legend under it keys what is drawn.
 * What is this card's is the centre — always where the character is, so every
 * step recentres the picture — and the zoom, which it keeps as its density
 * setting.
 */
function MapCard({
  character,
  finds,
  load,
  loop,
  onBuild,
  onPeek,
  onPeekEnd,
  walk,
  ...chrome
}: MapCardProps) {
  const [map, setMap] = useState<LocalMap>(EMPTY_MAP);
  /*
   * The rooms alone, memoised on the log: the picture asks per drawn room, and
   * a fresh array every render would reconcile two hundred rooms for a value
   * that did not change.
   */
  const foundRooms = useMemo(() => [...roomsWithFinds(finds)], [finds]);
  const { map: area, number } = character.room;
  const here = area === null || number === null ? null : roomId(area, number);
  const { mapRoomPixelsSparse: sparse, mapRoomPixelsDense: dense } = tuning();
  /*
   * How much of the realm to fit on the card, from the gear in its own action
   * column. Read off `chrome.settings` — already this card's settings for
   * *this* character, addressed the way a pinned float's are — rather than
   * taken as a prop, which would be a second route to the same value.
   *
   * It chooses how small a room may be drawn, not the room count: the count
   * is still measured from the laid-out box, so a map dragged twice as big
   * shows more of the realm at every setting.
   */
  const density = chrome.settings?.value.mapDensity ?? DEFAULT_MAP_DENSITY;

  /*
   * The zoom, and the setting are one number read two ways. The wheel moves
   * the zoom at once and writes it into the setting once the hand has
   * stopped (`mapZoomSettleMs`) — a wheel reports a dozen events a second and
   * every write re-lays the workspace out — and the slider moves the setting,
   * which the zoom then follows. A setting that already says what the zoom
   * is, because the zoom just wrote it, moves nothing.
   */
  const [zoom, setZoom] = useState(() => roomPixelsFor(density, sparse, dense));
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const settle = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const write = chrome.settings?.onChange;
  const writeRef = useRef(write);
  writeRef.current = write;

  const flush = useCallback((): void => {
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    const perRoom = pending.current;
    pending.current = null;
    if (perRoom === null || writeRef.current === undefined) return;
    const at = densityFor(perRoom, sparse, dense);
    // Cleared back to nothing where it agrees with the shipped answer, as the
    // slider does: what is stored is what somebody chose.
    writeRef.current({ mapDensity: at === DEFAULT_MAP_DENSITY ? undefined : at });
  }, [sparse, dense]);
  // A zoom still waiting to be written when the card goes is written then.
  useEffect(() => flush, [flush]);

  const onZoom = useCallback(
    (perRoom: number): void => {
      setZoom(perRoom);
      pending.current = perRoom;
      if (settle.current !== null) window.clearTimeout(settle.current);
      settle.current = window.setTimeout(flush, tuning().mapZoomSettleMs);
    },
    [flush]
  );

  useEffect(() => {
    if (densityFor(zoomRef.current, sparse, dense) === density) return;
    // The slider moved: it outranks a wheel still waiting to be written down.
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = null;
    pending.current = null;
    setZoom(roomPixelsFor(density, sparse, dense));
  }, [density, sparse, dense]);

  /* One element for as long as the reason holds, so the view's memo holds too. */
  const empty = useMemo(
    () => (
      <div className="empty">
        {area === null ? t('cards.map.emptyNoLocation') : t('cards.map.emptyNoWorldData')}
      </div>
    ),
    [area]
  );

  const badge =
    map.dropped > 0 ? (
      <span className="chip warn" title={t('cards.map.badgeTooltipDropped')}>
        {t('cards.map.badgeFoldedCount', {
          roomCount: map.cells.length,
          droppedCount: map.dropped
        })}
      </span>
    ) : (
      <span className="chip off">
        {t('cards.map.badgeRoomCount', { roomCount: map.cells.length })}
      </span>
    );

  return (
    <BentoCard
      {...chrome}
      actions={
        onBuild === null
          ? undefined
          : [{ id: 'build', label: t('cards.map.buildAction'), icon: 'flag', run: onBuild }]
      }
      badge={badge}
      className="map-card"
      scroll
      title={t('cards.map.title')}
    >
      {/*
       * The picture, always present — including while there is nothing to
       * draw, so the view keeps its measured size across the moment it is
       * told where the character is. Its box and the legend under it are
       * `MapView`'s own, so this card and every other map are one picture
       * with one key.
       *
       * Clicking a room opens what the realm knows about it, and the walk is
       * a button on that panel; it does not walk one, and it does not plan one
       * either. Showing the facts first is the whole reason walking is a
       * separate, deliberate action — a bare map click is the easiest possible
       * way to send a character somewhere by accident.
       */}
      <MapView
        centre={here}
        empty={empty}
        load={load}
        name="map"
        onLoaded={setMap}
        onPeek={onPeek ?? undefined}
        onPeekEnd={onPeekEnd ?? undefined}
        onZoom={onZoom}
        finds={foundRooms}
        path={walk.path}
        stops={loop.remainingStops}
        zoom={zoom}
      />
    </BentoCard>
  );
}

export default memo(MapCard);
