/**
 * The settings screen's Export and Import for a character: where the file
 * goes, where it comes from, and the channels. What is in the file is
 * `config/CharacterTransfer.ts`.
 *
 * The host says where: the player's choice in a dialog on the desktop; in a
 * browser, `exports/` under the home, then downloaded into the tab
 * (`WebHost.chooseSaveFile`, `Host.deliver`), and the tab's own home picker
 * for an import (`lib/pickers.ts`).
 */
import fs from 'node:fs';

import { asProfileId } from '../../shared/drafts';
import { fileSlug } from '../../shared/files';
import { Invoke, type CharacterExport, type CharacterImport } from '../../shared/ipc';
import { errorMessage } from '../../shared/values';
import { exportCharacter, importCharacter } from '../config/CharacterTransfer';
import type { Host } from '../host/Host';
import type { Home } from './home';
import { t } from './i18n';
import { tuning } from './tuning';

export interface TransferDeps {
  home: Home;
  host: Pick<Host, 'transport' | 'chooseFile' | 'chooseSaveFile' | 'deliver'>;
  /** Whether a loaded character already uses this id, file or no file. */
  loaded(id: string): boolean;
}

export function handleCharacterTransfer({ home, host, loaded }: TransferDeps): void {
  const { handle } = host.transport;

  handle(
    Invoke.exportCharacter,
    async (caller, rawId: unknown, rawPassword: unknown): Promise<CharacterExport> => {
      const id = asProfileId(rawId);
      if (id === null) return { kind: 'refused', error: t('app.profiles.noSuchCharacter') };
      const built = await exportCharacter(home, id, rawPassword === true);
      if (!built.ok) return { kind: 'refused', error: built.error };
      try {
        const file = await host.chooseSaveFile(caller, {
          title: t('app.dialog.exportCharacterTitle'),
          defaultName: `${fileSlug(built.name)}-${new Date().toISOString().slice(0, 10)}.tar.gz`,
          extensions: ['gz'],
          extensionsLabel: t('app.dialog.characterFileFilter')
        });
        if (file === null) return { kind: 'dismissed' };
        await fs.promises.writeFile(file, built.bytes);
        return { kind: 'written', file, download: host.deliver(caller, file) };
      } catch (error) {
        return {
          kind: 'refused',
          error: t('app.transfer.exportFailed', { message: errorMessage(error) })
        };
      }
    }
  );

  handle(Invoke.chooseCharacterFile, (caller) =>
    host.chooseFile(caller, {
      title: t('app.dialog.importCharacterTitle'),
      extensions: ['gz'],
      extensionsLabel: t('app.dialog.characterFileFilter'),
      allFilesLabel: t('app.dialog.allFilesFilter')
    })
  );

  handle(Invoke.importCharacter, async (_caller, rawFile: unknown): Promise<CharacterImport> => {
    if (typeof rawFile !== 'string' || rawFile.length === 0) {
      return { kind: 'refused', error: t('app.transfer.notACharacter') };
    }
    const { maxImportBytes } = tuning().transfer;
    try {
      // Asked before reading: a device, a directory or a huge log picked by
      // mistake is refused without main holding it.
      const info = await fs.promises.stat(rawFile);
      if (!info.isFile() || info.size > maxImportBytes) {
        return { kind: 'refused', error: t('app.transfer.notACharacter') };
      }
      const bytes = await fs.promises.readFile(rawFile);
      return await importCharacter(home, bytes, { maxBytes: maxImportBytes, taken: loaded });
    } catch (error) {
      return {
        kind: 'refused',
        error: t('app.transfer.unreadable', { file: `${rawFile}: ${errorMessage(error)}` })
      };
    }
  });
}
