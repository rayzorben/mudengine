/**
 * Using a chosen carried item for the blessing it casts (`use <item>`), when
 * that blessing is not up. The realm's reading (unlimited items, spells with a
 * duration, a weapon or armour only while worn) is `renewingBlessing`, shared
 * with the Spells page's list. On top of it: only the items Auto Choose
 * Blessings picked (`ChosenItems`), else those in `invokeWith`; only when the
 * spell's mana is there (an item cast costs it, `MA=21` to `MA=13` on the
 * wire); never over a blessing up that `RemovesSpell` ties it to; never in a
 * fight or while a token that negates is next (`NegateDue`); one cast a round
 * (`CastGate`). The server's answer to a `use` is read (`invokeAnswer.ts`): a
 * failed roll or spent round is tried again, a refusal holds the item and is
 * said. A bless weapon in the pack is wielded for the `use` and the fighting
 * weapon put back (`offRoundPlan`, todo 42), watched by `SwapBack`. See
 * `mudengine-automation` › parts/recovery.md, *A weapon that blesses is
 * chosen, and pays the spell's mana*.
 */
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import { NO_NEGATE_DUE, type NegateDue } from '../../shared/cashRun';
import { exclusive } from '../../shared/blessingeffects';
import { isEquipCommand, offRoundSteps, type HandsOf } from '../../shared/gear';
import { bareName, sameItem } from '../../shared/items';
import {
  renewingBlessing,
  chosenToInvoke,
  NO_CHOSEN_ITEMS,
  type BlessingRealm,
  type ChosenItems
} from '../../shared/invoke';
import {
  gatedCast,
  OPEN_CAST_GATE,
  sameSpell,
  spellIsUp,
  type CastGate
} from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue, Intent } from './CommandQueue';
import { answerOf, holdFor, stillHeld, type InvokeHold, type UseOut } from './invokeAnswer';
import type { ChargeLedger } from './ItemCharges';
import { canPayFor } from './mana';
import type { SessionModule } from './Module';
import { SwapBack, type SwapBackEvents } from './SwapBack';

/** What this needs of the realm, injected as functions. */
export interface InvokeSources extends BlessingRealm {
  /**
   * A spell by name, for the buff list, which carries words, not ids.
   *
   * Both sides of *is this buff already up* are resolved to the realm's own
   * id before they are compared, which is the reading `Blessings.sameSpell`
   * settled on and for its reason: the server prints a spell's whole name
   * where a configuration may hold a short one.
   */
  spellNamed(name: string): WorldSpell | null;
  /** The uses left on a charged item, and a look to learn them (`ItemCharges`, todo 44). */
  charges: Pick<ChargeLedger, 'usesLeft' | 'lookOnce' | 'used'>;
  /** One hand or two, as `Errands.gearHandsOf` reads it, or null. */
  handsOf: HandsOf;
  /**
   * A fight running or asked for, on the state at the send
   * (`fightIsRunning || AutoCombat.quarry`, as `AutoSearch.fightHere`).
   */
  fightHere(): boolean;
}

/** Where a refusal to use an item is said, and a fighting weapon not put back. */
export interface AutoInvokeEvents extends SwapBackEvents {
  decided?(decision: SafetyDecision): void;
}

/** The coalesce keys of a swap's commands, by which the queue says one is still waiting. */
const SWAP_KEY = 'invoke-swap:';

/** What a chosen item would give now, and whether it is wielded from the pack first. */
interface Offer {
  spell: WorldSpell;
  several: boolean;
  swap: boolean;
}

/** The two settings this reads: the switch and the items it may use. */
type InvokeSettings = Pick<SpellsConfig, 'invokeItems' | 'invokeWith'>;

