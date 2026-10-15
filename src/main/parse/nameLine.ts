/**
 * The rooms a room's name line can be, read before `Obvious exits:` and
 * before the block is applied, for what the console draws on that line
 * (`Marks`). The claim the block answers is put to the ladder the same way
 * the room reader puts it (`ladderInput`), less the printed exits.
 */
import { narrowByName, type NameInput, type ResolveGraph } from '../world/resolve';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import { isPortalClaim, type Expectation, type Expectations } from './expectations';

/** What the ladder is asked for the claim a room block answers, less its exits. */
export function ladderInput(
  name: string,
  previous: RoomId | null,
  claim: Readonly<Expectation> | null
): NameInput {
  if (claim?.kind === 'move' && claim.landing !== undefined) return { name, among: claim.landing };
  return { name, previous, moved: claim?.kind === 'move' ? claim.direction : null };
}

/**
 * Whether a block answering `claim` spends a `sys go` or portal promise: one
 * that answered a portal's claim, or any while no portal is owed. A retried
 * portal's first landing is the first (todo 763).
 */
export function spendsPromise(
  claim: Readonly<Expectation> | null,
  queue: Pick<Expectations, 'portalOwed'>
): boolean {
  return isPortalClaim(claim) || !queue.portalOwed;
}

/** The promised room, when the realm gives it the name the block printed. */
export function promisedRoom(
  world: ResolveGraph,
  name: string,
  promised: { map: number; number: number } | null
): WorldRoom | null {
  if (promised === null) return null;
  const there = world.byId(roomId(promised.map, promised.number));
  return there && calls(there, name) ? there : null;
}

/** Whether the realm gives `room` the name a block printed. */
function calls(room: WorldRoom, name: string): boolean {
  return room.name.trim().toLowerCase() === name.trim().toLowerCase();
}

/**
 * A portal's promised room when the room reader would spend it on this block
 * and the realm agrees on the name; otherwise the rooms `narrowByName` leaves.
 * A re-read or a block nothing asked for keeps the room stood in among its
 * namesakes next door, because the name line has not seen the exits that
 * would tell them apart. A move in flight keeps it too when it has the
 * printed name: the room reader tells a reprint of it from the arrival only
 * by the exits (`room.ts`, a reprint during a step). A peek is a room in
 * some direction: the name alone.
 */
export function roomsNameCanBe(
  world: ResolveGraph,
  name: string,
  previous: RoomId | null,
  queue: Pick<Expectations, 'head' | 'promised' | 'portalOwed'>
): readonly WorldRoom[] {
  const claim = queue.head();
  if (claim?.kind === 'peek') return world.findByName(name);
  const there = spendsPromise(claim, queue) ? promisedRoom(world, name, queue.promised) : null;
  const rooms = there ? [there] : narrowByName(world, ladderInput(name, previous, claim)).rooms;
  const here = claim?.kind === 'move' && previous !== null ? world.byId(previous) : undefined;
  return here && calls(here, name) && !rooms.includes(here) ? [...rooms, here] : rooms;
}
