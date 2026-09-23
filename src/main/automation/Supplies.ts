/**
 * Keeping the pack stocked, unasked — MegaMUD's *Must Have Minimum*.
 *
 * `automation.supplies` names the things a character must not run out of —
 * torches, in practice — with a floor, a ceiling and the shop to buy them at.
 * When the pack falls below the floor this **holds** whatever the character
 * was doing, walks it to the shop, asks the counter what it sells, buys back
 * up to the ceiling one at a time, and lets go. A loop that was running plans
 * its next leg from the shop, which is the same recovery a fight gets.
 *
 * ## An errand is a walk the character did not choose, so it yields to everything
 *
 * It starts only when nothing else has the character: not in a fight, not
 * resting, not with a move unanswered, not while the player's own route or a
 * retreat is walking it, and not while an escape is in flight. Once walking it
 * is an ordinary route through `Walker` — one verified step at a time, held
 * for health, stopped by a fight — and a leg the fight ended is planned again
 * from wherever the fight left the character, bounded by `tuning.supplies.maxLegs`
 * so a shop nothing can reach does not pin the character to a corridor.
 *
 * ## The counter is the authority, not the index
 *
 * The realm's shop table is a lead — stock rotates, a derivative edits it —
 * and the realm's price column is in the item's own coin with the shop's
 * markup and the character's charm still to apply (measured 2026-09-03: a
 * short-spear the index prices at 2 sold for 400 copper). So on arrival the
 * counter is asked (`list`, which the client already reads as `shop-list`),
 * and the purchase is priced and confirmed off *that*: an item the counter
 * does not list is refused before a `buy` is spent on it, and a quote the
 * purse cannot meet is refused with both figures in the trace.
 *
 * ## One at a time, and every answer is read
 *
 * `buy torch` is answered `You just bought torch for 0 copper farthings.`
 * (captured live, `user-buys`), and that sentence is what moves the count:
 * the next `buy` goes out on it, and the pack is maintained by the tracker
 * for free. A `buy N torch` would need the shelf to hold N (`ItemContainer
 * .GetItemStacks` refuses a count above the stack) and one refusal would lose
 * the lot. The refusals themselves — *You cannot afford*, *is not a known
 * item*, *You cannot carry that much* — have never been captured on this
 * wire, so no pattern claims them; a `buy` the confirmation does not answer
 * inside `tuning.supplies.buyTimeoutMs` is taken as refused, said out loud,
 * and the item is left alone for `retryMs` rather than tried again on the
 * next status line.
 *
 * Every decision — going, bought, refused and why — is a `SafetyDecision`,
 * because an errand that silently did not happen is a character that runs
 * out of torches with the feature switched on.
 *
 * ## A short purse goes to the bank first
 *
 * The realm prices the purchase before the walk (`priceAt`, charm applied by
 * `chargedInCopper`), and the counter's quote prices it again on arrival; either
 * finding the purse short sends the errand to the vault the record says holds
 * the rest, nearest the counter first (`cashFrom`), where `bank` is asked
 * before `withdraw` because the server answers a withdrawal it will not pay
 * with nothing at all. Once per errand. See `mudengine-automation` › *The pack
 * is kept stocked*.
 */
import type { CommandQueue } from './CommandQueue';
import { fightIsRunning } from './Walker';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import { chargedInCopper, quotedInCopper } from '../../shared/coins';
import { balanceOf } from '../../shared/character';
import type { SuppliesConfig, SupplyItem } from '../../shared/config';
import { bareName } from '../../shared/items';
import { carriedCount } from '../../shared/supplies';
import { nameAnswersTo, roomId, type CashPlace, type RoomId, type Route } from '../../shared/world';

