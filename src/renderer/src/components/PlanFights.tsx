import { t } from '../lib/i18n';
import { fightWords } from '@shared/navigation';
import type { PlanFight } from '@shared/world';

/**
 * The fights a planned way takes, with the odds: shown, and the player
 * decides (the user, 2026-10-03). Nothing where it takes none. The route
 * panel's list, and the Gear card's trip's chips, from one reading.
 */
export default function PlanFights({
  fights,
  compact = false
}: {
  fights: readonly PlanFight[] | undefined;
  /** As chips in a row, for a tile, rather than a headed list. */
  compact?: boolean;
}) {
  if (fights === undefined || fights.length === 0) return null;
  if (compact) {
    return (
      <span className="plan-fights" data-route-fights={fights.length}>
        {fights.map((fight, index) => (
          <span
            className="chip cased plan-fight"
            data-odds={fight.odds.kind}
            key={`${fight.monsters.join()}-${index}`}
          >
            {fightWords(fight, t)}
          </span>
        ))}
      </span>
    );
  }
  return (
    <div className="route-needs" data-route-fights={fights.length}>
      {t('cards.route.fightsAlong')}
      <ul className="route-blocked">
        {fights.map((fight, index) => (
          <li data-odds={fight.odds.kind} key={`${fight.monsters.join()}-${index}`}>
            {fightWords(fight, t)}
          </li>
        ))}
      </ul>
    </div>
  );
}
