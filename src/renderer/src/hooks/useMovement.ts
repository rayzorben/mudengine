/**
 * Moving a character: play, back and stop, a lap's skip and turn, a loop
 * started from the Loops modal or the Hunting card, each refusal said in the
 * console of the character it was about, and the question play may answer
 * with (`MovementPrompt`), held until somebody answers it.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/cards.md`, *Routing,
 * looping or stopped: one card, one face, one transport*.
 */
import { useCallback, useState } from 'react';

import { t } from '../lib/i18n';
import { loopOwner, type LoopChoice, type LoopDestination } from '../lib/loops';
import type { IpcApi, ProfileSummary, SessionId } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import type { MovementConfirm } from '@shared/movement';

/** A question play or back asked, and whose press is owed the answer. */
export type Wandered = { session: SessionId; loop: string | null } & MovementConfirm;

export interface MovementInputs {
  api: Pick<
    IpcApi,
    | 'startMoving'
    | 'stepBack'
    | 'stopMoving'
    | 'skipLoopStop'
    | 'reverseLoop'
    | 'startLoop'
    | 'runLoop'
    | 'addLoop'
  >;
  /** The character on screen, or `NO_SESSION`. */
  session: SessionId;
  profiles: readonly Pick<ProfileSummary, 'id' | 'serverName'>[];
  returnFocus(): void;
  /** A sentence into one character's console. */
  say(session: SessionId, message: string): void;
}

export interface Movement {
  /** A refusal said in its own character's console. */
  sayRefusal(sid: SessionId): (refused: string | null) => void;
  /** Play, for any character, answered with a question past a distance. */
  startMovingIn(sid: SessionId, loop: string | null, confirmed: number | null): void;
  /** Back, for any character. */
  stepBackIn(sid: SessionId, confirmed: number | null): void;
  /** The shown character's transport, each handing the caret back. */
  startMoving(loop: string | null): void;
  stopMoving(): void;
  startLoop(name: string): void;
  skipLoop(): void;
  reverseLoop(): void;
  runChosenLoop(choice: LoopChoice, destination: LoopDestination): void;
  runHunt(loop: Loop, destination: LoopDestination): void;
  /** The question asked, or null while nothing has been. */
  wandered: Wandered | null;
  /** Leave the movement stopped where it was. */
  stay(): void;
  /** Press the same play again, with the figure that was on screen. */
  walkOn(): void;
}

