/**
 * One row of what the realm says about a monster, as a `dt`/`dd` pair inside
 * a card's one `.readout`: the Reference card's detail and the Combat card's
 * target at its large size (todo 06) draw it the same way. Absent when the
 * realm does not say.
 */
import type { WorldMob } from '@shared/world';
import { t } from '../lib/i18n';

export type MobFact = 'experience' | 'magicResist' | 'undead';

export default function MobFactRow({
  mob,
  fact,
  className
}: {
  mob: Pick<WorldMob, MobFact>;
  fact: MobFact;
  /** On the label and the value both, as a size class (`lib/cardSize.ts`). */
  className?: string;
}) {
  const row = (label: string, value: string | number) => (
    <>
      <dt className={className}>{label}</dt>
      <dd className={className}>{value}</dd>
    </>
  );
  switch (fact) {
    case 'experience':
      return mob.experience === undefined
        ? null
        : row(t('cards.reference.mob.experienceLabel'), mob.experience.toLocaleString());
    case 'magicResist':
      return mob.magicResist === undefined
        ? null
        : row(t('cards.reference.mob.magicResistLabel'), mob.magicResist);
    case 'undead':
      return mob.undead === true
        ? row(t('cards.reference.mob.undeadLabel'), t('cards.reference.mob.undeadYes'))
        : null;
    default: {
      const never: never = fact;
      return never;
    }
  }
}