export class AutoInvoke implements SessionModule {
  /** When each item's `use` last went out, so one in flight is not repeated. */
  private readonly sentAt = new Map<string, number>();
  /** The `use` the server has not answered yet, and when it went. */
  private out: { use: UseOut; at: number } | null = null;
  /** Items a refusal holds, by the pack's spelling. */
  private readonly held = new Map<string, InvokeHold>();
  /** Charged items said to be at none left, so the refusal is said once until the uses come back. */
  private readonly saidSpent = new Set<string>();
  private enabled = false;
  private chosen: readonly string[] = [];
  private readonly swapBack: SwapBack;

  constructor(
    spells: InvokeSettings,
    enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: InvokeSources,
    private readonly gate: CastGate = OPEN_CAST_GATE,
    private readonly now: () => number = () => Date.now(),
    private readonly picked: ChosenItems = NO_CHOSEN_ITEMS,
    private readonly events: AutoInvokeEvents = {},
    private readonly due: NegateDue = NO_NEGATE_DUE
  ) {
    this.swapBack = new SwapBack(events, now);
    this.configure(spells, enabled);
  }

  configure(spells: InvokeSettings, enabled: boolean): void {
    // `invokeItems` switches the hand list only: an item Auto Choose Blessings
    // picked is used without it, or the choice it names would go unused.
    this.enabled = enabled;
    this.chosen = spells.invokeItems ? spells.invokeWith : [];
  }

  reset(): void {
    this.sentAt.clear();
    this.held.clear();
    this.saidSpent.clear();
    this.out = null;
    this.swapBack.reset();
  }

  /**
   * The server's answer to the outstanding `use`. Read only while it is
   * outstanding, for as long as the retry floor treats it as in flight, since
   * no sentence but the equipped one names the item.
   */
  onBlock(block: Block, before: CharacterState): void {
    const out = this.out;
    if (out === null) return;
    if (this.now() - out.at >= tuning().spells.blessRetryMs) {
      this.out = null;
      return;
    }
    const { use } = out;
    const answer = answerOf(
      block,
      use,
      (printed) => sameSpell(printed, use.spell, before.spellbook, this.sources.spellNamed),
      (printed) => sameItem(printed, use.item)
    );
    if (answer === null) return;
    this.out = null;
    if (answer === 'landed') {
      this.sources.charges.used(use.item);
      return;
    }
    // Tried again next round: the cast gate paces it, not the retry floor.
    this.sentAt.delete(use.item);
    const hold = holdFor(answer, before);
    if (hold === null) return;
    // A charged item at none left is held by the ledger's count, which the cleanup refills.
    const today = hold.answer === 'used-up' && this.charged(use.item);
    if (today) this.saidSpent.add(use.item);
    else this.held.set(use.item, hold);
    this.events.decided?.({
      at: this.now(),
      action: 'use',
      because: use.item,
      acted: false,
      refused: today ? t('automation.invoke.usedUpToday', { item: use.item }) : refusalOf(hold, use)
    });
  }

