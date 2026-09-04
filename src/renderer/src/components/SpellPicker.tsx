import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import FormField from './FormField';
import { useListNavigation } from '../hooks/useListNavigation';
import { t } from '../lib/i18n';
import type { SpellOption } from '@shared/ipc';
import type { SpellTargeting } from '@shared/spellcraft';

/**
 * A spell name field with the character's own book behind it.
 *
 * A free text input first — a derivative realm, or a book the client has not
 * read yet, must never lock the field — with a filtered list of what the
 * character actually knows under it, because the field that caused this
 * component shipped as bare text beside a second bare text box and the first
 * person to use it typed the spell into the wrong one and lost the row. The
 * value is always the **whole name** — the readable spelling; the client
 * resolves it to the realm's short word at the moment of casting
 * (`castWord`), because `c` reads exactly one word as the spell. The
 * abbreviation is still searched, because `mihe` is how a MegaMUD-trained
 * player thinks of `minor healing`.
 *
 * The interaction is `useListNavigation`'s, like every filtered list here.
 * Escape closes the list and goes no further while it is open — the settings
 * dialog owns its own Escape, and one press must not do both.
 */
export interface SpellComboProps {
  name: string;
  value: string;
  onChange(value: string): void;
  /** What the picker offers. Empty means offer nothing — typing still works. */
  spells: readonly SpellOption[];
  ariaLabel?: string;
  describedBy?: string;
  disabled?: boolean;
  placeholder?: string;
}

/** How many suggestions are worth showing under a field. */
const MOST = 14;

/**
 * Narrow a picker to the spells the realm says may be cast on a given kind of
 * target — `castsOnSelf` for a self field, `castsOnOthers` for a party one.
 *
 * A helper rather than each caller filtering, so the Global page and the
 * character page cannot end up offering different lists for the same field.
 * The predicate itself already says yes to `unknown`: a realm this build
 * cannot read the targeting column of must not lose the field.
 */
export function castableOn(
  spells: readonly SpellOption[],
  allows: (targeting: SpellTargeting) => boolean
): SpellOption[] {
  return spells.filter((spell) => allows(spell.targeting));
}

/**
 * Whether the configured name is a spell the realm will not let this field
 * cast — a self-only spell in the party heal, say.
 *
 * Only ever true for a spell the realm actually names: a name it has never
 * heard of is not a contradiction, it is a derivative realm or a book learned
 * from the level-up line, and the field stays silent. The field itself is
 * never disabled and the value is never rewritten — this reports, and the
 * player decides. It exists because the migration that split one heal into two
 * seeds the party field from the old single spell, which for a mystic is
 * `way of the swan`: without saying so, the client would keep the exact
 * configuration it had and heal nobody.
 */
export function refusesTarget(
  all: readonly SpellOption[],
  allows: (targeting: SpellTargeting) => boolean,
  configured: string
): boolean {
  const needle = configured.trim().toLowerCase();
  if (needle.length === 0) return false;
  const found = all.find(
    (spell) => spell.name.toLowerCase() === needle || spell.short?.toLowerCase() === needle
  );
  return found !== undefined && !allows(found.targeting);
}

function matches(spells: readonly SpellOption[], value: string): SpellOption[] {
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return spells.slice(0, MOST);
  const ranked: Array<{ spell: SpellOption; rank: number }> = [];
  for (const spell of spells) {
    const name = spell.name.toLowerCase();
    const short = spell.short?.toLowerCase() ?? '';
    // A prefix outranks a match anywhere: typing `heal` means Heal before
    // the eleven spells with "heal" somewhere in the name — the same rule
    // the Reference card's search follows.
    const rank = name.startsWith(needle) || short === needle ? 0 : name.includes(needle) ? 1 : -1;
    if (rank < 0) continue;
    ranked.push({ spell, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.spell.name.localeCompare(b.spell.name))
    .slice(0, MOST)
    .map((hit) => hit.spell);
}

export function SpellCombo({
  name,
  value,
  onChange,
  spells,
  ariaLabel,
  describedBy,
  disabled,
  placeholder
}: SpellComboProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => matches(spells, value), [spells, value]);
  const shown = open && !disabled && options.length > 0;

  const navigation = useListNavigation<SpellOption>({
    items: shown ? options : [],
    onChoose: (spell) => {
      onChange(spell.name);
      setOpen(false);
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Only while the list is showing: a closed picker leaves Escape to the
      // dialog, and an open one spends the press on the list alone.
      if (shown) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === 'Enter' && !shown) {
      // Never the form's implicit submission — the enclosing form saves the
      // whole character, and Enter in a spell field is not that.
      event.preventDefault();
      return;
    }
    navigation.onKeyDown(event);
  };

  return (
    <span className="spell-picker" data-open={shown ? 'true' : 'false'}>
      <input
        aria-autocomplete="list"
        aria-describedby={describedBy}
        aria-expanded={shown}
        aria-label={ariaLabel}
        disabled={disabled}
        name={name}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        value={value}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul className="spell-options" ref={navigation.listRef} role="listbox">
          {options.map((spell, index) => (
            <li
              aria-selected={navigation.isActive(index)}
              data-active={navigation.isActive(index) ? 'true' : 'false'}
              key={spell.name}
              // Before the input's blur, or the click would close the list
              // out from under itself and choose nothing.
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(spell.name);
                setOpen(false);
              }}
              onMouseEnter={() => navigation.point(index)}
              role="option"
            >
              <span>{spell.name}</span>
              {spell.short !== null && <span className="spell-short">{spell.short}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

export interface SpellFieldProps {
  label: React.ReactNode;
  name: string;
  hint?: React.ReactNode;
  value: string;
  onChange(value: string): void;
  spells: readonly SpellOption[];
  disabled?: boolean;
  placeholder?: string;
  /**
   * Said in the open, above the switch's own hint, when the realm contradicts
   * what is typed here. A refusal that is not reported is worse than one that
   * was never made — the value stays, the field stays editable, and the player
   * is told what the realm says about it.
   */
  warning?: React.ReactNode;
}

/** The labeled settings-row face of the picker. */
export default function SpellField({
  label,
  name,
  hint,
  value,
  onChange,
  spells,
  disabled,
  placeholder,
  warning
}: SpellFieldProps): React.JSX.Element {
  return (
    <>
      {warning !== undefined && <p className="settings-warn">{warning}</p>}
      <FormField hint={hint} label={label} name={name}>
        {({ describedBy }) => (
          <SpellCombo
            describedBy={describedBy}
            disabled={disabled}
            name={name}
            onChange={onChange}
            placeholder={placeholder ?? t('settings.spells.pickerPlaceholder')}
            spells={spells}
            value={value}
          />
        )}
      </FormField>
    </>
  );
}
