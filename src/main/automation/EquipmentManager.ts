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
import { fightIsRunning, type CarriedItem, type CharacterState } from '../../shared/character';
import type { GearConfig } from '../../shared/config';
import { mobKey } from '../../shared/world';
import { backstabWorth, derivedBackstabWeapon, withBackstabWeapon } from '../../shared/backstab';
import {
  heldWeapon,
  kitFor,
  WEAPON_KEY,
  offRoundPlan,
  overlayFor,
  swapPlan,
  type GearSet,
  type GearSituation,
  type GearPlan,
  type PlaceLayer,
  type Wearer,
  NO_PLACE,
  placeKey
} from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { BackstabHands } from './BackstabHands';
import type { SessionModule } from './Module';
import { PlaceGear, type PlaceGearSources } from './PlaceGear';

export interface EquipmentSources extends PlaceGearSources {
  /** Which slot the realm says an item goes in, by name, or null. */
  slotOf(name: string): string | null;
  /** One hand or two, off `Items.WeaponType`, or null where the realm cannot say. */
  handsOf(name: string): 1 | 2 | null;
  /** Whether the next fight opens with a backstab with these in hand (`AutoCombat`). */
  opensWithBackstab(weapons: readonly string[]): boolean;
  /**
   * Hands the weapon hand over from a bless weapon's swap (`AutoInvoke.yieldHand`):
   * what is left of it is dropped and the weapon it would have put back is
   * returned, or null where no swap had started.
   */
  yieldSwap(): string | null;
  /** Whether a rest is wanted and the client may sit the character down (`Recovery.wouldRest`, `mayRest`). */
  wantsRest(state: CharacterState): boolean;
  /** Who the character is, for which carried weapons it may wield (`wearerOf`). */
  wearer(): Wearer;
  /** Whether the server refused a backstab with this weapon this session (`AutoCombat`). */
  refusesBackstabWith(weapon: string): boolean;
}

export interface EquipmentEvents {
  notice?(message: string): void;
}

export class EquipmentManager implements SessionModule {
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
  /**
   * The weapon put in hand for a monster the hand could not hurt (todo 46),
   * what it replaced, that monster's key, and whether a fight has been seen
   * since: the old weapon waits for that fight to end, not for the line
   * before it opens.
   */
  private reached: {
    weapon: string;
    was: string | null;
    target: string;
    fought: boolean;
  } | null = null;
  /** The armour the room calls for (todo 69). */
  private readonly place: PlaceGear;
  /** What the place layer last asked for, so its notice is said once a change. */
  private placeSaid = '';
  /** What the hands held before a derived backstab weapon, to put back after it (todo 76). */
  private readonly hands = new BackstabHands();
  /** Backstab weapons said to be carried while the sets are off, once each a session. */
  private readonly saidBackstab = new Set<string>();

