/**
 * What a look at this character says it looks like (todo 20261019-0931-01):
 * gender, hair and eyes, read off `Player.ObjDesc`'s first two sentences.
 * Each list is what character creation offers (GreaterMUD
 * `AssignStatsState.cs:14-16`, source), lower-cased as the look prints them;
 * a word outside one is unknown, never guessed.
 */

/** `Misc.GetGenderPronoun`'s subject pronouns, as the art gateway names them. */
export const GENDERS = ['male', 'female', 'androgynous'] as const;
export type Gender = (typeof GENDERS)[number];

export const HAIR_LENGTHS = [
  'short',
  'shoulder-length',
  'long',
  'waist-length',
  'ankle-length'
] as const;
export type HairLength = (typeof HAIR_LENGTHS)[number];

export const HAIR_COLOURS = [
  'black',
  'white',
  'silver',
  'red',
  'brown',
  'dark-brown',
  'blonde',
  'green',
  'blue',
  'grey'
] as const;
export type HairColour = (typeof HAIR_COLOURS)[number];

export const EYE_COLOURS = [
  'black',
  'crimson',
  'yellow',
  'pale-blue',
  'sea-blue',
  'dark-blue',
  'grey-blue',
  'slate-grey',
  'bright-green',
  'forest-green',
  'pale-green',
  'chestnut-brown',
  'dark-brown',
  'hazel',
  'violet',
  'lavender',
  'golden'
] as const;
export type EyeColour = (typeof EYE_COLOURS)[number];

/** `no hair` (`HairLength` `None`), or a length and a colour. */
export type Hair = { none: true } | { none: false; length: HairLength; colour: HairColour };

/** Each field null where the look printed a word outside its list. */
export interface Appearance {
  gender: Gender | null;
  hair: Hair | null;
  eyes: EyeColour | null;
}

/** A look at this character that said none of the three: read, and nothing known. */
export const UNKNOWN_APPEARANCE: Appearance = { gender: null, hair: null, eyes: null };

const PRONOUN_GENDER: Readonly<Record<string, Gender>> = {
  he: 'male',
  she: 'female',
  they: 'androgynous'
};

function member<T extends string>(list: readonly T[], word: string): T | null {
  return (list as readonly string[]).includes(word) ? (word as T) : null;
}

function hairOf(text: string): Hair | null {
  if (text === 'no') return { none: true };
  const at = text.indexOf(' ');
  if (at === -1) return null;
  const length = member(HAIR_LENGTHS, text.slice(0, at));
  const colour = member(HAIR_COLOURS, text.slice(at + 1));
  return length === null || colour === null ? null : { none: false, length, colour };
}

/**
 * The three words the description printed, or null when it printed none of
 * them: `It` (`Gender.Unknown`) is no gender the gateway draws.
 */
export function appearanceOf(
  hair: string | undefined,
  eyes: string | undefined,
  pronoun: string | undefined
): Appearance | null {
  if (hair === undefined || eyes === undefined || pronoun === undefined) return null;
  return {
    gender: PRONOUN_GENDER[pronoun.toLowerCase()] ?? null,
    hair: hairOf(hair.trim().toLowerCase()),
    eyes: member(EYE_COLOURS, eyes.trim().toLowerCase())
  };
}

/** The hair as the look prints it and the gateway takes it: `no`, or `shoulder-length brown`. */
export function hairWords(hair: Hair): string {
  return hair.none ? 'no' : `${hair.length} ${hair.colour}`;
}

export function sameAppearance(a: Appearance | null, b: Appearance | null): boolean {
  if (a === null || b === null) return a === b;
  const hair = (h: Hair | null): string | null => (h === null ? null : hairWords(h));
  return a.gender === b.gender && a.eyes === b.eyes && hair(a.hair) === hair(b.hair);
}
