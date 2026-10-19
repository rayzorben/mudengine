/**
 * The drawn portrait at full size over the character panel, from a press on
 * the small one (todo 20261019-0931-01): Copy puts it on the clipboard as a
 * PNG, Save writes the file as drawn. Esc or × goes back to the panel.
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { PNG_DATA_URL } from '@shared/portrait';
import { errorMessage } from '@shared/values';
import { t } from '../../lib/i18n';
import Icon from '../Icon';

/**
 * The picture as a PNG `data:` URL, the one type every clipboard takes: a
 * WebP is redrawn on a canvas, since Electron's clipboard image reads no WebP.
 * Null where the window has no canvas to draw on.
 */
async function pngOf(src: string): Promise<string | null> {
  if (src.startsWith(PNG_DATA_URL)) return src;
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function PortraitViewer({
  src,
  name,
  api,
  session,
  onClose
}: {
  src: string;
  name: string;
  api: Pick<IpcApi, 'copyImage' | 'savePortrait'>;
  session: SessionId;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => close.current?.focus(), []);

  const copy = (): void => {
    pngOf(src)
      .then((png) => (png === null ? false : api.copyImage(png)))
      .then(
        (copied) =>
          setSaid(copied ? t('game.sheet.portraitCopied') : t('game.sheet.portraitNotCopied')),
        (error: unknown) =>
          setSaid(t('game.sheet.portraitCopyFailed', { message: errorMessage(error) }))
      );
  };
  const save = (): void => {
    api.savePortrait(session).then(
      (result) => {
        if (result.kind === 'refused') setSaid(result.error);
        else if (result.kind === 'written' && result.download !== null) {
          setSaid(t('game.sheet.portraitDownloaded'));
        } else if (result.kind === 'written') {
          setSaid(t('game.sheet.portraitSaved', { file: result.file }));
        }
      },
      (error: unknown) =>
        setSaid(t('game.sheet.portraitSaveFailed', { message: errorMessage(error) }))
    );
  };
  // Its own Esc, before the game view's closes the whole panel.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      aria-label={t('game.sheet.portraitViewer', { name })}
      className="gv-portrait-viewer"
      aria-modal="true"
      onKeyDown={onKeyDown}
      role="dialog"
    >
      <img alt={name} src={src} />
      <div className="gv-portrait-viewer-bar">
        {said !== null && <span className="gv-quiet">{said}</span>}
        <button
          aria-label={t('game.sheet.portraitCopy')}
          className="gv-icon-button"
          onClick={copy}
          title={t('game.sheet.portraitCopy')}
          type="button"
        >
          <Icon name="copy" />
        </button>
        <button
          aria-label={t('game.sheet.portraitSave')}
          className="gv-icon-button"
          onClick={save}
          title={t('game.sheet.portraitSave')}
          type="button"
        >
          <Icon name="download" />
        </button>
        <button
          aria-label={t('game.sheet.portraitClose')}
          className="gv-icon-button"
          onClick={onClose}
          ref={close}
          title={t('game.sheet.portraitClose')}
          type="button"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default memo(PortraitViewer);
