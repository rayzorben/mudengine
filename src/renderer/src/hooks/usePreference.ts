import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A setting with two sources: the options file and a quick in-app control.
 *
 * Both need to work, and the obvious implementations each break one of them.
 * If the file always wins, the palette toggle is undone by the next config
 * push. If the stored choice always wins, editing the key in the YAML silently
 * does nothing forever after the first toggle — which defeats the point of a
 * watched config file, and is exactly the bug this hook exists to prevent.
 *
 * The rule is therefore: the stored choice outranks the file, until the file's
 * value actually *changes*. An edit is an explicit act and takes effect
 * immediately, clearing the override; a reload that leaves the key untouched
 * leaves the user's toggle alone.
 *
 * **An override is stored against the file value it deviated from**, and that
 * is what makes "the file changed" answerable across a restart rather than only
 * within one session. Comparing against the first render's value cannot do it:
 * the first render happens before the config has arrived, so it holds the
 * built-in default — and an edit that brings the file *to* that default is then
 * invisible, leaving the override in force forever. That is exactly what
 * happened when `ui.tabs` changed its default to `left` and a file edited to
 * `left` could not dislodge a remembered `top`.
 *
 * A bare stored value from before this was recorded is discarded rather than
 * honoured, because there is no way to tell what it deviated from and guessing
 * reinstates the same trap. Losing one palette toggle falls back to the file,
 * which is the documented behaviour and is safe.
 *
 * @param storageKey `localStorage` key holding the override.
 * @param configured The current value from the options file.
 * @param isValid Guard for stored text, which is untrusted input.
 */
/**
 * What a stored override is worth, given what the file currently says.
 *
 * Pure, and separated from the hook because this *is* the rule — everything
 * around it is plumbing. `keep` is the value to use, or null to fall back to
 * the file; `forget` says the stored entry is spent and should be cleared so it
 * cannot come back later.
 */
export function resolveOverride<T extends string>(
  stored: string | null,
  configured: T,
  isValid: (value: unknown) => value is T
): { keep: T | null; forget: boolean } {
  if (stored === null) return { keep: null, forget: false };
  // A bare string predates `against` and cannot say what it deviated from.
  // Honouring it reinstates the trap; falling back to the file costs one toggle.
  if (!stored.startsWith('{')) return { keep: null, forget: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { keep: null, forget: true };
  }
  if (typeof parsed !== 'object' || parsed === null) return { keep: null, forget: true };
  const { value, against } = parsed as { value?: unknown; against?: unknown };
  // Untrusted: this is a string a person can edit by hand.
  if (!isValid(value)) return { keep: null, forget: true };
  // The file has been edited since this was chosen, so the edit wins.
  if (against !== configured) return { keep: null, forget: true };
  return { keep: value, forget: false };
}

export function useOverridablePreference<T extends string>(
  storageKey: string,
  configured: T,
  isValid: (value: unknown) => value is T
): [T, (next: T) => void] {
  const forget = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Nothing was stored to begin with.
    }
  }, [storageKey]);

  /** The override, if there is one and the file still says what it deviated from. */
  const read = useCallback((): T | null => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      // Private mode, or storage disabled. The file is the fallback.
      return null;
    }
    const { keep, forget: spent } = resolveOverride(stored, configured, isValid);
    if (spent) forget();
    return keep;
  }, [storageKey, isValid, configured, forget]);

  const [value, setValue] = useState<T>(() => read() ?? configured);

  /**
   * The configured value this hook has already reconciled against.
   *
   * Within a session this is what distinguishes an edit from the config merely
   * arriving over IPC; across sessions the stored `against` does the same job,
   * which is the half this used to be missing.
   */
  const lastConfigured = useRef<T>(configured);

  useEffect(() => {
    if (configured === lastConfigured.current) return;
    lastConfigured.current = configured;

    // An explicit edit outranks the remembered toggle.
    forget();
    setValue(configured);
  }, [configured, forget]);

  const choose = useCallback(
    (next: T) => {
      try {
        // Recorded against what the file says *now*: the next edit to it is
        // then detectable however long the client has been closed in between.
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ value: next, against: lastConfigured.current })
        );
      } catch {
        // The choice still applies for this session.
      }
      setValue(next);
    },
    [storageKey]
  );

  return [value, choose];
}
