/**
 * The loot's question about a floor item (todo 77), composed: the character as
 * the slot rankings read it (`slotAskerOf`), the realm's rows, and the items a
 * gear set names while gear sets are on. Out of `SessionManager` whole.
 */
import type { AutomationConfig } from '../../shared/config';
import type { FloorGearReader } from '../../shared/upgrades';
import { floorGear } from '../world/floorGear';
import { slotAskerOf } from '../world/slotGear';
import type { WearerRealm } from '../world/wearer';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';

export function floorGearReader(
  world: (WearerRealm & Pick<WorldGraph, 'item'>) | undefined,
  errands: Pick<Errands, 'realmClass'>,
  configNow: () => AutomationConfig
): FloorGearReader | undefined {
  // No realm data weighs nothing, so the loot owes no read after a kill for it.
  if (world === undefined) return undefined;
  return (floor, state) => {
    const config = configNow();
    const kit = config.gear.enabled ? config.gear.sets.flatMap((set) => set.wear) : [];
    const askerOf = () =>
      slotAskerOf(state, world, errands.realmClass(), config.combat.attack, config);
    return floorGear(floor, state, world, askerOf, kit);
  };
}
