/**
 * `rm`'s answer on MajorMUD Plus, read into a `RoomSurvey`.
 *
 * The rows come from the `room-survey` batch (`patterns.ts`), one row per
 * line it read; this folds them into the survey of the room `Location:`
 * named. Pure, so the tracker stays a dispatcher (`mudengine-wire` ›
 * `parts/room.md`).
 */
import type { CharacterState } from '../../shared/character';
import type { RoomSurvey, SurveyGroup, SurveyMob } from '../../shared/survey';
import { figure } from '../../shared/values';
import { itemList } from './inventory';

/** `giant rat (#1)`: a name and the realm's number for it. */
const LAIR_MOB = /^(?<name>.+?)(?:\s+\(#(?<id>\d+)\))?$/;

/** The survey the answer states, on a new state; null where it named no room or read no row. */
export function surveyed(
  s: CharacterState,
  groups: Record<string, string>,
  rows: ReadonlyArray<Record<string, string>>,
  at: number
): CharacterState | null {
  const map = figure(groups['map']);
  const room = figure(groups['room']);
  if (map === null || room === null || rows.length === 0) return null;
  const survey: RoomSurvey = {
    map,
    room,
    at,
    light: null,
    spawn: null,
    group: null,
    lair: null,
    type: null,
    flags: null,
    shop: null,
    trap: null
  };
  let group: SurveyGroup | null = null;
  for (const row of rows) {
    const seen = figure(row['seen']);
    const ambient = figure(row['ambient']);
    const own = figure(row['own']);
    const others = figure(row['others']);
    if (seen !== null && ambient !== null && own !== null && others !== null) {
      survey.light = { seen, phrase: row['phrase'] ?? '', ambient, own, others };
    }
    const present = figure(row['present']);
    const max = figure(row['max']);
    if (present !== null && max !== null) survey.spawn = { present, max };
    const id = figure(row['group']);
    if (id !== null) {
      const low = figure(row['low']);
      const high = figure(row['high']);
      group = {
        id,
        levels: low !== null && high !== null ? { low, high } : null,
        mobs: [],
        shown: null
      };
    }
    // A name line or the cut belongs to the group above it; with none above, it is not this listing's.
    const members = row['members'];
    if (members !== undefined && group !== null) {
      group = { ...group, mobs: [...group.mobs, ...itemList(members)] };
    }
    const shown = figure(row['shown']);
    if (shown !== null && group !== null) group = { ...group, shown };
    if (row['lair'] !== undefined) survey.lair = itemList(row['lair']).map(lairMob);
    if (row['type'] !== undefined && row['glyph'] !== undefined) {
      survey.type = { name: row['type'], glyph: row['glyph'] };
    }
    if (row['flags'] !== undefined) {
      survey.flags = row['flags'] === 'None' ? [] : itemList(row['flags']);
    }
    if (row['shop'] !== undefined)
      survey.shop = row['shop'] === 'None' ? 'none' : figure(row['shop']);
    if (row['trap'] !== undefined) survey.trap = row['trap'];
  }
  survey.group = group;
  return { ...s, survey };
}

function lairMob(entry: string): SurveyMob {
  const match = LAIR_MOB.exec(entry);
  return { name: match?.groups?.['name'] ?? entry, id: figure(match?.groups?.['id']) };
}
