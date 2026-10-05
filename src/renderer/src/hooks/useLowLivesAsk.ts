/**
 * The low-lives question (todo 07): main held a dial because the character is
 * down to its last few lives with automation on, and nothing logs it in until
 * the player answers. Main dials on the answer (`Invoke.answerLowLives`).
 *
 * One question per character, asked oldest first: Connect on Start can hold
 * several at once. Not kept across a reload; pressing Connect asks again.
 */
import { useCallback, useEffect, useState } from 'react';

import type { Addressed, IpcApi, LowLivesAsk } from '@shared/ipc';
import type { LowLivesAnswer } from '@shared/lives';

export interface LowLivesQuestion {
  /** The question on screen and whose it is, or null while none is open. */
  asked: Addressed<LowLivesAsk> | null;
  /** Closes the question on screen with the player's answer and hands the caret back. */
  answer(answer: LowLivesAnswer): void;
}

export function useLowLivesAsk(
  api: Pick<IpcApi, 'onLowLives' | 'answerLowLives'>,
  returnFocus: () => void
): LowLivesQuestion {
  const [open, setOpen] = useState<readonly Addressed<LowLivesAsk>[]>([]);

  // Asked again, a character's question replaces its own in place.
  useEffect(
    () =>
      api.onLowLives((ask) =>
        setOpen((was) =>
          was.some((held) => held.session === ask.session)
            ? was.map((held) => (held.session === ask.session ? ask : held))
            : [...was, ask]
        )
      ),
    [api]
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

  return { asked, answer };
}
