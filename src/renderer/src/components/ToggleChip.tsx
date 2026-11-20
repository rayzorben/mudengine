export interface ToggleChipProps {
  label: string;
  name: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  /** A chip that only qualifies the one before it, drawn smaller. */
  sub?: boolean;
  title?: string;
  describedBy?: string;
}

/**
 * A yes-or-no on a settings row, drawn as a chip: an outline while off, a tint
 * of the accent while on. It is a checkbox underneath, so it is named, focused
 * and pressed as one.
 */
export default function ToggleChip({
  label,
  name,
  checked,
  onChange,
  disabled,
  sub,
  title,
  describedBy
}: ToggleChipProps) {
  return (
    <label className="toggle-chip" data-sub={sub === true ? '' : undefined} title={title}>
      <input
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        name={name}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}
