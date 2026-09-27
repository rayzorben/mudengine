/**
 * How the realm ranks a character.
 *
 * Its own module, and the reason is a cycle rather than a taxonomy.
 * `character.ts` needs `NO_PLAYERS` to build `EMPTY_CHARACTER`, and
 * `players.ts` needed `ALIGNMENTS` to parse a stored record — two *value*
 * imports pointing at each other, which is a cycle a bundler resolves by
 * picking an order. Whichever module it enters second sees the first one's
 * exports as `undefined` at evaluation time, and `EMPTY_CHARACTER` captured
 * that: `players` came out `undefined` rather than `{}`, permanently, for
 * every consumer in that graph. It went unnoticed because every existing entry
 * point happened to reach `players.ts` first, and it surfaced the moment a new
 * module imported the pair in the other order — `Object.values(undefined)`,
 * from a state constant the whole client treats as safe.
 *
 * So the vocabulary both of them share lives underneath both of them, and
 * neither imports the other's values any more. `character.ts` re-exports these
 * names, because they are part of the character model as far as every caller
 * is concerned and moving a file should not move an import.
 *
 * The words are the server's own — extracted from the GreaterMUD source and
 * confirmed against the live `who` listing. A closed union rather than a
 * string because it is the field a PvP decision is made on, and "is this
 * person an Outlaw" must not depend on matching prose.
 */
export type Alignment =
  'Saint' | 'Good' | 'Neutral' | 'Seedy' | 'Outlaw' | 'Criminal' | 'Villain' | 'Lawful' | 'FIEND';

export const ALIGNMENTS: readonly Alignment[] = [
  'Saint',
  'Good',
  'Lawful',
  'Neutral',
  'Seedy',
  'Outlaw',
  'Criminal',
  'Villain',
  'FIEND'
];

/** Alignments the realm treats as hostile. */
const HOSTILE: readonly Alignment[] = ['Outlaw', 'Criminal', 'Villain', 'FIEND'];

export function isHostile(alignment: Alignment | null): boolean {
  return alignment !== null && HOSTILE.includes(alignment);
}

/**
 * The words the server's own enum has, in its own order.
 *
 * Deliberately **not** `ALIGNMENTS`, whose order is incidental and whose job is
 * membership. This is a *scale*, and the realm gates exits on a range of it —
 * `Alignment: Saint to Seedy` is `AlignmentExit(min, max)`, comparing
 * `Player.EvilPoints` against two figures whose bands these words are — so
 * comparing them needs an order or nothing can be compared at all.
 *
 * `GreaterMUD.Module/Player.cs`'s `Alignment`, read out of the source rather
 * than captured, and matching the boundaries `EvilPointLevels` states.
 *
 * **`Lawful` is a second spelling of the top rung, not a ninth rung**
 * (2026-09-17). It was deliberately absent here while `ALIGNMENT_RANGE` had no
 * band for it; `src/shared/mobs.ts` carries the capture that settled where it
 * sits — MajorMUD prints `Lawful` where GreaterMUD prints `Saint`, and neither
 * ladder has both. So it is an alias below rather than an entry here: this
 * array is the *scale*, one word per rung, and `asAlignment` reads membership
 * from `ALIGNMENTS` so a realm that writes `Lawful` sees it written back.
 */
const ALIGNMENT_SCALE: readonly Alignment[] = [
  'Saint',
  'Good',
  'Neutral',
  'Seedy',
  'Outlaw',
  'Criminal',
  'Villain',
  'FIEND'
];

/**
 * The words one realm spells differently for a rung another already has.
 *
 * One entry, and the shape exists because a second is expected rather than
 * because one is hypothetical: the two realms this client has read differ by
 * exactly this word, and a derivative that renames another rung would be
 * added here rather than given a rank of its own.
 */
const ALIGNMENT_ALIASES: Readonly<Record<string, Alignment>> = { lawful: 'Saint' };

