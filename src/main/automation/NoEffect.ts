/**
 * The monsters the server said the weapon in hand cannot hurt (todo 46):
 * `Your weapon has no effect against this monster!` opens no fight
 * (`AttackCommand.cs:467-489`), so the same attack sent again earns the same
 * line. Kept per monster against the weapon that was in hand, and answered
 * only while that weapon still is. The wire outranks the realm's rows, so
 * this decides where `weaponReach` says `hurts` or `unknown`.
 */
import { mobKey } from '../../shared/world';

export class NoEffect {
  /** `monster|weapon` pairs, so each hand refused stays refused. */
  private readonly refused = new Set<string>();

  /** The server refused `target` with `weapon` in hand (null: the bare hand). */
  heard(target: string, weapon: string | null): void {
    this.refused.add(pair(target, weapon));
  }

  /** Whether the server has refused `target` with this same hand. */
  refuses(target: string, weapon: string | null): boolean {
    return this.refused.has(pair(target, weapon));
  }

  reset(): void {
    this.refused.clear();
  }
}

function pair(target: string, weapon: string | null): string {
  return `${mobKey(target)}|${weapon?.toLowerCase() ?? ''}`;
}
