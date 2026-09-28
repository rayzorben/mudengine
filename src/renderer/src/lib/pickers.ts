/**
 * The window's own file picker, for a bridge that has no native one.
 *
 * `IpcApi.chooseRealm` and `IpcApi.chooseCharacterFile` are native dialogs on
 * the desktop. In a browser tab the disk being chosen from is the *client's*,
 * the machine the sockets and the files are on, and a `<input type="file">`
 * would browse the viewer's instead: a different operation wearing the same
 * label. So the web bridge asks the window to draw a picker over
 * `Invoke.browseHome`, and this is the seam it asks through. `useHomeBrowser`
 * registers one while the window is mounted; the bridge is not React and must
 * not reach into it.
 */
export type HomePicker = () => Promise<string | null>;

let picker: HomePicker | null = null;

export function registerHomePicker(next: HomePicker | null): void {
  picker = next;
}

/** Whether a picker is registered — a bridge asks before promising one. */
export function hasHomePicker(): boolean {
  return picker !== null;
}

/** The chosen path, or null when dismissed or when nothing can ask. */
export function pickFromHome(): Promise<string | null> {
  return picker === null ? Promise.resolve(null) : picker();
}
