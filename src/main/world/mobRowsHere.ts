/**
 * The rows of a shared monster name that a room itself names: its resident,
 * its lair and the wanderers of its group. One of them is the monster standing
 * there; several are the only rows it can be, and what they agree on is known.
 * `mudengine-world` › `parts/realm.md` › *And the room a name was printed in
 * resolves it to a row*.
 */
import { foldDisposition } from '../../shared/mobs';
import { parseLair, type WorldMob, type WorldMobRow, type WorldRoom } from '../../shared/world';

/** Which of `wanted` the room names, each once. */
export function rowsNamedHere(room: WorldRoom, wanted: ReadonlySet<number>): number[] {
  const named = new Set<number>();
  if (room.npcId !== undefined && wanted.has(room.npcId)) named.add(room.npcId);
  if (room.lair !== undefined) {
    for (const id of parseLair(room.lair).ids) if (wanted.has(id)) named.add(id);
  }
  // The server walks a monster only into a room of its own group
  // (`Mob.CanMoveThroughExit`), and these are that group's rows (format 61).
  for (const id of room.wanderers ?? []) if (wanted.has(id)) named.add(id);
  return [...named];
}

/**
 * The fold, answering for the rows this room names where it names several but
 * not all: `giant rat` is rows 1 and 109, which attack on sight, and row 1116,
 * which does not, and the Newhaven Arena's group holds only the first two.
 *
 * Only `ids`, `disposition` and `uncertain` are narrowed. `hp`, `span` and
 * every other figure stay the worst of the whole name, rows not named included.
 * A row stating no alignment leaves the fold as it was.
 */
export function amongRowsHere(
  mob: WorldMob,
  room: WorldRoom | undefined,
  rowOf: (id: number) => WorldMobRow | undefined
): WorldMob {
  if (room === undefined || mob.ids === undefined) return mob;
  const wanted = new Set(mob.ids.filter((id) => rowOf(id) !== undefined));
  const rows = rowsNamedHere(room, wanted).flatMap((id) => rowOf(id) ?? []);
  if (rows.length < 2 || rows.length === wanted.size) return mob;
  const tempers = rows.flatMap((row) => row.disposition ?? []);
  if (tempers.length < rows.length) return mob;
  return { ...mob, ids: rows.map((row) => row.id), ...foldDisposition(tempers) };
}
