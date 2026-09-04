import SpellField from './SpellPicker';
import { t } from '../lib/i18n';
import type { SpellOption } from '@shared/ipc';
import type { CureGates } from '@shared/spellcraft';

export interface CuresValue {
  blindness: string;
  poison: string;
  disease: string;
}

export interface CureFieldsProps {
  cures: CuresValue;
  onChange(cures: CuresValue): void;
  spells: readonly SpellOption[];
  /**
   * What the realm says the book can cure — null while no book has been
   * read, which disables nothing: unknown must never switch a cure off.
   */
  gates: CureGates | null;
  namePrefix: string;
}

const CURES = ['blindness', 'poison', 'disease'] as const;

/**
 * The three cures as one three-column row of label-over-field pairs, drawn by
 * both settings forms.
 *
 * A field is disabled — with the reason in its hint — when the character's
 * book has been read and the realm marks nothing in it as curing that
 * condition. Blindness and poison are the realm's own unambiguous marks;
 * disease is only the negative gate (`shared/spellcraft.ts` has the whole
 * argument), and everything stays enabled while the book is unread, because
 * "the client has not looked" is not "the character cannot".
 */
export default function CureFields({
  cures,
  onChange,
  spells,
  gates,
  namePrefix
}: CureFieldsProps): React.JSX.Element {
  return (
    <div className="settings-cures">
      {CURES.map((cure) => {
        const closed = gates !== null && !gates[cure];
        return (
          <SpellField
            disabled={closed}
            hint={closed ? t('settings.spells.cureClosedHint') : t('settings.spells.cureHint')}
            key={cure}
            label={
              cure === 'blindness'
                ? t('settings.spells.cureBlindnessLabel')
                : cure === 'poison'
                  ? t('settings.spells.curePoisonLabel')
                  : t('settings.spells.cureDiseaseLabel')
            }
            name={`${namePrefix}-cure-${cure}`}
            onChange={(value) => onChange({ ...cures, [cure]: value })}
            spells={spells}
            value={cures[cure]}
          />
        );
      })}
    </div>
  );
}
