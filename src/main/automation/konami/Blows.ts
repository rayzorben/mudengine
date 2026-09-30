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
        this.add({
          at: block.at,
          from: block.groups['attacker'] ?? null,
          damage,
          text: block.text
        });
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
