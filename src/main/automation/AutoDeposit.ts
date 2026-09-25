/**
 * Banking the purse — MegaMUD's StashCoin, and the console's `Deposit All`.
 *
 * Coins carried are coins a death can scatter and weight the walker carries;
 * coins on deposit are neither. One owner for both ways of banking them: the
 * threshold below, and the button beside a bank's own name, which differ in
 * what they keep back and in which band their commands go out in and in
 * nothing else.
 *
 * ## The figure is read, then spent — in that order, and it was not
 *
 * Both used to compose `deposit <n>` **beside** the `i` meant to correct it,
 * and both documented the `i` as what made the figure current. It never could
 * be: the number was already a literal by then. Measured on the button
 * (`logs/2026-09-04_20-39-52_festus`, t=771361) — `i`, `deposit 192600` and
 * `bank` left the client in the same millisecond, and the `Wealth: 190400`
 * that answered the `i` arrived 71ms later, with the deposit already on the
 * wire. Two levels' training (1000 + 1200) had left the maintained purse
 * 2,200 high, this server refuses an over-deposit in **silence**, and the
 * button therefore did nothing at all until a bare Enter happened to reprint
 * the room and compose it again from the corrected figure.
 *
 * So the sequence is a request, not a list: `i` goes out, `onListing` waits
 * for the listing that answers it, and the deposit is composed from that.
 * Facts fan out, actions funnel in — the shape everything else here follows.
 *
 * ## The three facts it acts on, and where each comes from
 *
 * - **The purse is the listing's own figure** (`inventory.wealth`) — the
 *   server's copper total, restated a moment before it is spent. It is
 *   maintained between listings (a purchase, a sale, a level, coins picked
 *   up, the deposit and withdrawal sentences), and it can still drift in
 *   either direction, because coins out of a chest arrive with nothing on the
 *   wire announcing them. That is what the `i` is for, and why nothing is
 *   composed until it has been answered. An unread purse deposits nothing —
 *   unknown is not rich.
 * - **The counter is the resolved room's own shop** — `WorldRoom.shop` at the
 *   coordinates the character actually stands, graded `bank` by the realm.
 *   The resolved room, not the room's name: thirteen rooms can share a name,
 *   and a deposit typed outside a bank is a command said out loud. Checked
 *   **twice** — when the deposit is asked for, because the button lives in
 *   the backscroll and can be pressed from a room the character left an hour
 *   ago, and again when it is composed, because the character can walk out
 *   between the `i` and its answer.
 * - **The verb is the sampled one.** `deposit <n>`, a number in copper —
 *   `depo 10000` answered `You deposit 10000 copper farthings.` live
 *   (todo/archive/23); `dep all` has never been seen on this wire and is not
 *   sent. A `bank` goes out behind it: the first deposit at an unasked vault
 *   has no figure to maintain, and one command establishes it while every
 *   later deposit keeps it true for free.
 *
 * Never in combat, and one ask per cooldown: the deposit sentence is what
 * moves the purse, and a status line arriving before it would otherwise
 * propose the same deposit again. `probe` band for the threshold, `user` for
 * the button — a person pressing it outranks housekeeping and is not silenced
 * by the master switch. Nothing here touches a socket.
 */
import type { Priority } from '../../shared/automation';
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { BankingConfig } from '../../shared/config';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';

/** The one `i` this module ever proposes; a second request rides the first. */
const COUNT_KEY = 'auto-deposit-count';

