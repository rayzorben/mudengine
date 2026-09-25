import type { Block } from './blocks';
import type { CharacterState } from './character';
import type { PlayerRegistry } from './players';

/**
 * What a debug record is about.
 *
 * These are the six things the todo asked to see, plus the two the client says
 * on its own behalf. They are a closed union because the view colours by them
 * and the saved report is read by somebody — a person or a model — who has to
 * be able to tell one kind of line from another without a legend.
 *
 * | kind | what it is |
 * |---|---|
 * | `in` | bytes the server sent, decoded, escape sequences intact |
 * | `out` | a command this client committed to the wire |
 * | `line` | one framed line, as the parser will see it |
 * | `block` | what that line was classified as |
 * | `state` | what changed in the character because of it |
 * | `event` | something the client decided or noticed |
 * | `link` | the socket and the Telnet negotiation |
 * | `notice` | the client speaking for itself |
 */
export type DebugKind = 'in' | 'out' | 'line' | 'block' | 'state' | 'event' | 'link' | 'notice';

export interface DebugRecord {
  /** Monotonic within a session, so a report can be read in order. */
  seq: number;
  at: number;
  kind: DebugKind;
  /**
   * A short word qualifying the kind: the block's type, the line's terminator,
   * whether a command came from the player or from automation.
   *
   * Drawn as a chip and written into the report's second column, so it has to
   * be short — this is the column somebody scans down.
   */
  tag: string;
  /** The headline, on one line. Control bytes already made visible. */
  text: string;
  /** More, when there is more: the plain text under a raw line, a diff. */
  detail?: string;
}

/**
 * The longest a record's text may be.
 *
 * A socket read can be a whole screen of a shop's stock, and a debug ring
 * holding a thousand of those is a bug report nobody can open. The cut is
 * marked, because a silently truncated record is worse than a short one: it
 * reads as the server having stopped mid-sentence.
 */
export const DEBUG_TEXT_LIMIT = 400;