export interface SupplyPlanner {
  /** Where the character is, or null while it is not placed. */
  here(): RoomId | null;
  /** The room a supply's shop is in, or the reason the shop cannot be settled. */
  shopRoom(item: SupplyItem): { room: RoomId; name: string } | string;
  routeTo(room: RoomId): Route | string;
  /** What one costs at the counter in that room, in copper before charm; null where unsaid. */
  priceAt(item: SupplyItem, shop: RoomId): number | null;
  /** The vaults the record says hold `need` copper, best first on the way to `then`. */
  cashFrom(need: number, then: RoomId): CashPlace[];
  /** Hands the route to the walker; a refusal, or null once walking. */
  walk(route: Route): string | null;
  moveInFlight(): boolean;
  /** Some other walk has the character — the player's route, a retreat. */
  walking(): boolean;
  /** Anything that outranks shopping: an escape in flight, a haven armed. */
  busy(): boolean;
  /**
   * Whether a lap is actually running.
   *
   * The one state an errand may start itself from. See `consider`.
   */
  looping(): boolean;
  /** Hold the running loop for the errand, and let it go afterwards. */
  hold(): void;
  release(): void;
}

export interface SupplyEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** What the errand is doing, for the trace and the card. */
export type ErrandStage = 'walking' | 'waiting' | 'listing' | 'buying' | 'balance' | 'withdrawing';

/** The vault an errand is drawing cash from on its way to the counter. */
export interface BankLeg {
  place: CashPlace;
  room: RoomId;
  /** What the purse is short by, what the errand costs and what the purse held, in copper. */
  shortfall: number;
  owed: number;
  wealth: number;
  /** The withdrawal asked for, so a `withdraw` the player typed is not taken for it. */
  amount: number | null;
  /** Vaults already found wanting, so the next is the fallback. */
  tried: RoomId[];
}

export interface Errand {
  item: SupplyItem;
  stage: ErrandStage;
  /** Where the shop is. */
  room: RoomId;
  shopName: string;
  /** How many the pack held when the errand began, and how many to buy. */
  have: number;
  wanted: number;
  bought: number;
  legs: number;
  /** When `list` or `bank` was asked, for the answer's own stamp to be compared against. */
  askedAt: number;
  /** The vault being walked to first, while the purse is short. */
  bank: BankLeg | null;
  /** Whether a vault has been drawn on: once per errand, so a counter no purse meets is refused. */
  banked: boolean;
}

/** What the errand asks a counter or a vault, withdrawn when it walks on before the answer. */
const ERRAND_ASKS = new Set(['supplies:list', 'supplies:bank', 'supplies:withdraw']);

export class Supplies {
  private errand: Errand | null = null;
  /** Items refused recently, and until when they are left alone. */
  private readonly retryAt = new Map<string, number>();
  /** Standing conditions already said, so they are said once. See `report`. */
  private readonly reported = new Set<string>();
  /**
   * A `drop` proposed for a surplus, and the deadline it is owed an answer by.
   *
   * A declared postcondition with a bounded deadline, which is what anything
   * corrective here needs (`Recovery`'s rule): the pack listing is what says
   * the surplus is gone, and it arrives whole seconds after the command. The
   * queue's own coalescing does not cover it — a status line arrives every few
   * hundred milliseconds and each one is a fresh enqueue *after* the last has
   * already gone out, so without this the character puts its entire stock on
   * the floor before the listing catches up.
   */
  private readonly droppedUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /**
   * The whole errand's deadline.
   *
   * `Walker.start` deliberately raises no `ended` when it *replaces* a running
   * walk, so an errand whose leg is superseded — by the player's own route, or
   * by a `safe-haven` walk home — would otherwise sit at `walking` for ever
   * with no timer armed and no way out, holding the lap with it. A declared
   * postcondition with a bounded deadline on it, which is the shape `Recovery`
   * had to learn: anything corrective here needs one.
   */
  private errandTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: SuppliesConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: SupplyPlanner,
    private readonly events: SupplyEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: SuppliesConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  /** New connection: nothing is owed, and nothing is remembered as refused. */
  reset(): void {
    this.clearTimer();
    this.clearErrandTimer();
    this.errand = null;
    this.retryAt.clear();
    this.reported.clear();
    this.droppedUntil.clear();
  }

  dispose(): void {
    this.clearTimer();
    this.clearErrandTimer();
  }

  /**
   * The player moved the character themselves, so the errand is off.
   *
   * Shopping is a walk *automation* chose, and the one thing it may never do
   * is argue with the person at the keyboard — `Walker.stop` raises `ended`
   * for a typed direction exactly as it does for a shut door, and reading that
   * as a failed leg had the errand replan from wherever the player had just
   * walked to and march them back, four times over. `LoopRunner.notePlayerMoved`
   * is the shape; this is the same sentence about the same fact.
   */
  notePlayerMoved(): void {
    this.abandon(t('automation.supplies.abandonedPlayerMoved'));
  }