/**
 * Where a word sits on that scale, or null for one it does not name.
 *
 * Case-insensitive, because the realm's own exit instruction writes `Fiend`
 * where the roster writes `FIEND`, and null is a first-class answer everywhere
 * it is asked — a word from a realm this client has never seen and an empty
 * string both read as *nobody has said*, which the router discourages and
 * never prunes. `Lawful` used to be in that company and no longer is: it ranks
 * with `Saint`, so `Alignment: Saint to Seedy` admits a Lawful character
 * exactly as the realm printing that word intends.
 */
export function alignmentRank(word: string): number | null {
  const key = word.trim().toLowerCase();
  if (key.length === 0) return null;
  const rung = (ALIGNMENT_ALIASES[key] ?? key).toLowerCase();
  const index = ALIGNMENT_SCALE.findIndex((entry) => entry.toLowerCase() === rung);
  return index < 0 ? null : index;
}

/**
 * The scale's own spelling of a word, or null for one it does not name.
 *
 * Parse, do not validate: the realm's exit instruction writes a word and the
 * rest of the client carries a closed union, so the crossing happens once and
 * everything downstream holds an `Alignment` or nothing. Here beside the scale
 * rather than at the parser, and by **membership** rather than by rank: the
 * two arrays are different lengths, and indexing one by the other's index is
 * what once returned `Lawful` for `Neutral`. It is also what keeps an alias
 * its own word — a realm that writes `Lawful` is answered `Lawful`, and it is
 * `alignmentRank` that knows the two rank together.
 */
export function asAlignment(word: string): Alignment | null {
  const key = word.trim().toLowerCase();
  if (key.length === 0) return null;
  return ALIGNMENTS.find((entry) => entry.toLowerCase() === key) ?? null;
}

/**
 * Where the realm's alignment words sit on the scale the server compares.
 *
 * `GMUDServer.GetAlignmentTitle` turns a float into one of eight words at fixed
 * boundaries, and `ShouldMobAttackTarget` compares the *float*. Going back the
 * other way — word to number — only recovers a range, so this carries the range
 * and every question is answered from it rather than from a midpoint somebody
 * picked: whether a monster attacks on sight (`mobs.ts`), and whether an
 * alignment gate on an item refuses the character (`gear.ts`).
 *
 * `Seedy` is the one band a boundary runs through: it spans 30 up to 40, and a
 * `LawfulEvil` monster attacks at `<= 30`. So a Seedy character is attacked by
 * one only at the exact bottom of their own band, which nothing on screen
 * distinguishes — and that is reported as *unknown* rather than resolved.
 *
 * **`Lawful` is MajorMUD's word for `Saint`'s band** (2026-09-17), which is
 * why it has one at all: it was deliberately absent here on the grounds that
 * `GetAlignmentTitle` does not produce it, and the exemption said it would go
 * when the capture arrived. It has. Bearfather's MajorMUD 1.11p prints a
 * roster of `Lawful`, `Good`, `Neutral` and `Criminal` and never `Saint`, and
 * `Saint` appears nowhere in the 218-capture corpus while `Lawful` appears in
 * two — eight rungs on each ladder, seven words shared, one word in each that
 * the other does not have. The cost of the absence was a route: every
 * `hates-evil` guardsman in Godfrey answered *nobody can say* against a
 * `Lawful` character, a pass was priced as a fight a level-1 mystic cannot
 * survive, and the walk to Newhaven went 46 steps round a town square it
 * could have crossed. See `decisions.md`.
 */
const ALIGNMENT_RANGE: Partial<Record<Alignment, [number, number]>> = {
  Saint: [-1000, -200],
  Lawful: [-1000, -200],
  Good: [-200, -50],
  Neutral: [-50, 30],
  Seedy: [30, 40],
  Outlaw: [40, 80],
  Criminal: [80, 120],
  Villain: [120, 210],
  FIEND: [210, 1000]
};

/**
 * The span of evil points a word covers, or null for a word with no band.
 *
 * Neighbouring bands share an end, and the word does not say which side of it
 * the character is on, so a reader decides on the open interval between the two.
 */
export function alignmentBand(word: Alignment): readonly [number, number] | null {
  return ALIGNMENT_RANGE[word] ?? null;
}
