/**
 * The teleport below the retreat (todo 813), drawn inside the retreat's own
 * fieldset by both settings forms: the switch and the floor it discloses as one
 * row, and a character's own command under them. Global states no command, since
 * a teleport is spelled per realm; the realm's form states it. The why is in
 * `mudengine-settings` and `mudengine-automation` › `parts/safety.md`.
 */
import { CheckField, NumberField, TextField } from './FormField';
import type { barOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { CharacterFields } from '../lib/characterForm';

type FleeGotoForm = Pick<CharacterFields, 'fleeGoto' | 'fleeGotoBelow' | 'fleeGotoCommand'>;

export interface FleeGotoFieldsProps {
  form: FleeGotoForm;
  patch(change: Partial<FleeGotoForm>): void;
  /** The floor's band strip, from the percent as typed. */
  bar(typed: string): ReturnType<typeof barOf>;
  /** The floor as a figure of this character's maximum; absent where there is none. */
  figure?(typed: string): string | null;
  /** The options file's form: the command belongs to the realm, so none is offered. */
  withoutCommand?: boolean;
  namePrefix?: string;
}

export default function FleeGotoFields({
  form,
  patch,
  bar,
  figure,
  withoutCommand = false,
  namePrefix = ''
}: FleeGotoFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="settings-inline">
        <CheckField
          checked={form.fleeGoto}
          hint={t('settings.health.fleeGotoHint')}
          label={t('settings.health.fleeGotoLabel')}
          name={`${namePrefix}flee-goto`}
          onChange={(value) => patch({ fleeGoto: value })}
        />
        {form.fleeGoto && (
          <NumberField
            label={t('settings.health.belowHealthLabel')}
            name={`${namePrefix}flee-goto-health`}
            bar={bar(form.fleeGotoBelow)}
            figure={figure?.(form.fleeGotoBelow) ?? null}
            onChange={(value) => patch({ fleeGotoBelow: value })}
            value={form.fleeGotoBelow}
          />
        )}
      </div>
      {form.fleeGoto && !withoutCommand && (
        <TextField
          hint={t('settings.health.fleeGotoCommandHint')}
          label={t('settings.health.fleeGotoCommandLabel')}
          name={`${namePrefix}flee-goto-command`}
          onChange={(value) => patch({ fleeGotoCommand: value })}
          placeholder={t('settings.health.fleeGotoCommandPlaceholder')}
          spellCheck={false}
          value={form.fleeGotoCommand}
          wide
        />
      )}
    </>
  );
}
