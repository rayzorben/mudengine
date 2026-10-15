/**
 * A fight line as the game view's arena draws it (todo 140): who struck whom,
 * for how much, or missed, or healed. Read off the blocks the parser already
 * sends on `session:block`; nothing is stored, and a line naming nobody on the
 * arena draws nothing.
 *
 * The patterns keep the attacker inside `line` (`The kobold thief slashes you
 * for 5 damage!`), so both ends are found by the names the arena holds: `You`,
 * each party member, each monster in the room.
 */
import type { Block } from '@shared/blocks';

export type BlowKind = 'hit' | 'miss' | 'heal';

export interface Blow {
  /** The arena token keys of both ends. */
  from: string;
  to: string;
  kind: BlowKind;
  amount: number | null;
}

/** A token on the arena, by the name the realm prints for it. */
export interface ArenaName {
  key: string;
  name: string;
}

/** The token standing for the character itself. */
export const SELF = 'self';

const HITS = new Set(['user-hits', 'mob-hits']);
const MISSES = new Set(['user-misses', 'mob-misses', 'player-misses']);

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\w']/.test(ch);

/** Where a name first appears in the line, whole words only and in any case; -1 when it does not. */
function at(text: string, name: string): number {
  if (name.length === 0) return -1;
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + 1)) {
    if (!isWordChar(haystack[from - 1]) && !isWordChar(haystack[from + needle.length])) return from;
  }
  return -1;
}

/** The arena tokens a line names, in the order the line names them. */
function named(text: string, names: readonly ArenaName[]): string[] {
  const hits: Array<{ key: string; index: number }> = [];
  if (/^you\b/i.test(text)) hits.push({ key: SELF, index: 0 });
  else {
    const you = /\b(?:you|yourself|your body)\b/i.exec(text);
    if (you) hits.push({ key: SELF, index: you.index });
  }
  for (const one of names) {
    const index = at(text, one.name);
    if (index >= 0) hits.push({ key: one.key, index });
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.key);
}

export function blowOf(
  block: Pick<Block, 'type' | 'text' | 'groups'>,
  names: readonly ArenaName[]
): Blow | null {
  const cast = block.type === 'spell-cast' ? block.groups['kind'] : undefined;
  const kind: BlowKind | null =
    HITS.has(block.type) || cast === 'for'
      ? 'hit'
      : MISSES.has(block.type)
        ? 'miss'
        : cast === 'healing'
          ? 'heal'
          : null;
  if (kind === null) return null;
  const order = named(block.text, names);
  const from = order[0];
  const to =
    kind === 'heal' && /\byourself\b/i.test(block.text) ? from : order.find((key) => key !== from);
  if (from === undefined || to === undefined) return null;
  const raw = Number(block.groups['damage'] ?? block.groups['amount']);
  return { from, to, kind, amount: Number.isFinite(raw) && raw > 0 ? raw : null };
}
