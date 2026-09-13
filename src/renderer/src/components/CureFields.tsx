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
 * Which `spellServes` flag each field's own question reads.
 *
 * The names differ on purpose and are not derivable from one another: the
 * settings vocabulary is the condition as a player says it (*poison*), the
 * wire's is the state the character is in (*poisoned*).
 */
const SERVES: Record<(typeof CURES)[number], 'blind' | 'poisoned' | 'diseased'> = {
  blindness: 'blind',
  poison: 'poisoned',
  disease: 'diseased'
};

/**
 * The spells this realm says would end that condition.
 *
 * **A spell the realm cannot place is offered**, which is the rule every
 * picker here keeps: `serves` absent means this build could not read the
 * realm's columns, and a field emptied by ignorance is worse than one holding
 * a spell that turns out not to help. A realm that answers for every spell and
 * says none of them serves leaves the field empty, which is the true answer —
 * the gate beside it has already said the book cannot cure this.
 */
function serving(spells: readonly SpellOption[], cure: (typeof CURES)[number]): SpellOption[] {
  const flag = SERVES[cure];
  return spells.filter((spell) => spell.serves === undefined || spell.serves[flag]);
}

/**
 * The three cures as one three-column row of label-over-field pairs, drawn by
 * both settings forms.
 *
 * **Each field offers only the spells the realm says end its own condition**
 * (todo 00). All three drew the whole book before, so *Cure Poison* listed
 * every spell the character knows; blindness only looked filtered because its
 * gate closes more often. `spellServes` is the one reading, shared with the
 * item picker, and a spell the realm cannot place is offered by all three.
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
            spells={serving(spells, cure)}
            value={cures[cure]}
          />
        );
      })}
    </div>
  );
}
