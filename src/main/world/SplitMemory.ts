import type { Discovery } from '../../shared/memory';
import type { RealmMemory } from '../session/SessionManager';
import type { WorldMemory } from './WorldMemory';

/**
 * One character's memory, with the parts that belong to the *realm* shared.
 *
 * `WorldMemory` is one file per character, and for an **exit** that is right:
 * a character that has been down a corridor knows something a second character
 * has not been, and the record is of that character's own exploration.
 *
 * A shop's stock is not exploration. That a counter in Godfrey sells black
 * plate leggings the realm data does not list is a fact about the *world*, in
 * the same way a giant rat's health is — and `RealmLore` and `PlayerBook` both
 * already keep that kind of fact once per realm rather than once per character.
 * Kept per character it is re-learned by every character in turn, each spending
 * the `list` that teaches it and each announcing the same three lines.
 *
 * So the two go to two stores, and this routes between them. It is a router and
 * not a third store: neither half's file format, de-duplication, cap or write
 * scheduling changes, and `WorldMemory` is untouched by the split.
 *
 * **`all` concatenates, character-first.** Every reader of it — the Room card's
 * `Found` face, the `learned` push — asks *what has been learned about this
 * realm*, and the answer is both halves. Nothing downstream needs to know which
 * file a row came from, and `forget` finds it in whichever holds it, because a
 * row struck out from a card must go from the file it is actually in.
 */
export class SplitMemory implements RealmMemory {
  /**
   * @param own This character's own record: exits, and rooms the realm has no
   *   name for.
   * @param shared The realm's record, one file for every character dialling it:
   *   what shops turn out to stock.
   */
  constructor(
    private readonly own: WorldMemory,
    private readonly shared: WorldMemory
  ) {}

  /** Which store a discovery belongs in. The one decision this class makes. */
  private storeFor(reason: Discovery['reason']): WorldMemory {
    return reason === 'unknown-stock' ? this.shared : this.own;
  }

  learn(discovery: Discovery): Discovery | null {
    return this.storeFor(discovery.reason).learn(discovery);
  }

  /*
   * Both are asked, and the `||` is deliberately not short-circuiting away a
   * needed call: `forget` returns false when it held nothing, so asking the
   * store that does not have it costs a `Set` miss. Keying is by room and
   * command, and the two stores hold disjoint reasons, so a key cannot be in
   * both — but asking both is what keeps that from being an assumption this
   * method would break silently if the split ever moved.
   */
  forget(key: string): boolean {
    const fromOwn = this.own.forget(key);
    const fromShared = this.shared.forget(key);
    return fromOwn || fromShared;
  }

  get all(): readonly Discovery[] {
    return [...this.own.all, ...this.shared.all];
  }
}
