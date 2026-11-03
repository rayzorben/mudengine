/**
 * Bytes written to a file the player picks, and handed to a browser tab:
 * the desktop's save dialog, or `exports/` under the home and a download
 * (`WebHost.chooseSaveFile`, `Host.deliver`). The character export, the
 * portrait's Save and a card layout write this way; the character import and
 * a card layout read a picked file through `readChosenFile`.
 */
import fs from 'node:fs';

import type { SavedFile } from '../../shared/ipc';
import { errorMessage } from '../../shared/values';
import type { Caller, Host, SaveChoice } from '../host/Host';
import { t } from './i18n';

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

/** A file the player picked, read whole, or the sentence the player is told instead. */
export type ChosenRead = { ok: true; bytes: Buffer } | { ok: false; error: string };

/**
 * Read a file a picker returned. The host first says the window could have
 * picked it (`Host.chosenPath`), so a window naming any other file learns
 * nothing about it. Its size is asked before it is read, so a device, a
 * directory or a huge file picked by mistake is refused without main holding
 * it; `refused` is the sentence for that, and for no path at all.
 */
export async function readChosenFile(
  host: Pick<Host, 'chosenPath'>,
  caller: Caller,
  rawFile: unknown,
  maxBytes: number,
  refused: string
): Promise<ChosenRead> {
  if (typeof rawFile !== 'string' || rawFile.length === 0) return { ok: false, error: refused };
  try {
    const file = await host.chosenPath(caller, rawFile);
    if (file === null) return { ok: false, error: t('app.files.notPicked', { file: rawFile }) };
    const info = await fs.promises.stat(file);
    if (!info.isFile() || info.size > maxBytes) return { ok: false, error: refused };
    return { ok: true, bytes: await fs.promises.readFile(file) };
  } catch (error) {
    return { ok: false, error: unreadable(rawFile, error) };
  }
}

/** The sentence for a file that could not be read, with where and why. */
export function unreadable(file: string, error: unknown): string {
  return t('app.files.unreadable', { file, message: errorMessage(error) });
}
