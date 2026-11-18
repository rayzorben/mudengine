/**
 * The wait after a step for the monsters that follow the character in.
 *
 * A monster that follows walks in behind the character, and its `moves into
 * the room from` line comes after the room and the prompt the rest was
 * decided on. Festus, 2026-11-17 (Paradigm): `rest` went out on the prompt of
 * an empty Lorthan River, a thin muck crab and two water pixies moved in
 * ahead of the server's answer, a large river eel a second later, and the
 * rest was broken by the first blow. `tuning.rest.followersMs` has the
 * measurement.
 */
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';

export class FollowersWait {
  /** The arrival last seen (`Room.arrival`), null before the first room. */
  private arrival: number | null = null;
  private until = 0;

  /**
   * Every changed state. The first room seen was not stepped into, so
   * nothing is waited for there.
   */
  note(state: CharacterState, now: number): void {
    const { arrival } = state.room;
    if (arrival === this.arrival) return;
    if (this.arrival !== null) this.until = now + tuning().rest.followersMs;
    this.arrival = arrival;
  }

  /** Whether what followed the last step may still be on its way in. */
  awaited(now: number): boolean {
    return now < this.until;
  }

  reset(): void {
    this.arrival = null;
    this.until = 0;
  }
}
