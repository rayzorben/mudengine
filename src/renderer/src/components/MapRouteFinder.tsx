/**
 * The Map card's finder: a start and a destination, drawn while the card's
 * search glyph has them out, and under them the pager through the route's
 * legs, drawn whenever there is a route.
 *
 * Picking a destination alone moves the map to it; with a start (the
 * character's room when none is picked) the route between them is planned
 * and the map shows it one leg at a time, each leg the stretch the map
 * draws whole around its first room (`pagesOf`, in main). The pager names
 * the jump between two legs: the way up, the typed exit, the portal or the
 * step onto another map.
 */
import { memo } from 'react';

import Icon from './Icon';
import RoomField from './RoomField';
import type { RoutePreview } from '../hooks/useRoutePreview';
import { keepFocus } from '../lib/focus';
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
}

function LegPager({ preview }: { preview: RoutePreview }) {
  const { legs, leg: at, page, clear } = preview;
  const leg = legs[at];
  if (leg === undefined) return null;
  const count = leg.steps.length;
  const last = legs.length - 1;
  const arriving = leg.steps.at(-1)?.name ?? leg.entry?.name ?? preview.to?.name ?? '';
  const onward =
    leg.jump !== null
      ? t('cards.map.preview.then', { command: leg.jump.command, roomName: leg.jump.name })
      : at === last
        ? t('cards.map.preview.arrives', { roomName: arriving })
        : t('cards.map.preview.continues', { roomName: arriving });
  return (
    <div className="map-legs" data-leg={at}>
      <div className="map-legs-row">
        <button
          aria-label={t('cards.map.preview.previous')}
          className="quiet builder-key"
          disabled={at === 0}
          onClick={() => page(at - 1)}
          onMouseDown={keepFocus}
          title={t('cards.map.preview.previous')}
          type="button"
        >
          <Icon name="previous" />
        </button>
        <span className="map-leg-count">
          {t('cards.map.preview.legOf', { leg: at + 1, count: legs.length })}
        </span>
        <button
          aria-label={t('cards.map.preview.next')}
          className="quiet builder-key"
          disabled={at === last}
          onClick={() => page(at + 1)}
          onMouseDown={keepFocus}
          title={t('cards.map.preview.next')}
          type="button"
        >
          <Icon name="next" />
        </button>
        <span className="map-leg-steps">
          {count === 1
            ? t('cards.map.preview.steps.one', { count })
            : t('cards.map.preview.steps.many', { count })}
        </span>
        <button
          aria-label={t('cards.map.preview.close')}
          className="quiet builder-key"
          onClick={clear}
          onMouseDown={keepFocus}
          title={t('cards.map.preview.close')}
          type="button"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="map-leg-text" title={onward}>
        {onward}
      </div>
    </div>
  );
}

function MapRouteFinder({ preview, search, placed, finding, onDone }: MapRouteFinderProps) {
  const note = preview.planning ? (
    <div className="map-finder-note quiet">{t('cards.map.preview.planning')}</div>
  ) : preview.refused !== null ? (
    <div className="map-finder-note route-refused">{preview.refused}</div>
  ) : preview.legs.length > 0 ? (
    <LegPager preview={preview} />
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