  constructor(
    private config: GearConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: EquipmentSources,
    private readonly events: EquipmentEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.place = new PlaceGear(sources);
  }

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
    this.reached = null;
    this.place.reset();
    this.placeSaid = '';
    this.hands.reset();
    this.saidBackstab.clear();
  }

  /** The player's own sets. */
  private get acting(): boolean {
    return this.enabled && this.config.enabled;
  }

  /** The armour the room calls for, its own switch (`automation.gear.resists`). */
  private get placing(): boolean {
    return this.enabled && this.config.resists;
  }

  /**
   * Dress for the situation, on every state change.
   *
   * `moving` is the session's to answer — a route or a lap under way — because
   * it is the one half of the situation that is not on the wire.
   */
  onCharacter(state: CharacterState, moving: boolean): void {
    this.dress(state, moving, false);
  }

  /** `stepping` is the walker's next step about to go, which stands a resting character up. */
  private dress(state: CharacterState, moving: boolean, stepping: boolean): void {
    if (state.phase !== 'in-game') return;
    /*
     * Down, and no step about to go: a `wear` would stand the character up
     * (`EquipCommand.cs:135,143`) and the next rest tick would pay nothing
     * (`CalcRestTick`'s `BeenResting`). The resting set goes on before the
     * `rest`, ahead of it in the same band; anything else, the reach weapon's
     * return included, waits for the step or the fight that stands it up anyway.
     */
    const down = state.vitals.resting || state.vitals.meditating;
    const holding = down && !stepping && !fightIsRunning(state);
    if (!holding) this.reachedBack(state);
    if (!this.acting) this.sayBackstabWeapon(state);
    if (!this.acting && !this.placing) return;
    /*
     * An unlisted pack is not an empty one. Nothing is worn off a listing
     * nobody has read, and nothing is reported missing on its account either —
     * the same refusal `Wards` makes, for the same reason.
     */
    if (state.inventory.listedAt === null) return;

    const sets = this.acting ? this.setsFor(state) : [];
    const now: GearSituation = {
      moving,
      resting: !stepping && (down || this.sources.wantsRest(state)),
      fighting: state.inCombat || state.combat.attackers.length > 0,
      backstab: this.opensWithBackstab(sets),
      target: state.combat.target
    };
    const set = overlayFor(sets, now);
    const layer = this.placing ? this.place.layer(state, now.fighting) : NO_PLACE;
    // The place is part of the situation: walking out of the desert and back
    // in inside the retry floor must still put the armour back on.
    const name = `${set?.name ?? ''}|${placeKey(layer)}`;
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

    if (holding) return;

    const kit = kitFor(
      sets,
      now,
      (item) => this.sources.slotOf(item),
      layer,
      (item) => this.sources.handsOf(item)
    );
    // A weapon wielded for a monster the hand cannot hurt outranks a set's until it goes back.
    if (this.reached !== null && kit.has(WEAPON_KEY)) kit.set(WEAPON_KEY, this.reached.weapon);
    if (kit.size === 0) return;
    this.sayPlace(layer, state);
    const plan = swapPlan(kit, state.inventory.items, tuning().spending.maxGear, (item) =>
      this.sources.handsOf(item)
    );
    this.send(plan, bandFor(now, set), set);
  }

  /**
   * Put a carried weapon in hand because the one there cannot hurt `target`
   * (`AutoCombatEvents.wield`, todo 46). Not gated on the gear sets: it is
   * the attack's own precondition, sent in `combat` so the queue keeps it
   * ahead of the attack that asked for it.
   */
  wieldFor(state: CharacterState, weapon: string, target: string): void {
    if (!this.enabled || state.inventory.listedAt === null) return;
    if (!this.wieldInHand(state, weapon, 'combat')) return;
    // A bless weapon's swap mid-way: the weapon it would put back is the one to come home.
    const swapped = this.sources.yieldSwap();
    const was = this.reached?.was ?? swapped ?? heldWeapon(state.inventory.items)?.name ?? null;
    this.reached = { weapon, was, target: mobKey(target), fought: false };
    this.events.notice?.(t('automation.gear.reachWield', { weapon, target }));
  }

  /**
   * The weapon that was in hand before `wieldFor`, back once its fight is
   * over, or once the monster is no longer in the room with no fight on
   * (the attack never opened one, or the character moved on).
   */
  private reachedBack(state: CharacterState): void {
    const reached = this.reached;
    if (reached === null) return;
    if (fightIsRunning(state)) {
      if (!reached.fought) this.reached = { ...reached, fought: true };
      return;
    }
    const here = state.room.occupants.some(
      (who) => who.kind === 'mob' && mobKey(who.name) === reached.target
    );
    if (!reached.fought && here) return;
    this.reached = null;
    if (reached.was === null || !this.enabled) return;
    if (this.wieldInHand(state, reached.was, 'probe')) {
      this.events.notice?.(t('automation.gear.reachBack', { weapon: reached.was }));
    }
  }

  /** `swapPlan` for the weapon hand alone; whether anything was sent. */
  private wieldInHand(state: CharacterState, weapon: string, band: Priority): boolean {
    const plan = swapPlan(
      new Map([[WEAPON_KEY, weapon]]),
      state.inventory.items,
      tuning().spending.maxGear,
      (item) => this.sources.handsOf(item)
    );
    if (plan.commands.length === 0) return false;
    this.send(plan, band, null);
    return true;
  }

  /** Said once each time the place layer changes what it wants on, and only for what is not on yet. */
  private sayPlace(layer: PlaceLayer, state: CharacterState): void {
    const key = placeKey(layer);
    if (key === this.placeSaid) return;
    this.placeSaid = key;
    const off = (names: Iterable<string>): string[] =>
      [...names].filter(
        (name) => !state.inventory.items.some((item) => item.equipped && sameItem(item.name, name))
      );
    const wear = off(layer.wear.values());
    const back = off(layer.putBack.values());
    if (wear.length > 0) {
      this.events.notice?.(t('automation.gear.forPlace', { items: wear.join(', ') }));
    }
    if (back.length > 0) {
      this.events.notice?.(t('automation.gear.placeBack', { items: back.join(', ') }));
    }
  }

  /** Whether a backstab set is written or derived and the next fight opens with its weapon. */
  private opensWithBackstab(sets: readonly GearSet[]): boolean {
    const set = sets.find((each) => each.when === 'backstab');
    return set !== undefined && this.sources.opensWithBackstab(set.wear);
  }

  /**
   * The written sets, with the pack's best backstab weapon laid in where the
   * player wrote no backstab set (todo 76). A weapon the next fight would not
   * open with (refused this session, or no backstab opener at all) is never
   * chosen, so nothing changes for a character that does not backstab.
   */
  private setsFor(state: CharacterState): readonly GearSet[] {
    const written = this.config.sets;
    const items = state.inventory.items;
    const derived = this.derive(state);
    // Chosen only for a fight that opens with it, so a weapon wielded by hand otherwise is the player's own.
    const weapon =
      derived !== null && this.sources.opensWithBackstab([derived.name]) ? derived : null;
    const hands = this.hands.note(items, weapon?.name ?? null);
    const chosen =
      weapon === null
        ? null
        : { set: t('automation.gear.backstabWeapon', { item: weapon.name }), item: weapon.name };
    return withBackstabWeapon(written, chosen, hands, (item) => this.sources.slotOf(item));
  }

  /**
   * The carried weapon the sets wear for a backstab, or null: none with the
   * sets off, a backstab set written, or the pack unlisted. The one answer
   * the opener choice reads too (`FightWordParts.backstabWeapon`).
   */
  backstabWeapon(state: CharacterState): CarriedItem | null {
    return this.acting ? this.derive(state) : null;
  }

  /** `derivedBackstabWeapon` over the pack, a weapon the server refused this session left out. */
  private derive(state: CharacterState): CarriedItem | null {
    if (state.inventory.listedAt === null) return null;
    return derivedBackstabWeapon(
      this.config.sets,
      state.inventory.items,
      this.sources.wearer(),
      (name) => this.sources.refusesBackstabWith(name)
    );
  }

  /**
   * With the sets off, a carried weapon that would backstab harder than the
   * one in hand is said once (todo 76): wearing it unasked would break stealth
   * on a character the player has not given the hand to.
   */
  private sayBackstabWeapon(state: CharacterState): void {
    if (!this.enabled || state.inventory.listedAt === null) return;
    const items = state.inventory.items;
    const hand = heldWeapon(items);
    if (hand === undefined || !this.sources.opensWithBackstab([hand.name])) return;
    const better = this.derive(state);
    if (better === null || this.saidBackstab.has(better.name)) return;
    if ((backstabWorth(better) ?? 0) <= (backstabWorth(hand) ?? 0)) return;
    this.saidBackstab.add(better.name);
    this.events.notice?.(
      t('automation.gear.betterBackstabWeapon', { item: better.name, hand: hand.name })
    );
  }

  /**
   * The walker's next step is about to go. Dressed again here because a
   * `wear` breaks stealth (`EquipCommand.cs:138,165`): the backstab set has
   * to reach the wire before the `sn` that `Walker.sneakFirst` sends next,
   * in the same band, and the queue keeps a band's order.
   */
  beforeStep(state: CharacterState): void {
    this.dress(state, true, true);
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
    let asked = 0;
    for (const command of plan.commands) {
      if (at - (this.askedAt.get(command) ?? 0) < tuning().spells.blessRetryMs) continue;
      this.askedAt.set(command, at);
      asked += 1;
      this.queue.enqueue({
        command,
        priority,
        coalesceKey: `gear:${command}`,
        expiresAt: at + tuning().spells.buffExpiresMs
      });
    }
    // Said when something went, so the walker asking before each step does not repeat it.
    if (asked > 0 && set !== null) {
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

/**
 * The band a swap goes out in. A fight's in `combat`; the backstab set's in
 * `movement`, the walker's own, so it is ahead of the next `sn` rather than
 * behind the step; anything else waits in `probe`.
 */
function bandFor(now: GearSituation, set: GearSet | null): Priority {
  if (now.fighting) return 'combat';
  return set?.when === 'backstab' ? 'movement' : 'probe';
}
