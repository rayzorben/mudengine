/**
 * A monster row that overrules the realm's disposition, said once a connection
 * per monster (todo 818). What the automation does beside such a monster —
 * opening on it, resting beside it, counting the crowd, running the fight —
 * follows the row (`attacksFirst`), while the Room card keeps the realm's
 * *hostile*; this is the sentence that says why the two disagree. Its own unit,
 * since it explains every one of those readers and belongs to none of them.
 * `mudengine-automation` › `parts/combat.md` › *A row's does not attack first
 * is believed, and shown beside the realm's*.
 */
import { t } from '../app/i18n';
import { ownAlignment, type CharacterState } from '../../shared/character';
import type { AutomationConfig, CombatConfig } from '../../shared/config';
import { attacksOnSight } from '../../shared/mobs';
import { rowPeaceFor, type RowPeace } from '../../shared/mobRules';
import { mobKey } from '../../shared/world';
import type { SessionModule } from './Module';

/** What a reload hands it: the master switch and the monster rows. */
export type RowOverridesSettings = Pick<AutomationConfig, 'enabled'> & {
  combat: Pick<CombatConfig, 'mobRules'>;
};

export interface RowOverridesEvents {
  notice(message: string): void;
}

/** The sentence for each claim a row can make over the realm. */
function overrideWords(peace: RowPeace, target: string): string {
  switch (peace) {
    case 'friend':
      return t('automation.combat.overrideFriend', { target });
    case 'not-hostile':
      return t('automation.combat.overrideNotHostile', { target });
    default: {
      const unreachable: never = peace;
      return unreachable;
    }
  }
}

export class RowOverrides implements SessionModule {
  /** Monsters already said, by key. */
  private readonly said = new Set<string>();

  constructor(
    private settings: RowOverridesSettings,
    private readonly events: RowOverridesEvents
  ) {}

  configure(settings: RowOverridesSettings): void {
    this.settings = settings;
  }

  /** A new connection, or the realm left: said again to the character that comes. */
  reset(): void {
    this.said.clear();
  }

  /** Every state: a monster here whose row contradicts the realm, said the first time. */
  onCharacter(state: CharacterState): void {
    const rules = this.settings.combat.mobRules;
    if (!this.settings.enabled || rules.length === 0 || state.phase !== 'in-game') return;
    const mine = ownAlignment(state);
    for (const who of state.room.occupants) {
      if (who.kind !== 'mob') continue;
      const peace = rowPeaceFor(rules, who.name);
      if (peace === null || attacksOnSight(who.disposition, mine) !== true) continue;
      const key = mobKey(who.name);
      if (this.said.has(key)) continue;
      this.said.add(key);
      this.events.notice(overrideWords(peace, who.name));
    }
  }
}