/** A deposit waiting for a listing to say what there is to deposit. */
interface PendingDeposit {
  /** Copper held back. The threshold keeps `keepCopper`; the button keeps none. */
  keep: number;
  /** The band both commands go out in — see the header. */
  priority: Priority;
  /** Given up on after this, so an `i` the server swallowed cannot arm the slot for ever. */
  expiresAt: number;
  /**
   * Whether the refresh this waits on has actually reached the socket.
   *
   * A listing that arrived before it answers an *older* ask, and an older ask
   * is the stale figure this whole shape exists to refuse. It matters whenever
   * the queue holds the `i` back — a half-typed line, the pacing gap, the
   * acknowledgement window closed — which is exactly when a listing asked for
   * earlier has time to land in front of it.
   *
   * **What it does not close, and why that is left open.** With the queue
   * clear the `i` is written synchronously, so a listing already *in flight*
   * when it goes out would still be taken. That window is one round trip
   * (71ms, measured), and the purse can only move by a command — so being
   * wrong here needs an `i`, then something that spends money, then the press,
   * all inside one round trip, which nobody can type and which automation's
   * own `minGapMs` forbids. Closing it properly means counting inventory asks
   * outstanding the way the look queue counts looks; if a capture ever shows
   * this happening, that is the shape to reach for.
   */
  refreshed: boolean;
}

export class AutoDeposit implements SessionModule {
  private lastAt = 0;
  /**
   * The listing figure the last ask was composed from.
   *
   * A deposit the server refused moves nothing, so re-asking on an unchanged
   * purse would send the identical refused command once per cooldown for as
   * long as the character stands at the counter. What frees a fresh ask is the
   * figure changing — which, now that every ask is composed from a listing
   * rather than from the maintained total, means the *server* saying something
   * different rather than the client noticing it was wrong.
   */
  private askedAtWealth: number | null = null;
  /** The deposit asked for and not yet composed. One at a time, by design. */
  private pending: PendingDeposit | null = null;

