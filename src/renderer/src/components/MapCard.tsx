import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import MapPlan, { MapLegend } from './MapPlan';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';
import {
  DEFAULT_MAP_DENSITY,
  EMPTY_MAP,
  radiusForBox,
  roomPixelsFor,
  type LocalMap
} from '@shared/map';
import { errorMessage } from '@shared/values';
import type { CharacterState } from '@shared/character';
import type { LoopProgress } from '@shared/loops';
import type { WalkProgress } from '@shared/walk';

export interface MapCardProps extends CardChrome {
  character: CharacterState;
  /**
   * The neighbourhood around a room, out to `radius` rooms.
   *
   * The radius is the card's, measured from its own laid-out box — see
   * `radiusForBox`. It used to be main's default of five whatever the card was
   * drawn in, so a floating map dragged bigger drew the same rooms larger.
   */
  load(map: number, room: number, radius: number): Promise<LocalMap>;
  /** Plan a route to a room on the map. Never walks it — see below. */
  onChoose(map: number, room: number): void;
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
 * Drawn as vector shapes. It was character cells first, on the argument that
 * the game draws its own maps that way — but this map is not the game's. It is
 * derived by the client and never crosses the wire, so the character-cell rule
 * that governs the console does not reach it. It is chrome, and chrome follows
 * the design language.
 */
function MapCard({ character, load, loop, onChoose, walk, ...chrome }: MapCardProps) {
  const [map, setMap] = useState<LocalMap>(EMPTY_MAP);
  const { map: area, number } = character.room;
  const box = useRef<HTMLDivElement>(null);
  const { mapRadiusMin, mapRadiusMax, mapRoomPixelsSparse, mapRoomPixelsDense } = tuning();
  const [radius, setRadius] = useState(mapRadiusMin);
  /*
   * How much of the realm to fit on the card, from the gear in its own action
   * column. Read off `chrome.settings` — already this card's settings for
   * *this* character, addressed the way a pinned float's are — rather than
   * taken as a prop, which would be a second route to the same value.
   *
   * It chooses the room *budget*, not the room count: the count is still
   * measured from the laid-out box below, so a map dragged twice as big shows
   * more of the realm at every setting, which is what `radiusForBox` was
   * written for.
   */
  const perRoom = roomPixelsFor(
    chrome.settings?.value.mapDensity ?? DEFAULT_MAP_DENSITY,
    mapRoomPixelsSparse,
    mapRoomPixelsDense
  );

  /*
   * How far out to walk is a property of how big this card *is*, so it is
   * measured from the laid-out element and re-measured whenever that changes.
   * A railed map has a declared height and settles once; a float is dragged,
   * and every drag is a new answer.
   *
   * `ResizeObserver` rather than a window resize listener: a float is resized
   * without the window changing at all, and a splitter drag changes the rail's
   * width with the window fixed. The observer is the only thing that hears
   * both. The same measure-the-element rule the purse row already follows.
   *
   * `setRadius` with the same number is a no-op in React, so a resize that
   * does not cross a room boundary costs a measurement and no fetch.
   */
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setRadius(radiusForBox(rect.width, rect.height, perRoom, mapRadiusMin, mapRadiusMax));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // `perRoom` is a dependency, not only the tuning behind it: moving the
    // slider must re-measure without waiting for the card to be resized.
  }, [perRoom, mapRadiusMin, mapRadiusMax]);

  useEffect(() => {
    if (area === null || number === null) {
      setMap(EMPTY_MAP);
      return;
    }
    let live = true;
    void load(area, number, radius)
      .then((next) => {
        // The room can change while this is in flight; a late answer must not
        // paint a map of somewhere the character has already left.
        if (live) setMap(next);
      })
      .catch((error) => {
        // A failed fetch must not leave the previous room's map on screen with
        // the `you` marker in the wrong place — an empty card refuses where a
        // stale one lies. The cause has no room on the card, so it goes to the
        // console rather than nowhere.
        console.error(`[map] local map ${area}/${number}: ${errorMessage(error)}`);
        if (live) setMap(EMPTY_MAP);
      });
    return () => {
      live = false;
    };
  }, [area, number, load, radius]);

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
    <BentoCard {...chrome} badge={badge} className="map-card" scroll title={t('cards.map.title')}>
      {/*
       * The measured box, and always present — including while the card is
       * empty. A ref on the picture itself would detach whenever there was
       * nothing to draw, so the card would lose its size exactly when it was
       * about to be told where the character is, and come back at the floor
       * radius for one fetch.
       *
       * It is the picture's own area rather than the card's: the legend takes
       * a fixed strip at the bottom, and measuring the whole body would count
       * rows the map is never drawn in.
       */}
      <div className="map-box" ref={box}>
        {map.cells.length === 0 ? (
          <div className="empty">
            {area === null ? t('cards.map.emptyNoLocation') : t('cards.map.emptyNoWorldData')}
          </div>
        ) : (
          /*
           * Clicking a room *plans* a route to it; it does not walk one. The
           * route panel shows the steps and asks. Showing the plan first is
           * the whole reason walking is a separate, deliberate action — a map
           * click is the easiest possible way to send a character somewhere
           * by accident.
           */
          <MapPlan map={map} onChoose={onChoose} path={walk.path} stops={loop.remainingStops} />
        )}
      </div>
      <MapLegend />
    </BentoCard>
  );
}

export default memo(MapCard);
