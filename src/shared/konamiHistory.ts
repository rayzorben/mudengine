/**
 * What the planner's character has done, as the card's History face lists it:
 * the hunts it went on and what they paid, the levels it trained, the stat
 * points it spent, what it bought, what it wore and removed, and its
 * deaths. Read off what the realm showed (the sheet, the inventory listing,
 * the kills); a purchase is the planned item and its quoted price, once the
 * trip says it was bought. Kept per character in
 * `history.jsonl` so a restart does not forget it.
 *
 * Dependency-free like everything in `shared/`.
 */
import type { CharacterState } from './character';
import { wornItems } from './items';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from './training';

export type HistoryEvent =
  | { kind: 'huntStarted'; place: string }
  /** A hunt left, for whatever reason: how long it ran and what it paid. */
  | { kind: 'hunted'; place: string; minutes: number; exp: number | null }
  | { kind: 'levelled'; from: number; to: number }
  | { kind: 'stats'; changes: Array<{ stat: TrainedAttribute; from: number; to: number }> }
  | { kind: 'bought'; item: string; shop: string; copper: number }
  | { kind: 'wore'; item: string }
  | { kind: 'removed'; item: string }
  | { kind: 'died'; room: string | null; killers: string[] };

export interface HistoryEntry {
  at: number;
  event: HistoryEvent;
}

/**
 * What changed between two readings of the character that is worth the
 * history: the level, the trained stats, and what is worn. A worn item is
 * compared only where both readings had an inventory listing, so a listing
 * not yet read is never read as everything taken off.
 */
export function changesOf(before: CharacterState, after: CharacterState): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const was = before.progress.level;
  const now = after.progress.level;
  if (was !== null && now !== null && now > was)
    events.push({ kind: 'levelled', from: was, to: now });

  // Points spent, not any change: the sheet prints a stat with its bonus (`Player.Strength`), so
  // a ring or a curse moves it too. Only a drop in the character points left says they were spent.
  const spent =
    before.progress.cp !== null &&
    after.progress.cp !== null &&
    after.progress.cp < before.progress.cp;
  const changes = spent
    ? TRAINED_ATTRIBUTES.flatMap((stat) => {
        const from = before.progress[stat];
        const to = after.progress[stat];
        return from === null || to === null || to <= from ? [] : [{ stat, from, to }];
      })
    : [];
  if (changes.length > 0) events.push({ kind: 'stats', changes });

  if (before.inventory.listedAt !== null && after.inventory.listedAt !== null) {
    // Counted by name, so a second gold ring put on or taken off is seen.
    const worn = (state: CharacterState): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const item of wornItems(state.inventory.items)) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
      }
      return counts;
    };
    const old = worn(before);
    const fresh = worn(after);
    for (const [item, count] of fresh) {
      for (let at = old.get(item) ?? 0; at < count; at += 1) events.push({ kind: 'wore', item });
    }
    for (const [item, count] of old) {
      for (let at = fresh.get(item) ?? 0; at < count; at += 1)
        events.push({ kind: 'removed', item });
    }
  }
  return events;
}

const KINDS: ReadonlySet<string> = new Set<HistoryEvent['kind']>([
  'huntStarted',
  'hunted',
  'levelled',
  'stats',
  'bought',
  'wore',
  'removed',
  'died'
]);

/** Whether a value read back from disk is an entry of a kind this build knows. */
export function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<HistoryEntry>;
  const kind = (entry.event as { kind?: unknown } | undefined)?.kind;
  return typeof entry.at === 'number' && typeof kind === 'string' && KINDS.has(kind);
}
