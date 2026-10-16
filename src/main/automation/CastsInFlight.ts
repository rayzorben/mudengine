/**
 * The casts sent and not yet answered, the player's and the client's: what
 * a sentence that names no spell can be about. `Your spell has no effect on
 * <monster>.` names none, and with two casts out it is either one's (todo
 * 131: the player's `turn grave` answered 12 ms after the client's `harm`,
 * and harm was filed as useless on every gravedigger). `AttackSpells` owns
 * one. The rules: `mudengine-automation` › `parts/combat.md` › *A spell the
 * server says has no effect is not cast again this fight*.
 */
import type { Block } from '../../shared/blocks';
import { castNamed } from '../../shared/spellcraft';

/** One cast on its way to the server, or answered by nothing yet. */
export interface CastOut {
  /** The spell as it was sent or typed. */
  spell: string;
  area: boolean;
  by: 'module' | 'player';
  at: number;
}

export class CastsInFlight {
  private out: CastOut[] = [];

  /**
   * `spellings` lists every name a cast of a spell prints under
   * (`spellingsOf`). `within` is how long a cast waits for its answer, the
   * wait an attack has (`AutoCombat.engageCooldown`): past it a cast whose
   * answer the client could not read is let go, as a refused attack is.
   */
  constructor(
    private readonly spellings: (spell: string) => readonly string[],
    private readonly within: () => number
  ) {}

  sent(cast: Omit<CastOut, 'at'>, now: number): void {
    this.out = [...this.out, { ...cast, at: now }];
  }

  /** The casts still owed an answer, oldest first. */
  unanswered(now: number): readonly CastOut[] {
    const within = this.within();
    this.out = this.out.filter((cast) => now - cast.at < within);
    return this.out;
  }

  /** The spell of the player's cast still owed an answer, or null. */
  playerCast(now: number): string | null {
    return this.unanswered(now).find((cast) => cast.by === 'player')?.spell ?? null;
  }

  /** Whether the player has a cast of `said` (any of its names) still owed an answer. */
  playerOwes(said: string, now: number): boolean {
    const name = said.trim().toLowerCase();
    return this.unanswered(now).some(
      (cast) => cast.by === 'player' && this.spellings(cast.spell).includes(name)
    );
  }

  /**
   * A line that answers a cast by naming its spell: the confirmation, the
   * fizzle or the blow. An engagement or a refusal that names no spell
   * (`spell-short-of-mana`, `target-missing`) may answer a heal or an attack
   * the client cannot tell from these, so it ends nothing: a cast let go
   * early would hand a later refusal to the one left, which is how harm was
   * blamed. The wait (`within`) bounds them instead.
   */
  heard(block: Block): void {
    const said =
      (block.type === 'spell-cast' && block.groups['caster'] === 'You') ||
      block.type === 'spell-failed'
        ? block.groups['spell']
        : block.type === 'user-hits' && block.groups['attacker'] === 'You'
          ? this.castOf(block.groups['line'])
          : undefined;
    if (said !== undefined) this.answer(said);
  }

  /** The line `You cast <spell> at …` names the spell of a cast out, or undefined. */
  private castOf(line: string | undefined): string | undefined {
    for (const cast of this.out) {
      const named = castNamed(line, this.spellings(cast.spell));
      if (named !== undefined) return named;
    }
    return undefined;
  }

  /**
   * Every cast of `said` is answered: with the player's and this client's of
   * one spell out, the line cannot say whose it is, and keeping either owed
   * would hold the fight for a cast the line may have answered.
   */
  private answer(said: string): void {
    const name = said.trim().toLowerCase();
    this.out = this.out.filter((cast) => !this.spellings(cast.spell).includes(name));
  }

  /** Every cast out is answered or let go: a refusal read for them all, or a new connection. */
  clear(): void {
    this.out = [];
  }
}
