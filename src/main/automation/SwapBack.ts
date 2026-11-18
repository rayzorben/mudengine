/**
 * Whether the fighting weapon is back in hand after a bless weapon was wielded
 * from the pack for its `use` (todo 42), or the armour back on after bless
 * armour took its slot, and saying so when it is not. The swap-back can fail
 * (the item dropped or stolen, `You may not wear that item!`), and a
 * character must never fight on in the bless item without the player
 * knowing. Reads the pack's worn items only; `AutoInvoke` arms it.
 */
import type { CharacterState } from '../../shared/character';
import { heldWeapon } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { NoticeSink } from '../../shared/decisionSettings';

export interface SwapBackEvents {
  notice?: NoticeSink;
}

interface Armed {
  bless: string;
  /**
   * What goes back on: the weapon that was in hand, else the off-hand a
   * two-hander took off, else the armour that was in the bless armour's slot.
   */
  back: string;
  /** Everything the swap takes off or could take off, all worn again when it has settled. */
  kept: readonly string[];
  /** Whether the swap took the weapon hand, which a fight may ask for. */
  hand: boolean;
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
  queued(
    bless: string,
    back: string,
    kept: readonly string[],
    hand: boolean,
    inQueue: () => boolean
  ): void {
    this.armed = { bless, back, kept, hand, inQueue, begun: false, backSentAt: null };
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
   * Ends a weapon swap's watch, giving the weapon to put back where the
   * swap's first command went. An armour swap is not the hand's and stays.
   */
  handOver(): string | null {
    const armed = this.armed;
    if (armed !== null && !armed.hand) return null;
    this.armed = null;
    return armed?.begun === true ? armed.back : null;
  }

  /**
   * On every state change. Ended by the queue, never by a clock of its own:
   * forgotten when nothing of a swap whose first command never went is still
   * queued, settled when all of `kept` is worn after the last command went. Said
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
    const off = armed.kept.find(
      (name) => !state.inventory.items.some((item) => item.equipped && sameItem(item.name, name))
    );
    if (armed.backSentAt === null) {
      // Still on its way, behind whatever a fight queued first.
      if (armed.inQueue()) return;
    } else if (off === undefined) {
      this.armed = null;
      return;
    } else if (this.now() - armed.backSentAt < tuning().spells.swapBackMs) return;
    this.armed = null;
    const missing = off ?? armed.back;
    this.events.notice?.(
      armed.hand && missing === armed.back
        ? t('automation.invoke.notPutBack', {
            weapon: missing,
            held: held?.name ?? t('automation.invoke.emptyHand'),
            item: armed.bless
          })
        : t('automation.invoke.notWornBack', { back: missing, item: armed.bless }),
      'swap-back-check'
    );
  }
}
