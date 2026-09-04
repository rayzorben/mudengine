/**
 * Works out *which* room the player is standing in.
 *
 * The hard problem of this phase, and the reason `Room.coffee` is called the
 * deepest domain logic in the workspace. Room names are not unique — the realm
 * has fourteen rooms called something beginning "Newhaven", and dozens of
 * "Mossy Tunnel" — so the name alone identifies nothing. The game never tells
 * you your coordinates unless you ask for a profile.
 *
 * The disambiguation ladder, ported from `Room.coffee`:
 *
 *   1. Unique name — done.
 *   2. The exact set of obvious exits. A ten-direction signature is a strong
 *      discriminator and is free: the client already parsed it.
 *   3. Where you came from. If the previous room is known and you walked a
 *      direction, the destination is whatever that exit points at.
 *
 * Step 3 is both the most reliable and the cheapest, so it is tried *first*
 * here rather than last: once you know where you were, you know where you are,
 * and the name and exits become a check rather than a search.
 *
 * And a rung between the two (2026-08-30): where you came from **without** a
 * direction. Something moved the character that this client did not send — a
 * retreat, a drag, a follow — and one step is still one step, so the answer is
 * among the ten rooms around the last known one. Measured over every
 * (previous, destination) pair in the shipped realm, that turns 3.07%
 * resolvable into 70.43%. It is the answer to *why did the client have to
 * ask*: it was searching 55,806 rooms for something that had to be next door.
 */
import type { Direction, RoomId, WorldRoom } from '../../shared/world';
import { roomId } from '../../shared/world';
import type { WorldGraph } from './WorldGraph';

export interface ResolveInput {
  /** Room name as parsed from the stream. */
  name: string;
  /** Directions on the `Obvious exits:` line. */
  exits: Direction[];
  /** Where we believed we were before this room arrived. */
  previous?: RoomId | null;
  /** The direction just walked, if any. */
  moved?: Direction | null;
}

export type ResolveMethod =
  | 'coordinates'
  | 'movement'
  | 'neighbour'
  | 'unique-name'
  | 'exit-signature'
  | 'dead-reckoning'
  | 'none';

/**
 * A room the server refused to describe, and the direction that reached it.
 *
 * Deliberately a **separate input type** rather than making `ResolveInput.name`
 * optional. The ladder below treats the name as a check on every rung, and an
 * optional name would silently loosen all of them — a parse miss on a lit
 * room's name would start resolving like a dark one, which is the class of
 * quiet weakening this codebase has been bitten by. Nameless is a different
 * question with a different answer, so it gets its own door.
 */
export interface DeadReckonInput {
  /** Where we believed we were before the room that never described itself. */
  previous: RoomId;
  /** The direction just walked. Without one there is nothing to reckon from. */
  moved: Direction;
  /**
   * Why the room went undescribed, because it changes what can corroborate the
   * answer.
   *
   * `dark` is the room's own doing and the realm data has an opinion about it,
   * so the destination being recorded dark is a second witness and the refusal
   * below is worth making. `blind` is the character's, and the realm has
   * nothing to say about it: a blinded character is told `You are blind.`
   * whatever the light, so there is no agreement to check and the answer rests
   * on the previous room and the edge alone. Same inference, less evidence —
   * which is what `confidence` is for rather than a reason to refuse.
   */
  unseen?: 'dark' | 'blind';
}

export interface Resolution {
  room: WorldRoom | null;
  method: ResolveMethod;
  /** Every room still consistent with the evidence. */
  candidates: WorldRoom[];
  /**
   * 0–1. Movement from a known room is near-certain; an exit signature that
   * still leaves several candidates is a guess and says so.
   */
  confidence: number;
}

const NONE: Resolution = { room: null, method: 'none', candidates: [], confidence: 0 };

