import type { RailSide } from '../components/TabRail';
import type { Switch } from '../lib/switch';
import { useOverridablePreference, useOverridableSwitch } from './usePreference';

export interface TabPlacement {
  /** Which edge the character tabs take (`ui.tabs`). */
  tabSide: RailSide;
  setTabSide(side: RailSide): void;
  /** Which edge the card rail takes: the other one. */
  railSide: 'left' | 'right';
  /** Whether a side tab rail hides until the pointer reaches its edge (`ui.tabsAutoHide`). */
  tabsAutoHide: Switch;
  setTabsAutoHide(next: Switch): void;
}

const isRailSide = (value: unknown): value is RailSide =>
  value === 'top' || value === 'left' || value === 'right';

/**
 * Where the tab rail and the card rail sit, and whether the tab rail hides.
 *
 * Same precedence as density and theme: remembered, overridden by the file.
 */
export function useTabPlacement(configured: {
  tabs: RailSide;
  tabsAutoHide: boolean;
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
   * One setting decides both edges, because the two side rails cannot share
   * one: a client that let each be asked for independently would have to pick
   * a winner when both said left, and the pick would be arbitrary.
   *
   * Stated as its own attribute rather than read off `data-tabs` in the
   * stylesheet, because it has to hold with no tab rail at all, a client with
   * no characters yet: keyed on the tabs, the card rail would sit on the right
   * until the first character loaded and then jump across the window.
   */
  const railSide: 'left' | 'right' = tabSide === 'right' ? 'left' : 'right';
  return { tabSide, setTabSide, railSide, tabsAutoHide, setTabsAutoHide };
}
