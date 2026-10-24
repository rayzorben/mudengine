/**
 * What a route pays for what it walks through (todo 118), one fieldset for the
 * character form and the options page beside Avoiding: a fight and a lair in
 * steps, how Another way is looked for, and how long a trip goes round a room
 * this character ran from, whether a walk buys a key on the way (todo 02), how
 * long a chance way is tried and the most a fare may be (todo 20261024-0804-01).
 * The router reads them per request, so each character's own figures price
 * its own routes.
 */
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { CheckField } from './FormField';
import { t } from '../lib/i18n';
import { movementChoices, type MovementChoices } from '@shared/walkChoices';

type RoutePrice =
  | 'fightCost'
  | 'dangerCost'
  | 'anotherWayPenalty'
  | 'anotherWayLonger'
  | 'avoidRanFromMinutes'
  | 'chanceTries'
  | 'fareShare';

export interface RoutingFieldsetProps {
  choices: MovementChoices;
  onChoice(patch: Partial<MovementChoices>): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

function rows(): ReadonlyArray<ChoiceRow<RoutePrice>> {
  return [
    {
      field: 'fightCost',
      name: 'fight-cost',
      setting: 'automation.movement.fightCost',
      label: t('settings.movement.fightCost'),
      hint: t('settings.movement.fightCostHint')
    },
    {
      field: 'dangerCost',
      name: 'danger-cost',
      setting: 'automation.movement.dangerCost',
      label: t('settings.movement.dangerCost'),
      hint: t('settings.movement.dangerCostHint')
    },
    {
      field: 'anotherWayPenalty',
      name: 'another-way-penalty',
      setting: 'automation.movement.anotherWayPenalty',
      label: t('settings.movement.anotherWayPenalty'),
      hint: t('settings.movement.anotherWayPenaltyHint')
    },
    {
      field: 'anotherWayLonger',
      name: 'another-way-longer',
      setting: 'automation.movement.anotherWayLonger',
      label: t('settings.movement.anotherWayLonger'),
      hint: t('settings.movement.anotherWayLongerHint'),
      share: true
    },
    {
      field: 'avoidRanFromMinutes',
      name: 'avoid-ran-from',
      setting: 'automation.movement.avoidRanFromMinutes',
      label: t('settings.movement.avoidRanFrom'),
      hint: t('settings.movement.avoidRanFromHint')
    },
    {
      field: 'chanceTries',
      name: 'chance-tries',
      setting: 'automation.movement.chanceTries',
      label: t('settings.movement.chanceTries'),
      hint: t('settings.movement.chanceTriesHint')
    },
    {
      field: 'fareShare',
      name: 'fare-share',
      setting: 'automation.movement.fareShare',
      label: t('settings.movement.fareShare'),
      hint: t('settings.movement.fareShareHint')
    }
  ];
}

export default function RoutingFieldset({
  choices,
  onChoice,
  namePrefix
}: RoutingFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="movement-routing">
      <legend>{t('settings.movement.routingLegend')}</legend>
      <ChoiceFields
        namePrefix={namePrefix}
        onChange={onChoice}
        read={movementChoices}
        rows={rows()}
        values={choices}
      />
      <div className="settings-inline">
        <CheckField
          checked={choices.buyKeys}
          hint={t('settings.movement.buyKeysHint')}
          label={t('settings.movement.buyKeys')}
          name={`${namePrefix}buy-keys`}
          setting="automation.movement.buyKeys"
          onChange={(checked) => onChoice({ buyKeys: checked })}
        />
        {choices.buyKeys && (
          <ChoiceFields
            bare
            namePrefix={namePrefix}
            onChange={onChoice}
            read={movementChoices}
            rows={[
              {
                field: 'buyKeysMaxGold',
                name: 'buy-keys-max-gold',
                setting: 'automation.movement.buyKeysMaxGold',
                label: t('settings.movement.buyKeysMaxGold'),
                hint: t('settings.movement.buyKeysMaxGoldHint')
              }
            ]}
            values={choices}
          />
        )}
      </div>
    </fieldset>
  );
}
