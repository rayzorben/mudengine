import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { SessionId } from '@shared/ipc';

/**
 * Read what the store holds for a key, or fall back.
 *
 * `parse` runs inside the guard on purpose: a stored value written by an older
 * build is as much an expected failure as private mode or storage disabled,
 * and both hooks answer it the same way — the fallback, never a throw.
 */
function readStored<T>(key: string, parse: (stored: string) => T, fallback: () => T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback() : parse(stored);
  } catch {
    // Private mode, storage disabled, or a value written by an older build.
    return fallback();
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The choice still applies for as long as the window is open.
  }
}

/** State that re-reads when its key changes: switching character switches instrument. */
function useStored<T>(read: () => T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    setValue(read());
  }, [read]);
  return [value, setValue];
}

/**
 * A set of choices a card remembers, per character.
 *
 * The rail's arrangement is remembered per character and the *filters on the
 * cards in it* were not, which is an inconsistency somebody meets on their
 * second launch: mute a channel, come back, and it is unmuted. Both are the
 * same kind of thing — one player's instrument, set up the way they want it —
 * and a healer watches different channels from a warrior for the same reason
 * they watch different cards.
 *
 * `localStorage`, like the card layout, the theme and the density: a preference
 * changed by clicking must not make the client rewrite a file full of the
 * user's own comments.
 *
 * Values are kept as an allowlist-checked set of strings, so a stored value
 * from an older build — a channel that no longer exists — is dropped rather
 * than hiding something that does.
 */
export function useRemembered(
  session: SessionId,
  name: string,
  allowed: readonly string[]
): { has(value: string): boolean; toggle(value: string): void } {
  const key = `mudengine.${name}.${session}`;

  const read = useCallback(
    (): Set<string> =>
      readStored(
        key,
        (stored) => {
          const parsed: unknown = JSON.parse(stored);
          if (!Array.isArray(parsed)) return new Set<string>();
          return new Set(
            parsed.filter((entry): entry is string => allowed.includes(entry as string))
          );
        },
        () => new Set<string>()
      ),
    [key, allowed]
  );

  const [chosen, setChosen] = useStored(read);

  const toggle = useCallback(
    (value: string) => {
      setChosen((current) => {
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        writeStored(key, JSON.stringify([...next]));
        return next;
      });
    },
    [key, setChosen]
  );

  return { has: (value) => chosen.has(value), toggle };
}

/**
 * One remembered choice, per character. The sibling of {@link useRemembered}.
 *
 * A set answers "which of these are muted"; this answers "which one of these is
 * showing", and the Talk card's channel picker is the first thing that needed
 * it. Same storage, same key shape, same rule: a stored value the current build
 * does not recognise is dropped rather than honoured, because a channel that no
 * longer exists would otherwise sit in the picker sending nothing anybody could
 * read.
 *
 * `localStorage`, like everything else a player sets by clicking: a preference
 * changed by pointing at it must not make the client rewrite a file full of the
 * user's own comments.
 */
export function useRememberedChoice(
  session: SessionId,
  name: string,
  allowed: readonly string[],
  fallback: string
): [string, (value: string) => void] {
  const key = `mudengine.${name}.${session}`;

  const read = useCallback(
    (): string =>
      readStored(
        key,
        (stored) => (allowed.includes(stored) ? stored : fallback),
        () => fallback
      ),
    [key, allowed, fallback]
  );

  const [chosen, setChosen] = useStored(read);

  const choose = useCallback(
    (value: string) => {
      if (!allowed.includes(value)) return;
      setChosen(value);
      writeStored(key, value);
    },
    [key, allowed, setChosen]
  );

  return [chosen, choose];
}

/**
 * One value a card remembers per character, parsed on the way back in.
 *
 * The third shape beside the set and the single choice, for a card whose
 * remembered thing is neither — the Combat Stats card's Reset baseline, which
 * is a whole reading of the totals. Same store, same key shape, same rule: a
 * preference somebody sets by clicking must not make the client rewrite a file
 * full of their own comments.
 *
 * `parse` is handed whatever `JSON.parse` produced and answers null for
 * anything it cannot read, which is what a value written by an older build
 * arrives as. Setting null forgets it.
 */
export function useRememberedValue<T>(
  session: SessionId,
  name: string,
  parse: (value: unknown) => T | null
): [T | null, (value: T | null) => void] {
  const key = `mudengine.${name}.${session}`;

  const read = useCallback(
    (): T | null =>
      readStored(
        key,
        (stored) => parse(JSON.parse(stored) as unknown),
        () => null
      ),
    [key, parse]
  );

  const [value, setValue] = useStored(read);

  const remember = useCallback(
    (next: T | null): void => {
      setValue(next);
      if (next === null) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // The choice still applies for as long as the window is open.
        }
        return;
      }
      writeStored(key, JSON.stringify(next));
    },
    [key, setValue]
  );

  return [value, remember];
}
