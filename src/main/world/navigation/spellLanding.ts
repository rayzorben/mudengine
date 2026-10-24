/**
 * Where one spell's `TeleportRoom` puts the character, as the server works it
 * out (`Spell.cs` `ApplySpellAbilities`): a stated modifier is the room, a
 * zero is `inMainValue`, a roll of the spell's own `MinBase`–`MaxBase`. So the
 * answer is a range, which is a room when it is one wide. The map is
 * `TeleportMap` where the row states one and the target's own where it does
 * not. Read by a `Cast:` exit (`WorldGraph.resolveSpells`) and by a command's
 * run (`scriptLandings`), so the two cannot disagree about a spell.
 */
import { HAZARD_ABILITY } from '../../../shared/abilities';
import type { Landing } from '../../../shared/world';

/** A spell row as a landing reads it. */
export interface LandingRow {
  id: number;
  name: string;
  power?: readonly [number, number];
  abilities?: ReadonlyArray<readonly [number, number]>;
}

/**
 * The landing, or null for a row this cannot turn into a room: a zero
 * modifier with no power range is a draw between room 0 and room 0, and room
 * 0 is not a room. That is unread rather than harmless.
 */
export function spellLanding(spell: LandingRow, stated: number, onMap: number): Landing | null {
  const [min, max] = spell.power ?? [0, 0];
  const low = stated > 0 ? stated : min;
  const high = stated > 0 ? stated : max;
  if (low <= 0 || high < low) return null;
  const map = spell.abilities?.find(([id]) => id === HAZARD_ABILITY.teleportMap)?.[1];
  return {
    spell: spell.id,
    name: spell.name,
    map: map !== undefined && map > 0 ? map : onMap,
    low,
    high
  };
}

/** The `TeleportRoom` modifier a row states, or null where it moves nobody. */
export function teleportRoomOf(
  abilities: ReadonlyArray<readonly [number, number]> | undefined
): number | null {
  return abilities?.find(([id]) => id === HAZARD_ABILITY.teleportRoom)?.[1] ?? null;
}
