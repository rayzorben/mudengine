/**
 * A row of figures from one settings block (todo 118), each a whole number or
 * a share typed as a percent, read back through the block's own reader so a
 * cleared or out-of-range field saves as the shipped or nearest allowed figure.
 * Every figure row of the two settings pages is drawn through it.
 */
import { NumberField } from './FormField';
import { percentOf, shareOf } from '../lib/form';
import type { SettingPath } from '@shared/decisionSettings';

export interface ChoiceRow<K extends string> {
  field: K;
  /** The control's name, after the page's prefix. */
  name: string;
  label: string;
  hint?: string;
  /** Stored as a 0–1 share and typed as a whole percent. */
  share?: boolean;
  /** See `FormFieldProps.setting`. */
  setting?: SettingPath;
}

export interface ChoiceFieldsProps<K extends string, T extends Record<K, number>> {
  rows: ReadonlyArray<ChoiceRow<K>>;
  values: T;
  /** The block's reader (`huntChoices`, `movementChoices`, `combatChoices`), defaulting and bounding each figure. */
  read(raw: Record<string, unknown>): Pick<T, K>;
  onChange(next: Pick<T, K>): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
  /** Draw the fields alone, as cells of the row the caller's switch is already in. */
  bare?: boolean;
}

export default function ChoiceFields<K extends string, T extends Record<K, number>>({
  rows,
  values,
  read,
  onChange,
  namePrefix,
  bare = false
}: ChoiceFieldsProps<K, T>): React.JSX.Element {
  const fields = rows.map((row) => (
    <NumberField
      hint={row.hint}
      key={row.field}
      label={row.label}
      name={`${namePrefix}${row.name}`}
      onChange={(typed) =>
        onChange(read({ ...values, [row.field]: row.share ? shareOf(typed) : typed }))
      }
      setting={row.setting}
      value={row.share ? percentOf(values[row.field]) : values[row.field]}
    />
  ));
  return bare ? <>{fields}</> : <div className="settings-inline">{fields}</div>;
}
