/**
 * The settings footer's file buttons: open the options file or the
 * characters folder, and export or import a character (todo 000).
 *
 * Export asks first whether the account password goes in the file, because
 * the file is made to be carried to another computer. What the file holds is
 * `main/config/CharacterTransfer.ts`.
 */
import { useState } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { errorMessage } from '@shared/values';

export interface SettingsPathsProps {
  /** The character open in the form, or null when none is. */
  character: string | null;
  revealConfig(): void;
  revealProfiles(): void;
  /** One line in the footer: a refusal, or what was done. */
  report(problem: string | null, saved: string | null): void;
  /**
   * A character was imported under this id: show it. Resolves once it is
   * open, so the report that follows is not cleared by opening it.
   */
  onImported(id: string): Promise<void>;
}

export default function SettingsPaths({
  character,
  revealConfig,
  revealProfiles,
  report,
  onImported
}: SettingsPathsProps) {
  const api = window.mudengine;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    report(null, null);
    work()
      .catch((error: unknown) => report(errorMessage(error), null))
      .finally(() => setBusy(false));
  };

  const exportWith = (password: boolean): void => {
    setAsking(false);
    if (character === null) return;
    run(async () => {
      const result = await api.exportCharacter(character, password);
      if (result.kind === 'refused') report(result.error, null);
      else if (result.kind === 'written') {
        report(null, t('settings.transfer.exported', { file: result.file }));
      }
    });
  };

  const importOne = (): void =>
    run(async () => {
      const file = await api.chooseCharacterFile();
      if (file === null) return;
      const result = await api.importCharacter(file);
      if (result.kind === 'refused') return report(result.error, null);
      await onImported(result.id);
      report(
        null,
        [t('settings.transfer.imported', { characterName: result.name }), ...result.notes].join(' ')
      );
    });

  return (
    <span className="settings-paths">
      {asking ? (
        <>
          <span className="hint">{t('settings.transfer.askPassword')}</span>
          <button
            className="quiet"
            onClick={() => exportWith(false)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('settings.transfer.withoutPassword')}
          </button>
          <button
            className="quiet"
            onClick={() => exportWith(true)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('settings.transfer.withPassword')}
          </button>
          <button
            className="quiet"
            onClick={() => setAsking(false)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('settings.transfer.cancel')}
          </button>
        </>
      ) : (
        <>
          <button
            className="quiet"
            disabled={busy || character === null}
            onClick={() => setAsking(true)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('settings.transfer.export')}
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={importOne}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('settings.transfer.import')}
          </button>
        </>
      )}
      {/* Everything this screen does not cover is one click away, and saying
          so is what keeps the screen from having to grow into a YAML editor. */}
      <button className="quiet" onClick={revealConfig} onMouseDown={keepFocus} type="button">
        {t('settings.footer.openConfig')}
      </button>
      <button className="quiet" onClick={revealProfiles} onMouseDown={keepFocus} type="button">
        {t('settings.footer.openProfiles')}
      </button>
    </span>
  );
}
