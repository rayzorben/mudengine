/**
 * The receiving half of `main/host/web/patches.ts`: the last payload of each
 * patched push, per channel and character, and each patch applied to it,
 * inside a record or an array too (`RpcFieldPatch`). A browser tab holds one;
 * the peer gateway keeps each sharer's sheet with `applyPatch` (`peers.ts`).
 * A field a patch does not name keeps the same object, so a card that reads
 * only what did not change is not redrawn. Cleared when the sender starts
 * over, since what it remembered sending went with it.
 */
import type { Addressed } from './ipc';
import type { RpcFieldPatch, RpcPatch, RpcPush } from './rpc';
import { isRecord } from './values';

/**
 * `before` with one field patch applied, keeping every member and item it
 * leaves alone as the same object. A patch that does not fit what is held is
 * a broken invariant (main patches against what this tab was sent), so it is
 * thrown with its context rather than guessed at.
 */
function patched(before: unknown, patch: RpcFieldPatch, field: string): unknown {
  switch (patch.k) {
    case 'tail': {
      if (!Array.isArray(before) || before.length < patch.skip + patch.keep) {
        throw new Error(
          `A patch keeps ${patch.keep} items of ${field} after ${patch.skip}, which holds no such list.`
        );
      }
      return [...before.slice(patch.skip, patch.skip + patch.keep), ...patch.tail];
    }
    case 'fields': {
      if (!isRecord(before)) {
        throw new Error(`A patch changes members of ${field}, which holds no record.`);
      }
      const next: Record<string, unknown> = { ...before, ...patch.set };
      for (const [member, inner] of Object.entries(patch.deep)) {
        // Defined, not assigned: a players book is keyed by name, and `next['__proto__'] =` would
        // set the prototype instead of a member.
        Object.defineProperty(next, member, {
          value: patched(before[member], inner, `${field}.${member}`),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      for (const member of patch.drop) delete next[member];
      return next;
    }
    default: {
      const never: never = patch;
      return never;
    }
  }
}

/** A whole payload's patch (`asTopPatch`) applied to `before`, named `label` in a broken invariant. */
export function applyPatch(
  before: Record<string, unknown>,
  patch: Pick<RpcPatch, 'set' | 'deep' | 'drop'>,
  label: string
): Record<string, unknown> {
  return patched(
    before,
    { k: 'fields', set: patch.set, deep: patch.deep, drop: patch.drop },
    label
  ) as Record<string, unknown>;
}

export class PushPatches {
  private readonly last = new Map<string, Record<string, unknown>>();

  /** The push the patch stands for. */
  apply(patch: RpcPatch): RpcPush {
    const key = `${patch.c}\u0000${patch.s}`;
    const payload = applyPatch(this.last.get(key) ?? {}, patch, patch.c);
    this.last.set(key, payload);
    const addressed: Addressed<Record<string, unknown>> = { session: patch.s, payload };
    return { k: 'push', c: patch.c, p: addressed };
  }

  clear(): void {
    this.last.clear();
  }
}
