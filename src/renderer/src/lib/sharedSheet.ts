/**
 * A shared character's sheet in words (todo 20261031-1156-01), as the Players
 * card and the tab rail's Remote characters both draw it. A figure the
 * sharer's client did not send reads as unknown, never as 0.
 */
import { t } from './i18n';
import type { PeerSheet } from '@shared/peers';

export const figure = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? t('cards.players.shared.unknown')
    : value.toLocaleString();

/** The room the sharer's client placed it in; where it could not tell, every room it kept. */
export function roomOf(sheet: PeerSheet): string {
  const room = sheet.room;
  if (room?.name) return room.name;
  if (room === null || room.candidates.length === 0) return t('cards.players.shared.roomUnknown');
  return t('cards.players.shared.roomOneOf', {
    rooms: room.candidates.map((each) => each.name).join(', ')
  });
}
