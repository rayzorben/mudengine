/**
 * The time a kill costs outside its rounds (todo 124): the wait from
 * `*Combat Engaged*` to this character's first swing, and the gap from the
 * last kill in the room to the next engagement. An engagement starts with a
 * full round's energy (`combatEngageStartEnergy`), so the first swing comes
 * before the room's next round; Festus on paramud waited 2.1 s on average
 * over 10,355 fights, and a round is 5 s. `mudengine-world` › parts/hunting.md.
 */
import type { FightRecord } from '../../shared/fights';
import type { RoomId } from '../../shared/world';

/** The two timings a record carries, each absent where it was not seen. */
export type FightTiming = Pick<FightRecord, 'engageMs' | 'afterKillMs'>;

export class FightClock {
  private engagedAt: number | null = null;
  private engagedIn: RoomId | null = null;
  private swungAt: number | null = null;
  private lastKill: { at: number; room: RoomId } | null = null;

  /** `*Combat Engaged*` with no fight running: a new engagement. */
  engage(at: number, room: RoomId | null): void {
    this.engagedAt = at;
    this.engagedIn = room;
    this.swungAt = null;
  }

  /** This character swung, hit or miss; only the first swing of an engagement counts. */
  swung(at: number): void {
    if (this.engagedAt !== null && this.swungAt === null) this.swungAt = at;
  }

  /**
   * The engagement's timings, handed once to the fight it opened, and the
   * engagement forgotten. The gap after a kill counts only in the kill's room
   * and up to `gapMostMs`, so a rest or a walk between is not looting.
   */
  take(gapMostMs: number): FightTiming {
    const engagedAt = this.engagedAt;
    const timing: FightTiming = {};
    if (engagedAt !== null && this.swungAt !== null && this.swungAt >= engagedAt) {
      timing.engageMs = this.swungAt - engagedAt;
    }
    const kill = this.lastKill;
    if (engagedAt !== null && kill !== null && kill.room === this.engagedIn) {
      const gap = engagedAt - kill.at;
      if (gap >= 0 && gap <= gapMostMs) timing.afterKillMs = gap;
    }
    this.engagedAt = null;
    this.engagedIn = null;
    this.swungAt = null;
    // One gap a kill: a fight that ends with no kill does not stretch the next one's.
    if (engagedAt !== null) this.lastKill = null;
    return timing;
  }

  /** A kill settled in `room`; an unplaced room starts no gap. */
  killed(at: number, room: RoomId | null): void {
    this.lastKill = room === null ? null : { at, room };
  }

  /** The character left the realm: nothing carries over. */
  forget(): void {
    this.engagedAt = null;
    this.engagedIn = null;
    this.swungAt = null;
    this.lastKill = null;
  }
}
