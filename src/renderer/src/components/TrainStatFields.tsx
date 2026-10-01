import { NumberField, SelectField } from './FormField';
import { t } from '../lib/i18n';
import type { TrainPick } from '@shared/config';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from '@shared/training';

export interface TrainStatFieldsProps {
  /** The stem each field's name is built from: `train` or `global-train`. */
  name: string;
  pick: TrainPick;
  onPick(pick: TrainPick): void;
  wanted: Readonly<Record<TrainedAttribute, string | number>>;
  onWanted(attribute: TrainedAttribute, value: string): void;
}

/** Each stat's label, one literal key apiece (`i18n-coverage.test.ts` reads literals). */
function label(attribute: TrainedAttribute): string {
  switch (attribute) {
    case 'strength':
      return t('settings.train.strength');
    case 'intellect':
      return t('settings.train.intellect');
    case 'willpower':
      return t('settings.train.willpower');
    case 'agility':
      return t('settings.train.agility');
    case 'health':
      return t('settings.train.health');
    case 'charm':
      return t('settings.train.charm');
    default: {
      const never: never = attribute;
      return never;
    }
  }
}

/**
 * How character points are spent (`automation.train.pick`, todo 83) and the
 * six figures `wanted` aims at, as both the character's form and the Global
 * page draw them. The figures are shown only where they are what is spent on.
 */
export default function TrainStatFields({
  name,
  pick,
  onPick,
  wanted,
  onWanted
}: TrainStatFieldsProps): React.JSX.Element {
  return (
    <>
      <SelectField
        hint={t('settings.train.pickHint')}
        label={t('settings.train.pick')}
        name={`${name}-pick`}
        onChange={(value) => onPick(value === 'wanted' ? 'wanted' : 'exp')}
        options={[
          { value: 'exp', label: t('settings.train.pickExp') },
          { value: 'wanted', label: t('settings.train.pickWanted') }
        ]}
        value={pick}
      />
      {pick === 'wanted' && (
        <>
          <p className="settings-note">{t('settings.train.wantedNote')}</p>
          <div className="settings-inline">
            {TRAINED_ATTRIBUTES.map((attribute) => (
              <NumberField
                key={attribute}
                label={label(attribute)}
                name={`${name}-${attribute}`}
                onChange={(value) => onWanted(attribute, value)}
                value={wanted[attribute]}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
