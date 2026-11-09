/**
 * A file from the viewer's own machine, sent to the client in web mode and
 * stored under its home (`main/host/web/uploads.ts`). The answer is the
 * stored path, which the picker hands back exactly as if the player had
 * chosen it from the home listing. Only a browser tab draws the picker that
 * calls this; the desktop picks with the operating system's dialog.
 */
import { UPLOAD_NAME_HEADER, UPLOAD_PATH } from '@shared/rpc';
import { errorMessage } from '@shared/values';
import { t } from './i18n';

export type Uploaded = { kind: 'stored'; file: string } | { kind: 'refused'; error: string };

export async function uploadToClient(file: File): Promise<Uploaded> {
  let response: Response;
  try {
    response = await fetch(UPLOAD_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { [UPLOAD_NAME_HEADER]: encodeURIComponent(file.name) },
      body: file
    });
  } catch (error) {
    // A cap passed mid-stream tears the request down, so the browser sees a network error.
    return {
      kind: 'refused',
      error: t('browser.upload.failed', {
        name: file.name,
        message: errorMessage(error)
      })
    };
  }
  if (response.status === 413) {
    return { kind: 'refused', error: t('browser.upload.tooLarge', { name: file.name }) };
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  const stored =
    typeof body === 'object' && body !== null && 'file' in body && typeof body.file === 'string'
      ? body.file
      : null;
  return stored === null
    ? {
        kind: 'refused',
        error: t('browser.upload.failed', { name: file.name, message: String(response.status) })
      }
    : { kind: 'stored', file: stored };
}