/** Compares two exit sets regardless of order. */
function sameExits(a: readonly Direction[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function resolveRoom(graph: WorldGraph, input: ResolveInput): Resolution {
  const named = graph.findByName(input.name);

  /*
   * Movement from a known room. Cheapest and strongest: the realm data already
   * says where that exit leads, so there is nothing to search.
   *
   * The name is still verified. A mismatch means the belief about the previous
   * room was wrong, and continuing to trust it would compound the error room
   * after room — better to fall through and re-derive from scratch.
   */
  if (input.previous && input.moved) {
    const from = graph.byId(input.previous);
    const exit = from?.exits.find((candidate) => candidate.direction === input.moved);
    if (exit) {
      const destination = graph.get(exit.map, exit.room);
      if (destination && destination.name.toLowerCase() === input.name.trim().toLowerCase()) {
        return {
          room: destination,
          method: 'movement',
          candidates: [destination],
          confidence: 0.98
        };
      }
    }
  }

  /*
   * Something moved the character and it was not this client.
   *
   * A retreat, a drag, a follow the server did not announce in a shape this
   * client reads: the room that arrived is not the one being stood in, and no
   * queued direction explains it. What is knowable anyway is that the
   * character went **one step**, so the answer is somewhere in the ten rooms
   * around the last known one rather than anywhere in the realm.
   *
   * That is the whole difference between a client that recovers by itself and
   * one that has to ask. Measured against the shipped realm over all 190,443
   * (previous, destination) pairs: a name alone identifies the room 3.07% of
   * the time, a name inside the neighbourhood 11.44%, and a name with the
   * printed exit list 70.43%. The global ladder below was answering the first
   * of those three.
   *
   * Refused rather than guessed when the neighbourhood still holds several,
   * and left to the global ladder when it holds none — a recall or a
   * teleport is a step nobody took, and the realm is the right place to look
   * for the answer to that.
   */
  if (input.previous && !input.moved) {
    const near = neighbours(graph, input.previous, input.name);
    if (near.length === 1) {
      return { room: near[0]!, method: 'neighbour', candidates: near, confidence: 0.9 };
    }
    if (near.length > 1) {
      const bySignature = near.filter((room) =>
        sameExits(
          input.exits,
          room.exits.map((exit) => exit.direction)
        )
      );
      if (bySignature.length === 1) {
        return {
          room: bySignature[0]!,
          method: 'neighbour',
          candidates: bySignature,
          confidence: 0.85
        };
      }
      const left = bySignature.length > 1 ? bySignature : near;
      return { room: null, method: 'neighbour', candidates: left, confidence: 1 / left.length };
    }
  }

  if (named.length === 0) return { ...NONE, candidates: [] };

  if (named.length === 1) {
    return { room: named[0]!, method: 'unique-name', candidates: named, confidence: 0.9 };
  }

  /*
   * Several rooms share the name, so match on the exit signature. Note this
   * compares against the *realm data's* exits, which include exits the game
   * does not list as obvious — hidden ones — so an exact match is evidence but
   * its absence is not proof.
   */
  const bySignature = named.filter((room) =>
    sameExits(
      input.exits,
      room.exits.map((exit) => exit.direction)
    )
  );

  if (bySignature.length === 1) {
    return {
      room: bySignature[0]!,
      method: 'exit-signature',
      candidates: bySignature,
      confidence: 0.85
    };
  }

  if (bySignature.length > 1) {
    // Still ambiguous. Report the narrowed set rather than picking one: a
    // confidently wrong location sends the pathfinder somewhere else entirely.
    return {
      room: null,
      method: 'exit-signature',
      candidates: bySignature,
      confidence: 1 / bySignature.length
    };
  }

  return { room: null, method: 'none', candidates: named, confidence: 0 };
}

/**
 * The rooms one step from `from` that carry `name`, the previous room included.
 *
 * Itself as well as its neighbours, because the thing that moved the character
 * may have moved it back, and a room that is genuinely where it already was is
 * the answer rather than a case to fall through on. De-duplicated: two exits
 * of one room can lead to the same place.
 */
function neighbours(graph: WorldGraph, from: RoomId, name: string): WorldRoom[] {
  const origin = graph.byId(from);
  if (!origin) return [];

  const wanted = name.trim().toLowerCase();
  const seen = new Set<RoomId>();
  const found: WorldRoom[] = [];
  const consider = (room: WorldRoom | undefined): void => {
    if (!room) return;
    const id = roomId(room.map, room.room);
    if (seen.has(id)) return;
    seen.add(id);
    if (room.name.trim().toLowerCase() === wanted) found.push(room);
  };

  consider(origin);
  for (const exit of origin.exits) consider(graph.get(exit.map, exit.room));
  return found;
}

/**
 * Where a character landed when the room would not say — a room too dark to
 * describe, or a character too blind to read one.
 *
 * `The room is pitch black - you can't see anything` is the whole room block:
 * no name, no description, no exits. Every rung of {@link resolveRoom} needs a
 * name, so the strongest method the client has is unavailable in the one case
 * it is the *only* method that could work.
 *
 * And a printed name would not save it either: **98% of the realm's dark rooms
 * share their name with another room** (29,164 of 29,894). Measured live in the
 * sewer, holding a full room block with name *and* exits, the ladder still
 * returned nothing, because five rooms are called `Sewer Tunnel`. Dead
 * reckoning from the previous room and the direction is the only answer that
 * exists.
 *
 * The evidence is not a guess, and it is checked rather than assumed:
 *
 * - a previous room the client actually identified,
 * - a direction it actually walked,
 * - an edge the realm data states runs that way, and
 * - and, for a *dark* room, a destination the realm data **also records as
 *   dark**, agreeing with what the server printed.
 *
 * That last one is the refusal. If the realm says the destination is lit, the
 * character is somewhere it did not expect and saying so is the whole point —
 * this returns nothing rather than placing it, with the room it expected kept
 * as the candidate so a reader can see what was ruled out. It does not apply
 * to a blinded character: see `DeadReckonInput.unseen`.
 *
 * Confidence is deliberately below the 0.98 a name-verified move earns: the
 * inference is sound but nothing corroborated the arrival except agreement
 * about the dark, and `confidence` exists to carry exactly that difference.
 */
export function resolveByDeadReckoning(graph: WorldGraph, input: DeadReckonInput): Resolution {
  const from = graph.byId(input.previous);
  const exit = from?.exits.find((candidate) => candidate.direction === input.moved);
  if (!exit) return { ...NONE, candidates: [] };

  const destination = graph.get(exit.map, exit.room);
  if (!destination) return { ...NONE, candidates: [] };

  // A blinded character is told the same sentence in a torchlit hall as in a
  // cavern, so there is nothing here for the realm data to agree or disagree
  // with and the refusal below would only throw the one answer available away.
  if (input.unseen === 'blind') {
    return {
      room: destination,
      method: 'dead-reckoning',
      candidates: [destination],
      confidence: 0.6
    };
  }

  // Absent is not dark: `buildRealm` writes the level only when the realm
  // recorded a non-zero one, so no value means an ordinarily lit room.
  const dark = destination.light !== undefined && destination.light < 0;
  if (!dark) {
    return { room: null, method: 'none', candidates: [destination], confidence: 0 };
  }

  return {
    room: destination,
    method: 'dead-reckoning',
    candidates: [destination],
    confidence: 0.75
  };
}

/**
 * Resolution from an explicit `Location: map,room` in a profile.
 *
 * The only source that is not inference. Kept separate so a caller can prefer
 * it over anything this module derives.
 */
export function resolveFromCoordinates(graph: WorldGraph, map: number, room: number): Resolution {
  const found = graph.get(map, room);
  if (!found) return { ...NONE, candidates: [] };
  return { room: found, method: 'coordinates', candidates: [found], confidence: 1 };
}

export { roomId };
