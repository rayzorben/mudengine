/**
 * `run` once the window is idle, or after `timeoutMs` at the latest; the
 * returned function cancels it. A browser without `requestIdleCallback`
 * (Safari, in web mode) waits the timeout instead.
 */
export function whenIdle(run: () => void, timeoutMs: number): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: timeoutMs });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, timeoutMs);
  return () => clearTimeout(handle);
}