  /**
   * Considers the pack against the buffs that are up, and asks for at most one.
   *
   * One per state change, deliberately: two `use` commands in a breath is two
   * rounds spent, and the second buff is still there to ask for on the next
   * status line.
   */
  consider(state: CharacterState): void {
    // Watched with the switch off too: a swap started before it went off still
    // has to end with the fighting weapon in hand.
    this.swapBack.check(state);
    if (!this.enabled) return;
    // A `use` spends the round like a cast. Blessing is what you do before a
    // fight, not during one.
    if (state.inCombat) return;
    // A cash run's token is next, and its negate magic would take the blessing off.
    if (this.due.negateDue) return;
    // An unlisted pack is not an empty one — the router and `AutoKeys` refuse
    // on the same silence, and this refuses on it too rather than asking for
    // items nobody has read.
    if (state.inventory.listedAt === null) return;
    // One swap at a time: the hand is not settled until it ends.
    if (this.swapBack.pending) return;

    const now = this.now();
    // Auto Choose Blessings' items where it has chosen; the hand list otherwise.
    const chosen = this.picked.chosenItems() ?? this.chosen;
    if (chosen.length === 0) return;
    for (const carried of state.inventory.items) {
      const name = bareName(carried.name);
      if (!chosenToInvoke(chosen, name)) continue;
      const hold = this.held.get(name);
      if (hold !== undefined && stillHeld(hold, state)) continue;
      this.held.delete(name);
      const found = this.offer(name, carried.equipped, state);
      if (found === null) continue;
      const { spell } = found;

      /*
       * The same retry floor a blessing's own recast uses. A `use` the server
       * swallowed, refused, or answered with a sentence this client does not
       * read must not be re-sent on every status line — and the buff landing
       * is what actually stops it, since the spell's onset is in the message
       * table and reaches `state.buffs`.
       */
      if (now - (this.sentAt.get(name) ?? 0) < tuning().spells.blessRetryMs) continue;

      if (found.swap) {
        if (this.swap(name, found, state, now)) return;
        continue;
      }
      this.queue.enqueue({
        // The item's own name, as the pack listed it: `use` reads everything
        // before the last word as the item, and the last word as an exit —
        // which is why nothing is appended here (see `Walker`'s key rung).
        command: `use ${name}`,
        priority: 'probe',
        coalesceKey: `invoke:${name}`,
        expiresAt: now + tuning().spells.buffExpiresMs,
        reason: t('automation.invoke.reason', { item: name, spell: spell.name }),
        // Spent when the `use` leaves, so one held for the round is proposed
        // again rather than waiting out `blessRetryMs`.
        ...gatedCast(this.gate, spell.name, () => this.used(name, found))
      });
      return;
    }
  }

  /**
   * The weapon hand is wanted for a fight (`EquipmentManager.wieldFor`): the
   * swap's commands still queued are dropped, and the weapon it would have
   * put back is returned for that module to put back after the fight; null
   * where no swap had started.
   */
  yieldHand(): string | null {
    this.queue.cancel((intent) => intent.coalesceKey?.startsWith(SWAP_KEY) === true);
    return this.swapBack.handOver();
  }

  /** The `use` went: the retry floor starts and its answer is read. */
  private used(name: string, found: Offer): void {
    this.sentAt.set(name, this.now());
    this.out = {
      use: { item: name, spell: found.spell.name, several: found.several },
      at: this.now()
    };
  }

  /**
   * A bless weapon in the pack: wielded, used, and the fighting weapon (and a
   * two-hander's off-hand) put back, in one band so nothing of this module's
   * comes between. Only the first command (the off-hand off, or the `wear`)
   * and the `use` can be dropped (a fight, the round's cast spent, expired);
   * once the first has gone the rest always follow, since the swap-back is
   * what must not be lost. False where there is nothing to swap.
   */
  private swap(name: string, found: Offer, state: CharacterState, now: number): boolean {
    // A fight running or asked for (`aa` unanswered) is a fight: never swap into one.
    if (this.sources.fightHere()) return false;
    // Another module's `wear` or `remove` waiting (a gear set, a reach weapon
    // going back): the hand this would put back is not settled yet.
    if (this.queue.queued((intent) => isEquipCommand(intent.command))) return false;
    const plan = offRoundSteps(name, null, state.inventory.items, (item) =>
      this.sources.handsOf(item)
    );
    if (plan === null) return false;
    const { commands, useAt, putBack } = plan;
    const spell = found.spell.name;
    const expiresAt = now + tuning().spells.buffExpiresMs;
    const reason = t('automation.invoke.swapReason', { item: name, spell });
    const wanted = (): boolean => !this.sources.fightHere() && this.gate.mayCast(spell);
    let started = false;
    const last = commands.length - 1;
    const steps = commands.map((command, index): Intent => {
      const step = {
        command,
        priority: 'probe' as const,
        coalesceKey: `${SWAP_KEY}${index}:${command}`,
        reason
      };
      const backSent = (): void => {
        if (index === last) this.swapBack.backSent();
      };
      if (index === 0)
        return {
          ...step,
          expiresAt,
          stillWanted: wanted,
          onSent: () => {
            started = true;
            this.sentAt.set(name, this.now());
            this.swapBack.begun();
            backSent();
          }
        };
      if (index === useAt) {
        const cast = gatedCast(this.gate, spell, () => this.used(name, found));
        return {
          ...step,
          expiresAt,
          ...cast,
          stillWanted: () => started && wanted(),
          onSent: () => {
            cast.onSent();
            backSent();
          }
        };
      }
      return { ...step, stillWanted: () => started, onSent: backSent };
    });
    const [first, ...rest] = steps;
    if (first === undefined) return false;
    // Armed before the offer: the queue may send the first command at once.
    // Nothing to put back (an empty hand): the bless weapon stays wielded.
    if (putBack !== null)
      this.swapBack.queued(name, putBack, () =>
        this.queue.queued((intent) => intent.coalesceKey?.startsWith(SWAP_KEY) === true)
      );
    const offered = this.queue.offer(first);
    // Refused at the door (switched off, held): nothing of the swap goes.
    if (offered !== 'queued' && offered !== 'joined') {
      this.swapBack.reset();
      return false;
    }
    for (const step of rest) this.queue.enqueue(step);
    return true;
  }

