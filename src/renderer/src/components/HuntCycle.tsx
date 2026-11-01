import { memo, useMemo } from 'react';

import SplitBar, { type SplitPart } from './viz/SplitBar';
import { seconds } from '../lib/huntWords';
import { t } from '../lib/i18n';
import type { SpotEstimate } from '@shared/hunting';

/**
 * Where a lap of a hunting spot goes, as one split bar: fighting, resting,
 * meditating, walking and waiting for the lair to regen. The same seconds the
 * detail's *One lap* row states in words; a part nobody could price is left
 * out of the bar rather than drawn as none, and the bar is not drawn at all
 * where the fight or the rest is unknown.
 */
function HuntCycle({ estimate }: { estimate: SpotEstimate }) {
  const { combatSeconds, restSeconds, meditateSeconds, walkSeconds, waitSeconds } = estimate;
  const parts = useMemo(
    (): SplitPart[] | null =>
      combatSeconds === null || restSeconds === null
        ? null
        : [
            {
              key: 'fight',
              label: t('cards.hunting.cycle.fight'),
              tone: 'foe',
              value: combatSeconds
            },
            { key: 'rest', label: t('cards.hunting.cycle.rest'), tone: 'hp', value: restSeconds },
            ...(meditateSeconds !== null && meditateSeconds > 0
              ? [
                  {
                    key: 'meditate',
                    label: t('cards.hunting.cycle.meditate'),
                    tone: 'mana' as const,
                    value: meditateSeconds
                  }
                ]
              : []),
            { key: 'walk', label: t('cards.hunting.cycle.walk'), tone: 'c', value: walkSeconds },
            ...(waitSeconds === null
              ? []
              : [
                  {
                    key: 'wait',
                    label: t('cards.hunting.cycle.wait'),
                    tone: 'quiet' as const,
                    value: waitSeconds
                  }
                ])
          ],
    [combatSeconds, restSeconds, meditateSeconds, walkSeconds, waitSeconds]
  );
  if (parts === null) return null;
  return <SplitBar format={seconds} label={t('cards.hunting.cycle.label')} parts={parts} />;
}

export default memo(HuntCycle);
