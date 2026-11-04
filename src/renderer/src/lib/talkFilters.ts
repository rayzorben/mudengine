/**
 * The Talk card's All toggle is gone (user, 2026-11-03): every channel toggle
 * means on is drawn and off is not. A character whose stored `talk-all` was
 * `on` was seeing every channel whatever `talk-muted` held, so that muted set
 * is cleared before the card reads it, and the card says so once in that
 * character's console. See mudengine-ui `parts/console.md`.
 */
import type { SessionId } from '@shared/ipc';

import { rememberedKey, type KeyStore } from './storage';

/**
 * Removes `talk-all` for one character. Where it was `on` and a muted set was
 * stored, that set is removed too and the answer is true: the player saw those
 * channels and would otherwise lose them without touching anything. Where it
 * was `off`, the muted set already matches what they saw. Run again, it finds
 * nothing and answers false.
 */
export function dropTalkAll(store: KeyStore, session: SessionId): boolean {
  const allKey = rememberedKey('talk-all', session);
  const word = store.read(allKey);
  if (word === null) return false;
  store.forget(allKey);
  if (word !== 'on') return false;
  const mutedKey = rememberedKey('talk-muted', session);
  const muted = store.read(mutedKey);
  if (muted === null) return false;
  store.forget(mutedKey);
  return muted !== '[]';
}

/** Characters already read this window, and those whose notice is still to be said. */
const settled = new Set<SessionId>();
const unsaid = new Set<SessionId>();

/**
 * Runs {@link dropTalkAll} once per character per window. Called while the card
 * draws, before it reads `talk-muted`, so the first read is already the new
 * meaning; repeated draws, and React's double draw in development, do nothing.
 */
export function settleTalkAll(store: KeyStore, session: SessionId): void {
  if (settled.has(session)) return;
  settled.add(session);
  if (dropTalkAll(store, session)) unsaid.add(session);
}

/** True once for a character whose muted set {@link settleTalkAll} cleared. */
export function takeTalkAllNotice(session: SessionId): boolean {
  return unsaid.delete(session);
}
