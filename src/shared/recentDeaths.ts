/**
 * One row of the realm's `Recent Deaths:` listing, which `death` prints alone
 * and `pro` prints last (`DeathsCommand.cs`, `ProfileCommand.cs`):
 *
 *     Recent Deaths:
 *     9/9/2026 9:55 PM - Festus - 1/2372
 *
 * The row is captured on Paradigm (`pro`, 2026-09-12); `None! :)` stands in
 * for the rows when there are none (the server's source). The date is the
 * server's `ToShortDateString`, read month first as `en-US` writes it and as
 * the user's example has it; the one captured row (`9/9`) cannot show the
 * order, so a day-first host is unmeasured.
 * `@death` answers from these (`DeathsRemote`).
 *
 * Dependency-free like everything in `shared/`.
 */
import { figure } from './values';

export interface RecentDeath {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** `AM` or `PM`, or null on a realm that prints the 24-hour clock. */
  half: 'AM' | 'PM' | null;
  map: number;
  room: number;
}

/**
 * A `user-recent-death` block's groups as a row, or null for `None! :)` and
 * anything short. The killer is in the groups and is not kept: nothing reads it.
 */
export function readRecentDeath(groups: Readonly<Record<string, string>>): RecentDeath | null {
  const [year, month, day, hour, minute, map, room] = [
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'map',
    'room'
  ].map((key) => figure(groups[key]));
  if (
    year == null ||
    month == null ||
    day == null ||
    hour == null ||
    minute == null ||
    map == null ||
    room == null
  )
    return null;
  const half = groups['half'] === 'AM' || groups['half'] === 'PM' ? groups['half'] : null;
  return { year, month, day, hour, minute, half, map, room };
}
