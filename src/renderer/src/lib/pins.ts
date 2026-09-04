import { pinnedMatches } from '@shared/internal';

/**
 * Which palette commands sit in the pinned section at the top.
 *
 * Two sources, exactly like the density and theme toggles: `internal.yaml`
 * ships a shelf worth having on the first launch, and a click on any row's pin
 * outranks it. Neither alone is enough — a shipped list that could not be
 * changed makes somebody edit YAML to move one command, and a stored list that
 * always won would make an edit to the file silently do nothing forever after
 * the first click.
 *
 * The rule is therefore the one {@link resolveOverride} already encodes for a
 * single preference, applied per command: **a deviation is stored against the
 * file's answer at the time it was made**, and it is spent the moment the file
 * changes its mind about that command. Comparing against the last render
 * cannot do it — the file arrives over IPC after the first paint — and a bare
 * remembered list could not say what it deviated from at all.
 */
export interface PinDeviation {
  /** What the click asked for. */
  pinned: boolean;
  /** What the file said about this command when the click was made. */
  against: boolean;
}

export type PinDeviations = Readonly<Record<string, PinDeviation>>;

/** Just enough of a command to answer both questions. */
export interface PinnableCommand {
  id: string;
  group?: string;
}

/**
 * The shelf as the file states it: every command whose group lists a pattern
 * naming it. Keyed by the command's *own* group, so a pattern filed under the
 * wrong heading names nothing — which is what silently happened to `search`,
 * listed under `view` while the command has always been a `navigate` one.
 */
export function shippedPins(
  patterns: Record<string, string[]>,
  commands: readonly PinnableCommand[]
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const command of commands) {
    if (command.group === undefined) continue;
    const stated = patterns[command.group] ?? [];
    if (stated.some((pattern) => pinnedMatches(pattern, command.id))) ids.add(command.id);
  }
  return ids;
}

/**
 * What was clicked, from whatever `localStorage` holds.
 *
 * Untrusted: a person can edit it by hand and an older build may have written
 * something else entirely. Every malformed entry is dropped individually
 * rather than the whole record being thrown away, because one bad row must not
 * cost somebody the rest of their shelf.
 */
export function readDeviations(stored: string | null): PinDeviations {
  if (stored === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const kept: Record<string, PinDeviation> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const { pinned, against } = value as { pinned?: unknown; against?: unknown };
    if (typeof pinned !== 'boolean' || typeof against !== 'boolean') continue;
    kept[id] = { pinned, against };
  }
  return kept;
}

/** Whether this command is pinned, given what the file says about it now. */
export function isPinned(id: string, shipped: boolean, deviations: PinDeviations): boolean {
  const deviation = deviations[id];
  if (deviation === undefined) return shipped;
  // The file has changed its mind since the click, so the edit wins.
  if (deviation.against !== shipped) return shipped;
  return deviation.pinned;
}

/**
 * The deviations after a pin or an unpin.
 *
 * A choice that agrees with the file again is *removed* rather than recorded:
 * a stored entry saying the same thing as the shelf is one that would go on
 * outranking the shelf after the next edit to it, which is the trap in reverse.
 */
export function withPin(
  deviations: PinDeviations,
  id: string,
  shipped: boolean,
  pinned: boolean
): PinDeviations {
  const next: Record<string, PinDeviation> = { ...deviations };
  if (pinned === shipped) delete next[id];
  else next[id] = { pinned, against: shipped };
  return next;
}

/** The whole shelf: the file's answer for each command, as deviated from. */
export function resolvePins(
  patterns: Record<string, string[]>,
  commands: readonly PinnableCommand[],
  deviations: PinDeviations
): ReadonlySet<string> {
  const shipped = shippedPins(patterns, commands);
  const ids = new Set<string>();
  for (const command of commands) {
    if (isPinned(command.id, shipped.has(command.id), deviations)) ids.add(command.id);
  }
  return ids;
}
