/**
 * Whether this window is a phone's, and so shows the phone shell in place of
 * the desktop layout. Read from the media query and followed as it changes
 * (a phone turned on its side stays a phone); the consoles stay mounted under
 * either, as under the game view.
 */
import { useSyncExternalStore } from 'react';

import { PHONE_QUERY, phoneWanted } from '../lib/phone';

function subscribe(notify: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}

const snapshot = (): boolean =>
  phoneWanted(window.location.search, window.matchMedia(PHONE_QUERY).matches);

export function usePhoneView(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}

/** What `.app` wears: the game view's attributes, with the phone's `data-view` over them. */
export function withPhoneView<T extends { 'data-view'?: string }>(
  appProps: T,
  phone: boolean
): T | (Omit<T, 'data-view'> & { 'data-view': 'phone' }) {
  return phone ? { ...appProps, 'data-view': 'phone' } : appProps;
}
