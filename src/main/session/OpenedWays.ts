/**
 * The doors and hidden exits this session's walk opened, and for how long the
 * server is sure to leave them open (todo 62). GreaterMUD's `Door` starts a
 * close-and-lock timer of `Para × 300 s` when it is unlocked, picked or bashed,
 * and `HiddenExit` a close timer of `Para2 × 300 s` (600 s unset) when it is
 * found. The realm data does not carry `Para`, so the floor of 300 s is all a
 * route may count on. `mudengine-world` › parts/routing.md.
 */
import { shutBarrier, type CharacterState } from '../../shared/character';
import type { OpenedKind } from '../automation/walk/ports';
import {
  edgeKey,
  OPPOSITE,
  roomId,
  type Direction,
  type RoomId,
  type WorldRoom
} from '../../shared/world';

interface Opened {
  kind: OpenedKind;
  at: number;
}

/** The room lookup the far side of a door is found by. */
export interface OpenedWaysWorld {
  byId(id: RoomId): WorldRoom | undefined;
}

export class OpenedWays {
  /** By `from|direction`, the router's edge key. */
  private readonly opened = new Map<string, Opened>();

  constructor(private readonly world: () => OpenedWaysWorld | null) {}

  /** The walk opened this way at `at`; a door's far side opened with it (`Door.OpenDoor`). */
  noteOpened(from: RoomId, direction: Direction, kind: OpenedKind, at: number): void {
    this.opened.set(edgeKey(from, direction), { kind, at });
    if (kind !== 'door') return;
    const back = this.farSide(from, direction);
    if (back !== null) this.opened.set(back, { kind, at });
  }

  /**
   * The room the character stands in, as printed: a door it calls `closed`
   * shut early (somebody closed it, `Door.TryCloseDoor`), and a hidden exit
   * its printed list lacks has closed. A room whose exits were not read says
   * nothing.
   */
  onRoom(state: CharacterState): void {
    if (this.opened.size === 0 || state.room.exits.length === 0) return;
    const { map, number } = state.room;
    if (map === null || number === null) return;
    const here = roomId(map, number);
    for (const [key, opened] of this.opened) {
      if (!key.startsWith(edgeKey(here, ''))) continue;
      const direction = key.slice(here.length + 1);
      const listed = state.room.exits.find((exit) => exit.direction === direction);
      const shut =
        opened.kind === 'door' ? shutBarrier(listed?.note) !== null : listed === undefined;
      if (shut) this.opened.delete(key);
    }
  }

  /**
   * The ways still inside `holdMs` of being opened at `now` (`world.openedWayMs`
   * at the realm's speed); the rest are forgotten.
   */
  openAt(now: number, holdMs: number): ReadonlySet<string> {
    const open = new Set<string>();
    for (const [key, opened] of this.opened) {
      if (now - opened.at < holdMs) open.add(key);
      else this.opened.delete(key);
    }
    return open;
  }

  reset(): void {
    this.opened.clear();
  }

  /** The far side's edge key, where the realm records an exit straight back. */
  private farSide(from: RoomId, direction: Direction): string | null {
    const world = this.world();
    const exit = world?.byId(from)?.exits.find((one) => one.direction === direction);
    if (world === null || exit === undefined) return null;
    const beyond = roomId(exit.map, exit.room);
    const back = OPPOSITE[direction];
    const returns = world
      .byId(beyond)
      ?.exits.some((one) => one.direction === back && roomId(one.map, one.room) === from);
    return returns === true ? edgeKey(beyond, back) : null;
  }
}
