/**
 * The window's view of the `tuning:` block, read wherever it is used.
 *
 * The renderer's half of `src/main/app/tuning.ts`, and the same shape for the
 * same reason: a cap is read inside a reducer, a drag threshold inside a
 * pointer handler, a debounce inside a hook — none of which has a place to put
 * a configuration prop, and threading one through would put a parameter on
 * every card to carry a number none of them chooses.
 *
 * Fed from `Push.internal`, which arrives shortly after the first paint and
 * again on every save. A render that happened before it arrived ran on the
 * shipped defaults, which is the right fallback rather than a gap: the numbers
 * here are limits, delays and thresholds read at the moment they are needed,
 * so the next read has the new value.
 *
 * Deliberately **not** React state. These do not describe what is on screen —
 * they describe how the window behaves — so a component re-rendering because
 * somebody edited a debounce would be churn for nothing. Anything that must
 * redraw when the file changes already rides on the `internal` state in
 * `App.tsx`.
 */
import { DEFAULT_INTERNAL, type TuningConfig } from '@shared/internal';

let current: TuningConfig['view'] = DEFAULT_INTERNAL.tuning.view;

/** Called by `App.tsx` when the internal settings arrive or change. */
export function setTuning(next: TuningConfig['view']): void {
  current = next;
}

/** The numbers in force. Read where they are used, never captured. */
export function tuning(): TuningConfig['view'] {
  return current;
}
