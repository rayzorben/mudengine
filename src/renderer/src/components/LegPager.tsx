/**
 * The pager through a route's pages on the Map card: back and on, which page
 * of how many, the steps on it, and the jump that ends it. Drawn for the
 * route preview and for the route being walked, where it counts from the
 * page the character is on. See `mudengine-ui` › `parts/map.md` ›
 * *The route preview*.
 */
import { memo } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { RoutePage } from '@shared/routeLegs';

export interface LegPagerProps {
  legs: readonly RoutePage[];
  /** The page on screen. */
  at: number;
  /** The first page the pager goes back to: 0, or the page being walked. */
  first: number;
  page(index: number): void;
  /** Where the route ends, for a last page with no steps to name it. */
  destination: string;
  /** Ends the route shown; null where the pager has no close (a walk). */
  close: (() => void) | null;
}

function LegPager({ legs, at, first, page, destination, close }: LegPagerProps) {
  const leg = legs[at];
  if (leg === undefined) return null;
  const count = leg.steps.length;
  const last = legs.length - 1;
  const arriving = leg.steps.at(-1)?.name ?? leg.entry?.name ?? destination;
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
          disabled={at <= first}
          onClick={() => page(at - 1)}
          onMouseDown={keepFocus}
          title={t('cards.map.preview.previous')}
          type="button"
        >
          <Icon name="previous" />
        </button>
        <span className="map-leg-count">
          {t('cards.map.preview.legOf', { leg: at - first + 1, count: legs.length - first })}
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
        {close !== null && (
          <button
            aria-label={t('cards.map.preview.close')}
            className="quiet builder-key"
            onClick={close}
            onMouseDown={keepFocus}
            title={t('cards.map.preview.close')}
            type="button"
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="map-leg-text" title={onward}>
        {onward}
      </div>
    </div>
  );
}

export default memo(LegPager);
