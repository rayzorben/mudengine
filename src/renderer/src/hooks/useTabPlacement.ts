import { CARDS_SIDES, type CardsSide } from '@shared/config';
import type { RailSide } from '../components/TabRail';
import type { Switch } from '../lib/switch';
import { useOverridablePreference, useOverridableSwitch } from './usePreference';

export interface TabPlacement {
  /** Which edge the character tabs take (`ui.tabs`). */
  tabSide: RailSide;
  setTabSide(side: RailSide): void;
  /** Which side of the console the card rail takes (`ui.cards`). */
  railSide: CardsSide;
  setRailSide(side: CardsSide): void;
  /** Whether a side tab rail hides until the pointer reaches its edge (`ui.tabsAutoHide`). */
  tabsAutoHide: Switch;
  setTabsAutoHide(next: Switch): void;
}

const isRailSide = (value: unknown): value is RailSide =>
  value === 'top' || value === 'left' || value === 'right';

const isCardsSide = (value: unknown): value is CardsSide =>
  CARDS_SIDES.some((side) => side === value);

/**
 * Where the tab rail and the card rail sit, and whether the tab rail hides.
 *
 * Same precedence as density and theme: remembered, overridden by the file.
 */
export function useTabPlacement(configured: {
  tabs: RailSide;
  tabsAutoHide: boolean;
  cards: CardsSide;
}): TabPlacement {
  const [tabSide, setTabSide] = useOverridablePreference(
    'mudengine.tabs',
    configured.tabs,
    isRailSide
  );
  const [tabsAutoHide, setTabsAutoHide] = useOverridableSwitch(
    'mudengine.tabsAutoHide',
    configured.tabsAutoHide
  );
  /*
   * Its own attribute on the workspace rather than read off `data-tabs`,
   * because it has to hold with no tab rail at all, a client with no
   * characters yet.
   */
  const [railSide, setRailSide] = useOverridablePreference(
    'mudengine.cards',
    configured.cards,
    isCardsSide
  );
  return { tabSide, setTabSide, railSide, setRailSide, tabsAutoHide, setTabsAutoHide };
}
