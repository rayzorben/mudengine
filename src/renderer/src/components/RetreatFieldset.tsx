/**
 * The character page's Auto-Retreat fieldset: the switch and its three
 * figures as one row, where it goes, the safe haven when that is the answer,
 * and the teleport below it (`FleeGotoFields`). Out of `CharacterForm` whole,
 * as `HangUpFieldset` is (todo 119).
 */
import { CheckField, NumberField, SelectField, TextField } from './FormField';
import FleeGotoFields, { type FleeGotoForm } from './FleeGotoFields';
import { RETREAT_OPTIONS, type barOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { CharacterFields } from '../lib/characterForm';

type RetreatForm = FleeGotoForm &
  Pick<
    CharacterFields,
    | 'retreat'
    | 'retreatBelow'
    | 'retreatBelowMana'
    | 'retreatOutnumbered'
    | 'retreatStrategy'
    | 'retreatHaven'
  >;

/** Per vital, from the percent as typed. */
interface ByVital<T> {
  hp(typed: string): T;
  mana(typed: string): T;
}

export interface RetreatFieldsetProps {
  form: RetreatForm;
  patch(change: Partial<RetreatForm>): void;
  /** A floor's band strip. */
  bar: ByVital<ReturnType<typeof barOf>>;
  /** A floor as a figure of this character's maximum. */
  figure: ByVital<string | null>;
}

export default function RetreatFieldset({
  form,
  patch,
  bar,
  figure
}: RetreatFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="health-retreat">
      <legend>{t('settings.health.retreatLegend')}</legend>
      {/*
        The switch and its figures are one row: a switch is two
        columns and a threshold one, and a check alone above them
        spent a band saying what the legend had said.
      */}
      <div className="settings-inline">
        <CheckField
          checked={form.retreat}
          hint={t('settings.health.retreatHint')}
          label={t('settings.health.retreatLabel')}
          name="retreat"
          setting="automation.safety.retreat.enabled"
          onChange={(value) => patch({ retreat: value })}
        />
        {form.retreat && (
          <>
            <NumberField
              label={t('settings.health.belowHealthLabel')}
              name="retreat-health"
              setting="automation.safety.retreat.belowHealth"
              bar={bar.hp(form.retreatBelow)}
              figure={figure.hp(form.retreatBelow)}
              onChange={(value) => patch({ retreatBelow: value })}
              value={form.retreatBelow}
            />
            <NumberField
              hint={t('settings.health.belowManaHint')}
              label={t('settings.health.belowManaLabel')}
              name="retreat-mana"
              setting="automation.safety.retreat.belowMana"
              bar={bar.mana(form.retreatBelowMana)}
              figure={figure.mana(form.retreatBelowMana)}
              onChange={(value) => patch({ retreatBelowMana: value })}
              value={form.retreatBelowMana}
            />
            <NumberField
              hint={t('settings.health.outnumberedHint')}
              label={t('settings.health.outnumberedLabel')}
              name="outnumbered"
              setting="automation.safety.retreat.whenOutnumbered"
              onChange={(value) => patch({ retreatOutnumbered: value })}
              value={form.retreatOutnumbered}
            />
          </>
        )}
      </div>
      {form.retreat && (
        <>
          <SelectField
            hint={t('settings.health.retreatStrategyHint')}
            label={t('settings.health.retreatStrategyLabel')}
            name="retreat-strategy"
            setting="automation.safety.retreat.strategy"
            onChange={(value) => patch({ retreatStrategy: value })}
            options={RETREAT_OPTIONS()}
            value={form.retreatStrategy}
          />
          {form.retreatStrategy === 'safe-haven' && (
            <TextField
              hint={t('settings.health.safeHavenHint')}
              label={t('settings.health.safeHavenLabel')}
              name="retreat-haven"
              setting="automation.safety.retreat.safeHavenRoom"
              onChange={(value) => patch({ retreatHaven: value })}
              placeholder={t('settings.health.safeHavenPlaceholder')}
              spellCheck={false}
              value={form.retreatHaven}
              wide
            />
          )}
        </>
      )}
      <FleeGotoFields bar={bar.hp} figure={figure.hp} form={form} patch={patch} />
    </fieldset>
  );
}
