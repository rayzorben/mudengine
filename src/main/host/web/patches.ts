/**
 * A character push to a browser tab, sent as what changed.
 *
 * Every change to a character republishes its whole state, about 42 KB with
 * the room, the who list and the inventory, four times a second in a fight:
 * a replay of a player's evening sent one tab 185 KB/s (2026-10-11), the tab
 * fell behind, stopped answering pings and was cut off. The fields that change
 * between two pushes were 6% of it. So a tab is sent, per character, only the
 * top-level fields that differ from what it was last sent (`RpcPatch`), a
 * record or array among them as what changed inside it (`RpcFieldPatch`); the
 * tab puts the state back together (`lib/patches.ts`). See `mudengine-session`
 * › *A browser tab outlives its socket*.
 */
import { addressedOf } from '../../../shared/ipc';
import type { RpcPatch, RpcPush } from '../../../shared/rpc';
import { PATCH_DEPTH, PATCHED_PUSHES } from '../../../shared/rpc';

/** A value as last sent: its JSON, and a record's members' or an array's items' too. */
interface Sent {
  text: string;
  members?: ReadonlyMap<string, Sent>;
  items?: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `value`'s JSON, built from its parts down to `depth` so a later patch can name them. */
function sentOf(value: unknown, depth: number): Sent | undefined {
  if (depth > 0 && Array.isArray(value)) {
    const items = value.map((item) => JSON.stringify(item) ?? 'null');
    return { text: `[${items.join(',')}]`, items };
  }
  if (depth > 0 && isPlainRecord(value)) {
    const members = new Map<string, Sent>();
    for (const [field, inner] of Object.entries(value)) {
      const sent = sentOf(inner, depth - 1);
      if (sent !== undefined) members.set(field, sent);
    }
    return { text: membersText(members), members };
  }
  const text = JSON.stringify(value);
  return text === undefined ? undefined : { text };
}

function membersText(members: ReadonlyMap<string, Sent>): string {
  return `{${[...members].map(([field, sent]) => `${JSON.stringify(field)}:${sent.text}`).join(',')}}`;
}

/**
 * The members of `now` that differ from `before`, as the inside of a
 * `fields` patch: each set whole, patched (`changeOf`), or dropped.
 */
function fieldsText(before: ReadonlyMap<string, Sent>, now: ReadonlyMap<string, Sent>): string {
  const set: string[] = [];
  const deep: string[] = [];
  for (const [field, sent] of now) {
    const was = before.get(field);
    if (was?.text === sent.text) continue;
    const change = was === undefined ? null : changeOf(was, sent);
    if (change === null) set.push(`${JSON.stringify(field)}:${sent.text}`);
    else deep.push(`${JSON.stringify(field)}:${change}`);
  }
  const drop = [...before.keys()].filter((field) => !now.has(field));
  return `"set":{${set.join(',')}},"deep":{${deep.join(',')}},"drop":${JSON.stringify(drop)}`;
}

/** `now` as what changed since `before` (an `RpcFieldPatch`), or null where it goes whole. */
function changeOf(before: Sent, now: Sent): string | null {
  if (before.items !== undefined && now.items !== undefined) {
    // Kept from the head, or from where `now` starts in `before` once the head was trimmed.
    const first = now.items[0];
    const at = first === undefined ? -1 : before.items.indexOf(first);
    const skip = at === -1 ? 0 : at;
    let keep = 0;
    const most = Math.min(before.items.length - skip, now.items.length);
    while (keep < most && before.items[skip + keep] === now.items[keep]) keep += 1;
    if (keep === 0) return null;
    const tail = now.items.slice(keep).join(',');
    return `{"k":"tail","skip":${skip},"keep":${keep},"tail":[${tail}]}`;
  }
  if (before.members !== undefined && now.members !== undefined) {
    return `{"k":"fields",${fieldsText(before.members, now.members)}}`;
  }
  return null;
}

export class PushPatcher {
  /** What the tab was last sent, by channel and character, as each field's parts. */
  private readonly sent = new Map<string, ReadonlyMap<string, Sent>>();

  /**
   * The patch frame for `message` after its opening brace (the number goes
   * in front), or null for a push that is not patched, which goes whole.
   */
  patch(message: RpcPush): string | null {
    if (!PATCHED_PUSHES.has(message.c)) return null;
    const addressed = addressedOf(message.p);
    const state = addressed?.payload;
    if (addressed === null || !isPlainRecord(state)) return null;
    const session = addressed.session;

    const key = `${message.c}\u0000${session}`;
    const before = this.sent.get(key) ?? new Map<string, Sent>();
    const now = new Map<string, Sent>();
    for (const [field, value] of Object.entries(state)) {
      const sent = sentOf(value, PATCH_DEPTH);
      if (sent !== undefined) now.set(field, sent);
    }
    this.sent.set(key, now);
    // Written out rather than stringified, since each field's JSON is already
    // in hand; the head is checked against the type.
    const head: Omit<RpcPatch, 'set' | 'deep' | 'drop'> = { k: 'patch', c: message.c, s: session };
    return `${JSON.stringify(head).slice(1, -1)},${fieldsText(before, now)}}`;
  }
}
