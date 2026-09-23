/**
 * Which kit the character should be in, and getting it there (todo 00).
 *
 * The gear buttons beside this are presses — *put back what was on*, *wear
 * everything* — and what a press cannot say is *these boots while walking and
 * those while fighting*. That is a decision rather than an action, and one the
 * client is already in a position to make: it knows whether a route is under
 * way, whether anything is swinging, and what is being swung at.
 *
 * A set is partial, so the kit is the base (`always`) overlaid by whichever
 * set applies, and the plan is the diff against what is worn. The ordering
 * rules — the off-hand coming off before a two-hander, the weapon hand before
 * the rest — are `swapPlan`'s and pure. See `mudengine-automation` § *The kit
 * is a set of sets, chosen by what is happening*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Priority } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { GearConfig } from '../../shared/config';
import {
  kitFor,
  offRoundPlan,
  overlayFor,
  swapPlan,
  type GearSituation,
  type GearPlan
} from '../../shared/gear';

export interface EquipmentSources {
  /** Which slot the realm says an item goes in, by name, or null. */
  slotOf(name: string): string | null;
  /** One hand or two, off `Items.WeaponType`, or null where the realm cannot say. */
  handsOf(name: string): 1 | 2 | null;
}

export interface EquipmentEvents {
  notice?(message: string): void;
}

export class EquipmentManager {
  /** The set last dressed for, by name, so an unchanged situation sends nothing. */
  private wearing: string | null = null;
  /** When each command was last proposed, so one the server swallowed is not resent per line. */
  private readonly askedAt = new Map<string, number>();
  /** Items said to be missing, once each, until the situation changes. */
  private readonly saidMissing = new Set<string>();
  /** When the off-round invocation last went out. */
  private invokedAt = 0;
  /** Rounds seen since the last invocation, so `everyRounds` counts rounds and not seconds. */
  private roundsSince = 0;

  constructor(
    private config: GearConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: EquipmentSources,
    private readonly events: EquipmentEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: GearConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  /**
   * A new session or a closed socket. The kit is forgotten rather than kept:
   * a character comes back dressed in whatever the server says, and a
   * remembered set would be this module believing it had already dressed one
   * it has never seen.
   */
  reset(): void {
    this.wearing = null;
    this.askedAt.clear();
    this.saidMissing.clear();
    this.invokedAt = 0;
    this.roundsSince = 0;
  }

  private get acting(): boolean {
    return this.enabled && this.config.enabled;
  }

  /**
   * Dress for the situation, on every state change.
   *
   * `moving` is the session's to answer — a route or a lap under way — because
   * it is the one half of the situation that is not on the wire.
   */
  onCharacter(state: CharacterState, moving: boolean): void {
    if (!this.acting || state.phase !== 'in-game') return;
    /*
     * An unlisted pack is not an empty one. Nothing is worn off a listing
     * nobody has read, and nothing is reported missing on its account either —
     * the same refusal `Wards` makes, for the same reason.
     */
    if (state.inventory.listedAt === null) return;

    const now: GearSituation = {
      moving,
      fighting: state.inCombat || state.combat.attackers.length > 0,
      target: state.combat.target
    };
    const set = overlayFor(this.config.sets, now);
    const name = set?.name ?? '';
    if (name !== this.wearing) {
      /*
       * The situation changed, so the floor below has nothing to say about it.
       * Keeping it would be the bug it exists to prevent, inverted: a
       * character that fights, walks and fights again inside half a minute
       * would have the second swap refused by the first one's clock, and
       * stand in the fight in its walking boots.
       */
      this.askedAt.clear();
      this.saidMissing.clear();
      this.wearing = name;
    }

    const kit = kitFor(this.config.sets, now, (item) => this.sources.slotOf(item));
    if (kit.size === 0) return;
    const plan = swapPlan(kit, state.inventory.items, tuning().spending.maxGear, (item) =>
      this.sources.handsOf(item)
    );
    this.send(plan, now.fighting ? 'combat' : 'probe', set);
  }

  /**
   * The off-round invocation, on `AutoCombat`'s own round beat.
   *
   * Its own entry point rather than a branch of `onCharacter`, because a round
   * is a clock and a status line is not: two status lines inside one round
   * would otherwise buy two invocations, and the item has a use count.
   */
  round(state: CharacterState): void {
    if (!this.acting || state.phase !== 'in-game') return;
    const { item, everyRounds } = this.config.offRound;
    if (item.length === 0 || everyRounds <= 0) return;
    if (state.inventory.listedAt === null) return;
    const target = state.combat.target;
    if (target === null) return;

    this.roundsSince += 1;
    if (this.roundsSince < everyRounds) return;
    /*
     * And a floor in wall-clock too, because a round is counted from a tick
     * this module does not own: a fight whose rounds arrive faster than the
     * dance can be sent would queue a second one behind the first.
     */
    const at = this.now();
    if (at - this.invokedAt < tuning().spells.blessRetryMs) return;

    const commands = offRoundPlan(item, target, state.inventory.items, (name) =>
      this.sources.handsOf(name)
    );
    if (commands.length === 0) {
      // Said once per stretch: the pack does not hold it, and every round
      // saying so would be the console talking over the fight.
      if (this.saidMissing.has(item)) return;
      this.saidMissing.add(item);
      this.events.notice?.(t('automation.gear.offRoundMissing', { item }));
      return;
    }

    this.roundsSince = 0;
    this.invokedAt = at;
    for (const [index, command] of commands.entries()) {
      this.queue.enqueue({
        command,
        priority: 'combat',
        // Per step, so the five of a two-handed dance are five intents and
        // not one coalesced into nothing.
        coalesceKey: `offround:${index}:${command}`,
        expiresAt: at + tuning().spells.buffExpiresMs
      });
    }
    this.events.notice?.(t('automation.gear.offRound', { item, target }));
  }

  /** One plan, enqueued, with what it could not do said out loud. */
  private send(plan: GearPlan, priority: Priority, set: { name: string } | null): void {
    const at = this.now();
    for (const command of plan.commands) {
      const asked = this.askedAt.get(command) ?? 0;
      if (at - asked < tuning().spells.blessRetryMs) continue;
      this.askedAt.set(command, at);
      this.queue.enqueue({
        command,
        priority,
        coalesceKey: `gear:${command}`,
        expiresAt: at + tuning().spells.buffExpiresMs
      });
    }
    if (plan.commands.length > 0 && set !== null) {
      this.events.notice?.(t('automation.gear.wearing', { set: set.name }));
    }
    for (const item of plan.missing) {
      if (this.saidMissing.has(item)) continue;
      this.saidMissing.add(item);
      this.events.notice?.(t('automation.gear.missingFromSet', { item }));
    }
    if (plan.overflow > 0) {
      this.events.notice?.(
        t('automation.gear.capped', { max: tuning().spending.maxGear, more: plan.overflow })
      );
    }
  }
}
