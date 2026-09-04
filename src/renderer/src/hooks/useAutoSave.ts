import { useEffect, useRef, useState } from 'react';

import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';

/**
 * Saving what somebody typed without them having to say so.
 *
 * The Save button was the last thing on this screen that could be forgotten,
 * and forgetting it is silent: the form goes on showing what you typed, so a
 * change you meant to make and a change you made look identical until the next
 * time the client is started.
 *
 * Four rules, and each is a way this could go wrong instead:
 *
 * - **Only for something that already exists.** Creating still takes a press.
 *   A half-typed name is a *different* file, so auto-saving a new character
 *   would write `profiles/f/`, `profiles/fr/`, `profiles/fre/` — a directory
 *   per keystroke, none of them what anybody meant.
 * - **Debounced, and reset by every keystroke.** A save is a file write with a
 *   backup and a verify pass through the real resolver; one per character typed
 *   would be absurd, and the backup would be a copy of the state one letter ago.
 * - **A refused save stays on screen.** With no click to tie it to, an error
 *   that faded would be an error nobody saw — and what it means is that what is
 *   on screen is *not* what is on disk, which is the one thing a form must
 *   never be quiet about.
 * - **What arrives from disk is not an edit.** The value the caller last saved
 *   is remembered, so the reload that follows a save does not start another.
 *   Without that the two chase each other for ever.
 */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'refused';

export interface AutoSave {
  state: SaveState;
  /** Why it was refused, if it was. Stays until the next save succeeds. */
  error: string | null;
  /**
   * Save now rather than waiting out the delay — closing the dialog, or
   * switching to another character before the delay has run. Stable across
   * renders.
   */
  flush(): void;
}

export interface AutoSaveOptions<T> {
  /** What to save. `null` means there is nothing to save yet. */
  value: T | null;
  /**
   * Which thing is being edited — a character id, a realm name, a constant
   * where there is only one file. When it changes, the next value is adopted
   * as what is already on disk rather than compared against the previous
   * thing's form: switching between two existing characters never toggles
   * `enabled`, and without this the switch itself read as an edit and spent a
   * disk write (with its backup and verify pass) on a form nobody touched.
   */
  identity: string | null;
  /**
   * Off while what is on the form does not exist on disk yet.
   *
   * Not a detail: see the first rule above. Creating is a press.
   */
  enabled: boolean;
  /** Resolves to why it refused, or null. Never throws at this hook. */
  save(value: T): Promise<string | null>;
  /** Whether two values say the same thing, so a re-render is not an edit. */
  same(a: T, b: T): boolean;
  /** Long enough that a sentence being typed is one save. */
  delayMs?: number;
}

/** One write as it was asked for — see `again` below for why it is kept whole. */
interface Request<T> {
  value: T | null;
  save: (value: T) => Promise<string | null>;
  same: (a: T, b: T) => boolean;
  identity: string | null;
}

