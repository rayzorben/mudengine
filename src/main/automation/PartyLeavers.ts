/**
 * Who left this party, and when (todo 20261023-1950-01): the realm drops a
 * held member as the leader steps off, and its `@comeback` arrives after.
 * `Remotes` asks it for the `PACING_REMOTES` only, within
 * `tuning.remotes.leftPartyMs`. See `mudengine-automation` › parts/remotes.md.
 */
export class PartyLeavers {
  /** When each left, by lower-cased name. */
  private readonly leftAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  left(who: string): void {
    this.leftAt.set(who.toLowerCase(), this.now());
  }

  joined(who: string): void {
    this.leftAt.delete(who.toLowerCase());
  }

  /** Whether `who` left within `ms`; one older than that is forgotten. */
  within(who: string, ms: number): boolean {
    const key = who.toLowerCase();
    const at = this.leftAt.get(key);
    if (at === undefined) return false;
    if (this.now() - at <= ms) return true;
    this.leftAt.delete(key);
    return false;
  }

  forget(): void {
    this.leftAt.clear();
  }
}
