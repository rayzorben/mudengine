/**
 * `keys:` (todo 74), MegaMUD's macros, on the MudEngine page and a
 * character's (todo 134): a key and the macro it runs, one command a line.
 * The key is recorded by pressing it, so nobody types `NumpadDecimal`; Escape
 * gives the press up. Why a row does not load is said under it, as the load
 * notice says it. On a character's page an empty macro drops Global's key.
 */
import { useState, type KeyboardEvent } from 'react';

import PairRows from './PairRows';

import { t } from '../lib/i18n';
import { chordName, chordOfEvent, keyRefusalText, keyRowRefusals } from '@shared/keys';
import type { StatedPair } from '@shared/pairs';

/** Keys pressed on the way to a chord, never a chord themselves. */
const MODIFIERS = /^(?:Shift|Control|Alt|Meta|OS)(?:Left|Right)?$/;

export interface KeyFieldsProps {
  keys: StatedPair[];
  onChange(keys: StatedPair[]): void;
  /** On a character's page, where these add to Global's. */
  character?: boolean;
  /** The keys that reach themselves through the macros they call (`loopingMacros`). */
  looping?: ReadonlySet<string>;
}

export default function KeyFields({ keys, onChange, character = false, looping }: KeyFieldsProps) {
  const [pressing, setPressing] = useState<number | null>(null);
  const refusals = keyRowRefusals(keys, looping);
  const record = (
    event: KeyboardEvent<HTMLButtonElement>,
    setName: (name: string) => void
  ): void => {
    if (MODIFIERS.test(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code !== 'Escape') setName(chordName(chordOfEvent(event)));
    setPressing(null);
  };
  return (
    <fieldset className="settings-menus" data-fieldset="keys">
      <legend>{t('settings.keys.legend')}</legend>
      <p className="settings-note">{t('settings.keys.note')}</p>
      <p className="settings-note">{t('settings.keys.language')}</p>
      {character && <p className="settings-note">{t('settings.keys.characterNote')}</p>}
      <PairRows
        addLabel={t('settings.keys.add')}
        lineAria={(index) => t('settings.keys.lineAria', { number: index + 1 })}
        linePlaceholder={t('settings.keys.linePlaceholder')}
        nameControl={(pair, index, setName) => (
          <button
            aria-label={t('settings.keys.pressAria', { number: index + 1 })}
            className="answer key-chord"
            // While it waits it holds the keys, so a bound key does not fire.
            data-owns-keys={pressing === index ? 'true' : undefined}
            onBlur={() => setPressing(null)}
            onClick={() => setPressing(index)}
            onKeyDown={pressing === index ? (event) => record(event, setName) : undefined}
            type="button"
          >
            {pressing === index || pair.name === '' ? t('settings.keys.press') : pair.name}
          </button>
        )}
        onChange={onChange}
        pairs={keys}
        refusal={(index) => {
          const why = refusals[index] ?? null;
          if (why === 'empty' && character) return t('settings.keys.dropsGlobal');
          return why === null ? null : keyRefusalText(why, t);
        }}
        removeAria={(index) => t('settings.keys.removeAria', { number: index + 1 })}
      />
    </fieldset>
  );
}
