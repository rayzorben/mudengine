/**
 * The character page's Auto-Hangup fieldset: the switch, its floor and the
 * wait after a run (todo 118), the realm's charge (this character's own answer or its realm's), a player in the
 * room, and hanging up naked, which the switch does not govern (todo 118).
 */
import { CheckField, NumberField, SelectField } from './FormField';
import NakedHangUpFields from './NakedHangUpFields';
import { penaltiesChoice, penaltiesOf, type barOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { CharacterFields } from '../lib/characterForm';

type HangUpForm = Pick<
  CharacterFields,
  | 'hangUp'
  | 'hangUpBelow'
  | 'hangUpPenalties'
  | 'hangUpOnPlayer'
  | 'hangUpNaked'
  | 'hangUpNakedMargin'
  | 'hangUpAfterRun'
>;

export interface HangUpFieldsetProps {
  form: HangUpForm;
  patch(change: Partial<HangUpForm>): void;
  /** The floor's band strip, from the percent as typed. */
  bar(typed: string): ReturnType<typeof barOf>;
  /** The floor as a figure of this character's maximum. */
  figure(typed: string): string | null;
}

export default function HangUpFieldset({
  form,
  patch,
  bar,
  figure
}: HangUpFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="health-hangup">
      <legend>{t('settings.health.hangUpLegend')}</legend>
      {/*
        The second and last warning left in the open. Every MegaMUD-era
        client offers this; on this server family it is one of the more
        reliable ways to die.
      */}
      <p className="settings-warn">{t('settings.health.hangUpWarning')}</p>
      <div className="settings-inline">
        <CheckField
          checked={form.hangUp}
          label={t('settings.health.hangUpLabel')}
          name="hangup"
          setting="automation.safety.hangUp.enabled"
          onChange={(value) => patch({ hangUp: value })}
        />
        {form.hangUp && (
          <>
            <NumberField
              label={t('settings.health.belowHealthLabel')}
              name="hangup-health"
              setting="automation.safety.hangUp.belowHealth"
              bar={bar(form.hangUpBelow)}
              figure={figure(form.hangUpBelow)}
              onChange={(value) => patch({ hangUpBelow: value })}
              value={form.hangUpBelow}
            />
            <NumberField
              hint={t('settings.health.hangUpAfterRunHint')}
              label={t('settings.health.hangUpAfterRunLabel')}
              name="hangup-after-run"
              setting="automation.safety.hangUp.afterRunSeconds"
              onChange={(value) => patch({ hangUpAfterRun: value })}
              value={form.hangUpAfterRun}
            />
          </>
        )}
      </div>
      {form.hangUp && (
        <>
          <SelectField
            hint={t('settings.health.hangPenaltiesHint')}
            label={t('settings.health.hangPenaltiesLabel')}
            name="hang-penalties"
            setting="automation.safety.hangUp.penalties"
            onChange={(value) => patch({ hangUpPenalties: penaltiesOf(value) })}
            options={[
              { value: '', label: t('settings.health.hangPenaltiesRealm') },
              { value: 'yes', label: t('settings.health.hangPenaltiesYes') },
              { value: 'no', label: t('settings.health.hangPenaltiesNo') }
            ]}
            value={penaltiesChoice(form.hangUpPenalties)}
          />
          <CheckField
            checked={form.hangUpOnPlayer}
            label={t('settings.health.hangUpOnPlayer')}
            name="hangup-player"
            setting="automation.safety.hangUp.onPlayerInRoom"
            onChange={(value) => patch({ hangUpOnPlayer: value })}
          />
        </>
      )}
      <NakedHangUpFields
        margin={form.hangUpNakedMargin}
        onMargin={(hangUpNakedMargin) => patch({ hangUpNakedMargin })}
        onWhenNaked={(hangUpNaked) => patch({ hangUpNaked })}
        whenNaked={form.hangUpNaked}
      />
    </fieldset>
  );
}
