/**
 * Gear on the floor better than what is worn (todo 77): taken, then put on.
 * Owned by `AutoLoot`, as `FloorAfterKill` is. The weighing is
 * `world/floorGear.ts`; this says why on the loot line, says each refusal once,
 * and puts the item on once the pack holds it and no fight or rest is on.
 * What comes off is outgrown gear, and `OutgrownGear` stashes, sells or drops
 * it by worth when that is switched on.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import type { ItemEntity } from '../../shared/entities';
import { wearPlan } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import type { FloorGear, FloorGearReader } from '../../shared/upgrades';
import { offerEach, type CommandQueue } from './CommandQueue';

type Better = Extract<FloorGear, { kind: 'better' }>;

export class FoundGear {
  /** Taken for wearing, by name: what the pack confirming it puts on. */
  private readonly pending = new Map<string, Better>();
  /** Refusals already said, `name|why`: once a session, as the coin clash is. */
  private readonly said = new Set<string>();

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly read: FloorGearReader | undefined,
    private readonly notice: (message: string) => void
  ) {}

  /** Whether a floor item can be weighed: false with no world database, and no kill read is owed. */
  get weighs(): boolean {
    return this.read !== undefined;
  }

  /**
   * The loot line's reason to take `floor`, or null where it is no better or is
   * refused (said). `overCeiling` is Max Item Weight's refusal, said the same way.
   */
  consider(
    floor: ItemEntity,
    listed: string,
    state: CharacterState,
    overCeiling: boolean
  ): string | null {
    const gear = this.read?.(floor, state) ?? null;
    if (gear === null) return null;
    switch (gear.kind) {
      case 'better':
        if (overCeiling) {
          this.refused(floor.name, {
            kind: 'refused',
            slot: gear.slot,
            why: 'ceiling',
            worn: null
          });
          return null;
        }
        this.pending.set(floor.name.toLowerCase(), gear);
        return gear.over === null
          ? t('automation.loot.reasonGearEmpty', { item: listed, slot: gear.slot })
          : t('automation.loot.reasonGear', { item: listed, worn: gear.over, slot: gear.slot });
      case 'refused':
        this.refused(floor.name, gear);
        return null;
      default: {
        const never: never = gear;
        return never;
      }
    }
  }

  /** Puts on what was taken, once the pack holds it unworn and nothing else has the character. */
  onCharacter(state: CharacterState): void {
    if (this.pending.size === 0 || state.inCombat) return;
    if (state.vitals.resting || state.vitals.meditating) return;
    for (const [name, gear] of this.pending) {
      const held = state.inventory.items.find((item) => sameItem(item.name, name));
      if (held === undefined) continue;
      this.pending.delete(name);
      if (held.equipped) continue;
      const wanted = [{ name: held.name, replaces: gear.replaces, hands: gear.hands }];
      const reason = t('automation.loot.reasonWear', { item: held.name, slot: gear.slot });
      const expiresAt = Date.now() + tuning().loot.expiresMs;
      const unsent = offerEach(this.queue, wearPlan(wanted, state.inventory.items), (command) => ({
        command,
        priority: 'probe',
        coalesceKey: `loot:wear:${command}`,
        expiresAt,
        reason
      }));
      if (unsent.length > 0) {
        this.notice(t('automation.loot.notWorn', { item: held.name, commands: unsent.join(', ') }));
      }
    }
  }

  /** A new room: what was not picked up there is not owed a wear. */
  leftRoom(state: CharacterState): void {
    for (const name of this.pending.keys()) {
      if (!state.inventory.items.some((item) => sameItem(item.name, name))) {
        this.pending.delete(name);
      }
    }
  }

  reset(): void {
    this.pending.clear();
    this.said.clear();
  }

  private refused(name: string, gear: Extract<FloorGear, { kind: 'refused' }>): void {
    const key = `${name.toLowerCase()}|${gear.why}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    const worn = gear.worn ?? '';
    switch (gear.why) {
      case 'heavy':
        this.notice(t('automation.loot.gearHeavy', { item: name, slot: gear.slot }));
        return;
      case 'ceiling':
        this.notice(t('automation.loot.gearCeiling', { item: name, slot: gear.slot }));
        return;
      case 'unread':
        this.notice(t('automation.loot.gearUnread', { item: name, slot: gear.slot }));
        return;
      case 'kit':
        this.notice(t('automation.loot.gearKit', { item: name, slot: gear.slot, worn }));
        return;
      case 'hands':
        this.notice(t('automation.loot.gearHands', { item: name, worn }));
        return;
      case 'locked':
        this.notice(t('automation.loot.gearLocked', { item: name, slot: gear.slot, worn }));
        return;
      default: {
        const never: never = gear.why;
        return never;
      }
    }
  }
}
