/**
 * A character as a circle, its picture from `useCharacterPicture`. Drawn on the hidden tab rail's strip and at the
 * head of every tab on a side rail.
 */
import { memo } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { useCharacterPicture } from '../hooks/useCharacterPicture';
import { useItemArt } from '../hooks/useItemArt';
import { usePortrait } from '../hooks/usePortrait';

export type PortraitApi = Pick<IpcApi, 'portrait' | 'onPortrait'>;

function CharacterBadge({
  api,
  session,
  name,
  race,
  className
}: {
  api: PortraitApi;
  session: SessionId;
  name: string;
  race: string | null;
  className: string | null;
}) {
  const portrait = usePortrait(api, session);
  const { src, failed, drawn, initial } = useCharacterPicture(
    useItemArt(),
    portrait,
    race,
    className,
    name
  );
  // The drawn portrait is a whole figure and is cropped to the head; the race and class one is a bust.
  const picture = src === null ? undefined : drawn ? 'drawn' : 'kind';
  // Decorative: the name is beside it on a tab and in the strip's tooltip.
  return (
    <span aria-hidden="true" className="badge" data-picture={picture}>
      {src === null ? initial : <img alt="" onError={failed} src={src} />}
    </span>
  );
}

export default memo(CharacterBadge);
