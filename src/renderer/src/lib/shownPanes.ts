/**
 * The characters on screen when the window last drew, so a reload, a browser
 * tab the browser discarded, a remount after a lost web socket, or a relaunch
 * comes back to them instead of the first tab in the rail (`usePanes`).
 *
 * Kept per tab first (`sessionStorage`), since two browser tabs showing two
 * characters would otherwise each come back to the other's; the window's
 * `localStorage` copy is what a new tab or a relaunch starts from. A stored id
 * no longer loaded is dropped by `usePanes`' own filter.
 */
import type { SessionId } from '@shared/ipc';

import { readStored, writeStored, type StorageArea } from './storage';

const KEY = 'mudengine.shown';

export interface Shown {
  panes: SessionId[];
  at: number;
}

const NOTHING = (): Shown => ({ panes: [], at: 0 });

export function parseShown(stored: string): Shown {
  const parsed = JSON.parse(stored) as { panes?: unknown; at?: unknown } | null;
  const panes = Array.isArray(parsed?.panes)
    ? parsed.panes.filter((id): id is SessionId => typeof id === 'string')
    : [];
  const at = typeof parsed?.at === 'number' && Number.isInteger(parsed.at) ? parsed.at : 0;
  return { panes, at: Math.max(0, at) };
}

const readFrom = (area: StorageArea): Shown => readStored(KEY, parseShown, NOTHING, area);

export function readShown(): Shown {
  const own = readFrom('session');
  return own.panes.length > 0 ? own : readFrom('local');
}

export function writeShown(shown: Shown): void {
  const text = JSON.stringify(shown);
  writeStored(KEY, text, 'session');
  writeStored(KEY, text, 'local');
}
