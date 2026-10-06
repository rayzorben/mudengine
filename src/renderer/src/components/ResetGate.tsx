import { useEffect, useState } from 'react';

import ResetPrompt from './ResetPrompt';
import type { Addressed, IpcApi, ProfileSummary, ResetNotice } from '@shared/ipc';

export interface ResetGateProps {
  api: Pick<IpcApi, 'onCharacterReset' | 'forgetCharacter'>;
  profiles: readonly Pick<ProfileSummary, 'id' | 'name'>[];
  returnFocus(): void;
}

/**
 * The client thinks the character in the realm is not the one its records are
 * about, and is asking (`ResetPrompt`).
 *
 * The question is held here rather than remembered anywhere: main asks once
 * per session (`SessionManager.watchForReset`), so a dialog that survived a
 * reload would be one nobody could answer. Null is *nothing noticed*. Out of
 * `App` with the state it owns.
 */
export default function ResetGate({
  api,
  profiles,
  returnFocus
}: ResetGateProps): React.JSX.Element {
  const [asked, setAsked] = useState<Addressed<ResetNotice> | null>(null);
  // Not folded into a view: it is a question about a character rather than a
  // fact about one, and it is answered once.
  useEffect(() => api.onCharacterReset(setAsked), [api]);

  return (
    <ResetPrompt
      characterName={
        profiles.find((profile) => profile.id === asked?.session)?.name ?? asked?.session ?? ''
      }
      notice={asked?.payload ?? null}
      onForget={() => {
        setAsked(null);
        if (asked) void api.forgetCharacter(asked.session);
        returnFocus();
      }}
      onKeep={() => {
        setAsked(null);
        returnFocus();
      }}
    />
  );
}
