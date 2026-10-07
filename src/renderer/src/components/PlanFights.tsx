import { t } from '../lib/i18n';
import { fightWords } from '@shared/navigation';
import type { PlanFight } from '@shared/world';

/**
 * The fights a planned way takes, with the odds: shown, and the player
 * decides (the user, 2026-10-03). Nothing where it takes none. The route
 * panel's and the Gear card's trip, one list.
 */
export default function PlanFights({ fights }: { fights: readonly PlanFight[] | undefined }) {
  if (fights === undefined || fights.length === 0) return null;
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
