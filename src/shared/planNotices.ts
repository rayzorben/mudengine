/**
 * The end of a plan the player started: a quest run reaching its rank, a gear
 * trip or a sell run with every stop served.
 *
 * Its legs are walks nobody asked for, so `walkNotices` says nothing as they
 * land; the plan's end is the arrival the player set off for (user,
 * 2026-10-07). It is raised as `arrived`, so the Arrived row decides it. A
 * plan stopped or refused on the way says so in the console and the card.
 */
import type { GearTripProgress } from './gearTrip';
import { arrivalNotice, type Notice } from './notifications';
import type { QuestRunProgress } from './quests';

/** From the crossing into `done`, so a run standing done says it once. */
export function questRunNotices(
  before: QuestRunProgress,
  after: QuestRunProgress,
  at: number
): Notice[] {
  if (after.status !== 'done' || before.status === 'done' || after.reason === null) return [];
  return [arrivalNotice(`plan${at}`, at, after.reason)];
}

/** How a trip the player started stands at its end: a gear trip, a sell run. */
export type TripEnd = Pick<GearTripProgress, 'done' | 'ended'>;

/** From the crossing into a finished trip, read off `done` beside `ended`'s sentence. */
export function tripNotices(before: TripEnd | null, after: TripEnd | null, at: number): Notice[] {
  if (after === null || !after.done || after.ended === null || before?.done === true) return [];
  return [arrivalNotice(`plan${at}`, at, after.ended)];
}
