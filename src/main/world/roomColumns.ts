/**
 * Room columns of the world file read as typed values, parsed rather than
 * cast (`WorldGraph.toRoom`): an exit's levers (format 23) and a list of
 * monster rows (format 61), each list kept once however many rooms name it.
 */
import type { RequirementAction } from '../../shared/world';

/**
 * The levers on one exit, parsed rather than cast — format 23.
 *
 * Every other field in `parseRoom` is type-checked and this one was taken
 * wholesale, while `describeObstacle` and `Levers.pullLevers` both reach
 * `act.say[0]!` behind a non-null assertion. A realm whose `Action …` cell has
 * a shape this build does not expect would put `undefined` into the obstacle
 * chip and give the walker a rung that sends nothing, returns true and spends
 * a lever budget. Parse, do not validate — the reviewer's find, 2026-09-06.
 *
 * A member that will not parse drops the **whole** list rather than shortening
 * it: `openableHere` counts what is left against nothing, so half a lever set
 * would read as a passage this room can open when it cannot.
 */
export function readActions(raw: unknown): RequirementAction[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const actions: RequirementAction[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const say = record['say'];
    if (!Array.isArray(say) || say.length === 0) return [];
    if (!say.every((phrase): phrase is string => typeof phrase === 'string' && phrase.length > 0)) {
      return [];
    }
    const action: RequirementAction = { say: [...say] };
    const item = record['item'];
    if (item !== undefined) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return [];
      action.item = item;
    }
    const at = record['at'];
    if (at !== undefined) {
      if (typeof at !== 'object' || at === null) return [];
      const place = at as Record<string, unknown>;
      if (typeof place['map'] !== 'number' || typeof place['room'] !== 'number') return [];
      action.at = { map: place['map'], room: place['room'] };
    }
    actions.push(action);
  }
  return actions;
}

/**
 * A list of monster row ids, or null where the cell holds none or anything
 * but positive integers. `kept` holds each distinct list once: 39,097 of
 * Paradigm's rooms name 775 lists of their group's rows.
 */
export function readRows(
  raw: unknown,
  kept: Map<string, readonly number[]>
): readonly number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((id): id is number => Number.isInteger(id) && (id as number) > 0)) return null;
  const key = raw.join(',');
  const known = kept.get(key);
  if (known !== undefined) return known;
  const rows: readonly number[] = [...raw];
  kept.set(key, rows);
  return rows;
}
