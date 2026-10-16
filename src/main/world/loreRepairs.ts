/**
 * Once-only repairs of `mob-lore.json`, run by `RealmLore` as it reads the
 * file (`fileRepairs.ts` has how a step runs once).
 */
import { t } from '../app/i18n';
import type { FileRepair } from './fileRepairs';

/**
 * Every `noEffects` entry, on every realm (todo 131). A file without this
 * id was last written by a build without the fix, so any entry in it may
 * name the wrong spell: the file keeps when a refusal was heard, not who
 * cast. No cutoff date: an old build still running (the web image) writes
 * misread entries after any date, and drops `repaired` when it saves, so
 * the step runs again. A real immunity costs one refused cast to learn
 * again. The world database cannot settle it: the file is read before any
 * is open, and a realm's immunity is what the database can be wrong about.
 */
const noEffectMisread: FileRepair = {
  id: 'no-effect-misread-2026-10',
  why: (count) =>
    count === 1
      ? t('notices.world.lore.noEffectMisread.one', { count })
      : t('notices.world.lore.noEffectMisread.many', { count }),
  apply(file) {
    const section = file['noEffects'];
    if (typeof section !== 'object' || section === null) return { file, removed: 0 };
    let removed = 0;
    for (const monsters of Object.values(section)) {
      if (typeof monsters !== 'object' || monsters === null) continue;
      for (const row of Object.values(monsters as Record<string, unknown>)) {
        if (typeof row === 'object' && row !== null) removed += Object.keys(row).length;
      }
    }
    return { file: { ...file, noEffects: {} }, removed };
  }
};

/** In the order they run. A new step goes at the end, with an id never used before. */
export const LORE_REPAIRS: readonly FileRepair[] = [noEffectMisread];
