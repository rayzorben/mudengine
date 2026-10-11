/**
 * Attack Command and Opening Attack, one pair for the character form and the
 * options page. Blank chooses each (todo 47); with the character in the realm
 * the placeholders say what blank chooses and why (`world:attack`), and
 * otherwise what blank does. The options page has no character, so no choice.
 */
import type { ChosenWords } from '@shared/attackChoice';
import { TextField } from './FormField';
import { t } from '../lib/i18n';

export interface FightWordFieldsProps {
  /** Prefixed to each field's `name`, so two pages' fields keep their own ids. */
  prefix: string;
  attack: string;
  opener: string;
  onAttack(value: string): void;
  onOpener(value: string): void;
  /** What blank chooses for this character; null off the realm or on the options page. */
  chosen: ChosenWords | null;
}

function attackPlaceholder(chosen: ChosenWords | null): string {
  if (chosen === null) return t('settings.combat.attackVerbPlaceholder');
  const { verb, perRound } = chosen.attack;
  return perRound === null
    ? t('settings.combat.attackChosenUnpriced', { verb })
    : t('settings.combat.attackChosen', { verb, perRound: Math.round(perRound) });
}

function openerPlaceholder(chosen: ChosenWords | null): string {
  if (chosen === null) return t('settings.combat.openerPlaceholder');
  return chosen.opener === ''
    ? t('settings.combat.openerChosenNone')
    : t('settings.combat.openerChosen', { verb: chosen.opener });
}

export default function FightWordFields({
  prefix,
  attack,
  opener,
  onAttack,
  onOpener,
  chosen
}: FightWordFieldsProps): React.JSX.Element {
  return (
    <>
      <TextField
        hint={t('settings.combat.attackVerbHint')}
        label={t('settings.combat.attackVerbLabel')}
        name={`${prefix}attack`}
        onChange={onAttack}
        placeholder={attackPlaceholder(chosen)}
        spellCheck={false}
        value={attack}
      />
      <TextField
        hint={t('settings.combat.openerHint')}
        label={t('settings.combat.openerLabel')}
        name={`${prefix}opener`}
        onChange={onOpener}
        placeholder={openerPlaceholder(chosen)}
        spellCheck={false}
        value={opener}
      />
    </>
  );
}
