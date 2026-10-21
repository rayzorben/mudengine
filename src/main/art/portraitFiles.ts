/**
 * The character panel's Save on an enlarged portrait (todo 20261019-0931-01):
 * the picture as drawn, written where the player picks on the desktop, or
 * under the home and downloaded into a browser tab (`writeChosenFile`).
 */
import { fileSlug } from '../../shared/files';
import { Invoke, type SavedFile, type SessionId } from '../../shared/ipc';
import { writeChosenFile } from '../app/chosenFile';
import { t } from '../app/i18n';
import type { Host } from '../host/Host';
import type { Picture } from './pictureCache';

export interface PortraitFilesDeps {
  host: Pick<Host, 'transport' | 'chooseSaveFile' | 'deliver'>;
  picture(id: SessionId): Picture | null;
  /** The character's name, for the file's. */
  nameOf(id: SessionId): string;
}

const EXTENSION: Record<Picture['type'], string> = { 'image/webp': 'webp', 'image/png': 'png' };

export function handlePortraitFiles({ host, picture, nameOf }: PortraitFilesDeps): void {
  host.transport.handle(
    Invoke.savePortrait,
    async (caller, session: unknown): Promise<SavedFile> => {
      const shown = typeof session === 'string' ? picture(session) : null;
      if (shown === null || typeof session !== 'string') {
        return { kind: 'refused', error: t('app.portrait.none') };
      }
      const extension = EXTENSION[shown.type];
      return writeChosenFile(
        host,
        caller,
        {
          title: t('app.dialog.savePortraitTitle'),
          defaultName: `${fileSlug(nameOf(session))}-portrait.${extension}`,
          extensions: [extension],
          extensionsLabel: t('app.dialog.pictureFilter')
        },
        shown.bytes,
        (message) => t('app.portrait.saveFailed', { message })
      );
    }
  );
}