  get current(): Errand | null {
    return this.errand;
  }

  /**
   * Give the errand up — a death, the player resuming the loop by hand, the
   * realm left. The loop is let go so it can decide for itself.
   */
  abandon(reason: string): void {
    const errand = this.errand;
    if (errand === null) return;
    this.finish(errand, false, reason);
  }

  /**
   * One row, asked for by name rather than found short (todo 07).
   *
   * A route that needs a key is the other thing that makes a counter worth
   * walking to, and the errand's whole shape — walk, `list`, check the quote
   * against the purse, one `buy` confirmed by `You just bought …` — is the
   * same whether the row came from the player's list or from a door. **The
   * row is written nowhere**: it is wanted once, and a supply list that grew a
   * line every time a route crossed a lock would be the client editing the
   * player's file on their behalf.
   *
   * Refuses while an errand is already running: there is one pack and one
   * character, and the caller reports the refusal to whoever pressed.
   */
  fetch(row: SupplyItem, state: CharacterState): string | null {
    if (!this.enabled || !this.config.enabled) {
      return t('automation.supplies.abandonedSwitchedOff');
    }
    if (this.errand !== null) return t('automation.supplies.refusalBusy');
    if (state.phase !== 'in-game') return t('automation.supplies.refusalNotInRealm');
    this.begin(row, carriedCount(state, row.name), state);
    // `begin` refuses by saying so and leaving no errand; its own sentence has
    // already been said, so this only has to report that nothing started.
    return this.errand === null ? t('automation.supplies.refusalNoErrand') : null;
  }

  onCharacter(state: CharacterState): void {
    if (state.phase !== 'in-game') {
      this.abandon(t('automation.supplies.abandonedLeftRealm'));
      return;
    }
    if (!this.enabled || !this.config.enabled) {
      this.abandon(t('automation.supplies.abandonedSwitchedOff'));
      return;
    }
    const errand = this.errand;
    if (errand === null) {
      /*
       * **An idle character never goes shopping.** This used to consider on
       * every status line with nothing else holding the character, which meant
       * standing still was enough — and standing still is exactly what a
       * character does after it dies: killed and sent to the temple, the pack
       * emptied onto the corpse, it was walked straight back out to the General
       * Store for a torch it had no way of paying for. A shopping trip is part
       * of going somewhere, so it starts where going somewhere starts: a lap,
       * or a route the player asked for (`considerBeforeRoute`).
       */
      if (this.planner.looping()) this.consider(state);
      // And the other end of the same rule, which needs no errand and no lap:
      // what the pack holds over a stated ceiling.
      this.considerSurplus(state);
      return;
    }
    switch (errand.stage) {
      case 'waiting':
        if (fightIsRunning(state) || this.planner.moveInFlight()) return;
        this.leg(errand, state);
        return;
      case 'listing': {
        const listing = state.shopListing;
        if (listing === null || listing.at < errand.askedAt) return;
        const row = listing.items.find((entry) =>
          nameAnswersTo(bareName(entry.name), bareName(errand.item.name))
        );
        if (row === undefined) {
          this.finish(
            errand,
            false,
            t('automation.supplies.refusalNotSold', {
              item: errand.item.name,
              shop: errand.shopName
            })
          );
          return;
        }
        const price = quotedInCopper(row.price);
        const wealth = state.inventory.wealth;
        /*
         * The counter's own figure, where the realm's was unsaid or the record
         * was stale. The quote is before charm, as the listing prints it; what
         * is short is what the rest of the errand costs, the figure `begin` uses.
         */
        const owed =
          price === null
            ? null
            : chargedInCopper(price, state.progress.charm) * (errand.wanted - errand.bought);
        if (price !== null && owed !== null && wealth !== null && owed > wealth) {
          if (!errand.banked) {
            // Either walking to the vault, or ended with the vault's refusal.
            if (this.toBank(errand, owed - wealth, owed, wealth)) this.leg(errand, state);
            return;
          }
          this.finish(
            errand,
            false,
            t('automation.supplies.refusalCannotAfford', {
              item: errand.item.name,
              price: price.toLocaleString(),
              wealth: wealth.toLocaleString()
            })
          );
          return;
        }
        errand.stage = 'buying';
        this.buy(errand);
        return;
      }
      case 'balance':
        this.readBalance(errand, state);
        return;
      case 'walking':
      case 'buying':
      case 'withdrawing':
        return;
    }
  }

