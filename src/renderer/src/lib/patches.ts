/**
 * A browser tab's half of `main/host/web/patches.ts`: the last payload of
 * each patched push, per channel and character, and each patch applied to
 * it. A field a patch does not name keeps the same object, so a card that
 * reads only what did not change is not redrawn. Cleared when the client
 * starts the tab over, since what it remembered sending went with it.
 */
import type { Addressed } from '@shared/ipc';
import type { RpcPatch, RpcPush } from '@shared/rpc';

export class PushPatches {
  private readonly last = new Map<string, Record<string, unknown>>();

  /** The push the patch stands for. */
  apply(patch: RpcPatch): RpcPush {
    const key = `${patch.c}\u0000${patch.s}`;
    const payload: Record<string, unknown> = { ...(this.last.get(key) ?? {}), ...patch.set };
    for (const field of patch.drop) delete payload[field];
    this.last.set(key, payload);
    const addressed: Addressed<Record<string, unknown>> = { session: patch.s, payload };
    return { k: 'push', c: patch.c, p: addressed };
  }

  clear(): void {
    this.last.clear();
  }
}
