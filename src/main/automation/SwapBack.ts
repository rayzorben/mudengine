/**
 * Whether the fighting weapon is back in hand after a bless weapon was wielded
 * from the pack for its `use` (todo 42), and saying so when it is not. The
 * swap-back can fail (the weapon dropped or stolen, `You may not wear that
 * item!`), and a character must never fight on with the bless weapon without
 * the player knowing. Reads the pack's hand only; `AutoInvoke` arms it.
 */
import type { CharacterState } from '../../shared/character';
import { heldWeapon } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

export interface SwapBackEvents {
  notice?(message: string): void;
}

interface Armed {
  bless: string;
  /** What goes back on: the weapon that was in hand, else the off-hand a two-hander took off. */
  back: string;
  /** Whether any of the swap's commands still waits in the queue. */
  inQueue: () => boolean;
  /** Whether the swap's first command went out, taking `back` out of hand. */
  begun: boolean;
  /** When the swap's last command went out; null until it has. */
  backSentAt: number | null;
}

export class SwapBack {
  private armed: Armed | null = null;

  constructor(
    private readonly events: SwapBackEvents,
    private readonly now: () => number
  ) {}

  /** A swap is under way: nothing else is wielded until it settles. */
  get pending(): boolean {
    return this.armed !== null;
  }

  /** A swap was queued, so no second one is queued behind it. */
  queued(bless: string, back: string, inQueue: () => boolean): void {
    this.armed = { bless, back, inQueue, begun: false, backSentAt: null };
  }

  /** The swap's first command went out. */
  begun(): void {
    if (this.armed !== null) this.armed = { ...this.armed, begun: true };
  }

  /** The swap's last command went out. */
  backSent(): void {
    if (this.armed !== null) this.armed = { ...this.armed, backSentAt: this.now() };
  }

  reset(): void {
    this.armed = null;
  }

  /**
   * On every state change. Ended by the queue, never by a clock of its own:
   * forgotten when nothing of a swap whose first command never went is still
   * queued, settled when `back` is in hand after the last command went. Said
   * once when the commands putting `back` were dropped from the queue, or
   * `swapBackMs` passes after they went with `back` not in hand.
   */
  check(state: CharacterState): void {
    const armed = this.armed;
    if (armed === null || state.inventory.listedAt === null) return;
    if (!armed.begun) {
      // The first command was dropped (a fight, the round's cast spent,
      // expired): nothing left the hand, so there is nothing to put back.
      if (!armed.inQueue()) this.armed = null;
      return;
    }
    const held = heldWeapon(state.inventory.items);
    const backInHand = state.inventory.items.some(
      (item) => item.equipped && sameItem(item.name, armed.back)
    );
    if (armed.backSentAt === null) {
      // Still on its way, behind whatever a fight queued first.
      if (armed.inQueue()) return;
    } else if (backInHand) {
      this.armed = null;
      return;
    } else if (this.now() - armed.backSentAt < tuning().spells.swapBackMs) return;
    this.armed = null;
    this.events.notice?.(
      t('automation.invoke.notPutBack', {
        weapon: armed.back,
        held: held?.name ?? t('automation.invoke.emptyHand'),
        item: armed.bless
      })
    );
  }
}
