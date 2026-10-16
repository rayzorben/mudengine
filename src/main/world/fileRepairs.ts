/**
 * Once-only repairs of a file the client keeps, for what an earlier version
 * wrote wrong. The store runs each step not yet run when it reads the file,
 * before anything reads a table, and keeps the ids run in the file
 * (`repaired`), so a step runs once and a later write cannot undo it. Each
 * removal is said with a count. The rule: `mudengine-config` › *A fix for bad
 * data ships its repair*. The steps: `loreRepairs.ts`, `memoryRepairs.ts`.
 */

/** The file as parsed: a step reads and rewrites only its own section. */
export type RepairDocument = Readonly<Record<string, unknown>>;

export interface FileRepair {
  /** Written into the file once run; never reused. */
  readonly id: string;
  /** What the notice says was removed, given the count. */
  why(count: number): string;
  /** The file with the repair made, and how many entries it removed. */
  apply(file: RepairDocument): { file: RepairDocument; removed: number };
}

/**
 * The file with each step it has not had run, in order. `repaired` is the ids
 * the file now carries; `ran` is whether any step ran, so the store writes them.
 */
export function runRepairs(
  parsed: RepairDocument,
  steps: readonly FileRepair[],
  notify: ((message: string) => void) | undefined
): { file: RepairDocument; repaired: Set<string>; ran: boolean } {
  const done = parsed['repaired'];
  const repaired = new Set(
    Array.isArray(done) ? done.filter((id): id is string => typeof id === 'string') : []
  );
  let file = parsed;
  let ran = false;
  for (const step of steps) {
    if (repaired.has(step.id)) continue;
    const result = step.apply(file);
    file = result.file;
    repaired.add(step.id);
    ran = true;
    if (result.removed > 0) notify?.(step.why(result.removed));
  }
  return { file, repaired, ran };
}
