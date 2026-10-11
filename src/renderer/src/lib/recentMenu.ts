/**
 * The console's right-click rows for the rooms walked to and the loops run
 * lately, newest first (todo 28): a room walks in one click (`walkTo`), a loop
 * starts. Nothing recent is no rows, so the menu is Copy and Paste alone.
 * Pure over what it is handed, so a test drives it without rendering.
 */
import type { MenuItem } from '../components/PopupMenu';
import { t } from './i18n';
import { foundRoomHint } from './visited';
import { walkTo, type WalkToDeps } from './walkTo';
import type { FoundRoom } from '@shared/destinations';

export interface RecentMenuDeps extends WalkToDeps {
  /** Start a loop by name, its refusal said in the character's console. */
  startLoop(name: string): void;
}

export function recentMenuItems(
  rooms: readonly FoundRoom[],
  loops: readonly string[],
  deps: RecentMenuDeps,
  now: number
): MenuItem[] {
  const items: MenuItem[] = [
    ...rooms.map((room) => ({
      icon: 'route' as const,
      label: t('palette.navigate.gotoLabel', { roomName: room.name }),
      hint: foundRoomHint(room, now),
      run: () => walkTo(room, deps)
    })),
    ...loops.map((name) => ({
      icon: 'loop' as const,
      label: t('palette.navigate.loopLabel', { loopName: name }),
      run: () => deps.startLoop(name)
    }))
  ];
  return items.map((item, index) => (index === 0 ? { ...item, divided: true } : item));
}
