/**
 * What finding a hidden exit costs one character, and which exit types a
 * server family loads as plain exits (todo 62). Read off the GreaterMUD
 * source: `HiddenExit.SearchExit` finds a searchable exit on one roll of
 * 1–100 at or under Perception, and `RoomManager.LoadRooms` builds types 16
 * to 19 and 21 as `NormalExit` (`//fix this`). `mudengine-world` ›
 * parts/routing.md.
 */
import type { RealmFamily } from '../../../shared/realm';
import { edgeKey, type Direction, type Requirement, type RoomId } from '../../../shared/world';

/**
 * The commands finding a searchable exit costs on average: `100 / Perception`
 * searches, a bare Enter after every `recheckEvery`th miss and one after the
 * find (`Barriers.onSearchAnswered`). `unknown` while the sheet is unread;
 * null where no roll ever finds it.
 */
export function searchCost(
  perception: number | null | undefined,
  recheckEvery: number
): number | 'unknown' | null {
  if (perception === null || perception === undefined) return 'unknown';
  if (perception <= 0) return null;
  const searches = 100 / Math.min(perception, 100);
  const rechecks = recheckEvery > 0 ? (searches - 1) / recheckEvery : 0;
  return Math.round(searches + rechecks + 1);
}

/**
 * Whether this server loads the exit as a plain one whatever the realm data
 * calls it: `Timed:` (type 16) and `Ticket/Item:` (type 17) on GreaterMUD.
 * The other three plain-loaded types (users, block guard, delay) occur in no
 * shipped realm. An unread family is not GreaterMUD.
 */
export function familyOpens(
  requirement: Requirement,
  family: RealmFamily | null | undefined
): boolean {
  if (family !== 'greatermud') return false;
  return requirement.kind === 'timed' || requirement.ticket === true;
}

/** What of a traveller decides whether an exit stands open for it now. */
export interface Standing {
  family?: RealmFamily | null;
  opened?: ReadonlySet<string>;
}

/**
 * The requirement an exit stands under for this traveller: none where the
 * server family loads it as a plain exit (`familyOpens`), or for a door or
 * hidden exit this session's walk opened inside its close timer
 * (`Traveller.opened`). Every reader of an edge's gate asks this, so the
 * price, the blocks and the keys a plan fetches agree.
 */
export function standingRequirement(
  requirement: Requirement | null,
  from: RoomId,
  direction: Direction | 'portal',
  standing: Standing
): Requirement | null {
  if (requirement === null || familyOpens(requirement, standing.family)) return null;
  if ((standing.opened?.size ?? 0) === 0) return requirement;
  const kind = requirement.kind;
  if (kind !== 'door' && kind !== 'key' && kind !== 'hidden') return requirement;
  return standing.opened!.has(edgeKey(from, direction)) ? null : requirement;
}
