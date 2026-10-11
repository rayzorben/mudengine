/**
 * `automation.aliases` (todo 74), drawn once for the Global page and a
 * character's: a word, the line it stands for, and why an entry does not
 * load. On a character's page an empty line drops Global's alias of that word.
 */
import PairRows from './PairRows';

import { t } from '../lib/i18n';
import { aliasRefusalText, aliasRowRefusals } from '@shared/aliases';
import type { StatedPair } from '@shared/pairs';

export interface AliasFieldsProps {
  aliases: StatedPair[];
  onChange(aliases: StatedPair[]): void;
  /** On a character's page, where these add to Global's. */
  character?: boolean;
}

export default function AliasFields({ aliases, onChange, character = false }: AliasFieldsProps) {
  const refusals = aliasRowRefusals(aliases);
  const refusal = (index: number): string | null => {
    const why = refusals[index] ?? null;
    if (why === null) return null;
    if (why === 'empty' && character) return t('settings.aliases.dropsGlobal');
    return aliasRefusalText(why, t);
  };
  return (
    <fieldset className="settings-menus" data-fieldset="talk-aliases">
      <legend>{t('settings.aliases.legend')}</legend>
      <p className="settings-note">{t('settings.aliases.note')}</p>
      {character && <p className="settings-note">{t('settings.aliases.characterNote')}</p>}
      <PairRows
        addLabel={t('settings.aliases.add')}
        lineAria={(index) => t('settings.aliases.lineAria', { number: index + 1 })}
        linePlaceholder={t('settings.aliases.linePlaceholder')}
        nameControl={(pair, index, setName) => (
          <input
            aria-label={t('settings.aliases.wordAria', { number: index + 1 })}
            className="answer"
            onChange={(event) => setName(event.target.value)}
            placeholder={t('settings.aliases.wordPlaceholder')}
            value={pair.name}
          />
        )}
        onChange={onChange}
        pairs={aliases}
        refusal={refusal}
        removeAria={(index) => t('settings.aliases.removeAria', { number: index + 1 })}
      />
    </fieldset>
  );
}