  /** A charged item at none left, said once until its uses come back. */
  private saySpent(item: string): void {
    if (this.saidSpent.has(item)) return;
    this.saidSpent.add(item);
    this.events.decided?.({
      at: this.now(),
      action: 'use',
      because: item,
      acted: false,
      refused: t('automation.invoke.usedUpToday', { item })
    });
  }

  /** Whether the realm gives `item` a count of uses rather than for ever. */
  private charged(item: string): boolean {
    return renewingBlessing(item, this.sources)?.capacity.kind === 'charged';
  }

  /**
   * The buff this chosen item would give now, or null when it would give
   * none worth asking for: the realm's reading first, then the hand, the
   * mana, and the buffs that are up. A weapon in the pack is offered as a
   * swap; armour in the pack waits to be worn.
   */
  private offer(name: string, equipped: boolean, state: CharacterState): Offer | null {
    const blessing = renewingBlessing(name, this.sources);
    if (blessing === null) return null;
    if (blessing.capacity.kind === 'charged') {
      const left = this.sources.charges.usesLeft(name);
      if (left === 0) {
        this.saySpent(name);
        return null;
      }
      this.saidSpent.delete(name);
      if (left === null)
        this.sources.charges.lookOnce(name, t('automation.invoke.lookReason', { item: name }));
    }
    const swap = blessing.mustBeEquipped && !equipped;
    if (swap && !blessing.weapon) return null;
    const { spell, several } = blessing;
    if (!canPayFor(state, spell.mana ?? null)) return null;

    // Already up, under its own name or any the establishing sentence could
    // have meant (`sameSpell`: the server prints the whole name).
    if (spellIsUp(state.buffs, spell.name, state.spellbook, this.sources.spellNamed)) return null;
    /*
     * A blessing up that this one takes off, or that takes this one off
     * (`RemovesSpell`, `Spell.cs` applies it on the cast): the one up stays.
     * Zeal takes off the engraved warhorn's blast, so a paladin with zeal on
     * the list would otherwise spend a `use` on every zeal recast.
     */
    const clashes = state.buffs.some((buff) => {
      const removes = this.sources.spellNamed(buff.spell);
      return removes !== null && removes.id !== spell.id && exclusive(removes, spell);
    });
    return clashes ? null : { spell, several, swap };
  }
}

/** What a refusal is said as, on the Spells page and in the notice. */
function refusalOf(hold: InvokeHold, use: UseOut): string {
  const params = { item: use.item, spell: use.spell };
  switch (hold.answer) {
    case 'short-of-mana':
      return t('automation.invoke.shortOfMana', params);
    case 'not-equipped':
      return t('automation.invoke.notEquipped', params);
    case 'used-up':
      return t('automation.invoke.usedUp', params);
    default: {
      const unreachable: never = hold;
      return unreachable;
    }
  }
}