export function useAutoSave<T>({
  value,
  identity,
  enabled,
  save,
  same,
  delayMs = tuning().autoSaveDelayMs
}: AutoSaveOptions<T>): AutoSave {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  /** What is on disk, as far as this hook knows. See the fourth rule. */
  const written = useRef<T | null>(null);
  /**
   * An edit has been acknowledged as pending and not yet handed to `run`.
   *
   * Read when the form is taken away (`enabled` going false) so the edit is
   * saved rather than dropped. The timer cannot be the test for that: every
   * effect's cleanup has already run by then, and the debounce effect's
   * cleanup is what clears the timer.
   */
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
   * Read through rather than captured. `save` and `same` are ordinarily
   * inline arrows from a component, so depending on them would restart the
   * timer on every render -- which is the same defect as a child keying an
   * effect on a prop the parent passes inline, and it would mean nothing ever
   * settled long enough to be saved.
   */
  const latest = useRef({ save, same, value });
  latest.current = { save, same, value };

  /** A save in flight, so a second does not overtake it. */
  const running = useRef(false);
  /**
   * A write asked for while another was in flight, held as it was asked for.
   *
   * A snapshot and not a flag: what was on the form when the save was asked
   * for, the `save` that knew whose file it was, and which thing was being
   * edited. Re-reading `latest` when the running save finished would write
   * whatever the form holds *by then* — and `choose()` flushes and switches
   * characters in one call, so by then the form is somebody else's and the
   * edit that asked to be saved would be replaced by an untouched form under
   * another name.
   */
  const again = useRef<Request<T> | null>(null);
  const lastIdentity = useRef(identity);

  const run = useRef(
    (request: Request<T> = { ...latest.current, identity: lastIdentity.current }): void => {
      const { value: current, save: write, same: alike } = request;
      dirty.current = false;
      if (current === null) return;
      if (written.current !== null && alike(written.current, current)) return;
      if (running.current) {
        again.current = request;
        return;
      }

      running.current = true;
      setState('saving');
      void write(current).then(
        (refusal) => {
          running.current = false;
          if (refusal === null) {
            /*
             * Only while the same thing is still on the form. A write flushed
             * on the way out of one character resolves after the next one has
             * been adopted as the baseline, and recording it would compare that
             * character's form against this one's — spending a save on a form
             * nobody touched.
             */
            if (request.identity === lastIdentity.current) written.current = current;
            setError(null);
            setState('saved');
          } else {
            // Deliberately *not* recorded as written: what is on screen is not
            // what is on disk, and the next edit must try again.
            setError(refusal);
            setState('refused');
          }
          const queued = again.current;
          if (queued !== null) {
            again.current = null;
            run.current(queued);
          }
        },
        (reason: unknown) => {
          // The sentence on screen is deliberately generic — the player cannot
          // act on a stack trace — but the cause must survive somewhere it can
          // be diagnosed from, or the failure is swallowed whole.
          console.error('autosave failed', reason);
          running.current = false;
          setError(t('settings.autoSave.saveDidNotAnswer'));
          setState('refused');
        }
      );
    }
  );

  /*
   * A different thing is being edited under the same enabled flag. Declared
   * before the debounce effect below on purpose: effects run in order, so the
   * reset lands first and the same render's new value is then adopted as
   * "already on disk" rather than compared against the previous identity's
   * form — which is what made switching characters spend a save.
   */
  useEffect(() => {
    if (identity === lastIdentity.current) return;
    lastIdentity.current = identity;
    // Whatever was pending belonged to the previous identity, and the form on
    // this render is the next one's: a caller that wanted the edit saved
    // flushed before switching. Saving now would write it under the new name.
    dirty.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    written.current = null;
    setState('idle');
    setError(null);
  }, [identity]);

  useEffect(() => {
    if (!enabled || value === null) return;
    if (written.current === null) {
      // The first value is what is already on disk, not an edit. Adopted
      // rather than saved, so opening a form does not rewrite the file.
      written.current = value;
      return;
    }
    if (same(written.current, value)) return;

    setState('pending');
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      run.current();
    }, delayMs);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // `same` and `save` are deliberately not dependencies: both are read
    // through `latest` (see the ref above), so the timer is not restarted by
    // every render. Checked by hand — nothing in the lint gate audits
    // dependency arrays.
  }, [value, enabled, delayMs]);

  /*
   * The form is being taken away — the dialog closing, a crumb to another
   * page, the blank new-character form replacing a real one — and whatever
   * was on disk for it says nothing about what comes next.
   *
   * An edit still waiting out the delay goes to disk first. Switching pages
   * lost it: the crumb flipped `enabled`, the debounce cleanup cleared the
   * timer, and the threshold typed a moment before somebody clicked *Global*
   * to compare it against the default was gone — after the form had shown it,
   * which is the one way a form must never be quiet. The value and `save`
   * read here are this render's, and on a page switch they are still the same
   * character's; an identity change resets `dirty` above, in an effect
   * declared earlier and so run earlier, which is what keeps this from writing
   * one character's form under another's name.
   */
  useEffect(() => {
    if (enabled) return;
    if (dirty.current) run.current();
    written.current = null;
    setState('idle');
    setError(null);
  }, [enabled]);

  /*
   * Stable across renders, since it only touches refs: a caller may list it
   * among a `useCallback`'s dependencies without that callback being remade
   * every render. It reads the form as it stands *now*, so a caller about to
   * switch what is being edited must flush before changing the selection.
   */
  const flush = useRef((): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    run.current();
  });

  return { state, error, flush: flush.current };
}
