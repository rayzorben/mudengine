/**
 * Banking the purse, unasked — MegaMUD's StashCoin.
 *
 * Coins carried are coins a death can scatter and weight the walker carries;
 * coins on deposit are neither. What this does is exactly what the Room
 * card's Deposit All button does, minus keeping `keepCopper` back for tolls
 * and shops, fired by standing at a counter with a purse over the threshold
 * instead of by a press.
 *
 * ## The three facts it acts on, and where each comes from
 *
 * - **The purse is the maintained listing's figure** (`inventory.wealth`) —
 *   the server's own copper total, kept true by the deposit and withdrawal
 *   sentences. It can drift in either direction (coins out of a chest, a
 *   toll, arrive with nothing on the wire announcing them), which is why the
 *   `i` goes out ahead of each ask, exactly as the button sends one: the
 *   listing restates the purse, and a corrected figure frees a corrected
 *   ask. An unread purse deposits nothing — unknown is not rich, and a
 *   `deposit` composed from an absence is a command sent on a guess.
 * - **The counter is the resolved room's own shop** — `WorldRoom.shop` at the
 *   coordinates the character actually stands, graded `bank` by the realm.
 *   The resolved room, not the room's name: thirteen rooms can share a name,
 *   and a deposit typed outside a bank is a command said out loud.
 * - **The verb is the sampled one.** `deposit <n>`, a number in copper —
 *   `depo 10000` answered `You deposit 10000 copper farthings.` live
 *   (todo/archive/23); `dep all` has never been seen on this wire and is not
 *   sent. A `bank` goes out behind it, exactly as the button sends one: the
 *   first deposit at an unasked vault has no figure to maintain, and one
 *   command establishes it while every later deposit keeps it true for free.
 *
 * Never in combat, and one ask per cooldown: the deposit sentence is what
 * moves the purse, and a status line arriving before it would otherwise
 * propose the same deposit again. `probe` band; nothing here touches a
 * socket.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { BankingConfig } from '../../shared/config';
import { tuning } from '../app/tuning';

export class AutoDeposit {
  private lastAt = 0;
  /**
   * The purse figure the last ask was composed from. A deposit the server
   * refused moves nothing, so re-asking on an unchanged figure would send the
   * identical refused command once per cooldown for as long as the character
   * stands at the counter — the `i` in front of each ask is what changes the
   * figure when it was wrong, and the changed figure is what earns a fresh
   * ask.
   */
  private askedAtWealth: number | null = null;

  constructor(
    private config: BankingConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    /** Whether the resolved room the character stands in is a bank counter. */
    private readonly atBank: (state: CharacterState) => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: BankingConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.lastAt = 0;
    this.askedAtWealth = null;
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.autoDeposit || state.phase !== 'in-game') return;
    if (state.inCombat) return;
    // Unmeasured rather than settled, as for AutoLoot's `get`: whether an
    // inventory command breaks a rest has never been asked of the wire, and
    // refusing costs only a delay.
    if (state.vitals.resting || state.vitals.meditating) return;

    const wealth = state.inventory.wealth;
    // Unknown is not rich: no listing has stated a purse, so nothing is
    // composed from it.
    if (wealth === null) return;
    if (wealth <= this.config.depositThresholdCopper) return;
    const surplus = wealth - this.config.keepCopper;
    if (surplus <= 0) return;

    if (!this.atBank(state)) return;

    const at = this.now();
    if (at - this.lastAt < tuning().banking.cooldownMs) return;
    if (wealth === this.askedAtWealth) return;
    this.lastAt = at;
    this.askedAtWealth = wealth;

    const expiresAt = at + tuning().banking.expiresMs;
    /*
     * The Deposit All button's own sequence, whole: `i`, the deposit, `bank`.
     * The `i` first because the maintained purse can drift in either
     * direction — coins from a chest arrive with nothing on the wire
     * announcing them — and the listing restates it a moment before the
     * figure is spent; when it corrects the purse, the changed figure is what
     * frees the next, corrected ask (see `askedAtWealth`).
     */
    this.queue.enqueue({
      command: 'i',
      priority: 'probe',
      coalesceKey: 'auto-deposit-count',
      expiresAt,
      reason: t('automation.banking.reasonCount')
    });
    this.queue.enqueue({
      command: `deposit ${surplus}`,
      priority: 'probe',
      coalesceKey: 'auto-deposit',
      expiresAt,
      reason: t('automation.banking.reasonDeposit', {
        surplus: String(surplus),
        keep: String(this.config.keepCopper)
      })
    });
    /*
     * And `bank` behind it, every time, exactly as the button sends one: the
     * first deposit at an unasked vault has nothing to maintain, and on every
     * later one it is the vault's own authority restating the figure the
     * maintained balance approximates.
     */
    this.queue.enqueue({
      command: 'bank',
      priority: 'probe',
      coalesceKey: 'auto-deposit-confirm',
      expiresAt,
      reason: t('automation.banking.reasonConfirm')
    });
  }
}
