/**
 * The party settings, one set of fields for the character form and the
 * options page (todo 831): following (assist, defend, rest with the leader,
 * the leader's `@party`), leading (MegaMUD's *Wait For Party Members*, its
 * time limit and `@wait`, the portal relay and its rejoin wait, todo 839), the
 * party listing's pace, and healing. Each figure
 * is held as typed (`PartyForm`); the page turns a change back into its draft.
 */
import { CheckField, NumberField } from './FormField';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { PartyForm } from '../lib/characterForm';
import type { VitalThresholds } from '@shared/character';

export interface PartyFieldsProps {
  party: PartyForm;
  onChange(party: PartyForm): void;
  /** The health meter's bands, for the two health shares. */
  bands: VitalThresholds;
  /** The character's maximum health, for the figure beside a share; absent on the options page. */
  hpMax?: number | null;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

export default function PartyFields({
  party,
  onChange,
  bands,
  hpMax,
  namePrefix
}: PartyFieldsProps): React.JSX.Element {
  const set = <K extends keyof PartyForm>(key: K, value: PartyForm[K]): void =>
    onChange({ ...party, [key]: value });
  const share = (typed: string) => {
    const percent = Number.parseInt(typed, 10) || 0;
    return {
      bar: barOf(percent, bands),
      ...(hpMax === undefined ? {} : { figure: figureOf(percent, hpMax) })
    };
  };
  const check = (
    key:
      | 'assistLeader'
      | 'defendParty'
      | 'restWithLeader'
      | 'ignoreParty'
      | 'ignoreWait'
      | 'parAfterRound'
      | 'relayPortals'
      | 'helpWithDoors'
      | 'askHealth',
    label: string,
    hint: string,
    name: string
  ) => (
    <CheckField
      checked={party[key]}
      hint={hint}
      label={label}
      name={`${namePrefix}party-${name}`}
      onChange={(value) => set(key, value)}
    />
  );
  return (
    <>
      <fieldset className="settings-menus" data-fieldset="party-follow">
        <legend>{t('settings.party.legend')}</legend>
        <p className="settings-warn">{t('settings.party.warning')}</p>
        {check(
          'assistLeader',
          t('settings.party.assistLabel'),
          t('settings.party.assistHint'),
          'assist'
        )}
        {check(
          'defendParty',
          t('settings.party.defendLabel'),
          t('settings.party.defendHint'),
          'defend'
        )}
        {check(
          'restWithLeader',
          t('settings.party.restLabel'),
          t('settings.party.restHint'),
          'rest'
        )}
        {check(
          'ignoreParty',
          t('settings.party.ignorePartyLabel'),
          t('settings.party.ignorePartyHint'),
          'ignore-party'
        )}
        <div className="settings-inline">
          <NumberField
            hint={t('settings.party.waitBelowHint')}
            label={t('settings.party.waitBelowLabel')}
            name={`${namePrefix}party-wait-below`}
            onChange={(value) => set('waitBelow', value)}
            {...share(party.waitBelow)}
            value={party.waitBelow}
          />
          <NumberField
            hint={t('settings.party.waitMinutesHint')}
            label={t('settings.party.waitMinutesLabel')}
            name={`${namePrefix}party-wait-minutes`}
            onChange={(value) => set('waitMinutes', value)}
            value={party.waitMinutes}
          />
          <NumberField
            hint={t('settings.party.parSecondsHint')}
            label={t('settings.party.parSecondsLabel')}
            name={`${namePrefix}party-par-seconds`}
            onChange={(value) => set('parSeconds', value)}
            value={party.parSeconds}
          />
        </div>
        {check(
          'ignoreWait',
          t('settings.party.ignoreWaitLabel'),
          t('settings.party.ignoreWaitHint'),
          'ignore-wait'
        )}
        {check(
          'parAfterRound',
          t('settings.party.parAfterRoundLabel'),
          t('settings.party.parAfterRoundHint'),
          'par-after-round'
        )}
        {check(
          'relayPortals',
          t('settings.party.relayPortalsLabel'),
          t('settings.party.relayPortalsHint'),
          'relay-portals'
        )}
        {check(
          'helpWithDoors',
          t('settings.party.helpWithDoorsLabel'),
          t('settings.party.helpWithDoorsHint'),
          'help-with-doors'
        )}
        <div className="settings-inline">
          <NumberField
            hint={t('settings.party.regroupMinutesHint')}
            label={t('settings.party.regroupMinutesLabel')}
            name={`${namePrefix}party-regroup-minutes`}
            onChange={(value) => set('regroupMinutes', value)}
            value={party.regroupMinutes}
          />
        </div>
      </fieldset>
      <fieldset className="settings-menus" data-fieldset="party-healing">
        <legend>{t('settings.party.healLegend')}</legend>
        <p className="settings-note">{t('settings.party.healNote')}</p>
        <div className="settings-inline">
          <NumberField
            hint={t('settings.party.askHealHint')}
            label={t('settings.party.askHealLabel')}
            name={`${namePrefix}party-ask-heal`}
            onChange={(value) => set('askForHealBelow', value)}
            {...share(party.askForHealBelow)}
            value={party.askForHealBelow}
          />
        </div>
        {check(
          'askHealth',
          t('settings.party.askHealthLabel'),
          t('settings.party.askHealthHint'),
          'ask-health'
        )}
      </fieldset>
    </>
  );
}
