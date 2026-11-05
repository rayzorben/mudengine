/**
 * A whole-state push to a browser tab (`PATCHED_PUSHES`), sent as what changed.
 *
 * Every change to a character republishes its whole state, about 42 KB with
 * the room, the who list and the inventory, four times a second in a fight.
 * A tab is sent, per character, only the top-level fields that differ from
 * what it was last sent (`RpcPatch`), a record or array among them as what
 * changed inside it (`RpcFieldPatch`); the tab puts the state back together
 * (`src/shared/patches.ts`). Each part's JSON is kept by the object it was
 * made from (`SentParts`), shared by every tab: a field the state carried
 * over unchanged is the same object, so it is looked up, not stringified
 * again per push and per tab (2026-11-04). See `mudengine-session` › *A
 * browser tab outlives its socket*.
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

/** What a push is to one tab: not patched, what the tab already holds, or the patch frame's body. */
export type Patched = { k: 'whole' } | { k: 'same' } | { k: 'patch'; body: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Each object's parts as sent, by depth, kept while the object lives. The
 * state is built by immutable transforms, so an object is never changed after
 * it is published and its JSON never goes stale.
 */
class SentParts {
  private readonly byDepth = new Map<number, WeakMap<object, Sent>>();

  /** `value`'s JSON, built from its parts down to `depth` so a later patch can name them. */
  of(value: unknown, depth: number): Sent | undefined {
    if (typeof value !== 'object' || value === null) return whole(value);
    let kept = this.byDepth.get(depth);
    if (kept === undefined) {
      kept = new WeakMap();
      this.byDepth.set(depth, kept);
    }
    const held = kept.get(value);
    if (held !== undefined) return held;
    const sent = this.build(value, depth);
    if (sent !== undefined) kept.set(value, sent);
    return sent;
  }

  /** A record's members by name, for the top of a push, which is never sent as one text. */
  members(value: Record<string, unknown>, depth: number): ReadonlyMap<string, Sent> {
    const members = new Map<string, Sent>();
    for (const [field, inner] of Object.entries(value)) {
      const sent = this.of(inner, depth);
      if (sent !== undefined) members.set(field, sent);
    }
    return members;
  }

  private build(value: object, depth: number): Sent | undefined {
    if (depth <= 0) return whole(value);
    if (Array.isArray(value)) {
      const items = value.map((item: unknown) => this.of(item, 0)?.text ?? 'null');
      return { text: `[${items.join(',')}]`, items };
    }
    if (isPlainRecord(value)) {
      const members = this.members(value, depth - 1);
      return { text: membersText(members), members };
    }
    return whole(value);
  }
}

function whole(value: unknown): Sent | undefined {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : { text };
}

/** One for the process: every tab is sent the same states. */
const PARTS = new SentParts();

function membersText(members: ReadonlyMap<string, Sent>): string {
  return `{${[...members].map(([field, sent]) => `${JSON.stringify(field)}:${sent.text}`).join(',')}}`;
}

/**
 * The members of `now` that differ from `before`, as the inside of a
 * `fields` patch: each set whole, patched (`changeOf`), or dropped. Null
 * when nothing differs.
 */
function fieldsText(
  before: ReadonlyMap<string, Sent>,
  now: ReadonlyMap<string, Sent>
): string | null {
  const set: string[] = [];
  const deep: string[] = [];
  for (const [field, sent] of now) {
    const was = before.get(field);
    if (was === sent || was?.text === sent.text) continue;
    const change = was === undefined ? null : changeOf(was, sent);
    if (change === null) set.push(`${JSON.stringify(field)}:${sent.text}`);
    else deep.push(`${JSON.stringify(field)}:${change}`);
  }
  const drop = [...before.keys()].filter((field) => !now.has(field));
  if (set.length === 0 && deep.length === 0 && drop.length === 0) return null;
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
    // Called only where the texts differ, so some member does.
    const fields = fieldsText(before.members, now.members);
    return fields === null ? null : `{"k":"fields",${fields}}`;
  }
  return null;
}

export class PushPatcher {
  /** What the tab was last sent, by channel and character, as each field's parts. */
  private readonly sent = new Map<string, ReadonlyMap<string, Sent>>();

  /**
   * `message` for this tab: a push that is not patched goes whole; one that
   * changes nothing the tab holds is the same; otherwise the patch frame
   * after its opening brace (the number goes in front).
   */
  patch(message: RpcPush): Patched {
    if (!PATCHED_PUSHES.has(message.c)) return { k: 'whole' };
    const addressed = addressedOf(message.p);
    const state = addressed?.payload;
    if (addressed === null || !isPlainRecord(state)) return { k: 'whole' };
    const session = addressed.session;

    const key = `${message.c}\u0000${session}`;
    const before = this.sent.get(key);
    const now = PARTS.members(state, PATCH_DEPTH);
    this.sent.set(key, now);
    const fields = fieldsText(before ?? new Map<string, Sent>(), now);
    // The first push for a character goes even when it is empty: the tab holds nothing for it yet.
    const body = fields ?? (before === undefined ? `"set":{},"deep":{},"drop":[]` : null);
    if (body === null) return { k: 'same' };
    // Written out rather than stringified, since each field's JSON is already
    // in hand; the head is checked against the type.
    const head: Omit<RpcPatch, 'set' | 'deep' | 'drop'> = { k: 'patch', c: message.c, s: session };
    return { k: 'patch', body: `${JSON.stringify(head).slice(1, -1)},${body}}` };
  }
}
