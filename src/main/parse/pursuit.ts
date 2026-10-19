/**
 * Which monsters followed the character from room to room (todo
 * 20261018-1314-02). On a step, a monster fighting the character rolls its
 * `Follow%` and, if it follows, walks in from the way the character came:
 * `<name> moves into the room from the <direction>.` (`Exits.cs:165-184`,
 * `Mob.GetMobFollowMessage`). It keeps tracking for 30 s (`Mob.CheckFollow`).
 * A wandering monster prints the same line, so a follow is a fighter of that
 * name walking in from the way back inside that window, and nothing else.
 */
import type { Block } from '../../shared/blocks';
import { asSpokenDirection, mobKey, OPPOSITE, type Direction } from '../../shared/world';
import { moverName } from './movers';

interface Parked<T> {
  value: T;
  /** The way back from the character's latest step: where a follower walks in from. */
  from: Direction;
  until: number;
}

export class Pursuit<T> {
  private readonly parked = new Map<string, Parked<T>>();

  /** Sets aside what a monster that may follow this step carried. */
  park(key: string, value: T, moved: Direction, until: number): void {
    this.parked.set(key, { value, from: OPPOSITE[moved], until });
  }

  /**
   * Another step: a monster still tracking is now expected from its way back,
   * and one past its window, or a step with no way back, is let go and
   * returned, so its fight can be written down.
   */
  stepped(moved: Direction | null, at: number): T[] {
    const gone: T[] = [];
    for (const [key, one] of this.parked) {
      if (moved !== null && at <= one.until) one.from = OPPOSITE[moved];
      else {
        this.parked.delete(key);
        gone.push(one.value);
      }
    }
    return gone;
  }

  /** What a parked monster carried, when this block is it walking in from the way back in time. */
  arrived(block: Pick<Block, 'type' | 'text' | 'groups' | 'at'>): { key: string; value: T } | null {
    if (block.type !== 'mob-arrives-room') return null;
    const from = asSpokenDirection(block.groups['direction'] ?? '');
    if (from === null) return null;
    const key = mobKey(moverName(block.groups));
    const one = this.parked.get(key);
    if (one === undefined || one.from !== from || block.at > one.until) return null;
    this.parked.delete(key);
    return { key, value: one.value };
  }

  /** Lets go of every parked monster whose window has passed, returned. */
  expired(at: number): T[] {
    const gone: T[] = [];
    for (const [key, one] of this.parked)
      if (at > one.until) {
        this.parked.delete(key);
        gone.push(one.value);
      }
    return gone;
  }

  /** Lets every parked monster go, unrecorded: the session is over, as the ledgers are. */
  clear(): void {
    this.parked.clear();
  }
}
