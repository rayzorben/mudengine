/**
 * The names worth offering for what has been typed, best first.
 *
 * A prefix outranks a match anywhere (typing `heal` means `healing potion`
 * before `greater healing draught`), which is the rule the spell picker, the
 * item pickers (`NameCombo`), the Reference card's search and the rewrite
 * editor's tag completion all follow. Empty offers the first `most`.
 */
export function rankNames(options: readonly string[], value: string, most: number): string[] {
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return options.slice(0, most);
  const ranked: Array<{ name: string; rank: number }> = [];
  for (const name of options) {
    const lower = name.toLowerCase();
    const rank = lower.startsWith(needle) ? 0 : lower.includes(needle) ? 1 : -1;
    if (rank < 0) continue;
    ranked.push({ name, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, most)
    .map((hit) => hit.name);
}
