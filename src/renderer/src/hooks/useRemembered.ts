import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react';

import type { SessionId } from '@shared/ipc';
import { isCombatTally, type CombatTally } from '@shared/tally';

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

  // One object per set, not per render: a caller's memo keyed on this would
  // otherwise recompute every render — the Talk card's feed, and with it the
  // jump-to-latest offer, on every status line while `All` is off.
  return useMemo(() => ({ has: (value: string) => chosen.has(value), toggle }), [chosen, toggle]);
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
 * A number remembered against each of a set of things, per character.
 *
 * The third shape beside {@link useRemembered} (which of these are muted) and
 * {@link useRememberedChoice} (which one of these is showing): **how far
 * through each of these**. The quest book is what needed it — a quest is a
 * counter the server keeps and nothing it volunteers ever prints, so how far a
 * character has got is one number per quest rather than a mark per step.
 *
 * It is the *fallback* since 2026-09-07 rather than the only answer: GreaterMUD
 * has a command that states every counter (`CharacterState.abilities`), and the
 * card prefers the realm's own figure wherever one has been read. What is kept
 * here is still kept — a character re-pointed at a realm without that command
 * has nothing else — which is why a listing never writes through this store.
 *
 * Same storage and same rule as its siblings: an entry whose key this build no
 * longer recognises is dropped rather than honoured, so a book that shrinks
 * when a realm is swapped does not carry ranks for quests it no longer has.
 * A value that is not a non-negative integer is dropped for the same reason —
 * this file is on the player's own disk.
 *
 * `localStorage`, like every other preference set by clicking: saying *I have
 * done this much* must not make the client rewrite a file full of the user's
 * own comments.
 */
export function useRememberedRanks(
  session: SessionId,
  name: string,
  allowed: readonly string[]
): { get(key: string): number | null; set(key: string, rank: number | null): void } {
  const storageKey = `mudengine.${name}.${session}`;

  const read = useCallback(
    (): Record<string, number> =>
      readStored(
        storageKey,
        (stored) => {
          const parsed: unknown = JSON.parse(stored);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
          const kept: Record<string, number> = {};
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!allowed.includes(key)) continue;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue;
            kept[key] = value;
          }
          return kept;
        },
        () => ({})
      ),
    [storageKey, allowed]
  );

  const [ranks, setRanks] = useStored(read);

  const set = useCallback(
    (key: string, rank: number | null) => {
      setRanks((current) => {
        const next = { ...current };
        // Null is not zero here either: *not started* is the absence of a
        // rank, and rank zero would be a claim the realm's counters can make.
        if (rank === null) delete next[key];
        else next[key] = rank;
        writeStored(storageKey, JSON.stringify(next));
        return next;
      });
    },
    [storageKey, setRanks]
  );

  return { get: (key) => ranks[key] ?? null, set };
}

/**
 * The Combat Stats card's baseline, per character: the totals as they stood
 * when Reset was pressed.
 *
 * Not a hook — `App` holds the baseline and writes it from a callback — and
 * `localStorage` like the rest of this file, because a press on a card must
 * not rewrite a file full of the user's own comments. Main's totals outlive
 * the launch (`Belongings` keeps them), so the reading they are subtracted
 * from has to as well, or every launch silently undid the last Reset. Parsed
 * on the way back, not trusted: a value an older build wrote is dropped, and
 * one older than the totals is dropped by the card's own `stale` test.
 */
export function recallStatsBase(session: SessionId): CombatTally | null {
  return readStored(
    `mudengine.stats-base.${session}`,
    (stored) => {
      const parsed: unknown = JSON.parse(stored);
      return isCombatTally(parsed) ? parsed : null;
    },
    () => null
  );
}

export function rememberStatsBase(session: SessionId, base: CombatTally): void {
  writeStored(`mudengine.stats-base.${session}`, JSON.stringify(base));
}
