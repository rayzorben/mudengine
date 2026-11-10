/**
 * What the server's `rm` said about the room the character stood in.
 *
 * MajorMUD Plus (omniversebbs.com) answers `rm` with rows under the
 * coordinates: the light and its parts, how many monsters the room holds
 * against its limit, the spawn group or the lair, the room type, its flags,
 * its shop and its trap. Read from Yang's wire on Omniverse, 2026-11-04 to
 * 2026-11-10 (`mudengine-wire` › `parts/room.md`). Every field is the server's
 * own figure or word, and null where the listing did not print the row.
 *
 * Dependency-free like everything in `shared/`.
 */

/** `Illumination: 75 (Regular Light)   Ambient: 0  You: +75  Others: +0`. */
export interface SurveyLight {
  /** What the character sees by, the sum of the three parts. */
  seen: number;
  /** The server's word for it: `Regular Light`, `barely visible`. */
  phrase: string;
  /** The room's own level. */
  ambient: number;
  /** What this character's light and night vision add. */
  own: number;
  /** What the other players' lights add. */
  others: number;
}

/** `Spawn Grp:    5  (lvl 1-4)` and the names under it. */
export interface SurveyGroup {
  id: number;
  /** The group's level range, where the server printed one. */
  levels: { low: number; high: number } | null;
  /** The monsters the group can bring, in the server's order; empty for `(none present)`. */
  mobs: string[];
  /** `...(showing first 24)`: the server cut the list at this many. Null where it did not. */
  shown: number | null;
}

/** One monster under `Spawns:`, `giant rat (#1)`. */
export interface SurveyMob {
  name: string;
  /** The monster's number in the realm, where the server printed one. */
  id: number | null;
}

export interface RoomSurvey {
  /** The room the listing describes, from its `Location:` row. */
  map: number;
  room: number;
  /** Epoch ms the answer arrived. */
  at: number;
  light: SurveyLight | null;
  /** `Spawn:         2/8`: the monsters the room holds now, against its limit. */
  spawn: { present: number; max: number } | null;
  /** `Spawn Grp:`, printed for a room with no lair of its own. */
  group: SurveyGroup | null;
  /** `Spawns:`, the lair's own monsters. */
  lair: SurveyMob[] | null;
  /** `Type:          Shop [S]`: the type and the map letter the server gives it. */
  type: { name: string; glyph: string } | null;
  /** `Flags:`, in the server's words; empty for `None`. */
  flags: string[] | null;
  /** `Shop:`, the shop's number, or `none`. */
  shop: number | 'none' | null;
  /** `Trap:`, in the server's words (`None`). */
  trap: string | null;
}

/** The survey of the room the character stands in now; null for any other room. */
export function surveyHere(state: {
  survey: RoomSurvey | null;
  room: { map: number | null; number: number | null };
}): RoomSurvey | null {
  const survey = state.survey;
  if (survey === null) return null;
  return survey.map === state.room.map && survey.room === state.room.number ? survey : null;
}