  /** The walker's report: the errand's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const errand = this.errand;
    if (errand === null || errand.stage !== 'walking') return;
    if (arrived && this.planner.here() === (errand.bank?.room ?? errand.room)) {
      this.arrive(errand);
      return;
    }
    /*
     * The player pressed Stop. Compared against the copy itself rather than a
     * word in it, which is `LoopRunner.advance`'s own rule — and the same
     * decision `notePlayerMoved` makes for a typed direction.
     */
    if (reason === t('session.walk.stoppedByPlayer')) {
      this.finish(errand, false, t('automation.supplies.abandonedPlayerMoved'));
      return;
    }
    /*
     * Combat is the one failure that is not one, exactly as `LoopRunner`
     * reads it: the walker stops the moment a fight starts, and the errand
     * plans again from wherever the fight leaves the character. Compared
     * against the state, never a word in the reason — see the loop's note on
     * how a substring match on `combat` rotted.
     */
    /*
     * The walker's own definition of a fight — the flag, or anything still
     * swinging — because the walker is what refuses the leg (2026-09-04).
     * Read off the flag alone, an errand planned in the window after
     * `*Combat Off*` with the other monster still biting was refused by the
     * walker and shelved here as *no route to the shop*, which was neither
     * true nor what happened.
     */
    if (fightIsRunning(state)) {
      errand.stage = 'waiting';
      return;
    }
    if (errand.legs >= tuning().supplies.maxLegs) {
      this.finish(
        errand,
        false,
        t('automation.supplies.refusalUnreachable', {
          shop: errand.bank?.place.name ?? errand.shopName,
          why: reason ?? t('automation.loops.fallbackWhy')
        })
      );
      return;
    }
    this.leg(errand, state);
  }

  onBlock(block: Block, state: CharacterState): void {
    const errand = this.errand;
    if (errand?.stage === 'withdrawing' && block.type === 'user-withdraws') {
      // Only the errand's own: a `withdraw` the player typed is not the vault paying this.
      if (Number(block.groups['amount']) === errand.bank?.amount)
        this.withdrew(errand, block, state);
      return;
    }
    if (errand === null || errand.stage !== 'buying' || block.type !== 'user-buys') return;
    const item = block.groups['item'];
    if (item === undefined || !nameAnswersTo(bareName(item), bareName(errand.item.name))) return;
    this.clearTimer();
    const quantity = Number(block.groups['quantity'] ?? '1');
    errand.bought += Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    if (errand.bought < errand.wanted) {
      this.buy(errand);
      return;
    }
    this.finish(errand, true, null, state);
  }

  /**
   * The other moment an errand may start: the player has asked for a route.
   *
   * Answered *before* the route goes out, so the shop is visited first and the
   * route walked after — the same order a lap gets, where the errand holds the
   * lap rather than ending it. The caller owes the route back; see
   * `SessionManager.walkRoute`.
   *
   * Returns the errand it started, so the caller can name the shop in the
   * sentence it says about standing the route down.
   */
  considerBeforeRoute(state: CharacterState): Errand | null {
    if (!this.enabled || !this.config.enabled) return null;
    if (state.phase !== 'in-game') return null;
    if (this.errand !== null) return null;
    this.consider(state);
    return this.errand;
  }

  /** Nothing is owed: is anything short, and can it be bought right now? */
  private consider(state: CharacterState): void {
    if (this.config.items.length === 0) return;
    if (fightIsRunning(state) || state.vitals.resting || state.vitals.meditating) return;
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;
    // Nothing is short until the pack has been read: an unlisted pack is not
    // an empty one, and an errand for torches the character is carrying is a
    // walk to the shop for nothing.
    if (state.inventory.items.length === 0 && state.inventory.wealth === null) return;
    const now = this.now();
    for (const item of this.config.items) {
      if (item.min <= 0) continue;
      /*
       * A row naming no shop is a thing that is found rather than bought — a
       * `black star key` at min 2, max 2 is sold nowhere. Skipped in silence
       * rather than refused per status line: `AutoLoot` fills it off the floor
       * (`stockingUp`), and *no shop chosen* said once a second about a row
       * that is working correctly is noise.
       */
      if (item.shop.trim().length === 0) continue;
      const until = this.retryAt.get(bareName(item.name));
      if (until !== undefined && until > now) continue;
      const have = carriedCount(state, item.name);
      if (have >= item.min) continue;
      this.begin(item, have, state);
      return;
    }
  }

  /**
   * What the pack holds over a stated ceiling, put down one at a time.
   *
   * The other end of the rule `AutoLoot.stockingUp` keeps: a list states how
   * many of a thing to carry, and the client fills up to that number off the
   * floor and out of a shop — so it has to answer for the number being
   * exceeded too, or *max 2* would mean *at least 2* and a key nobody wanted a
   * third of would ride along for ever.
   *
   * Three refusals, and each is the point rather than caution:
   *
   * - **Never something the character is wearing, wielding or has readied.**
   *   `loadout` is what is in a slot, and dropping a lit torch in a dark room
   *   is the client putting a character somewhere it cannot see. The surplus is
   *   found among the spares or it is not found.
   * - **Never while anything else has the character** — the same gate the
   *   errand takes. A `drop` in front of an escape is a command ahead of the
   *   move that gets the character out.
   * - **One at a time, confirmed by the pack.** `drop` takes one, the listing
   *   that follows says how many are left, and the next status line decides
   *   again. Coalesced per item, so a listing repeating is one decision.
   *
   * Said out loud as a safety decision, because putting a player's property on
   * the floor is a thing somebody will ask about.
   */
  private considerSurplus(state: CharacterState): void {
    if (this.config.items.length === 0) return;
    if (fightIsRunning(state) || state.vitals.resting || state.vitals.meditating) return;
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;
    // An unlisted pack is not an empty one, and it is not an overfull one
    // either: nothing is surplus until the pack has been read.
    if (state.inventory.items.length === 0) return;
    const now = this.now();
    for (const row of this.config.items) {
      const ceiling = Math.max(row.min, row.max);
      if (ceiling <= 0) continue;
      const have = carriedCount(state, row.name);
      if (have <= ceiling) {
        // Back inside the ceiling: whatever was proposed was answered, and the
        // next surplus starts from nothing owed.
        this.droppedUntil.delete(bareName(row.name));
        continue;
      }
      const owed = this.droppedUntil.get(bareName(row.name));
      if (owed !== undefined && owed > now) continue;
      const spare = this.spareOf(state, row.name);
      if (spare === null) {
        // Every one of them is in a slot. Said once per item, so a character
        // wielding two of something does not report it on every status line.
        this.report(
          `supplies:surplus-worn:${bareName(row.name)}`,
          t('automation.supplies.becauseOver', { item: row.name, have, max: ceiling }),
          t('automation.supplies.surplusAllWorn', { item: row.name, have, max: ceiling })
        );
        continue;
      }
      const reason = t('automation.supplies.surplusDropped', {
        item: spare,
        have,
        max: ceiling
      });
      this.droppedUntil.set(bareName(row.name), now + tuning().supplies.buyTimeoutMs);
      this.queue.enqueue({
        command: `drop ${spare}`,
        priority: 'probe',
        coalesceKey: `supplies:surplus:${bareName(row.name)}`,
        expiresAt: now + tuning().supplies.expiresMs,
        reason
      });
      this.events.decided?.({
        at: this.now(),
        action: 'supplies',
        because: t('automation.supplies.becauseOver', {
          item: row.name,
          have,
          max: ceiling
        }),
        acted: true
      });
      this.events.notice?.(reason);
      return;
    }
  }

  /**
   * One carried item answering to this name that is **not** in use.
   *
   * `equipped` and not `loadout`: the loadout is what was last *seen* in a
   * slot and is never emptied by an item coming off, which is right for
   * putting a kit back on and wrong here — it would refuse to drop a spare
   * torch because a torch had once been readied. `equipped` is the listing's
   * own answer for this row, right now.
   *
   * Matched by `nameAnswersTo` against the configured name, the same rule
   * `carriedCount` counts by, so what is put down is one of the ones counted.
   */
  private spareOf(state: CharacterState, name: string): string | null {
    const wanted = bareName(name);
    for (const item of state.inventory.items) {
      if (item.equipped === true) continue;
      if (!nameAnswersTo(bareName(item.name), wanted)) continue;
      return item.name;
    }
    return null;
  }

  /** One sentence per subject, so a standing condition is not said per line. */
  private report(key: string, because: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.events.notice?.(message);
    this.events.decided?.({
      at: this.now(),
      action: 'supplies',
      because,
      acted: false,
      refused: message
    });
  }

  private begin(item: SupplyItem, have: number, state: CharacterState): void {
    const found = this.planner.shopRoom(item);
    if (typeof found === 'string') {
      this.refuse(item, t('automation.supplies.refusalNoShop', { item: item.name, why: found }));
      return;
    }
    const errand: Errand = {
      item,
      stage: 'walking',
      room: found.room,
      shopName: found.name,
      have,
      wanted: Math.max(item.max, item.min) - have,
      bought: 0,
      legs: 0,
      askedAt: 0,
      bank: null,
      banked: false
    };
    this.errand = errand;
    this.armErrandTimer(errand);
    this.planner.hold();
    /*
     * Priced before the walk where the realm states the coin. An unread purse
     * is not an empty one and walks as before; the counter's quote is the
     * second chance to find the purse short.
     */
    const each = this.planner.priceAt(item, found.room);
    const wealth = state.inventory.wealth;
    if (each !== null && wealth !== null) {
      const owed = chargedInCopper(each, state.progress.charm) * errand.wanted;
      if (owed > wealth && !this.toBank(errand, owed - wealth, owed, wealth)) return;
    }
    if (this.planner.here() === (errand.bank?.room ?? found.room)) {
      this.arrive(errand);
      return;
    }
    this.leg(errand, state);
  }

  /**
   * Send the errand to the vault that holds what the purse is short of, or
   * refuse it: true when a vault was chosen, false when the errand has ended.
   *
   * `cashFrom` answers from the character's own record, nearest the counter
   * first; a vault already found wanting is passed over for the next.
   */
  private toBank(errand: Errand, shortfall: number, owed: number, wealth: number): boolean {
    // Whatever the last place was waiting on is owed nothing now.
    this.clearTimer();
    this.queue.cancel((intent) => ERRAND_ASKS.has(intent.coalesceKey ?? ''));
    const tried = errand.bank?.tried ?? [];
    const place = this.planner
      .cashFrom(shortfall, errand.room)
      .find((each) => !tried.includes(roomId(each.map, each.room)));
    if (place === undefined) {
      const figures = {
        item: errand.item.name,
        owed: owed.toLocaleString(),
        wealth: wealth.toLocaleString(),
        short: shortfall.toLocaleString()
      };
      this.finish(
        errand,
        false,
        tried.length > 0
          ? t('automation.supplies.refusalNoOtherBank', figures)
          : t('automation.supplies.refusalNoBank', figures)
      );
      return false;
    }
    const room = roomId(place.map, place.room);
    errand.bank = { place, room, shortfall, owed, wealth, amount: null, tried: [...tried, room] };
    errand.banked = true;
    errand.legs = 0;
    errand.stage = 'walking';
    // Each vault is a walk of its own, and gets the whole errand's time for it.
    this.armErrandTimer(errand);
    this.events.notice?.(
      t('automation.supplies.toBank', {
        item: errand.item.name,
        owed: owed.toLocaleString(),
        wealth: wealth.toLocaleString(),
        bank: place.name,
        held: place.copper.toLocaleString()
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: 'supplies',
      because: t('automation.supplies.becausePurseShort', {
        item: errand.item.name,
        owed: owed.toLocaleString(),
        wealth: wealth.toLocaleString()
      }),
      acted: true
    });
    return true;
  }

  /**
   * `bank` has been asked at the vault: read the figure it stated, and
   * withdraw the shortfall and the buffer — never more than it holds, since a
   * withdrawal over the balance is answered with silence (`WithdrawCommand`).
   */
  private readBalance(errand: Errand, state: CharacterState): void {
    const leg = errand.bank;
    if (leg === null) return;
    const held = balanceOf({ id: leg.place.shop, name: leg.place.name }, state.banks);
    if (held === null || held.at < errand.askedAt) return;
    this.clearTimer();
    if (held.copper < leg.shortfall) {
      this.nextVault(
        errand,
        t('automation.supplies.bankShort', {
          bank: leg.place.name,
          held: held.copper.toLocaleString(),
          short: leg.shortfall.toLocaleString()
        })
      );
      return;
    }
    const amount = Math.min(held.copper, leg.shortfall + tuning().supplies.cashBuffer);
    leg.amount = amount;
    errand.stage = 'withdrawing';
    this.queue.enqueue({
      command: `withdraw ${amount}`,
      priority: 'probe',
      coalesceKey: 'supplies:withdraw',
      expiresAt: this.now() + tuning().supplies.expiresMs,
      reason: t('automation.supplies.reasonWithdraw', {
        amount: amount.toLocaleString(),
        item: errand.item.name
      })
    });
    this.armTimer(errand, t('automation.supplies.refusalNoPayout', { bank: leg.place.name }), true);
  }

  /**
   * This vault will not do — short, silent, or not paying — so the next the
   * record names, said with the reason; the errand ends only when none is left.
   */
  private nextVault(errand: Errand, why: string): void {
    const leg = errand.bank;
    if (leg === null) return;
    this.events.notice?.(why);
    if (this.toBank(errand, leg.shortfall, leg.owed, leg.wealth)) this.leg(errand);
  }

  /** The vault paid out: on to the counter, with the errand's clock started again. */
  private withdrew(errand: Errand, block: Block, state: CharacterState): void {
    this.clearTimer();
    const bank = errand.bank?.place.name ?? '';
    errand.bank = null;
    errand.legs = 0;
    errand.stage = 'walking';
    this.armErrandTimer(errand);
    this.events.notice?.(
      t('automation.supplies.withdrew', {
        amount: (block.groups['amount'] ?? '').trim(),
        bank,
        shop: errand.shopName
      })
    );
    if (this.planner.here() === errand.room) {
      this.arrive(errand);
      return;
    }
    this.leg(errand, state);
  }

  /** Plan and start a walk to the shop from wherever the character is. */
  private leg(errand: Errand, _state?: CharacterState): void {
    /*
     * Never onto an escape. The guard lives in `consider` for a fresh errand,
     * and a leg replanned after a fight is exactly when an escape is most
     * likely to be in flight — a shop trip queued in front of one is a command
     * ahead of the move that gets the character out.
     */
    if (this.planner.busy()) {
      this.finish(errand, false, t('automation.supplies.abandonedEscape'));
      return;
    }
    errand.legs += 1;
    errand.stage = 'walking';
    const place = errand.bank?.place.name ?? errand.shopName;
    const route = this.planner.routeTo(errand.bank?.room ?? errand.room);
    if (typeof route === 'string') {
      this.finish(
        errand,
        false,
        t('automation.supplies.refusalNoRoute', { shop: place, why: route })
      );
      return;
    }
    const refused = this.planner.walk(route);
    if (refused !== null) {
      this.finish(
        errand,
        false,
        t('automation.supplies.refusalNoRoute', { shop: place, why: refused })
      );
      return;
    }
    // Said once, on the first leg to the counter: the bank leg said its own.
    if (errand.legs === 1 && errand.bank === null && !errand.banked) {
      this.events.notice?.(
        t('automation.supplies.going', {
          item: errand.item.name,
          have: errand.have,
          min: errand.item.min,
          shop: errand.shopName,
          steps: route.steps.length
        })
      );
      this.events.decided?.({
        at: this.now(),
        action: 'supplies',
        because: t('automation.supplies.becauseShort', {
          item: errand.item.name,
          have: errand.have,
          min: errand.item.min
        }),
        acted: true
      });
    }
  }

  /** Standing at the counter: ask what it sells before spending a `buy`. */
  private arrive(errand: Errand): void {
    errand.askedAt = this.now();
    if (errand.bank !== null) {
      // At the vault: the balance first, since the record may be stale.
      errand.stage = 'balance';
      this.queue.enqueue({
        command: 'bank',
        priority: 'probe',
        coalesceKey: 'supplies:bank',
        expiresAt: this.now() + tuning().supplies.expiresMs,
        reason: t('automation.supplies.reasonBalance', { bank: errand.bank.place.name })
      });
      this.armTimer(
        errand,
        t('automation.supplies.refusalNoBalance', { bank: errand.bank.place.name }),
        true
      );
      return;
    }
    errand.stage = 'listing';
    this.queue.enqueue({
      command: 'list',
      priority: 'probe',
      coalesceKey: 'supplies:list',
      expiresAt: this.now() + tuning().supplies.expiresMs,
      reason: t('automation.supplies.reasonList', { item: errand.item.name })
    });
    this.armTimer(errand, t('automation.supplies.refusalNoListing', { shop: errand.shopName }));
  }

  private buy(errand: Errand): void {
    this.queue.enqueue({
      command: `buy ${errand.item.name}`,
      priority: 'probe',
      coalesceKey: 'supplies:buy',
      expiresAt: this.now() + tuning().supplies.expiresMs,
      reason: t('automation.supplies.reasonBuy', {
        item: errand.item.name,
        bought: errand.bought + 1,
        wanted: errand.wanted
      })
    });
    this.armTimer(errand, t('automation.supplies.refusalUnconfirmed', { item: errand.item.name }));
  }

  /**
   * A deadline on the counter answering, for the refusals nothing reads. At a
   * vault (`orNextVault`) silence is that vault's refusal, not the errand's.
   */
  private armTimer(errand: Errand, refusal: string, orNextVault = false): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.errand !== errand) return;
      if (orNextVault) this.nextVault(errand, refusal);
      else this.finish(errand, false, refusal);
    }, tuning().supplies.buyTimeoutMs);
    this.timer.unref?.();
  }

  private armErrandTimer(errand: Errand): void {
    this.clearErrandTimer();
    this.errandTimer = setTimeout(() => {
      this.errandTimer = null;
      if (this.errand !== errand) return;
      this.finish(errand, false, t('automation.supplies.refusalTookTooLong'));
    }, tuning().supplies.errandTimeoutMs);
    this.errandTimer.unref?.();
  }

  private clearErrandTimer(): void {
    if (this.errandTimer === null) return;
    clearTimeout(this.errandTimer);
    this.errandTimer = null;
  }

  private finish(
    errand: Errand,
    ok: boolean,
    refusal: string | null,
    state?: CharacterState
  ): void {
    this.clearTimer();
    this.clearErrandTimer();
    this.errand = null;
    if (ok) {
      const have =
        state === undefined ? errand.have + errand.bought : carriedCount(state, errand.item.name);
      this.events.notice?.(
        t('automation.supplies.bought', {
          count: errand.bought,
          item: errand.item.name,
          shop: errand.shopName,
          have
        })
      );
      this.events.decided?.({
        at: this.now(),
        action: 'supplies',
        because: t('automation.supplies.becauseShort', {
          item: errand.item.name,
          have: errand.have,
          min: errand.item.min
        }),
        acted: true
      });
    } else if (errand.bought > 0) {
      // Some were bought before the counter stopped answering: said as such,
      // rather than as a refusal of the whole errand.
      this.events.notice?.(
        t('automation.supplies.boughtSome', {
          count: errand.bought,
          wanted: errand.wanted,
          item: errand.item.name,
          why: refusal ?? ''
        })
      );
      this.retryAt.set(bareName(errand.item.name), this.now() + tuning().supplies.retryMs);
    } else {
      this.refuse(errand.item, refusal ?? '');
    }
    this.planner.release();
  }

  private refuse(item: SupplyItem, why: string): void {
    this.retryAt.set(bareName(item.name), this.now() + tuning().supplies.retryMs);
    this.events.notice?.(t('automation.supplies.refused', { item: item.name, why }));
    this.events.decided?.({
      at: this.now(),
      action: 'supplies',
      because: t('automation.supplies.becauseShortRefused', { item: item.name, min: item.min }),
      acted: false,
      refused: why
    });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
