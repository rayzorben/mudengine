/**
 * A pure function's last few answers, each kept by the parts it was asked
 * with, compared by identity. The character state is built by immutable
 * transforms, so a field no line moved is the same object on the next state:
 * a figure read from the inventory and the buffs is computed again only when
 * one of them moved, not on every status line (2026-11-04, the per-line
 * profile on the hosted client). Kept `size` deep so the characters a client
 * runs side by side do not push each other's answers out.
 */
export function keptByParts<Parts extends readonly unknown[], Answer>(
  size: number,
  compute: (...parts: Parts) => Answer
): (...parts: Parts) => Answer {
  const kept: Array<{ parts: Parts; answer: Answer }> = [];
  return (...parts: Parts): Answer => {
    const at = kept.findIndex((entry) => entry.parts.every((part, index) => part === parts[index]));
    if (at !== -1) {
      const entry = kept[at]!;
      // The newest at the front, so the next miss drops the one least recently asked.
      if (at > 0) kept.unshift(...kept.splice(at, 1));
      return entry.answer;
    }
    const answer = compute(...parts);
    kept.unshift({ parts, answer });
    if (kept.length > size) kept.pop();
    return answer;
  };
}
