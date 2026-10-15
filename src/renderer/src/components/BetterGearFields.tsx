import { CheckField, NumberField } from './FormField';

import { t } from '../lib/i18n';
import {
  GEAR_WEIGHT_FIELDS,
  asGearWeights,
  type GearWeightField,
  type GearWeights
} from '@shared/gearWeighing';

/** Each weight's label (the realm's ability name) and its one sentence. */
function wordsOf(): Readonly<Record<GearWeightField, { label: string; hint: string }>> {
  return {
    damageResist: {
      label: t('settings.gear.weightDamageResistLabel'),
      hint: t('settings.gear.weightDamageResistHint')
    },
    protectionEvil: {
      label: t('settings.gear.weightProtectionEvilLabel'),
      hint: t('settings.gear.weightProtectionEvilHint')
    },
    protectionGood: {
      label: t('settings.gear.weightProtectionGoodLabel'),
      hint: t('settings.gear.weightProtectionGoodHint')
    },
    maxDamage: {
      label: t('settings.gear.weightMaxDamageLabel'),
      hint: t('settings.gear.weightMaxDamageHint')
    },
    accuracy: {
      label: t('settings.gear.weightAccuracyLabel'),
      hint: t('settings.gear.weightAccuracyHint')
    },
    maxHp: {
      label: t('settings.gear.weightMaxHpLabel'),
      hint: t('settings.gear.weightMaxHpHint')
    },
    hpRegen: {
      label: t('settings.gear.weightHpRegenLabel'),
      hint: t('settings.gear.weightHpRegenHint')
    },
    maxMana: {
      label: t('settings.gear.weightMaxManaLabel'),
      hint: t('settings.gear.weightMaxManaHint')
    },
    manaRegen: {
      label: t('settings.gear.weightManaRegenLabel'),
      hint: t('settings.gear.weightManaRegenHint')
    },
    stealth: {
      label: t('settings.gear.weightStealthLabel'),
      hint: t('settings.gear.weightStealthHint')
    },
    shockShield: {
      label: t('settings.gear.weightShockShieldLabel'),
      hint: t('settings.gear.weightShockShieldHint')
    }
  };
}

export interface BetterGearFieldsProps {
  /** `automation.loot.upgrades`, Auto-Get Better Gear. */
  upgrades: boolean;
  weights: GearWeights;
  /** Prefix for every control name, as each page spells it (`gear`, `global-gear`). */
  namePrefix: string;
  onUpgrades(upgrades: boolean): void;
  onWeights(weights: GearWeights): void;
  /** `automation.gear.offersPerSlot`: how many better items the Gear card lists a slot. */
  perSlot: string | number;
  onPerSlot(typed: string): void;
}

/**
 * Auto-Get Better Gear and the gear weights (`automation.loot.upgrades`,
 * `automation.loot.gearWeights`, todo 117): whether floor gear is taken and
 * worn, and how many of an item's AC points one point of each ability is
 * worth wherever gear is ranked, and how many better items the Gear card
 * offers a slot (`automation.gear.offersPerSlot`). In the Gear section of both pages (the
 * user, 2026-10-12), though the keys stay in the loot block they always had.
 */
export default function BetterGearFields({
  upgrades,
  weights,
  namePrefix,
  onUpgrades,
  onWeights,
  perSlot,
  onPerSlot
}: BetterGearFieldsProps): React.JSX.Element {
  const words = wordsOf();
  return (
    <fieldset className="settings-menus" data-fieldset="gear-better">
      <legend>{t('settings.gear.betterLegend')}</legend>
      <CheckField
        checked={upgrades}
        hint={t('settings.gear.upgradesHint')}
        label={t('settings.gear.upgradesLabel')}
        name={`${namePrefix}-upgrades`}
        setting="automation.loot.upgrades"
        onChange={onUpgrades}
      />
      <p className="settings-note">{t('settings.gear.betterNote')}</p>
      <div className="settings-inline">
        {GEAR_WEIGHT_FIELDS.map((field) => (
          <NumberField
            hint={words[field].hint}
            key={field}
            label={words[field].label}
            name={`${namePrefix}-weight-${field}`}
            setting="automation.loot.gearWeights"
            onChange={(value) =>
              onWeights(
                asGearWeights({ ...weights, [field]: Number.parseInt(value, 10) || 0 }, weights)
              )
            }
            value={String(weights[field])}
          />
        ))}
      </div>
      <NumberField
        hint={t('settings.gear.perSlotHint')}
        label={t('settings.gear.perSlot')}
        name={`${namePrefix}-per-slot`}
        setting="automation.gear.offersPerSlot"
        onChange={onPerSlot}
        value={perSlot}
      />
    </fieldset>
  );
}
