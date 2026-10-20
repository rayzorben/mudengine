/**
 * Whether the game view's tutorial is open. It opens by itself once per
 * launch, the first time the view comes up, while "Show this tutorial on
 * startup" is ticked; `?` opens it again at any time.
 *
 * The tick is `gameView.tutorial` with the window's own pick over it, the rule
 * the console's dock and opacity follow (`useOverridableSwitch`). "Once per
 * launch" is the window's `sessionStorage`, which a new window starts empty
 * and a reload keeps.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { readStored, writeStored } from '../lib/storage';
import { useOverridableSwitch } from './usePreference';

const STARTUP_KEY = 'mudengine.gameView.tutorial';
const SHOWN_KEY = 'mudengine.gameView.tutorialShown';

/** Whether the tutorial has opened by itself in this window already. */
const shownThisLaunch = (): boolean =>
  readStored(
    SHOWN_KEY,
    (stored) => stored === 'yes',
    () => false,
    'session'
  );

export interface GameTutorial {
  open: boolean;
  show(): void;
  close(): void;
  /** The checkbox: open by itself on the next launch. */
  onStartup: boolean;
  setOnStartup(on: boolean): void;
}

export function useGameTutorial(
  configured: boolean,
  /**
   * False until the options file has arrived (the built-in default is no
   * answer), and while the console is open.
   */
  canOpen: boolean
): GameTutorial {
  const [startup, setStartup] = useOverridableSwitch(STARTUP_KEY, configured);
  const [open, setOpen] = useState(false);
  /*
   * Ready a render after `canOpen`: the switch takes a changed file value in
   * its own effect, so in the render where the file arrives it can still hold
   * the built-in default.
   */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (canOpen) setReady(true);
  }, [canOpen]);
  useEffect(() => {
    if (!ready || startup !== 'on') return;
    if (shownThisLaunch()) return;
    writeStored(SHOWN_KEY, 'yes', 'session');
    setOpen(true);
  }, [ready, startup]);

  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const setOnStartup = useCallback((on: boolean) => setStartup(on ? 'on' : 'off'), [setStartup]);
  return useMemo(
    () => ({ open, show, close, onStartup: startup === 'on', setOnStartup }),
    [open, show, close, startup, setOnStartup]
  );
}
