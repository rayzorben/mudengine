/**
 * The character page's Attacks fieldset: the attack and opener with the words
 * chosen for this character, hiding between fights, and how often the room is
 * looked at mid-fight. Out of `CharacterForm` whole (todo 118).
 */
import type { ChosenWords } from '@shared/attackChoice';
import { CheckField, NumberField } from './FormField';
import FightWordFields from './FightWordFields';
import { t } from '../lib/i18n';
import type { CharacterFields } from '../lib/characterForm';

type AttacksForm = Pick<
  CharacterFields,
  'combatAttack' | 'combatOpener' | 'combatHideForOpener' | 'combatRefresh'
>;

export interface AttacksFieldsetProps {
  form: AttacksForm;
  patch(change: Partial<AttacksForm>): void;
  /** The attack and opener chosen for this character, for the placeholders. */
  chosen: ChosenWords | null;
}

export default function AttacksFieldset({
  form,
  patch,
  chosen
}: AttacksFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="combat-attacks">
      <legend>{t('settings.combat.attacksLegend')}</legend>
      <div className="settings-inline">
        <FightWordFields
          attack={form.combatAttack}
          chosen={chosen}
          onAttack={(value) => patch({ combatAttack: value })}
          onOpener={(value) => patch({ combatOpener: value })}
          opener={form.combatOpener}
          prefix=""
        />
      </div>
      <CheckField
        checked={form.combatHideForOpener}
        hint={t('settings.combat.hideForOpenerHint')}
        label={t('settings.combat.hideForOpener')}
        name="hide-for-opener"
        setting="automation.combat.hideForOpener"
        onChange={(value) => patch({ combatHideForOpener: value })}
      />
      <NumberField
        hint={t('settings.combat.refreshHint')}
        label={t('settings.combat.refreshLabel')}
        name="refresh"
        setting="automation.combat.refreshRounds"
        onChange={(value) => patch({ combatRefresh: value })}
        value={form.combatRefresh}
      />
    </fieldset>
  );
}
