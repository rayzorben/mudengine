import type { ReactNode } from 'react';

import { Hint } from './Hint';

/**
 * One settings row: a label, a control, and the one sentence behind a mark.
 *
 * Every row on this screen used to be hand-rolled — a `<label>`, a `<span>`, a
 * control and, where somebody remembered, a `Hint` and the `aria-describedby`
 * tying the two together. A hundred and nineteen of them across two files, six
 * shapes, no common base, and the divergence was not hypothetical:
 *
 * - **Thirty-three of the sixty-two hints had no field pointing at them.** The
 *   sentence rendered, the mark opened it, and a screen reader reading the
 *   field was never told it existed. That is a wiring nobody can keep right by
 *   inspection, which is what a primitive is for.
 * - **Rows sized themselves.** `.settings-inline` gave each row `flex: 1 1
 *   120px` and let each *wrapped line* share the width independently, so one
 *   field in a group was full width, two were halves, and a fourth that wrapped
 *   started at an x nothing above it shared.
 *
 * So the row is one component and the pages hold none of it. A field names
 * itself, and everything derived from that name — the hint's id, the
 * description on the control — is derived here rather than typed twice.
 *
 * The label stays at most four words with its units in the field, and the
 * explanation stays behind the mark: `docs/terminology.md` §1, and the reason
 * is on `Hint` itself.
 */
export interface FormFieldProps {
  /**
   * What the row is called, in at most four words. Units go in the field.
   */
  label: ReactNode;
  /**
   * The field's own name, and the stem every id on the row is built from.
   *
   * Required rather than optional even where there is no hint: a row that
   * cannot be addressed is a row no test and no harness can reach, and the
   * name costs nothing to state.
   */
  name: string;
  /** The one sentence behind the mark. See `docs/terminology.md` §1. */
  hint?: ReactNode;
  /**
   * Take the whole row rather than one column of the field grid.
   *
   * A fact about the *value*, in the same way `spellCheck` is, and not about
   * the page it happens to be on: a comma-separated list of monster names, a
   * filesystem path, a font stack, or a control with a button beside it is
   * unreadable in a 190px track, and every one of those is unreadable there on
   * every screen it appears on. Everything else is one column wide, which is
   * the default precisely because it is the answer for almost every field.
   */
  wide?: boolean;
  /**
   * The control, given what it needs to claim its own description.
   *
   * A function rather than a node because the wiring is the whole point: the
   * row knows the id, the control has to carry it, and handing it over is the
   * only arrangement in which forgetting is not possible.
   */
  children: (wiring: { describedBy: string | undefined }) => ReactNode;
}

/** The id the sentence behind a field is published under. */
export function fieldHintId(name: string): string {
  return `hint-${name}`;
}

/**
 * The one piece of wiring both row shapes need: no hint, no id. Shared because
 * `CheckField` cannot reuse `FormField`'s render (the box precedes the label)
 * and a second hand-typed copy of this line is the drift this file exists to
 * end.
 */
function hintIdFor(name: string, hint: ReactNode): string | undefined {
  return hint === undefined ? undefined : fieldHintId(name);
}

export default function FormField({
  label,
  name,
  hint,
  wide,
  children
}: FormFieldProps): React.JSX.Element {
  const id = hintIdFor(name, hint);
  return (
    <label
      className={wide === true ? 'settings-field settings-field-wide' : 'settings-field'}
      data-field={name}
    >
      <span>
        {label}
        {id !== undefined && <Hint id={id}>{hint}</Hint>}
      </span>
      {children({ describedBy: id })}
    </label>
  );
}

interface FaceProps {
  label: ReactNode;
  name: string;
  hint?: ReactNode;
  /** See `FormFieldProps.wide`. */
  wide?: boolean;
}

export interface TextFieldProps extends FaceProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Left to the caller because it is a fact about the value: a host, a verb and
   * a command are not words a dictionary has opinions about, and a display name
   * is.
   */
  spellCheck?: boolean;
  autoComplete?: string;
  /**
   * For the one field a screen opens focused. Only the form that owns the
   * dialog knows which that is, so it is passed rather than guessed at here.
   */
  inputRef?: React.RefObject<HTMLInputElement>;
  /**
   * Enter means *take this one*, for a field that adds an entry rather than
   * editing one.
   *
   * Handled here rather than left to the form's implicit submission, for the
   * reason the route panel already records: implicit submission is a browser
   * default that is easy to lose and that CDP does not drive, so the smoke run
   * could not otherwise prove the thing a person actually does. The default is
   * prevented, because the enclosing form saves the whole character.
   */
  onSubmit?: () => void;
}

export function TextField({
  label,
  name,
  hint,
  wide,
  value,
  onChange,
  onSubmit,
  placeholder,
  spellCheck,
  autoComplete,
  inputRef
}: TextFieldProps): React.JSX.Element {
  return (
    <FormField hint={hint} label={label} name={name} wide={wide}>
      {({ describedBy }) => (
        <input
          aria-describedby={describedBy}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={
            onSubmit === undefined
              ? undefined
              : (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  onSubmit();
                }
          }
          placeholder={placeholder}
          ref={inputRef}
          spellCheck={spellCheck}
          value={value}
        />
      )}
    </FormField>
  );
}

