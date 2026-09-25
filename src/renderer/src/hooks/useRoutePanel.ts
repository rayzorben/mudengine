/**
 * The route panel: whether it is open, the room or the name it opens on, and
 * closing it, which hands the caret back.
 *
 * Out of `App` (todo 732) with the state it owns; what opens it (a map, a
 * console name, a palette row) is the opener's. See `mudengine-ui` ›
 * *Focus lives in the terminal*.
 */
import { useCallback, useState } from 'react';

import type { WorldRoom } from '@shared/world';

export interface RoutePanelState {
  open: boolean;
  /** A destination picked off the map, planned when the panel opens. */
  destination: WorldRoom | null;
  /** A room name clicked in the console that named more than one room. */
  search: string | null;
  close(): void;
  /**
   * Open on a room, or searching for a name, or on neither. The two are
   * exclusive in every caller: a seed left by an earlier click must not
   * survive into a panel opened for something else.
   */
  openOn(destination: WorldRoom | null, search: string | null): void;
  /** Opened cold, from the palette: neither a room nor a name is meant. */
  openCold(): void;
  /** `Ctrl/Cmd G`: open with no destination, or close; a search seed is kept. */
  toggleCold(): void;
}

/** @param returnFocus The window's one hand-back. */
export function useRoutePanel(returnFocus: () => void): RoutePanelState {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState<WorldRoom | null>(null);
  const [search, setSearch] = useState<string | null>(null);

  /** Route planning is a dialog that types, so it hands focus back on close. */
  const close = useCallback(() => {
    setOpen(false);
    returnFocus();
  }, [returnFocus]);

  const openOn = useCallback((room: WorldRoom | null, name: string | null) => {
    setDestination(room);
    setSearch(name);
    setOpen(true);
  }, []);

  const openCold = useCallback(() => openOn(null, null), [openOn]);

  const toggleCold = useCallback(() => {
    setDestination(null);
    setOpen((was) => !was);
  }, []);

  return { open, destination, search, close, openOn, openCold, toggleCold };
}
