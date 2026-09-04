/**
 * Scheduled actions — MegaMUD's Events tab, which this client had nothing for.
 *
 * `automation.routines` reacts to *state*: the realm entered, a party formed,
 * an idle stretch. What it has no notion of is a **clock**: ask for the party
 * roster every two minutes, check a lair on the hour, send a command at a
 * time of day. MegaMUD's list is log on / log off / re-log / go to / loop /
 * command; the two that dial a connection are deliberately not here — the
 * client's own autoconnect owns that (CLAUDE.md), and an event that hung up
 * would be a second thing deciding when to disconnect, which is exactly what
 * `hangUp` exists to refuse.
 *
 * So an event is: **every N seconds, or at a time of day, send this command**
 * — and the command goes through the arbiter like everything else, so it
 * queues behind an escape, waits out a half-typed line, and is coalesced by its
 * own name rather than by its text.
 */

export interface ScheduledEvent {
  /** How the player names it; also the coalesce key, so one is never queued twice. */
  name: string;
  /** What to send. The realm's own vocabulary, verbatim, like everything else. */
  command: string;
  /** Repeat every this many seconds. */
  everySeconds?: number;
  /** Or once a day at `HH:MM`, local time. */
  at?: string;
  /** Off without deleting it — MegaMUD's own "event disabled". */
  disabled?: boolean;
  /**
   * Hold while fighting, which is MegaMUD's "pause during combat" and the
   * right default: a command spent mid-round is a command the fight paid for.
   */
  inCombat?: boolean;
}

/** `HH:MM` on a 24-hour clock, or undefined. `25:00` is not a time of day. */
function readClock(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return value.trim();
}

export function asEvents(value: unknown): ScheduledEvent[] {
  if (!Array.isArray(value)) return [];
  const events: ScheduledEvent[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    const command = typeof record['command'] === 'string' ? record['command'].trim() : '';
    if (name.length === 0 || command.length === 0) continue;
    const every = record['everySeconds'];
    const at = readClock(record['at']);
    const everySeconds =
      typeof every === 'number' && Number.isFinite(every) && every > 0
        ? // Never faster than five seconds: the server acknowledges one command
          // per status line, and an event that outruns that starves everything
          // else in the queue.
          Math.max(5, Math.round(every))
        : undefined;
    // An event with no clock at all would fire once and never again, or never;
    // either way it is not what anybody meant.
    if (everySeconds === undefined && at === undefined) continue;
    events.push({
      name,
      command,
      ...(everySeconds === undefined ? {} : { everySeconds }),
      ...(at === undefined ? {} : { at }),
      ...(record['disabled'] === true ? { disabled: true } : {}),
      ...(record['inCombat'] === true ? { inCombat: true } : {})
    });
  }
  return events;
}

/**
 * Whether a timed event is due, and the time it should count from next.
 *
 * Pure, because this is the whole rule and everything around it is plumbing.
 * `last` is when it last fired (0 for never). A daily event is due when the
 * clock has passed its time and it has not fired since that time *today* —
 * so a client started at noon does not immediately fire this morning's event.
 */
export function dueAt(
  event: ScheduledEvent,
  now: number,
  last: number,
  startedAt: number
): boolean {
  if (event.disabled === true) return false;
  if (event.everySeconds !== undefined) {
    // Counted from the start when it has never fired, so an event does not
    // fire the instant a session connects.
    const since = last === 0 ? startedAt : last;
    return now - since >= event.everySeconds * 1000;
  }
  if (event.at === undefined) return false;
  const [hours, minutes] = event.at.split(':').map(Number);
  const when = new Date(now);
  when.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  const due = when.getTime();
  if (now < due) return false;
  // Already fired since today's time, or the session started after it passed.
  return last < due && startedAt < due;
}
