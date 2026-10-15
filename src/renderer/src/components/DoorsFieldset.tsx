/**
 * The Doors fieldset, one for the character form and the options page: open,
 * pick and bash with their tries, how far under a barrier's number each is
 * tried, and the other three ways past what stands in a route (disarming a
 * trap, searching for a hidden exit, pulling a lever, todo 118). A count
 * shows beside its switch only while the switch is on, on both pages. The
 * character page hands in the stat sheet's Picklocks for the sentence under
 * Auto-Pick Locks.
 */
import { CheckField, NumberField } from './FormField';
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { t } from '../lib/i18n';
import { wholeOf } from '../lib/form';
import { picklocksSays } from '../lib/liveSheet';
import { movementChoices, type MovementChoices } from '@shared/walkChoices';

/** The door switches and their tries, as each page holds them. */
export interface DoorSwitches {
  openDoors: boolean;
  pickLocks: boolean;
  bashDoors: boolean;
  openTries: number | string;
  pickTries: number | string;
  bashTries: number | string;
}

type Tries = 'openTries' | 'pickTries' | 'bashTries';

export type DoorPatch = Partial<
  Pick<DoorSwitches, 'openDoors' | 'pickLocks' | 'bashDoors'> & Record<Tries, string>
>;

type DoorFigure = 'pickMargin' | 'bashMargin' | 'disarmDoubt' | 'leverTries';

export interface DoorsFieldsetProps {
  value: DoorSwitches;
  onChange(patch: DoorPatch): void;
  choices: MovementChoices;
  onChoice(patch: Partial<MovementChoices>): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
  /** The stat sheet's `Picklocks`, null while unread; absent on the options page. */
  picklocks?: number | null;
}

/** A change with the tries as whole numbers, for the page that holds them as the file does. */
export function doorChangeOf(
  patch: DoorPatch
): Partial<Record<'openDoors' | 'pickLocks' | 'bashDoors', boolean> & Record<Tries, number>> {
  const whole = (typed: string | undefined): number | undefined =>
    typed === undefined ? undefined : wholeOf(typed);
  const { openTries, pickTries, bashTries, ...switches } = patch;
  const tries = {
    openTries: whole(openTries),
    pickTries: whole(pickTries),
    bashTries: whole(bashTries)
  };
  return {
    ...switches,
    ...Object.fromEntries(Object.entries(tries).filter(([, value]) => value !== undefined))
  };
}

export default function DoorsFieldset({
  value,
  onChange,
  choices,
  onChoice,
  namePrefix,
  picklocks
}: DoorsFieldsetProps): React.JSX.Element {
  const says = `${namePrefix}pick-locks-says`;
  const sheet = picklocks !== undefined && value.pickLocks;
  // A figure beside its switch, a cell of the switch's own row.
  const figure = (row: ChoiceRow<DoorFigure>): React.JSX.Element => (
    <ChoiceFields
      bare
      namePrefix={namePrefix}
      onChange={onChoice}
      read={movementChoices}
      rows={[row]}
      values={choices}
    />
  );
  return (
    <fieldset className="settings-menus" data-fieldset="movement-doors">
      <legend>{t('settings.movement.doorsLegend')}</legend>
      <div className="settings-inline">
        <CheckField
          checked={value.openDoors}
          hint={t('settings.movement.openDoorsHint')}
          label={t('settings.movement.openDoors')}
          name={`${namePrefix}open-doors`}
          setting="automation.movement.openDoors"
          onChange={(checked) => onChange({ openDoors: checked })}
        />
        {value.openDoors && (
          <NumberField
            label={t('settings.movement.openTries')}
            name={`${namePrefix}open-tries`}
            setting="automation.movement.openTries"
            onChange={(typed) => onChange({ openTries: typed })}
            value={value.openTries}
          />
        )}
      </div>
      {/* Picking above bashing, in the order the walk tries them: a failed
        pick costs a command, a failed bash a command and some health. */}
      <div className="settings-inline">
        <CheckField
          checked={value.pickLocks}
          {...(sheet ? { describedBy: says } : {})}
          hint={t('settings.movement.pickLocksHint')}
          label={t('settings.movement.pickLocks')}
          name={`${namePrefix}pick-locks`}
          setting="automation.movement.pickLocks"
          onChange={(checked) => onChange({ pickLocks: checked })}
        />
        {value.pickLocks && (
          <>
            <NumberField
              label={t('settings.movement.pickTries')}
              name={`${namePrefix}pick-tries`}
              setting="automation.movement.pickTries"
              onChange={(typed) => onChange({ pickTries: typed })}
              value={value.pickTries}
            />
            {figure({
              field: 'pickMargin',
              name: 'pick-margin',
              setting: 'automation.movement.pickMargin',
              label: t('settings.movement.pickMargin'),
              hint: t('settings.movement.pickMarginHint')
            })}
          </>
        )}
      </div>
      {sheet && (
        <p className="settings-note" id={says}>
          {picklocksSays(picklocks)}
        </p>
      )}
      <div className="settings-inline">
        <CheckField
          checked={value.bashDoors}
          hint={t('settings.movement.bashDoorsHint')}
          label={t('settings.movement.bashDoors')}
          name={`${namePrefix}bash-doors`}
          setting="automation.movement.bashDoors"
          onChange={(checked) => onChange({ bashDoors: checked })}
        />
        {value.bashDoors && (
          <>
            <NumberField
              label={t('settings.movement.bashTries')}
              name={`${namePrefix}bash-tries`}
              setting="automation.movement.bashTries"
              onChange={(typed) => onChange({ bashTries: typed })}
              value={value.bashTries}
            />
            {figure({
              field: 'bashMargin',
              name: 'bash-margin',
              setting: 'automation.movement.bashMargin',
              label: t('settings.movement.bashMargin'),
              hint: t('settings.movement.bashMarginHint')
            })}
          </>
        )}
      </div>
      <div className="settings-inline">
        <CheckField
          checked={choices.disarmTraps}
          hint={t('settings.movement.disarmTrapsHint')}
          label={t('settings.movement.disarmTraps')}
          name={`${namePrefix}disarm-traps`}
          setting="automation.movement.disarmTraps"
          onChange={(checked) => onChoice({ disarmTraps: checked })}
        />
        {choices.disarmTraps &&
          figure({
            field: 'disarmDoubt',
            name: 'disarm-doubt',
            setting: 'automation.movement.disarmDoubt',
            label: t('settings.movement.disarmDoubt'),
            hint: t('settings.movement.disarmDoubtHint'),
            share: true
          })}
      </div>
      <div className="settings-inline">
        <CheckField
          checked={choices.searchHidden}
          hint={t('settings.movement.searchHiddenHint')}
          label={t('settings.movement.searchHidden')}
          name={`${namePrefix}search-hidden`}
          setting="automation.movement.searchHidden"
          onChange={(checked) => onChoice({ searchHidden: checked })}
        />
      </div>
      <div className="settings-inline">
        <CheckField
          checked={choices.pullLevers}
          hint={t('settings.movement.pullLeversHint')}
          label={t('settings.movement.pullLevers')}
          name={`${namePrefix}pull-levers`}
          setting="automation.movement.pullLevers"
          onChange={(checked) => onChoice({ pullLevers: checked })}
        />
        {choices.pullLevers &&
          figure({
            field: 'leverTries',
            name: 'lever-tries',
            setting: 'automation.movement.leverTries',
            label: t('settings.movement.leverTries')
          })}
      </div>
    </fieldset>
  );
}
