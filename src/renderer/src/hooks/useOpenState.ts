/**
 * The open state of a page or panel that is reached for and put down: a plain
 * `useState`, never reopened on launch, whose close hands the caret back. The
 * help page and the theme picker are each one of these.
 */
import { useCallback, useState } from 'react';

export interface OpenState {
  open: boolean;
  toggle(): void;
  close(): void;
}

export function useOpenState(returnFocus: () => void): OpenState {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => {
    setOpen(false);
    returnFocus();
  }, [returnFocus]);
  return { open, toggle, close };
}
