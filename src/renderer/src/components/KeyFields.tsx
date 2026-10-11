/**
 * `keys:` (todo 74), MegaMUD's macros, on the MudEngine page: a key and the
 * line it sends. The key is recorded by pressing it, so nobody types
 * `NumpadDecimal`; Escape gives the press up. Why a row does not load is said
 * under it, as the load notice says it.
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
}

export default function KeyFields({ keys, onChange }: KeyFieldsProps) {
  const [pressing, setPressing] = useState<number | null>(null);
  const refusals = keyRowRefusals(keys);
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
          return why === null ? null : keyRefusalText(why, t);
        }}
        removeAria={(index) => t('settings.keys.removeAria', { number: index + 1 })}
      />
    </fieldset>
  );
}
