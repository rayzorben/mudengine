/**
 * Counts this character's own casts and swings in each round, for the realm's
 * lore (todos 121, 123). The server writes a round's lines together, so a line
 * of the character's after the quiet that opens a round (`roundQuietMs`)
 * opens the next. A round is counted only once the next opens on the same
 * target, so the round that killed it or ended the fight never is: a party's
 * kill before the second cast would read as one cast. Swings count in a round
 * within a round and a half of the last on that target (never a fight's
 * first), at the swings the sheet states for the attack fought with
 * (`swingKey`); a round of more than `MAX_SWINGS` is two read as one, and a
 * round with lines at two targets is not one attack's, so both are left out. See `mudengine-automation` › parts/combat.md › *A round is priced
 * at what the realm does in one*.
 */
import type { Block } from '../../shared/blocks';
import { MAX_SWINGS } from '../../shared/prowess';
import { swingKey, type RoundLore } from '../../shared/rounds';
import { spellKey } from '../../shared/spell-messages';
import { castLine } from '../../shared/spellcraft';
import { mobKey } from '../../shared/world';
import type { SessionModule } from './Module';
import { roundMsAt, roundQuietMs } from './RoundBeat';

export interface RoundCountParts {
  lore: Pick<RoundLore, 'observeRound'>;
  /** The realm's speed (`RealmSpeed`). */
  speed(): number;
  /** The attack fought with, and the swings a round the sheet states for it; null where it states none. */
  swinging(): { kind: string; stated: number } | null;
  /** What the character is fighting, for a failed cast that names nothing; null for nothing. */
  fighting(): string | null;
  /** The realm's name of the book's spell a landed cast's line names (`castNamed`); null for none. */
  spellIn(line: string): string | null;
}

interface Round {
  /** The target, by `mobKey`. */
  target: string;
  /** The character's last line in it. */
  last: number;
  /** Casts by spell (`spellKey`), failed ones too: each spends the round's energy. */
  casts: Map<string, number>;
  swings: number;
  /** What the swings are counted at (`swingKey`); null where they are not counted. */
  swingAt: string | null;
  /** A line at another target too, or a cast nothing names: the round is not one attack's. */
  mixed: boolean;
}

/** `You`, as the server names the character to itself. */
const isYou = (name: string | undefined): boolean => name !== undefined && /^you$/i.test(name);

export class RoundCount implements SessionModule {
  private round: Round | null = null;

  constructor(private readonly parts: RoundCountParts) {}

  onBlock(block: Pick<Block, 'type' | 'at' | 'groups'>): void {
    const g = block.groups;
    switch (block.type) {
      case 'user-hits':
        if (isYou(g['attacker']) && g['target'] !== undefined && !isYou(g['target'])) {
          this.mine(block.at, g['target'], this.castIn(g['line']));
        }
        return;
      case 'user-misses':
        if (g['target'] !== undefined) this.mine(block.at, g['target'], undefined);
        return;
      case 'spell-failed': {
        const target = g['target'] ?? this.parts.fighting();
        if (g['spell'] !== undefined && target !== null) this.mine(block.at, target, g['spell']);
        return;
      }
      // `*Combat Engaged*` or `*Combat Off*`: the round open cannot be shown to have been lived through.
      case 'combat-status':
        this.round = null;
        return;
      default:
        return;
    }
  }

  reset(): void {
    this.round = null;
  }

  /** A blow (undefined), a cast of a spell, or a cast nothing in the book names (null). */
  private castIn(line: string | undefined): string | null | undefined {
    const cast = castLine(line);
    return cast === null ? undefined : this.parts.spellIn(cast);
  }

  /** One of the character's own lines at `target`: a cast of `spell`, a swing, or (null) a cast unread. */
  private mine(at: number, target: string, spell: string | null | undefined): void {
    const key = mobKey(target);
    let round = this.round;
    if (round === null || at - round.last > roundQuietMs(this.parts.speed())) {
      round = this.open(at, key, round);
    }
    round.last = at;
    // At another target too (a room spell, a switch), or a cast unread: not one attack's round.
    if (key !== round.target || spell === null) round.mixed = true;
    if (spell === null) return;
    if (spell === undefined) round.swings += 1;
    else round.casts.set(spellKey(spell), (round.casts.get(spellKey(spell)) ?? 0) + 1);
  }

  /** The next round opens at `at` on `target`: the one before is counted if its target lived on. */
  private open(at: number, target: string, before: Round | null): Round {
    const lived = before !== null && before.target === target;
    if (lived) this.count(before);
    const steady = lived && at - before.last <= 1.5 * roundMsAt(this.parts.speed());
    const swinging = steady ? this.parts.swinging() : null;
    this.round = {
      target,
      last: at,
      casts: new Map(),
      swings: 0,
      mixed: false,
      swingAt: swinging === null ? null : swingKey(swinging.kind, swinging.stated)
    };
    return this.round;
  }

  private count(round: Round): void {
    if (round.mixed) return;
    for (const [spell, casts] of round.casts) this.parts.lore.observeRound('casts', spell, casts);
    if (round.swingAt !== null && round.swings > 0 && round.swings <= MAX_SWINGS) {
      this.parts.lore.observeRound('swings', round.swingAt, round.swings);
    }
  }
}
