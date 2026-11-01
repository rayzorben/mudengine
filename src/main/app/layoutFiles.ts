/**
 * The rail head's Layouts menu, to and from a file: where a card layout is
 * written, where it is read from, and the channels. The window owns the
 * layout inside the file (`renderer/src/lib/cardLayouts.ts`) and reads it
 * itself; main writes and hands back only text that is a card layout file
 * (`shared/cardLayoutFile.ts`), so the read channel never returns another
 * file's text.
 *
 * The host says where, as for a character export (`app/transfer.ts`).
 */
import { layoutFileValue } from '../../shared/cardLayoutFile';
import { fileSlug } from '../../shared/files';
import { Invoke, type SavedFile, type TextFileRead } from '../../shared/ipc';
import type { Host } from '../host/Host';
import { readChosenFile, writeChosenFile } from './chosenFile';
import { t } from './i18n';
import { tuning } from './tuning';

export interface LayoutFilesDeps {
  host: Pick<Host, 'transport' | 'chooseFile' | 'chooseSaveFile' | 'deliver'>;
}

/** What a card layout file is called on disk; the dialogs filter on it. */
const EXTENSION = 'json';

export function handleLayoutFiles({ host }: LayoutFilesDeps): void {
  const { handle } = host.transport;

  handle(
    Invoke.saveCardLayout,
    async (caller, rawName: unknown, rawText: unknown): Promise<SavedFile> => {
      // Both bridges pass two strings: anything else is a broken caller.
      if (typeof rawName !== 'string' || typeof rawText !== 'string') {
        throw new TypeError('saveCardLayout takes a name and the file text, both strings');
      }
      const bytes = Buffer.from(rawText, 'utf8');
      if (bytes.length > tuning().transfer.maxLayoutBytes || layoutFileValue(rawText) === null) {
        return { kind: 'refused', error: t('app.cardLayout.notALayout') };
      }
      return writeChosenFile(
        host,
        caller,
        {
          title: t('app.dialog.saveCardLayoutTitle'),
          defaultName: `${fileSlug(rawName)}-layout.${EXTENSION}`,
          extensions: [EXTENSION],
          extensionsLabel: t('app.dialog.cardLayoutFilter')
        },
        bytes,
        (message) => t('app.cardLayout.saveFailed', { message })
      );
    }
  );

  handle(Invoke.chooseCardLayoutFile, (caller) =>
    host.chooseFile(caller, {
      title: t('app.dialog.loadCardLayoutTitle'),
      extensions: [EXTENSION],
      extensionsLabel: t('app.dialog.cardLayoutFilter'),
      allFilesLabel: t('app.dialog.allFilesFilter')
    })
  );

  handle(Invoke.readCardLayout, async (_caller, rawFile: unknown): Promise<TextFileRead> => {
    const notALayout = t('app.cardLayout.notALayout');
    const read = await readChosenFile(rawFile, tuning().transfer.maxLayoutBytes, notALayout);
    if (!read.ok) return { kind: 'refused', error: read.error };
    const text = read.bytes.toString('utf8');
    return layoutFileValue(text) === null
      ? { kind: 'refused', error: notALayout }
      : { kind: 'read', text };
  });
}
