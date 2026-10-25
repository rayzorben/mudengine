/**
 * The party settings, one set of fields for the character form and the
 * options page (todo 831): following (assist, defend, rest with the leader,
 * the leader's `@party`), leading (MegaMUD's *Wait For Party Members*, its
 * time limit and `@wait`, the portal relay and its rejoin wait, todo 839), the
 * party listing's pace and how much lost health brings it sooner, and
 * healing. Each figure
 * is held as typed (`PartyForm`); the page turns a change back into its draft.
 */
import { CheckField, NumberField } from './FormField';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { PartyForm } from '../lib/characterForm';
import type { VitalThresholds } from '@shared/character';
import type { SettingPath } from '@shared/decisionSettings';

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
  const check = ({
    key,
    label,
    hint,
    name,
    setting
  }: {
    key:
      | 'assistLeader'
      | 'defendParty'
      | 'restWithLeader'
      | 'ignoreParty'
      | 'sayPanic'
      | 'ignoreWait'
      | 'manageParty'
      | 'parAfterRound'
      | 'relayPortals'
      | 'helpWithDoors'
      | 'askHealth';
    label: string;
    hint: string;
    name: string;
    setting: SettingPath;
  }) => (
    <CheckField
      checked={party[key]}
      hint={hint}
      label={label}
      name={`${namePrefix}party-${name}`}
      setting={setting}
      onChange={(value) => set(key, value)}
    />
  );
  return (
    <>
      <fieldset className="settings-menus" data-fieldset="party-follow">
        <legend>{t('settings.party.legend')}</legend>
        <p className="settings-warn">{t('settings.party.warning')}</p>
        {check({
          key: 'assistLeader',
          label: t('settings.party.assistLabel'),
          hint: t('settings.party.assistHint'),
          name: 'assist',
          setting: 'automation.party.assistLeader'
        })}
        {check({
          key: 'defendParty',
          label: t('settings.party.defendLabel'),
          hint: t('settings.party.defendHint'),
          name: 'defend',
          setting: 'automation.party.defendParty'
        })}
        {check({
          key: 'restWithLeader',
          label: t('settings.party.restLabel'),
          hint: t('settings.party.restHint'),
          name: 'rest',
          setting: 'automation.party.restWithLeader'
        })}
        {check({
          key: 'ignoreParty',
          label: t('settings.party.ignorePartyLabel'),
          hint: t('settings.party.ignorePartyHint'),
          name: 'ignore-party',
          setting: 'automation.party.ignoreParty'
        })}
        {check({
          key: 'sayPanic',
          label: t('settings.party.sayPanicLabel'),
          hint: t('settings.party.sayPanicHint'),
          name: 'say-panic',
          setting: 'automation.party.sayPanic'
        })}
        <div className="settings-inline">
          <NumberField
            hint={t('settings.party.waitBelowHint')}
            label={t('settings.party.waitBelowLabel')}
            name={`${namePrefix}party-wait-below`}
            setting="automation.party.waitBelow"
            onChange={(value) => set('waitBelow', value)}
            {...share(party.waitBelow)}
            value={party.waitBelow}
          />
          <NumberField
            hint={t('settings.party.waitMinutesHint')}
            label={t('settings.party.waitMinutesLabel')}
            name={`${namePrefix}party-wait-minutes`}
            setting="automation.party.waitMinutes"
            onChange={(value) => set('waitMinutes', value)}
            value={party.waitMinutes}
          />
          <NumberField
            hint={t('settings.party.parSecondsHint')}
            label={t('settings.party.parSecondsLabel')}
            name={`${namePrefix}party-par-seconds`}
            setting="automation.party.parSeconds"
            onChange={(value) => set('parSeconds', value)}
            value={party.parSeconds}
          />
          <NumberField
            hint={t('settings.party.parEveryRoundsHint')}
            label={t('settings.party.parEveryRoundsLabel')}
            name={`${namePrefix}party-par-every-rounds`}
            setting="automation.party.parEveryRounds"
            onChange={(value) => set('parEveryRounds', value)}
            value={party.parEveryRounds}
          />
          <NumberField
            hint={t('settings.party.parAtLossHint')}
            label={t('settings.party.parAtLossLabel')}
            name={`${namePrefix}party-par-at-loss`}
            setting="automation.party.parAtLoss"
            onChange={(value) => set('parAtLoss', value)}
            value={party.parAtLoss}
          />
        </div>
        {check({
          key: 'manageParty',
          label: t('settings.party.managePartyLabel'),
          hint: t('settings.party.managePartyHint'),
          name: 'manage-party',
          setting: 'automation.party.manageParty'
        })}
        {check({
          key: 'ignoreWait',
          label: t('settings.party.ignoreWaitLabel'),
          hint: t('settings.party.ignoreWaitHint'),
          name: 'ignore-wait',
          setting: 'automation.party.ignoreWait'
        })}
        {check({
          key: 'parAfterRound',
          label: t('settings.party.parAfterRoundLabel'),
          hint: t('settings.party.parAfterRoundHint'),
          name: 'par-after-round',
          setting: 'automation.party.parAfterRound'
        })}
        {check({
          key: 'relayPortals',
          label: t('settings.party.relayPortalsLabel'),
          hint: t('settings.party.relayPortalsHint'),
          name: 'relay-portals',
          setting: 'automation.party.relayPortals'
        })}
        {check({
          key: 'helpWithDoors',
          label: t('settings.party.helpWithDoorsLabel'),
          hint: t('settings.party.helpWithDoorsHint'),
          name: 'help-with-doors',
          setting: 'automation.party.helpWithDoors'
        })}
        <div className="settings-inline">
          <NumberField
            hint={t('settings.party.regroupMinutesHint')}
            label={t('settings.party.regroupMinutesLabel')}
            name={`${namePrefix}party-regroup-minutes`}
            setting="automation.party.regroupMinutes"
            onChange={(value) => set('regroupMinutes', value)}
            value={party.regroupMinutes}
          />
          <NumberField
            hint={t('settings.party.comebackRoomsHint')}
            label={t('settings.party.comebackRoomsLabel')}
            name={`${namePrefix}party-comeback-rooms`}
            setting="automation.party.comebackRooms"
            onChange={(value) => set('comebackRooms', value)}
            value={party.comebackRooms}
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
            setting="automation.party.askForHealBelow"
            onChange={(value) => set('askForHealBelow', value)}
            {...share(party.askForHealBelow)}
            value={party.askForHealBelow}
          />
        </div>
        {check({
          key: 'askHealth',
          label: t('settings.party.askHealthLabel'),
          hint: t('settings.party.askHealthHint'),
          name: 'ask-health',
          setting: 'automation.party.askHealth'
        })}
      </fieldset>
    </>
  );
}
