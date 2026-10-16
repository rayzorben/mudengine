/**
 * Once-only repairs of a memory file (`memory/<character>.json` and
 * `memory/realm-<world>.json`), run by `WorldMemory` as it reads the file
 * (`fileRepairs.ts` has how a step runs once).
 */
import { t } from '../app/i18n';
import { WAY_REASONS, type DiscoveryReason } from '../../shared/memory';
import type { FileRepair } from './fileRepairs';

/**
 * Every found way (todo 151, the user 2026-10-15: delete all learned rooms
 * from all characters). A build without the fix wrote a step from the room the
 * client believed it stood in: after an arrival nothing typed caused (a skiff,
 * a summons) whose name line was lost, the old room was kept under the new
 * room's exits, and the next `e` was written down as a way from Silvermere
 * into Newhaven. Which records are wrong cannot be told from the file, so all
 * go; a real one is learned again the next time it is walked. A shop's stock
 * is kept: it never depended on where the character stood.
 */
const foundWaysForgotten: FileRepair = {
  id: 'found-ways-forgotten-2026-10',
  why: (count) =>
    count === 1
      ? t('notices.world.memory.foundWaysForgotten.one', { count })
      : t('notices.world.memory.foundWaysForgotten.many', { count }),
  apply(file) {
    const rows = file['discoveries'];
    if (!Array.isArray(rows)) return { file, removed: 0 };
    const kept = rows.filter(
      (row: unknown) =>
        typeof row !== 'object' ||
        row === null ||
        !WAY_REASONS.has((row as { reason?: unknown }).reason as DiscoveryReason)
    );
    return { file: { ...file, discoveries: kept }, removed: rows.length - kept.length };
  }
};

/** In the order they run. A new step goes at the end, with an id never used before. */
export const MEMORY_REPAIRS: readonly FileRepair[] = [foundWaysForgotten];
