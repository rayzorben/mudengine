import { chosenToInvoke, type InvokeChoice } from '@shared/invoke';
import { CheckField } from './FormField';
import { t } from '../lib/i18n';

export interface InvokeFieldsProps {
  /** `automation.spells.invokeItems`, the switch the toolbar also holds. */
  enabled: boolean;
  /** `automation.spells.invokeWith`, the items it may use. */
  chosen: readonly string[];
  /** What the inventory holds that can bless; null while it has not been listed. */
  choices: readonly InvokeChoice[] | null;
  onEnabled(enabled: boolean): void;
  onChosen(chosen: string[]): void;
}

/**
 * The items that bless when used, as the character page draws them: the
 * switch, then one tick per item the inventory holds that can bless (from
 * `invokeChoices`), and one per item ticked that the inventory no longer
 * holds, so it can be unticked. A fragment, so each tick is a cell of the
 * fieldset's grid.
 */
export default function InvokeFields({
  enabled,
  chosen,
  choices,
  onEnabled,
  onChosen
}: InvokeFieldsProps): React.JSX.Element {
  const carried = choices ?? [];
  // Chosen and not among the choices. Before a listing nothing is known to be
  // carried or not, so those rows make no claim either way.
  const away = chosen.filter(
    (name) => !carried.some((choice) => chosenToInvoke([name], choice.item))
  );
  const tick = (item: string, on: boolean): void =>
    onChosen(on ? [...chosen, item] : chosen.filter((name) => !chosenToInvoke([name], item)));
  return (
    <>
      <p className="settings-note">
        {choices === null
          ? t('settings.spells.invokeUnlisted')
          : choices.length === 0
            ? t('settings.spells.invokeNone')
            : t('settings.spells.invokeNote')}
      </p>
      <CheckField
        checked={enabled}
        hint={t('settings.spells.invokeItemsHint')}
        label={t('settings.spells.invokeItemsLabel')}
        name="invoke-items"
        onChange={onEnabled}
      />
      {enabled && chosen.length === 0 && (
        <p className="settings-warn">{t('settings.spells.invokeNoneChosen')}</p>
      )}
      {carried.map((choice) => (
        <CheckField
          checked={chosenToInvoke(chosen, choice.item)}
          hint={
            choice.mana === null
              ? t('settings.spells.invokeCastsUnpriced', { spell: choice.spell })
              : t('settings.spells.invokeCasts', { spell: choice.spell, mana: choice.mana })
          }
          key={choice.item}
          label={
            choice.mustBeEquipped && !choice.equipped
              ? t('settings.spells.invokeUnequipped', { item: choice.item })
              : choice.item
          }
          name={`invoke-with-${choice.item}`}
          onChange={(on) => tick(choice.item, on)}
        />
      ))}
      {away.map((item) => (
        <CheckField
          checked
          hint={choices === null ? undefined : t('settings.spells.invokeNotCarried')}
          key={item}
          label={choices === null ? item : t('settings.spells.invokeAway', { item })}
          name={`invoke-with-${item}`}
          onChange={(on) => tick(item, on)}
        />
      ))}
    </>
  );
}
