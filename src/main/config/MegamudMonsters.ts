import { normalizeMobRules, type MobRule } from '../../shared/mobRules';
import { ShippedList } from './ShippedList';

/** Room for MegaMUD's whole table, which is 690 rows today. */
const SHIPPED_MOST = 4096;

/**
 * MegaMUD's monster table as monster list rows (todo 817): the lowest scope
 * on every realm, beneath the options file's, the realm's and the
 * character's. `resources/megamud/monsters.yaml` is written once by
 * `npm run build:megamud` and read here through the same parser the options
 * file goes through, so a shipped row means what a typed one does. See
 * `mudengine-automation` › `parts/combat.md` › *MegaMUD's monster table is the
 * lowest scope*.
 */
export class MegamudMonsters extends ShippedList<MobRule> {
  constructor(file: string) {
    super(file, 'mobRules', (value) => normalizeMobRules(value, SHIPPED_MOST));
  }
}
