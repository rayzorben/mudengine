/**
 * A login script's rows, drawn once for the realm's form and a character's:
 * when → send, repeat, and removing one. Adding a row stays each form's own,
 * since a character's first copies its realm's script. The why is in
 * `mudengine-settings`.
 */
import Icon from './Icon';

import { t } from '../lib/i18n';
import type { LoginStepDraft } from '@shared/drafts';

export interface LoginStepRowsProps {
  steps: LoginStepDraft[];
  onChange(steps: LoginStepDraft[]): void;
  /** Each form words its own, the realm's naming the realm and a character's the character. */
  whenPlaceholder: string;
  sendPlaceholder: string;
}

export default function LoginStepRows({
  steps,
  onChange,
  whenPlaceholder,
  sendPlaceholder
}: LoginStepRowsProps) {
  if (steps.length === 0) return null;
  const edit = (index: number, change: Partial<LoginStepDraft>): void =>
    onChange(steps.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));
  return (
    <ul className="settings-steps">
      {steps.map((step, index) => (
        // Keyed by position, deliberately: rows are edited in place and
        // identified by nothing else — two blank rows are genuinely the same
        // until somebody types.
        <li key={index}>
          <input
            aria-label={t('settings.login.stepWhenAria', { stepNumber: index + 1 })}
            onChange={(event) => edit(index, { when: event.target.value })}
            placeholder={whenPlaceholder}
            value={step.when}
          />
          <span aria-hidden="true" className="arrow">
            →
          </span>
          <input
            aria-label={t('settings.login.stepSendAria', { stepNumber: index + 1 })}
            className="answer"
            onChange={(event) => edit(index, { send: event.target.value })}
            placeholder={sendPlaceholder}
            value={step.send}
          />
          <input
            aria-label={t('settings.login.stepRepeatAria', { stepNumber: index + 1 })}
            checked={step.repeat ?? false}
            className="repeat"
            onChange={(event) => edit(index, { repeat: event.target.checked })}
            title={t('settings.login.stepRepeatTitle')}
            type="checkbox"
          />
          <button
            aria-label={t('settings.login.removeStepAria', { stepNumber: index + 1 })}
            className="quiet"
            onClick={() => onChange(steps.filter((_, at) => at !== index))}
            title={t('settings.login.removeStepTitle')}
            type="button"
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
}
