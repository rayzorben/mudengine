/**
 * Once-only repairs of `mob-lore.json`, for what an earlier version wrote
 * wrong. `RealmLore` runs each step not yet run when it reads the file,
 * before anything reads a table, and keeps the ids run in the file
 * (`repaired`), so a step runs once and a later write cannot undo it. Each
 * removal is said with a count. The rule: `mudengine-config` › *A fix for
 * bad data ships its repair*.
 */
import { t } from '../app/i18n';

/** The file as parsed: a step reads and rewrites only its own section. */
export type LoreDocument = Readonly<Record<string, unknown>>;

export interface LoreRepair {
  /** Written into the file once run; never reused. */
  readonly id: string;
  /** What the notice says was removed, given the count. */
  why(count: number): string;
  /** The file with the repair made, and how many entries it removed. */
  apply(file: LoreDocument): { file: LoreDocument; removed: number };
}

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
const noEffectMisread: LoreRepair = {
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
export const LORE_REPAIRS: readonly LoreRepair[] = [noEffectMisread];
