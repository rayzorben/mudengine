/**
 * Where the caret goes when the settings screen opens or changes page: the
 * rail's find field where the page draws one, else the form's first field
 * (the user, 2026-11-27: opening the screen puts focus in the find field).
 */
import { useEffect, type RefObject } from 'react';

/**
 * @param page What is on screen, so a change of page or character places the
 *   caret again; null while the screen is closed.
 * @param body The screen's body, which holds the rail and whichever form is on screen.
 * @param firstField The form's first field, on whichever form is drawn.
 * @param firstFieldFirst The first field is the one wanted: a new character's
 *   name, or a console gear's door, where `useSettingsFind` puts the caret on
 *   the setting asked for.
 */
export function useSettingsCaret(
  page: string | null,
  body: RefObject<HTMLElement>,
  firstField: RefObject<HTMLElement>,
  firstFieldFirst: boolean
): void {
  useEffect(() => {
    if (page === null) return;
    const id = window.requestAnimationFrame(() => {
      // `SettingsNav`'s `FindField`, by the classes `npm run smoke` finds it by.
      const find = firstFieldFirst
        ? null
        : body.current?.querySelector<HTMLElement>('.settings-nav .table-find input');
      (find ?? firstField.current)?.focus();
    });
    return () => window.cancelAnimationFrame(id);
    // `firstFieldFirst` is read when the page changes and is not a dependency:
    // the caret is placed once per page, never under somebody typing.
  }, [page, body, firstField]);
}
