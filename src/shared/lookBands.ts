/**
 * The phrase a look prints for each stat (todo 20261019-0931-01): GreaterMUD
 * `Player.cs` `GetHealthDesc` .. `GetWillpowerDesc` (source), one band per ten
 * points, highest first. Paradigm prints the same bands (the user,
 * 2026-10-19). A phrase that names the character's pronoun is kept to the part
 * before it, so one table serves every gender.
 */

export const LOOK_STATS = [
  'health',
  'strength',
  'agility',
  'charm',
  'intellect',
  'willpower'
] as const;
export type LookStat = (typeof LOOK_STATS)[number];

/** Each band's floor and phrase, highest first; the last band's floor is the bottom. */
type Bands = readonly (readonly [number, string])[];

const BANDS: Readonly<Record<LookStat, Bands>> = {
  health: [
    [100, 'colossal'],
    [90, 'gigantic'],
    [80, 'massive'],
    [70, 'solid'],
    [60, 'stout'],
    [50, 'healthy'],
    [40, 'thin'],
    [30, 'frail'],
    [-Infinity, 'stickly']
  ],
  strength: [
    [110, 'physically Godlike'],
    [100, 'Herculean'],
    [90, 'heroically proportioned'],
    [80, 'powerfully built'],
    [70, 'muscular'],
    [60, 'well built'],
    [50, 'moderately built'],
    [40, 'slightly built'],
    [30, 'weak'],
    [-Infinity, 'puny']
  ],
  agility: [
    [100, 'blindingly fast'],
    [90, 'with catlike agility'],
    [80, 'with uncanny speed'],
    [70, 'very swiftly'],
    [60, 'gracefully'],
    [50, 'cautiously'],
    [40, 'sluggishly'],
    [30, 'clumsily'],
    [-Infinity, 'slowly']
  ],
  charm: [
    [100, 'overwhelmingly charismatic'],
    [90, 'incredibly charismatic'],
    [80, 'extremely likeable, and fairly radiates charisma'],
    [70, 'charismatic and outgoing'],
    [60, 'quite attractive and pleasant to be around'],
    [50, 'likable in an unassuming sort of way'],
    [40, 'quite unfriendly and aloof'],
    [30, 'hostile and rather unappealing'],
    [-Infinity, 'openly hostile and quite revolting']
  ],
  intellect: [
    [100, 'all-knowing'],
    [90, 'a genius'],
    [80, 'brilliant'],
    [70, 'extremely clever'],
    [60, 'bright'],
    [50, 'intelligent'],
    [40, 'slightly dull'],
    [30, 'quite stupid'],
    [-Infinity, 'utterly moronic']
  ],
  willpower: [
    [100, 'one with the Gods'],
    [90, 'seems to be in an enlightened state of mind'],
    [80, 'seems to possess a wisdom beyond'],
    [70, 'has a worldly air'],
    [60, 'looks quite experienced and wise'],
    [50, 'looks fairly knowledgeable'],
    [40, 'seems a little naive'],
    [30, 'seems sullen and impulsive'],
    [-Infinity, 'seems selfish and hot-tempered']
  ]
};

/** The phrase a look prints for this stat at this value, or null for an unknown value. */
export function bandOf(stat: LookStat, value: number | null): string | null {
  if (value === null) return null;
  return BANDS[stat].find(([floor]) => value >= floor)?.[1] ?? null;
}
