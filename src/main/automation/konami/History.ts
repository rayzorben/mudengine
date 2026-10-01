/**
 * The planner's history of what its character did (`shared/konamiHistory.ts`):
 * compared against the last reading on every line, a hunt started and left
 * timed off the goal's activity, deaths and purchases told to it by the
 * planner. Keeps the newest `tuning.konami.historyShown` and writes each line
 * to the records, as `Journal` keeps the decisions.
 */
import type { CharacterState } from '../../../shared/character';
import type { KonamiGoal } from '../../../shared/konami';
import { changesOf, type HistoryEntry, type HistoryEvent } from '../../../shared/konamiHistory';
import type { KonamiActivity, KonamiRecords } from '../../../shared/konamiRecords';

export class History {
  private readonly entries: HistoryEntry[];
  /** The last reading compared against. */
  private lastSeen: CharacterState | null = null;
  /** The hunt the character is at, since when, and its experience then. */
  private huntedAt: { place: string; at: number; exp: number | null } | null = null;

  constructor(
    private readonly records: KonamiRecords | null,
    private readonly kept: () => number,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now
  ) {
    this.entries = (records?.history() ?? []).slice(-kept());
  }

  /** Newest first, for the card. */
  newestFirst(): HistoryEntry[] {
    return [...this.entries].reverse();
  }

  /**
   * One reading: what changed since the last (`changesOf`), and a hunt started
   * or left. Out of the realm or not running, a hunt in hand is closed and
   * nothing is compared, so a stretch the planner did not run is no change.
   */
  watch(state: CharacterState, running: boolean, activity: KonamiActivity | null): void {
    const before = this.lastSeen;
    this.lastSeen = state;
    if (!running || state.phase !== 'in-game') {
      this.leaveHunt(state);
      this.lastSeen = null;
      return;
    }
    const moved =
      before !== null &&
      before.phase === 'in-game' &&
      (before.progress !== state.progress || before.inventory !== state.inventory);
    if (moved) for (const event of changesOf(before, state)) this.note(event);
    const doing = activity?.doing;
    const place = doing?.kind === 'hunt' && !doing.walking ? doing.place : null;
    if (this.huntedAt?.place === place) return;
    this.leaveHunt(state);
    if (place === null) return;
    this.huntedAt = { place, at: this.now(), exp: state.progress.exp };
    this.note({ kind: 'huntStarted', place });
  }

  died(room: string | null, killers: string[]): void {
    this.note({ kind: 'died', room, killers });
  }

  bought(goal: Extract<KonamiGoal, { kind: 'buy' }>): void {
    this.note({ kind: 'bought', item: goal.name, shop: goal.shop, copper: goal.copper });
  }

  /** The hunt in hand, closed with how long it ran and what it paid. */
  private leaveHunt(state: CharacterState): void {
    const hunt = this.huntedAt;
    if (hunt === null) return;
    this.huntedAt = null;
    const { exp } = state.progress;
    this.note({
      kind: 'hunted',
      place: hunt.place,
      minutes: Math.round((this.now() - hunt.at) / 60_000),
      exp: exp === null || hunt.exp === null ? null : exp - hunt.exp
    });
  }

  private note(event: HistoryEvent): void {
    const entry = { at: this.now(), event };
    this.entries.push(entry);
    const kept = this.kept();
    if (this.entries.length > kept) this.entries.splice(0, this.entries.length - kept);
    this.records?.historyLine(entry);
    this.changed();
  }
}
