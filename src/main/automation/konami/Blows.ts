/**
 * Every blow that landed on the character lately, for the death log's
 * predicted-against-taken comparison (todo 57): what the brief said a round
 * beside each monster costs, next to what the lines say it did.
 *
 * Read off the same blocks `HangUp` reads: `user-hits` with `you` as the
 * target (the attacker named by the line), `mob-hits` (a monster's blow the
 * line names no caster for) and `user-takes-damage` (a trap, a room, a spell
 * with no attacker).
 */
import type { Block } from '../../../shared/blocks';
import type { KonamiBlow } from '../../../shared/konamiRecords';

/**
 * `The fierce bandit slashes you for 7 damage!`: the words before the verb,
 * without the article, and at most three of them, as a monster's name is.
 * `A dark beam shoots forth and drains you` is a spell, and names nobody.
 */
const BY_GRAMMAR = /^(?:(?:The|A|An) )?((?:[\w'-]+ ){0,2}[\w'-]+) \S+ you\b/;

/**
 * Who landed a blow on the character: the classifier's name where it found
 * one, else the line's own words before the verb. A monster the realm names
 * with a word in front (`fierce bandit`) is not in the classifier's table, and
 * the death log listed every blow of the fight as nobody's.
 */
function attackerOf(block: Block): string | null {
  const named = block.groups['attacker'];
  if (named !== undefined) return named.replace(/^(?:The|A|An) /, '');
  return BY_GRAMMAR.exec(block.text)?.[1] ?? null;
}

export class Blows {
  private readonly kept: KonamiBlow[] = [];

  /** `size` is `tuning.konami.blowsKept`: several long fights; a death log needs the last one. */
  constructor(private readonly size: () => number) {}

  onBlock(block: Block): void {
    const damage = Number(block.groups['damage']);
    if (!Number.isFinite(damage)) return;
    switch (block.type) {
      case 'user-hits': {
        const target = block.groups['target'];
        if (target === undefined || !/^you$/i.test(target)) return;
        this.add({ at: block.at, from: attackerOf(block), damage, text: block.text });
        return;
      }
      case 'mob-hits':
      case 'user-takes-damage':
        this.add({ at: block.at, from: null, damage, text: block.text });
        return;
      default:
        return;
    }
  }

  /** The blows since `since`, oldest first. */
  since(since: number): KonamiBlow[] {
    return this.kept.filter((blow) => blow.at >= since);
  }

  reset(): void {
    this.kept.length = 0;
  }

  private add(blow: KonamiBlow): void {
    this.kept.push(blow);
    const over = this.kept.length - this.size();
    if (over > 0) this.kept.splice(0, over);
  }
}
