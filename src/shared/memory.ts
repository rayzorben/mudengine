/**
 * What this client has learned about a realm that the realm data does not have.
 *
 * The shipped world is a snapshot of one build of one server. A derivative adds
 * rooms, an operator rewires a corridor, and a `Text:` exit nobody wrote down
 * turns out to work — and the moment any of that happens the client is walking
 * a map that disagrees with the game. It cannot be told; it can only be
 * *watched*, which is what this is: the character walks somewhere the data said
 * was not there, and the fact is written down against that character.
 *
 * **Observations, not corrections.** Nothing here edits the realm database, and
 * nothing here is fed to the pathfinder. A learned edge is one sample of one
 * walk, and a route planned through a wrong one sends a character somewhere it
 * cannot get back from — the same reason `WorldGraph` refuses to guess a
 * location rather than picking the likeliest candidate. What this buys is that
 * the client *says* what it found, keeps it, and can show it beside the room it
 * belongs to.
 *
 * Dependency-free, like the rest of `shared/`: main writes these and the
 * renderer reads them.
 */
import type { RoomId } from './world';

/**
 * Why an observation was worth writing down.
 *
 * **Both halves of this union live here and move together.** The type below is
 * derived from the list, rather than the two being written out separately: a
 * reason in the type and not in the list type-checks everywhere, is written to
 * disk happily, and is then rejected by the reader — which is not a lost row
 * but a lost *file*, because one unrecognised reason fails the whole-file
 * check and every exit learned beside it is discarded with it.
 *
 * That is not hypothetical. `unknown-stock` was added to the type when shops
 * were learned from and never added to `WorldMemory`'s reader, so from that day
 * a character that had listed one shop reloaded with **nothing** — and the only
 * symptom was the client learning the same shop again every session, which
 * reads as a memory that is not being saved rather than one that cannot be
 * read. Found 2026-08-31 from a player's own `memory/main.json`, which held
 * three correct stock rows the client refused to load.
 */
export const DISCOVERY_REASONS = [
  /** The realm data has this room, and no edge from where we were to it. */
  'unknown-exit',
  /** The realm data has no room by this name at all. */
  'unknown-room',
  /** A shop sold something the realm data does not list it as stocking. */
  'unknown-stock'
] as const;

export type DiscoveryReason = (typeof DISCOVERY_REASONS)[number];

/** Whether a value off disk is a reason this build knows. */
export function isDiscoveryReason(value: unknown): value is DiscoveryReason {
  return DISCOVERY_REASONS.includes(value as DiscoveryReason);
}

export interface Discovery {
  reason: DiscoveryReason;
  /** Where the character was standing. Known, or the observation is not learnable. */
  from: RoomId;
  /** The realm's name for `from`, so a record is readable without the database. */
  fromName: string;
  /**
   * What was typed to leave — or, for `unknown-stock`, what was bought.
   *
   * `ne` for a compass exit the data does not have, `jump cliff` for something
   * the client does not model as movement at all. Verbatim, because that is
   * what a player would have to type to do it again.
   */
  command: string;
  /** Where it led, when the realm data could name it. Null for `unknown-room`. */
  to: RoomId | null;
  /** The name the server printed on arrival. */
  name: string;
  /** The exits printed on arrival — the only description of a room not in the data. */
  exits: string[];
  /** When it was first seen. Not updated on a repeat: this is the discovery. */
  at: number;
}

/**
 * The identity of an observation, for keeping one copy of it.
 *
 * Keyed on the walk rather than on its outcome, so walking the same new exit
 * twice is one fact — and so an edge whose far side resolves one day and not
 * the next does not become two.
 *
 * A shop's stock keys the same way and means the same thing: `from` is the shop
 * room and `command` is what was bought, so buying the same unlisted thing
 * twice is still one discovery.
 */
export function discoveryKey(discovery: Pick<Discovery, 'from' | 'command'>): string {
  return `${discovery.from}|${discovery.command.trim().toLowerCase()}`;
}

/** One line of English for an observation, for a notice or a card row. */
export function describeDiscovery(discovery: Discovery): string {
  if (discovery.reason === 'unknown-stock') {
    return `${discovery.fromName} sells ${discovery.name}, which the realm data does not list`;
  }
  const where =
    discovery.to === null ? `${discovery.name} (not in the realm data)` : discovery.name;
  return `"${discovery.command}" leads from ${discovery.fromName} to ${where}`;
}