  constructor(
    private config: BankingConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    /**
     * The realm's shop row for the counter the character is standing at, or
     * null where the resolved room is not a bank. The row, not a yes, so
     * {@link wrongBank} can tell *not a bank* from *not your bank*.
     */
    private readonly bankHere: (state: CharacterState) => number | null,
    private readonly events: { notice?(message: string): void } = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: BankingConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  /**
   * Whether this counter is one the player said not to bank at.
   *
   * `bank: 0` is *whichever counter it is standing at*, which is what every
   * file did before the setting existed, so it agrees with everything. A
   * stated row agrees with itself and nothing else — including a row this
   * realm does not place, which banks nowhere rather than at the nearest
   * counter instead: choosing the vault is the whole point of the setting,
   * and choosing a different one is the client overruling it.
   */
  private wrongBank(counter: number): boolean {
    return this.config.bank > 0 && this.config.bank !== counter;
  }

  reset(): void {
    this.lastAt = 0;
    this.askedAtWealth = null;
    this.pending = null;
  }

  /**
   * Bank the purse at the counter in front of the character, once a listing
   * has said what it holds.
   *
   * Refuses out loud rather than sending a `deposit` anywhere the realm does
   * not call a bank: an unrecognised command on this server is *said out loud*
   * to everybody in the room, and this is reachable from the backscroll, where
   * the room beside the button is not the room the character is in.
   *
   * Returns whether it was taken. `false` is a refusal that has already
   * reported itself, a press that rode the request already in flight, or a
   * character not in the realm — where a `deposit` is a menu answer and the
   * button is not on screen to be pressed in the first place.
   */
  request(keep: number, priority: Priority, state: CharacterState): boolean {
    if (state.phase !== 'in-game') return false;
    const at = this.now();
    // One at a time: the second press before the first listing lands is the
    // same request, and it is already waiting.
    if (this.pending !== null && at < this.pending.expiresAt) return false;
    const counter = this.bankHere(state);
    if (counter === null) {
      this.events.notice?.(t('automation.banking.notAtCounter'));
      return false;
    }
    if (this.wrongBank(counter)) {
      this.events.notice?.(t('automation.banking.notYourBank'));
      return false;
    }

    const expiresAt = at + tuning().banking.expiresMs;
    this.pending = { keep, priority, expiresAt, refreshed: false };
    /*
     * The refresh, and the whole of what goes out now. `enqueue` answering
     * `false` here means a stale `i` from an expired request is still queued —
     * it carries this same callback, so it arms the request that replaced it.
     * (The other `false`, the master switch, cannot reach here: the threshold
     * is gated on it and the button asks in the `user` band, which outranks
     * it.)
     */
    this.queue.enqueue({
      command: 'i',
      priority,
      coalesceKey: COUNT_KEY,
      expiresAt,
      reason: t('automation.banking.reasonCount'),
      onSent: () => {
        if (this.pending !== null) this.pending.refreshed = true;
      }
    });
    return true;
  }

  /**
   * A pack listing landed, and with it the figure the deposit is composed
   * from.
   *
   * Called after the tracker has applied it, so `state` is the purse the
   * server just restated rather than the one the client believed a moment ago.
   */
  onListing(state: CharacterState): void {
    const pending = this.pending;
    if (pending === null) return;
    if (this.now() >= pending.expiresAt) {
      this.pending = null;
      return;
    }
    if (!pending.refreshed) return;
    this.pending = null;

    // The counter again: a listing is a round trip, and a character can walk
    // out of a bank — or into a different one — inside one.
    const counter = this.bankHere(state);
    if (counter === null) {
      this.events.notice?.(t('automation.banking.notAtCounter'));
      return;
    }
    if (this.wrongBank(counter)) {
      this.events.notice?.(t('automation.banking.notYourBank'));
      return;
    }

    const wealth = state.inventory.wealth;
    const surplus = wealth === null ? 0 : wealth - pending.keep;
    if (surplus <= 0) {
      // Said out loud rather than quietly dropped: a button that reports
      // nothing is indistinguishable from one that is broken, which is the
      // failure this whole change is about.
      this.events.notice?.(t('automation.banking.nothingToBank'));
      return;
    }
    this.askedAtWealth = wealth;

    const expiresAt = this.now() + tuning().banking.expiresMs;
    this.queue.enqueue({
      command: `deposit ${surplus}`,
      priority: pending.priority,
      coalesceKey: 'auto-deposit',
      expiresAt,
      reason: t('automation.banking.reasonDeposit', {
        surplus: String(surplus),
        keep: String(pending.keep)
      })
    });
    /*
     * And `bank` behind it, every time: the first deposit at an unasked vault
     * has nothing to maintain, and on every later one it is the vault's own
     * authority restating the figure the maintained balance approximates.
     */
    this.queue.enqueue({
      command: 'bank',
      priority: pending.priority,
      coalesceKey: 'auto-deposit-confirm',
      expiresAt,
      reason: t('automation.banking.reasonConfirm')
    });
  }

  onCharacter(state: CharacterState): void {
    // A request whose listing never came is dropped here rather than pinning
    // the slot: the status line is the one thing that arrives whatever else
    // does not.
    if (this.pending !== null && this.now() >= this.pending.expiresAt) this.pending = null;

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
    if (wealth - this.config.keepCopper <= 0) return;

    /*
     * The counter, **here as well as in `request`**, and silently.
     *
     * `request` refuses away from a bank *out loud*, because a press is a
     * person asking and a refusal nobody can read is the bug this whole change
     * is about. This is the opposite case: a threshold, re-derived from every
     * status line, standing in a corridor with a fat purse. Left to `request`
     * it would print that same refusal several times a second for as long as
     * the character walked — which is the terminal talking over the realm, and
     * a notice nobody asked for is worse than none.
     */
    const counter = this.bankHere(state);
    if (counter === null || this.wrongBank(counter)) return;

    const at = this.now();
    if (at - this.lastAt < tuning().banking.cooldownMs) return;
    if (wealth === this.askedAtWealth) return;
    // The threshold reads the maintained figure to decide *whether* to ask;
    // what it deposits is the listing's, which is the whole point of the ask.
    if (!this.request(this.config.keepCopper, 'probe', state)) return;
    this.lastAt = at;
  }
}
