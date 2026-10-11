/**
 * One realm's unread lines, by shape (todo 73). Kept for the life of the
 * process and shared by every character on the realm; nothing is written to
 * disk. Bounded by `tuning.session.unreadShapes`: past it the shape seen
 * longest ago goes, so a realm full of one-off lines cannot grow it without
 * end. `mudengine-wire` › *Develop patterns from captures* has the offline half.
 */
import type { Block } from '../../shared/blocks';
import { shapeOf, unreadKind, type RealmUnread, type UnreadLine } from '../../shared/unread';
import { tuning } from '../app/tuning';

export class UnreadTally implements RealmUnread {
  /** Keyed on kind and shape; insertion order is recency, oldest first. */
  private readonly lines = new Map<string, UnreadLine>();

  observe(block: Block, room: UnreadLine['room'], at: number): void {
    const kind = unreadKind(block);
    if (kind === null) return;
    const text = block.text.trim();
    if (text.length === 0) return;
    const message = kind === 'realm-message' ? Number(block.groups['message']) : null;
    const shape = shapeOf(text);
    const key = `${kind}\u0000${shape}`;
    const held = this.lines.get(key);
    // Taken out and put back, so the Map's order stays the order last seen.
    this.lines.delete(key);
    this.lines.set(key, {
      kind,
      shape,
      sample: text,
      count: (held?.count ?? 0) + 1,
      message: message !== null && Number.isInteger(message) ? message : null,
      room,
      firstAt: held?.firstAt ?? at,
      lastAt: at
    });
    const limit = tuning().session.unreadShapes;
    for (const oldest of this.lines.keys()) {
      if (this.lines.size <= limit) break;
      this.lines.delete(oldest);
    }
  }

  list(): UnreadLine[] {
    return [...this.lines.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  }
}
