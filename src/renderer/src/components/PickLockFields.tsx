import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';
import { picklocksSays } from '../lib/liveSheet';

export interface PickLockFieldsProps {
  pickLocks: boolean;
  pickTries: string;
  onChange(patch: Partial<{ pickLocks: boolean; pickTries: string }>): void;
  /** The stat sheet's `Picklocks`, null while unread. */
  picklocks: number | null;
}

/**
 * The character page's pick-locks switch, its tries, and which way the stat
 * sheet sends it (todo 50): on picks only where `Picklocks` is above 0, so
 * the page says what the sheet answered.
 */
export default function PickLockFields({
  pickLocks,
  pickTries,
  onChange,
  picklocks
}: PickLockFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="settings-inline">
        <CheckField
          checked={pickLocks}
          {...(pickLocks ? { describedBy: 'pick-locks-says' } : {})}
          hint={t('settings.movement.pickLocksHint')}
          label={t('settings.movement.pickLocks')}
          name="pick-locks"
          onChange={(value) => onChange({ pickLocks: value })}
        />
        {pickLocks && (
          <NumberField
            label={t('settings.movement.pickTries')}
            name="pick-tries"
            onChange={(value) => onChange({ pickTries: value })}
            value={pickTries}
          />
        )}
      </div>
      {pickLocks && (
        <p className="settings-note" id="pick-locks-says">
          {picklocksSays(picklocks)}
        </p>
      )}
    </>
  );
}
