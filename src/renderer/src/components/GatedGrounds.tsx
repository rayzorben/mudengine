import { t } from '../lib/i18n';
import type { GatedGround } from '@shared/hunting';

/** One ground's line: its monsters, the level the way admits from, the steps. */
export function gatedRow(ground: GatedGround): string {
  return t('cards.hunting.locked.row', {
    mobs: ground.mobs.join(', '),
    level: ground.level,
    steps: ground.steps.toLocaleString()
  });
}

/**
 * The hunting grounds a level gate on the way shuts (todo 2322-01), greyed
 * under the rated spots: what a level opens, and the level the way there
 * admits from. Listed, never rated or walked, so nothing here is a button.
 */
export default function GatedGrounds({
  grounds
}: {
  grounds: readonly GatedGround[];
}): React.JSX.Element | null {
  if (grounds.length === 0) return null;
  return (
    <section className="hunt-gated" data-gated="true">
      <h4>{t('cards.hunting.locked.heading')}</h4>
      <ul>
        {grounds.map((ground) => (
          <li key={ground.key}>
            {gatedRow(ground)}
            {ground.experience === null ? null : (
              <span className="chip quiet">
                {t('cards.hunting.locked.pays', { exp: ground.experience.toLocaleString() })}
              </span>
            )}
            <span className="chip quiet">
              {t('cards.hunting.locked.rooms', { count: ground.roomCount })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
