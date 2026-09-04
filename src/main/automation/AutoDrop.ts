/**
 * Dropping named junk, unasked — the other half of MegaMUD's drop list.
 *
 * `AutoLoot` picks up whatever the player named; nothing shed what they did
 * not want, so a lap through a lair filled the pack until the server graded
 * the load and the walker stalled under it. This is the module that sheds:
 * the pack listing is the maintained fact it reads, and `drop <name>` is the
 * whole of what it does.
 *
 * ## What it will not drop
 *
 * - **Anything the player did not name**, unless the realm itself prices it at
 *   zero and `worthless` is on. The realm data does not mark quest items, so
 *   the `items` list stays the authority on what is junk; the one exception is
 *   bounded to a column the realm *does* state, and to its explicit zero
 *   rather than its silence — a price nobody has stated is not a price of
 *   nothing, and dropping on absence would empty a kit into the road on the
 *   first derivative realm. Names are matched by the server's own rule for a
 *   typed name (`nameAnswersTo`), because the `drop` this proposes is read by
 *   that rule on the other end.
 * - **Anything the realm marks `Not Droppable`**, whatever the price says: the
 *   server would answer that one out loud in the room.
 * - **Anything equipped.** A worn helm that happens to answer to a junk name
 *   stays on the head, whatever the list says.
 * - **Coins.** They are not `CarriedItem`s, so they cannot match; stated here
 *   because it is a promise and not an accident of the shape.
 *
 * ## When it will not drop
 *
 * - **In combat.** A command spent mid-round is one the fight paid for.
 * - **While resting**, for `AutoLoot`'s reason: whether an inventory command
 *   breaks a rest is unmeasured, and refusing costs only a delay.
 * - **Under `whenEncumbered`, until the server itself says so.** The trigger
 *   is the listing's own grading word (`Encumbrance: 840/2400 - Medium
 *   [35%]`) being anything but `None` — never a percentage this client
 *   computed, because the thresholds behind the grades are unsampled and
 *   MegaMUD's "67% is Heavy" has never been seen on this wire. An unread
 *   grade drops nothing: unknown is not encumbered, and a drop is not a
 *   thing to do on a guess.
 *
 * **One ask per item, released by the pack.** A `drop` the server refused
 * would otherwise be re-proposed on every listing — the failure that forced
 * `AutoLoot`'s once-per-room memory. Here the memory is released when the
 * name leaves the pack, so junk picked up again is junk dropped again; a
 * second copy under one name waits for the listing to say the first is gone.
 *
 * Proposes to `CommandQueue` in the `probe` band; nothing here touches a
 * socket.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { DropConfig } from '../../shared/config';
import { bareName } from '../../shared/items';
import { nameAnswersTo } from '../../shared/world';
import { tuning } from '../app/tuning';

export class AutoDrop {
  /** Names already asked to drop, lower case, until the pack stops listing them. */
  private asked = new Set<string>();

  constructor(
    private config: DropConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue
  ) {}

  configure(config: DropConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.asked.clear();
  }

  onCharacter(state: CharacterState): void {
    // The pack is the release as well as the trigger, and it is read before
    // any gate: a name no longer listed is free to be asked about again the
    // next time it is picked up, whether or not this is currently allowed to
    // act at all.
    for (const key of this.asked) {
      if (!state.inventory.items.some((item) => bareName(item.name) === key)) {
        this.asked.delete(key);
      }
    }

    if (!this.enabled || !this.config.enabled || state.phase !== 'in-game') return;
    // Either half is a reason to look: a list of names, or the realm's own
    // zero-price column. Neither on its own leaves anything to do.
    if (this.config.items.length === 0 && !this.config.worthless) return;
    if (state.inCombat) return;
    // Unmeasured rather than settled, as for AutoLoot's `get`.
    if (state.vitals.resting || state.vitals.meditating) return;
    /*
     * The server's own grading, or nothing. `encumbranceWord` is null until a
     * listing has printed one, and null is unknown — not "not encumbered" and
     * not permission.
     */
    if (this.config.whenEncumbered) {
      const word = state.inventory.encumbranceWord;
      if (word === null || word.trim().toLowerCase() === 'none') return;
    }

    for (const item of state.inventory.items) {
      // Worn, wielded or lit stays exactly where it is.
      if (item.equipped) continue;
      const carried = bareName(item.name);
      const named = this.config.items.some((name) => nameAnswersTo(carried, bareName(name)));
      /*
       * The realm's own explicit zero, and never its silence.
       *
       * `price === 0` is the realm saying the thing is worth nothing;
       * `price === undefined` is nobody having said, which on a derivative
       * realm is every item in the pack. Dropping on absence would empty a
       * character's kit into the road the first time they played somewhere
       * this client has no data for.
       *
       * `Not Droppable` is the realm refusing outright, and it outranks the
       * price — the server would answer the `drop` out loud in the room.
       */
      const worthless = this.config.worthless && item.price === 0 && item.notDroppable !== true;
      if (!named && !worthless) continue;
      if (this.asked.has(carried)) continue;
      this.asked.add(carried);
      this.queue.enqueue({
        command: `drop ${item.name}`,
        priority: 'probe',
        // One key per item name: a listing repeating is one decision, not two.
        coalesceKey: `drop:${carried}`,
        expiresAt: Date.now() + tuning().drop.expiresMs,
        reason: named
          ? t('automation.drop.reasonJunk', { item: item.name })
          : t('automation.drop.reasonWorthless', { item: item.name })
      });
    }
  }
}
