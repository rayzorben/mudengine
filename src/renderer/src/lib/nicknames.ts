/**
 * How a room search row and the route panel show MegaMUD's name for a room
 * (todo 144): `Darkwood Forest Vortex · Darkwood Forest`, then its marks after
 * the reference, `3/782 · avoid · level 20+`. Marks only: nothing here changes
 * a route. See `mudengine-ui` › `parts/tables.md`.
 */
import { t } from './i18n';
import type { FoundRoom } from '@shared/destinations';
import type { RoomNickname } from '@shared/roomNicknames';

/** The row's name: MegaMUD's before the realm's, or the realm's alone. */
export function nicknamedLabel(room: Pick<FoundRoom, 'name' | 'nickname'>): string {
  return room.nickname === null
    ? room.name
    : t('rooms.megamud.label', { nickname: room.nickname.name, roomName: room.name });
}

/** What MegaMUD records about the room, as short marks; none for a room it names plainly. */
export function nicknameMarks(nickname: RoomNickname | null): string[] {
  if (nickname === null) return [];
  const { stopBefore, avoid, minLevel: min, maxLevel: max } = nickname;
  const levels =
    min !== null && max !== null
      ? t('rooms.megamud.levelRange', { min, max })
      : min !== null
        ? t('rooms.megamud.levelFrom', { min })
        : max !== null
          ? t('rooms.megamud.levelTo', { max })
          : null;
  return [
    stopBefore ? t('rooms.megamud.stopBefore') : null,
    avoid ? t('rooms.megamud.avoid') : null,
    levels
  ].filter((mark): mark is string => mark !== null);
}

/** A row's hint with the marks after it. */
export function withMarks(hint: string, nickname: RoomNickname | null): string {
  return nicknameMarks(nickname).reduce(
    (text, mark) => t('rooms.megamud.marked', { text, mark }),
    hint
  );
}
