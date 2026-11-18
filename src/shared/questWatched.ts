/**
 * The quest ranks a character was watched reaching, kept between sessions, and
 * the port they are kept through.
 *
 * A realm with no `abil` states no counter, so what the client watched is the
 * only record of a step done there, and it was lost at every reconnect (Yang
 * on stock MajorMUD, 2026-11-18: four steps of GoodQuest run, the daily
 * disconnect, and the book back at 0 of 30). It is kept in the character's
 * record beside the `abil` listing, each with its own clock, so
 * `questReading` ranks them after a restart as it does within a session.
 */
import type { QuestSeen, QuestWatched } from './quests';
import { isRecord } from './values';

export interface QuestWatchedSink {
  /** What was watched before this session. Empty is nothing kept. */
  recallQuestWatched(): QuestWatched;
  /** A step was watched; keep the whole record as it stands. */
  rememberQuestWatched(watched: QuestWatched): void;
}

export const NOTHING_WATCHED: QuestWatched = {};

/** The sink for a session with nowhere to write. */
export const NO_QUEST_WATCHED: QuestWatchedSink = {
  recallQuestWatched: () => NOTHING_WATCHED,
  rememberQuestWatched: () => {}
};

/** The record as a file holds it. A row that does not read is a quest nothing was watched for. */
export function asQuestWatched(value: unknown): QuestWatched {
  if (!isRecord(value)) return NOTHING_WATCHED;
  const watched: Record<number, QuestSeen> = {};
  for (const [key, seen] of Object.entries(value)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !isRecord(seen)) continue;
    const { to, at } = seen;
    if (typeof to !== 'number' || !Number.isInteger(to)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    watched[id] = { to, at };
  }
  return watched;
}
