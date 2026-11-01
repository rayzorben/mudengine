/**
 * What the rail head and the palette do to the whole rail, composed: auto
 * layout (`useAutoLayout`), the saved card layouts (`useNamedLayouts`) and
 * their files (`useLayoutFiles`).
 */
import { useMemo } from 'react';

import type { SessionId } from '@shared/ipc';

import type { RailLayoutsApi } from '../lib/cardLayouts';
import type { CardLayoutApi, RailGridView } from '../lib/cards';
import { useAutoLayout } from './useAutoLayout';
import { useLayoutFiles } from './useLayoutFiles';
import { useNamedLayouts } from './useNamedLayouts';

export function useRailLayouts(
  session: SessionId,
  cards: CardLayoutApi,
  rail: RailGridView
): RailLayoutsApi {
  const auto = useAutoLayout(session, cards, rail);
  const named = useNamedLayouts(cards);
  const files = useLayoutFiles(window.mudengine, cards, named.adopt);
  return useMemo(() => ({ auto, named, files }), [auto, named, files]);
}