export function useMovement({
  api,
  session,
  profiles,
  returnFocus,
  say
}: MovementInputs): Movement {
  /**
   * The character has wandered a long way from what it was walking, and play
   * is asking before it walks it back. Null while nothing has been asked.
   *
   * Held in the window rather than in main, like `resetAsked` in `App`: main
   * decided there was a question (it is the only side that can measure the
   * distance) and this is the window holding it until somebody answers. The
   * loop the picker named goes with it, so pressing *walk it* presses exactly
   * the play that was pressed.
   */
  const [wandered, setWandered] = useState<Wandered | null>(null);

  const stopMoving = useCallback(() => {
    // One stop for both: main works out whether it is a lap or a route, and
    // stops the leg with the lap — a stopped walk under a live loop is a walk
    // the loop would just restart. Neither forgets where it was.
    void api.stopMoving(session);
    // The rail takes no typed input, so a click in it must not keep the caret:
    // stopping is exactly the moment you want to be able to type.
    returnFocus();
  }, [api, returnFocus, session]);
  /*
   * The lap's other controls, each handing the caret back like every click in
   * the rail. A refusal — nothing looping, a plain loop asked to turn round —
   * is said in the console of the character it was about, the same way the
   * palette's loop command reports one.
   */
  const sayRefusal = useCallback(
    (sid: SessionId) => (refused: string | null) => {
      if (refused) say(sid, refused);
    },
    [say]
  );
  /**
   * Start a loop chosen from the modal, and keep it where the player said.
   *
   * **Filed first, then started, and the order is not an accident.**
   * `loop:start` resolves a name against the character's *own* resolved
   * options, which is the same list the palette and the card start from — a
   * loop that has never been written into a scope this character reads is a
   * name main answers `notFound` to. So the write has to land, and the store
   * has to have re-read it, before the start is asked for.
   *
   * `Don't keep it` takes the other channel entirely: `loop:run` hands the
   * loop over whole, so nothing is written and nothing has to be cleaned up
   * afterwards. Filing one in order to start it and then deleting it would be
   * a write into the user's tree on the one path that promised not to make
   * one.
   *
   * **A row that is only *held* is already on disk and is started by name.**
   * `loop:list` reports one as a name and a stop *count*, never its stops, so
   * there is no loop to hand over and nothing to file — `loop:start` resolves
   * it exactly as the palette and the card do. The first version of this
   * invented empty stops to make such a row look like a shelf loop, and
   * `asLoops` then dropped them: the client refused the player's own
   * hand-written loop as one it could not file, which is a false claim about
   * their data as well as a loop that did not walk.
   *
   * Either way the outcome is said out loud in the character's own console —
   * a loop quietly filed somewhere is a file somebody finds a fortnight later
   * with no memory of asking for it.
   */
  const runChosenLoop = useCallback(
    (choice: LoopChoice, destination: LoopDestination) => {
      const refuse = sayRefusal(session);
      const said = (message: string) => say(session, message);

      void (async () => {
        // Already on disk: nothing to write, whatever the destination says.
        if (choice.kind === 'by-name') {
          const refused = await api.startLoop(session, choice.name);
          refuse(refused);
          if (refused === null) said(t('loops.startedKept', { loopName: choice.name }));
          return;
        }

        const { loop } = choice;
        if (destination === 'none') {
          const refused = await api.runLoop(session, loop);
          refuse(refused);
          if (refused === null) said(t('loops.startedOnly', { loopName: loop.name }));
          return;
        }

        const refused = await api.addLoop(
          destination,
          loopOwner(destination, session, profiles),
          loop
        );
        if (refused !== null) {
          refuse(refused);
          return;
        }
        const started = await api.startLoop(session, loop.name);
        refuse(started);
        if (started === null) said(t('loops.startedKept', { loopName: loop.name }));
      })();
    },
    [api, profiles, say, sayRefusal, session]
  );

  /** A loop the Hunting card built: the same two outcomes as the builder's save. */
  const runHunt = useCallback(
    (loop: Loop, destination: LoopDestination) => {
      runChosenLoop({ kind: 'loop', loop }, destination);
      returnFocus();
    },
    [returnFocus, runChosenLoop]
  );

  const startLoop = useCallback(
    (name: string) => {
      void api.startLoop(session, name).then(sayRefusal(session));
      returnFocus();
    },
    [api, returnFocus, sayRefusal, session]
  );
  /*
   * Play, for any character — the float's own as well as the shown one.
   *
   * Three answers and one of them is a question: main measures how far the
   * character has wandered from whatever it was walking, and past
   * `tuning.walk.resumeAskSteps` it asks rather than walking it back across
   * the realm. The window holds the question until somebody answers it, and
   * pressing play again with `confirmed` is the answer. See `MovementPrompt`.
   */
  const startMovingIn = useCallback(
    (sid: SessionId, loop: string | null, confirmed: number | null) => {
      void api.startMoving(sid, loop, confirmed).then((answer) => {
        if ('confirm' in answer) {
          setWandered({ session: sid, loop, ...answer.confirm });
          return;
        }
        if ('refused' in answer) sayRefusal(sid)(answer.refused);
      });
    },
    [api, sayRefusal]
  );
  const startMoving = useCallback(
    (loop: string | null) => {
      startMovingIn(session, loop, null);
      returnFocus();
    },
    [returnFocus, session, startMovingIn]
  );
  /*
   * Back, for any character: one room the way it came.
   *
   * Answers like play, and for the same reason — the way back is not always
   * one step, and a press that quietly became a fourteen-step journey round a
   * one-way corridor would be this gesture meaning something nobody intended.
   * The window holds that question in `wandered`, whose `kind` says which of
   * the two presses is owed the answer.
   */
  const stepBackIn = useCallback(
    (sid: SessionId, confirmed: number | null) => {
      void api.stepBack(sid, confirmed).then((answer) => {
        if ('confirm' in answer) {
          setWandered({ session: sid, loop: null, ...answer.confirm });
          return;
        }
        if ('refused' in answer) sayRefusal(sid)(answer.refused);
      });
    },
    [api, sayRefusal]
  );
  const skipLoop = useCallback(() => {
    void api.skipLoopStop(session).then(sayRefusal(session));
    returnFocus();
  }, [api, returnFocus, sayRefusal, session]);
  const reverseLoop = useCallback(() => {
    void api.reverseLoop(session).then(sayRefusal(session));
    returnFocus();
  }, [api, returnFocus, sayRefusal, session]);

  const stay = useCallback(() => {
    setWandered(null);
    returnFocus();
  }, [returnFocus]);
  const walkOn = useCallback(() => {
    const asked = wandered;
    setWandered(null);
    // The figure that was on screen goes back with the answer: agreeing
    // to a journey is agreeing to *that* journey, and main asks again if
    // it has grown while the dialog stood.
    if (asked?.kind === 'back') stepBackIn(asked.session, asked.steps);
    else if (asked) startMovingIn(asked.session, asked.loop, asked.steps);
    returnFocus();
  }, [returnFocus, startMovingIn, stepBackIn, wandered]);

  return {
    sayRefusal,
    startMovingIn,
    stepBackIn,
    startMoving,
    stopMoving,
    startLoop,
    skipLoop,
    reverseLoop,
    runChosenLoop,
    runHunt,
    wandered,
    stay,
    walkOn
  };
}
