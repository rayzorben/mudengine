/**
 * The help page's open state (todo 75): opened from the palette, put away by
 * its own Escape or close button, which hands the caret back. A plain
 * `useState`, like the Loops modal: a page reached for and put down, never
 * reopened on launch.
 */
import { useCallback, useState } from 'react';

export interface HelpScreenState {
  helpOpen: boolean;
  toggleHelp(): void;
  closeHelp(): void;
}

export function useHelpScreen(returnFocus: () => void): HelpScreenState {
  const [helpOpen, setHelpOpen] = useState(false);
  const toggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    returnFocus();
  }, [returnFocus]);
  return { helpOpen, toggleHelp, closeHelp };
}
