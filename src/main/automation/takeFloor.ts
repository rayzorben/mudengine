/**
 * `@get-all`'s work and the typed `get all`'s (todo 83): one `get` per item
 * the room listing names, up to `max` (`automation.remotes.maxGets`), each handed to the
 * caller's way of sending it. Never a literal `get all`: GreaterMUD reads
 * `all` as an item's name (`GetCommand.cs`). Beside `restoreKit`, its
 * `equip all` twin; each caller words its own notices.
 */
import type { CharacterState } from '../../shared/character';

export interface Taken {
  /** How many `get`s went to `send`. */
  sent: number;
  /** How many items the room listing names. */
  listed: number;
  /** The cap the `get`s were held to. */
  max: number;
}

export function takeFloor(
  state: CharacterState,
  max: number,
  send: (command: string) => void
): Taken {
  // The names, because `get` takes a name.
  const items = state.room.items.map((item) => item.name).slice(0, max);
  for (const item of items) send(`get ${item}`);
  return { sent: items.length, listed: state.room.items.length, max };
}
