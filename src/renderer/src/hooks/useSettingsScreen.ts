/**
 * The settings screen: whether it is open, which character or section it
 * opens on, each way in, and closing it, which hands the caret back — or
 * refuses while there is no character to hand it to.
 *
 * Out of `App` (todo 732) with the state it owns. See `mudengine-ui` ›
 * *Focus lives in the terminal*, and `mudengine-settings` for the screen.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  SETTINGS_DEFAULTS,
  SETTINGS_GLOBAL,
  SETTINGS_MANAGE_SERVERS,
  SETTINGS_NEW_CHARACTER
} from '../components/SettingsScreen';
import type { SessionId } from '@shared/ipc';

export interface SettingsScreenState {
  open: boolean;
  /**
   * Which character the screen opens on. `null` means "wherever it was",
   * which is what `Ctrl/Cmd ,` and the palette want — reopening the screen on
   * the character you were last editing. A tab's own menu names one, because
   * "edit *this* character" is the whole point of reaching it from the tab
   * rather than from the palette.
   */
  openAt: string | null;
  close(): void;
  /** Wherever it was — the palette and the shortcut. */
  openSettings(): void;
  /** On one named character — a tab's own menu. */
  editCharacter(id: SessionId): void;
  /** On an empty character — the `+` at the head of the rail. */
  newCharacter(): void;
  /** Straight to the servers list — the palette's own way in. */
  manageServers(): void;
  /**
   * On the client's own — the gear at the head of the tab rail.
   *
   * Beside the `+` because that is where somebody already is when they want to
   * change something about the client rather than about a character, and
   * because a settings screen reachable only by a chord is one most people
   * never find. Also in the palette, for the same reason.
   */
  editGlobal(): void;
  /** And the other half of that file: what a new realm and character start with. */
  editDefaults(): void;
}

/**
 * @param required No character exists, so the screen is the client's only
 *   job: it opens on a new character and cannot be closed.
 * @param returnFocus The window's one hand-back.
 */
export function useSettingsScreen(required: boolean, returnFocus: () => void): SettingsScreenState {
  const [open, setOpen] = useState(false);
  const [openAt, setOpenAt] = useState<string | null>(null);

  const show = useCallback((at: string | null) => {
    setOpenAt(at);
    setOpen(true);
  }, []);

  /*
   * A character is step one; there is no "before you have one".
   *
   * With no characters there is no session and no console, so the client's only
   * job is to help make one — and the way in is the new-character form, opened
   * here rather than described in a notice somebody has to find. The anonymous
   * session this replaced was retired 2026-08-29 (see `NO_SESSION`).
   *
   * It used to be offered **once per launch** and was closeable, on the
   * reasoning that closing it is a choice. It is not one: behind it is an empty
   * window with no rail, no tab and nothing that says what to do, which is
   * where a fresh installation put somebody who clicked outside the form. So
   * while there is no character the screen is open and `required`, and the
   * latch that made the offer once is gone with the choice it was protecting.
   */
  useEffect(() => {
    if (!required) return;
    show(SETTINGS_NEW_CHARACTER);
  }, [required, show]);

  /*
   * Settings is a form, so it hands the keyboard back to the game on the way
   * out — Escape, the close button, or a click on the scrim. The one surface
   * that holds the caret while a character is standing somewhere is the one
   * that has to be reliable about giving it back.
   */
  const close = useCallback(() => {
    // Nothing to hand the keyboard back *to*: there is no console behind this
    // screen until there is a character. The screen draws no close and answers
    // no Escape while that holds; this is the same refusal at the palette's
    // and the shortcut's door.
    if (required) return;
    setOpen(false);
    returnFocus();
  }, [required, returnFocus]);

  const openSettings = useCallback(() => show(null), [show]);
  const editCharacter = useCallback((id: SessionId) => show(id), [show]);
  const newCharacter = useCallback(() => show(SETTINGS_NEW_CHARACTER), [show]);
  const manageServers = useCallback(() => show(SETTINGS_MANAGE_SERVERS), [show]);
  const editGlobal = useCallback(() => show(SETTINGS_GLOBAL), [show]);
  const editDefaults = useCallback(() => show(SETTINGS_DEFAULTS), [show]);

  return {
    open,
    openAt,
    close,
    openSettings,
    editCharacter,
    newCharacter,
    manageServers,
    editGlobal,
    editDefaults
  };
}
