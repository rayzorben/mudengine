/**
 * How the realm ranks a character, worst to best behaved.
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
