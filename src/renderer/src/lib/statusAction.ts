/**
 * The status rail's one line for what the engine is doing, newest concern
 * first. Out of `App`, which is composition.
 */
import { t } from './i18n';
import type { AutomationSnapshot } from '@shared/automation';
import type { WalkProgress } from '@shared/walk';

/**
 * A walk outranks the queue depth, and a walk with auto-combat off is
 * running (todo 129). With nothing under way the rail shows nothing. The
 * typing hold is left out: it was true on every keystroke, so the rail
 * repeated the player's own typing back to them. Commands queued behind the
 * hold are shown.
 */
export function statusAction(
  walk: WalkProgress,
  queue: AutomationSnapshot['queue']
): string | null {
  if (walk.status === 'walking') {
    const step = walk.step?.command ?? '';
    const steps = { done: walk.done, total: walk.total };
    const progress =
      walk.pace === 'running'
        ? t('statusRail.action.running', steps)
        : t('statusRail.action.walking', steps);
    return step ? `${progress} · ${step}` : progress;
  }
  const next = queue.pending[0];
  if (next) return t('statusRail.action.queued', { depth: queue.depth, command: next.command });
  return null;
}