/** Cuts to `DEBUG_TEXT_LIMIT` and says so. */
export function clip(text: string, limit = DEBUG_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (+${text.length - limit} more)`;
}

/**
 * Control bytes made visible, so the raw stream can be read.
 *
 * `ESC` is the one that matters — this server family repaints its status line
 * with a literal `CSI 79 D` rather than a newline, and a report that swallowed
 * it would be a report of a stream nobody can reason about. Written as `␛`
 * (U+241B) and the other C0 bytes as their own control pictures, which are one
 * column each in a monospace face and cannot be mistaken for text the server
 * sent: `\\x1b` would be four characters that a server could equally have
 * printed literally.
 *
 * `\r` and `\n` are shown as `␍` and `␊` rather than as an actual break, so
 * one record stays one line in the view and in the file.
 */
export function visible(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x7f) out += '␡';
    else if (code < 0x20) out += String.fromCodePoint(0x2400 + code);
    else out += ch;
  }
  return out;
}

/**
 * A one-line summary of what a block was.
 *
 * The type is the tag; this is the evidence for it — the text that matched and
 * the groups the pattern pulled out, which is the pair somebody needs to see
 * to say *that was classified wrongly*. Without the groups a misclassification
 * and a correct classification look identical in a log.
 */
export function summariseBlock(block: Block): string {
  const groups = Object.entries(block.groups)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  const confidence = `${Math.round(block.confidence * 100)}%`;
  return groups.length > 0 ? `${confidence}  ${groups}` : confidence;
}

/**
 * What changed about the character, and nothing else.
 *
 * The whole `CharacterState` several times a second is not a record anybody
 * can read — it is the same forty fields over and over with two of them
 * different, and the two are the answer. A diff is also the honest shape for
 * the question the todo asks (*what state was applied*): applying state is a
 * change, and a snapshot cannot show one.
 *
 * **Null is not zero and absence is not a change.** A field that has never
 * arrived reads as `—`, and going from unknown to a number is reported as
 * exactly that: an unknown maximum becoming 334 is a different event from 0
 * becoming 334, and a client that conflated them is the one this project keeps
 * writing rules against.
 */
export function describeStateChange(before: CharacterState, after: CharacterState): string[] {
  const changes: string[] = [];
  const show = (value: unknown): string =>
    value === null || value === undefined ? '—' : String(value);
  const note = (what: string, from: unknown, to: unknown): void => {
    if (from === to) return;
    changes.push(`${what} ${show(from)} → ${show(to)}`);
  };

  note('phase', before.phase, after.phase);
  note('realm', before.realm, after.realm);
  note('name', before.name, after.name);
  note('level', before.progress.level, after.progress.level);
  note('exp', before.progress.exp, after.progress.exp);
  note('hp', before.vitals.hp, after.vitals.hp);
  note('hp max', before.vitals.hpMax, after.vitals.hpMax);
  note('mana', before.vitals.mana, after.vitals.mana);
  note('mana max', before.vitals.manaMax, after.vitals.manaMax);
  note('resting', before.vitals.resting, after.vitals.resting);
  note('meditating', before.vitals.meditating, after.vitals.meditating);
  note('room', before.room.name, after.room.name);
  note('room id', before.room.number, after.room.number);
  note('map', before.room.map, after.room.map);
  note('in combat', before.inCombat, after.inCombat);
  /*
   * Counts rather than contents for the listings. What is in the pack is the
   * Carrying card's job and a diff of a hundred items per pick-up is a report
   * nobody can read; that the count moved is the fact a bug report needs, and
   * the line that caused it is two records above.
   */
  note('carried', before.inventory.items.length, after.inventory.items.length);
  note('in the realm', before.online.length, after.online.length);
  return changes;
}

/**
 * Who the registry learned something about, by name — its push's half of
 * `describeStateChange`. By identity: `observe` replaces a record only when it
 * changed, so a record that is not the same object is exactly a record that
 * moved, and a push with nothing different in it names nobody.
 */
export function describePlayersChange(before: PlayerRegistry, after: PlayerRegistry): string[] {
  if (before === after) return [];
  return Object.entries(after)
    .filter(([key, record]) => before[key] !== record)
    .map(([, record]) => record.name);
}

/**
 * The saved bug report, as text.
 *
 * Plain text with fixed columns rather than JSON, and that is a decision about
 * who reads it: a person pasting it into an issue, and a model asked what went
 * wrong. Both read prose better than a tree, and a column somebody can scan
 * down — the kind, then the tag — is what makes a thousand records navigable at
 * all. The header is what a bug report is useless without: which build, which
 * realm, when, and how much of the session this is.
 *
 * **It carries no password**, and that is a property of what it is given
 * rather than of anything here: every outbound command reaches a record
 * through `Publisher.reportable`, which is the one place this client
 * redacts. Nothing in this function can put one back, and nothing in it should
 * try to take one out — a second redactor is a second thing to keep correct.
 */
export function formatDebugReport(
  header: {
    title: string;
    version: string;
    platform: string;
    character: string;
    realm: string;
    at: number;
    /** How many records the ring dropped before the oldest one kept. */
    dropped: number;
  },
  records: readonly DebugRecord[]
): string {
  const stamp = (at: number): string => new Date(at).toISOString().slice(11, 23);
  const lines: string[] = [
    header.title,
    '='.repeat(header.title.length),
    '',
    `version    ${header.version}`,
    `platform   ${header.platform}`,
    `character  ${header.character}`,
    `realm      ${header.realm}`,
    `saved      ${new Date(header.at).toISOString()}`,
    `records    ${records.length}${header.dropped > 0 ? ` (${header.dropped} older dropped)` : ''}`,
    '',
    'Times are UTC. Control bytes are shown as their Unicode control pictures:',
    '␛ is ESC, ␍ is CR, ␊ is LF. Passwords are never recorded.',
    '',
    `${'time'.padEnd(12)} ${'kind'.padEnd(6)} ${'tag'.padEnd(22)} what`,
    `${'-'.repeat(12)} ${'-'.repeat(6)} ${'-'.repeat(22)} ${'-'.repeat(40)}`
  ];
  for (const record of records) {
    lines.push(
      `${stamp(record.at).padEnd(12)} ${record.kind.padEnd(6)} ${record.tag.padEnd(22)} ${record.text}`
    );
    // Indented under its own record, so the columns above stay scannable.
    if (record.detail !== undefined && record.detail.length > 0) {
      for (const extra of record.detail.split('\n')) {
        lines.push(`${' '.repeat(44)}${extra}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
