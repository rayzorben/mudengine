/**
 * The Talk card as the game view's panel draws it, with the panel's own close
 * (todo 140). Out of `App` with the one callback it was.
 */
import { useCallback, type ReactNode } from 'react';

import type { SessionId } from '@shared/ipc';
import { cardElement } from '../components/CardSwitch';
import type { CardContexts } from './useCardContext';
import type { SessionView } from './useSessionViews';

export function useTalkPanel(
  contextFor: CardContexts['contextFor'],
  session: SessionId,
  view: SessionView,
  returnFocus: () => void
): (onClose: () => void) => ReactNode {
  return useCallback(
    (onClose: () => void) =>
      cardElement(
        'conversation',
        contextFor(session, view, { cardId: 'conversation', onClose, returnFocus })
      ),
    [contextFor, session, view, returnFocus]
  );
}
