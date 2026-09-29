/**
 * The Map card's finder: a start and a destination, drawn while the card's
 * search glyph has them out, and under them the pager through the route's
 * legs, drawn whenever there is a route. With no preview, the pager goes
 * through the route being walked, from the page the character is on.
 *
 * Picking a destination alone moves the map to it; with a start (the
 * character's room when none is picked) the route between them is planned
 * and the map shows it one leg at a time, each leg the stretch the map
 * draws whole around its first room (`pagesOf`, in main). The pager names
 * the jump between two legs: the way up, the typed exit, the portal or the
 * step onto another map.
 */
import { memo } from 'react';

import LegPager from './LegPager';
import RoomField from './RoomField';
import type { RoutePreview } from '../hooks/useRoutePreview';
import type { WalkPager } from '../hooks/useWalkPages';
import { t } from '../lib/i18n';
import type { WorldRoom } from '@shared/world';

export interface MapRouteFinderProps {
  preview: RoutePreview;
  search(query: string): Promise<WorldRoom[]>;
  /** Whether the character's room is known, so the start may be left empty. */
  placed: boolean;
  /** Whether the two fields are out, from the search glyph in the action column. */
  finding: boolean;
  onDone?: () => void;
  /** The route being walked, paged, drawn when there is no preview. */
  walk: WalkPager;
  /** Where the walk ends, for its last page. */
  walkingTo: string;
}

function MapRouteFinder({
  preview,
  search,
  placed,
  finding,
  onDone,
  walk,
  walkingTo
}: MapRouteFinderProps) {
  const note = preview.planning ? (
    <div className="map-finder-note quiet">{t('cards.map.preview.planning')}</div>
  ) : preview.refused !== null ? (
    <div className="map-finder-note route-refused">{preview.refused}</div>
  ) : preview.legs.length > 0 ? (
    <LegPager
      at={preview.leg}
      close={preview.clear}
      destination={preview.to?.name ?? ''}
      first={0}
      legs={preview.legs}
      page={preview.page}
    />
  ) : preview.to === null && walk.walking !== null ? (
    <LegPager
      at={walk.shown ?? walk.walking}
      close={null}
      destination={walkingTo}
      first={walk.walking}
      legs={walk.legs}
      page={walk.page}
    />
  ) : null;
  if (!finding && note === null) return null;
  return (
    <div className="map-finder">
      {finding && (
        <div className="map-finder-fields">
          <RoomField
            label={t('cards.map.finder.fromAria')}
            onDone={onDone}
            onPick={preview.pickFrom}
            picked={preview.from}
            placeholder={
              placed ? t('cards.map.finder.fromHere') : t('cards.map.finder.fromUnknown')
            }
            search={search}
          />
          <RoomField
            autoFocus
            label={t('cards.map.finder.toAria')}
            onDone={onDone}
            onPick={preview.pickTo}
            picked={preview.to}
            placeholder={t('cards.map.finder.toPlaceholder')}
            search={search}
          />
        </div>
      )}
      {note}
    </div>
  );
}

export default memo(MapRouteFinder);
