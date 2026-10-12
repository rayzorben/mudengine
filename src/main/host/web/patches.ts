/**
 * A character push to a browser tab, sent as what changed.
 *
 * Every change to a character republishes its whole state, about 42 KB with
 * the room, the who list and the inventory, four times a second in a fight:
 * a replay of a player's evening sent one tab 185 KB/s (2026-10-11), the tab
 * fell behind, stopped answering pings and was cut off. The fields that change
 * between two pushes were 6% of it. So a tab is sent, per character, only the
 * top-level fields that differ from what it was last sent (`RpcPatch`); the
 * tab puts the state back together (`lib/patches.ts`). See `mudengine-session`
 * › *A browser tab outlives its socket*.
 */
import { addressedOf } from '../../../shared/ipc';
import type { RpcPatch, RpcPush } from '../../../shared/rpc';
import { PATCHED_PUSHES } from '../../../shared/rpc';

export class PushPatcher {
  /** What the tab was last sent, by channel and character, as each field's JSON. */
  private readonly sent = new Map<string, Map<string, string>>();

  /**
   * The patch frame for `message` after its opening brace (the number goes
   * in front), or null for a push that is not patched, which goes whole.
   */
  patch(message: RpcPush): string | null {
    if (!PATCHED_PUSHES.has(message.c)) return null;
    const addressed = addressedOf(message.p);
    const state = addressed?.payload;
    if (addressed === null || typeof state !== 'object' || state === null || Array.isArray(state)) {
      return null;
    }
    const session = addressed.session;

    const key = `${message.c}\u0000${session}`;
    const before = this.sent.get(key) ?? new Map<string, string>();
    const now = new Map<string, string>();
    const set: string[] = [];
    for (const [field, value] of Object.entries(state)) {
      const text = JSON.stringify(value);
      if (text === undefined) continue;
      now.set(field, text);
      if (before.get(field) !== text) set.push(`${JSON.stringify(field)}:${text}`);
    }
    const drop = [...before.keys()].filter((field) => !now.has(field));
    this.sent.set(key, now);
    // Written out rather than stringified, since each field's JSON is already
    // in hand; the head is checked against the type.
    const head: Omit<RpcPatch, 'set' | 'drop'> = { k: 'patch', c: message.c, s: session };
    return `${JSON.stringify(head).slice(1, -1)},"set":{${set.join(',')}},"drop":${JSON.stringify(drop)}}`;
  }
}
