/**
 * Where a desktop window may go. The preload hands every page the window
 * shows the whole of `IpcApi`, so a page from anywhere else (a link dragged
 * onto the window, a file dropped on it) would be able to send to the realm,
 * write settings and read files. A window stays on the page it was loaded
 * with: the built `index.html`, or the dev server's origin.
 */

/** Whether `target` is still the client loaded from `loaded`. */
export function staysOnClient(loaded: string, target: string): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(loaded);
    to = new URL(target);
  } catch {
    return false;
  }
  if (from.protocol !== to.protocol) return false;
  if (from.protocol === 'file:') return from.pathname === to.pathname;
  if (from.protocol === 'http:' || from.protocol === 'https:') return from.origin === to.origin;
  return false;
}