export interface NumberFieldProps extends FaceProps {
  /**
   * Held as whatever the caller is showing, not coerced here: `0` means
   * *never* in half these fields and has to be visible, while an empty field is
   * how the other half say the same thing. Both are the caller's decision.
   */
  value: number | string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * What this percentage actually is, in the character's own numbers —
   * `56/80` beside a field reading 70.
   *
   * A percentage is the right thing to *store*, because one figure then holds
   * at every level; it is the wrong thing to *reason with* when the question is
   * "will this rest start before or after the cave worm's next bite", which is
   * asked in hit points. So the field keeps the percentage and states the
   * figure beside it.
   *
   * The caller's, and null wherever the client does not know a maximum: the
   * Global page is edited with no character in the realm at all, and an unknown
   * maximum has never been drawn as a number in this client. Absent rather than
   * `0/0`, which is the same lie a meter painted red for want of a figure tells.
   */
  figure?: string | null;
}

/**
 * `inputMode="numeric"` on a text field rather than `type="number"`, which is
 * settled by what the alternative brings: spinners nobody uses, a locale's
 * decimal separator in a field that holds whole percentages, and a value that
 * reads back as the empty string the moment it is invalid — which loses the
 * number somebody was halfway through typing.
 */
export function NumberField({
  label,
  name,
  hint,
  wide,
  value,
  onChange,
  placeholder,
  figure
}: NumberFieldProps): React.JSX.Element {
  return (
    <FormField hint={hint} label={label} name={name} wide={wide}>
      {({ describedBy }) => (
        <>
          <input
            aria-describedby={describedBy}
            inputMode="numeric"
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            value={value}
          />
          {/*
            After the input, and drawn at its right-hand end -- see
            `.field-figure`, which has the reason: a settings field is a
            two-row subgrid, so this third child lands in the input's own cell
            whatever it is told, and the only question is whether it sits there
            legibly. Not appended to the label instead: the label is one line
            of small caps with a shared height, and a figure inside it would
            set one field's label taller than its neighbours' -- the identical
            defect the hint mark's own `min-height` rule exists to fix.
            `aria-hidden`, because it restates the value in the field beside it
            rather than adding a fact.
          */}
          {figure !== null && figure !== undefined && (
            <span aria-hidden="true" className="field-figure">
              {figure}
            </span>
          )}
        </>
      )}
    </FormField>
  );
}

export interface PasswordFieldProps extends FaceProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * A password, with the two attributes that must never be forgotten stated once.
 *
 * `autoComplete="new-password"` because the browser's saved-credential fill is
 * wrong here twice over: the field is blank on purpose — blank means *I did not
 * touch this* — and a filled one would write somebody's browser password into a
 * character's file.
 */
export function PasswordField({
  label,
  name,
  hint,
  wide,
  value,
  onChange,
  placeholder
}: PasswordFieldProps): React.JSX.Element {
  return (
    <FormField hint={hint} label={label} name={name} wide={wide}>
      {({ describedBy }) => (
        <input
          aria-describedby={describedBy}
          autoComplete="new-password"
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type="password"
          value={value}
        />
      )}
    </FormField>
  );
}

export interface FieldOption {
  value: string;
  label: ReactNode;
}

export interface SelectFieldProps extends FaceProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly FieldOption[];
}

export function SelectField({
  label,
  name,
  hint,
  wide,
  value,
  onChange,
  options
}: SelectFieldProps): React.JSX.Element {
  return (
    <FormField hint={hint} label={label} name={name} wide={wide}>
      {({ describedBy }) => (
        <select
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

/**
 * `wide` is not offered: a checkbox row is a sentence read left to right and
 * already takes the whole row, so a field that could say otherwise would be a
 * setting with no effect.
 */
export interface CheckFieldProps extends Omit<FaceProps, 'wide'> {
  checked: boolean;
  onChange: (value: boolean) => void;
  /**
   * A hint that describes the whole group this box sits in. `aria-describedby`
   * only speaks from the focusable control, so a group-level hint has to be
   * named by every box in the group rather than by their wrapping `<div>`,
   * where assistive technology never looks.
   */
  describedBy?: string;
}

/**
 * A checkbox row, which is the one shape that reads left to right.
 *
 * Settled, and kept: the box goes in front of the sentence it turns on, and the
 * hint follows the sentence rather than sitting inside it, because a mark in
 * the middle of a line somebody is reading is a mark in the way. Everything
 * else about the row — the name, the id, the description — is the same as every
 * other field, which is why it is a face of the same primitive rather than a
 * second one.
 */
export function CheckField({
  label,
  name,
  hint,
  checked,
  onChange,
  describedBy
}: CheckFieldProps): React.JSX.Element {
  const id = hintIdFor(name, hint);
  const description = [id, describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <label className="settings-field settings-check" data-field={name}>
      <input
        aria-describedby={description}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
      {id !== undefined && <Hint id={id}>{hint}</Hint>}
    </label>
  );
}
