/**
 * Bytes written to a file the player picks, and handed to a browser tab:
 * the desktop's save dialog, or `exports/` under the home and a download
 * (`WebHost.chooseSaveFile`, `Host.deliver`). The character export and the
 * portrait's Save both write this way.
 */
import fs from 'node:fs';

import type { SavedFile } from '../../shared/ipc';
import { errorMessage } from '../../shared/values';
import type { Caller, Host, SaveChoice } from '../host/Host';

export async function writeChosenFile(
  host: Pick<Host, 'chooseSaveFile' | 'deliver'>,
  caller: Caller,
  choice: SaveChoice,
  bytes: Uint8Array,
  failed: (message: string) => string
): Promise<SavedFile> {
  try {
    const file = await host.chooseSaveFile(caller, choice);
    if (file === null) return { kind: 'dismissed' };
    await fs.promises.writeFile(file, bytes);
    return { kind: 'written', file, download: host.deliver(caller, file) };
  } catch (error) {
    return { kind: 'refused', error: failed(errorMessage(error)) };
  }
}
