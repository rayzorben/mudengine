/**
 * The low-lives question (todo 07): main held a dial because the character is
 * down to its last few lives with automation on, and nothing logs it in until
 * the player answers. Main dials on the answer (`Invoke.answerLowLives`).
 *
 * One question per character, asked oldest first: Connect on Start can hold
 * several at once. A window that attaches after the question was put (a dial
 * at launch, a reload) takes it from the attach snapshot.
 */
import { useCallback, useEffect, useState } from 'react';

import type { Addressed, AttachSnapshot, IpcApi, LowLivesAsk, SessionId } from '@shared/ipc';
import type { LowLivesAnswer } from '@shared/lives';

export interface LowLivesQuestion {
  /** The question on screen and whose it is, or null while none is open. */
  asked: Addressed<LowLivesAsk> | null;
  /** Closes the question on screen with the player's answer and hands the caret back. */
  answer(answer: LowLivesAnswer): void;
  /** Hands an attach snapshot on to `apply`, then opens or closes the character's question from it. */
  attached(session: SessionId, snapshot: AttachSnapshot): void;
}

export function useLowLivesAsk(
  api: Pick<IpcApi, 'onLowLives' | 'answerLowLives'>,
  returnFocus: () => void,
  apply: (session: SessionId, snapshot: AttachSnapshot) => void
): LowLivesQuestion {
  const [open, setOpen] = useState<readonly Addressed<LowLivesAsk>[]>([]);

  // Asked again, a character's question replaces its own in place.
  useEffect(() => api.onLowLives((ask) => setOpen((was) => putAsk(was, ask))), [api]);

  // Main's open question is the authority at attach: none there means none here.
  const attached = useCallback(
    (session: SessionId, snapshot: AttachSnapshot) => {
      apply(session, snapshot);
      const payload = snapshot.lowLives;
      setOpen((was) =>
        payload === null
          ? was.filter((held) => held.session !== session)
          : putAsk(was, { session, payload })
      );
    },
    [apply]
  );

  const asked = open[0] ?? null;
  const answer = useCallback(
    (given: LowLivesAnswer) => {
      if (asked === null) return;
      setOpen((was) => was.filter((held) => held.session !== asked.session));
      void api.answerLowLives(asked.session, given);
      returnFocus();
    },
    [api, asked, returnFocus]
  );

  return { asked, answer, attached };
}

function putAsk(
  was: readonly Addressed<LowLivesAsk>[],
  ask: Addressed<LowLivesAsk>
): readonly Addressed<LowLivesAsk>[] {
  return was.some((held) => held.session === ask.session)
    ? was.map((held) => (held.session === ask.session ? ask : held))
    : [...was, ask];
}
