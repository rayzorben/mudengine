/**
 * The route panel: whether it is open, the room or the name it opens on, and
 * closing it, which hands the caret back.
 *
 * Out of `App` (todo 732) with the state it owns; what opens it (a map, a
 * console name, a palette row) is the opener's. See `mudengine-ui` ›
 * *Focus lives in the terminal*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LoopJoining } from '../lib/loops';
import type { WorldRoom } from '@shared/world';

export interface RoutePanelState {
  open: boolean;
  /** A destination picked off the map, planned when the panel opens. */
  destination: WorldRoom | null;
  /** A room name clicked in the console that named more than one room. */
  search: string | null;
  /** A loop picked in the Loops modal, whose way in is shown before it starts. */
  joining: LoopJoining | null;
  close(): void;
  /**
   * Open on a room, or searching for a name, or on neither. The two are
   * exclusive in every caller: a seed left by an earlier click must not
   * survive into a panel opened for something else.
   */
  openOn(destination: WorldRoom | null, search: string | null): void;
  /** Open on the stop a loop joins, with the press starting the loop. */
  openToJoin(joining: LoopJoining): void;
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
  const [joining, setJoining] = useState<LoopJoining | null>(null);

  const close = useCallback(() => setOpen(false), []);

  /*
   * Route planning is a dialog that types, so it hands the caret back once it
   * has closed, however it closed. When `close` called `returnFocus` beside
   * `setOpen(false)`, a close made after a walk's IPC answer could reach
   * `returnFocus`'s frame before React removed the panel; the caret was still
   * in the dialog, so the hand-back stood down, and the unmount then left it on
   * the body, where the next Enter reached nothing (todo 00). `Ctrl/Cmd G`
   * never handed it back.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) returnFocus();
    wasOpen.current = open;
  }, [open, returnFocus]);

  // Every other opening is a walk somewhere, so it drops a loop's join.
  const openOn = useCallback((room: WorldRoom | null, name: string | null) => {
    setDestination(room);
    setSearch(name);
    setJoining(null);
    setOpen(true);
  }, []);

  const openToJoin = useCallback((loop: LoopJoining) => {
    setDestination(loop.at);
    setSearch(null);
    setJoining(loop);
    setOpen(true);
  }, []);

  const openCold = useCallback(() => openOn(null, null), [openOn]);

  const toggleCold = useCallback(() => {
    setDestination(null);
    setJoining(null);
    setOpen((was) => !was);
  }, []);

  return { open, destination, search, joining, close, openOn, openToJoin, openCold, toggleCold };
}
