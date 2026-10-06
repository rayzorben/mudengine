/**
 * Which face a card with several faces draws, by face id.
 *
 * A card's faces come and go as the character walks: the Room card gains LAIR
 * and SHOP in the rooms that have them. The player's pick was kept as an
 * index, so walking into a lair while on FINDS put LAIR at FINDS' index and
 * drew it (user, 2026-10-05). A pick whose face has gone shows face 0.
 */
export function faceIndex(
  ids: readonly string[],
  active: string | undefined,
  picked: string | null
): number {
  const named = active === undefined ? -1 : ids.indexOf(active);
  if (named >= 0) return named;
  return picked === null ? 0 : Math.max(ids.indexOf(picked), 0);
}

/** The pick while its face is offered, else nothing picked. */
export function keptPick(ids: readonly string[], picked: string | null): string | null {
  return picked !== null && ids.includes(picked) ? picked : null;
}
